/**
 * Twilio REST client.
 *
 * Thin and deliberate: everything the platform needs from a carrier — verify an
 * account, search for numbers, buy one, wire its webhooks, place a call, list
 * calls, hang one up. `TWILIO_API_BASE` is overridable so the entire flow can be
 * exercised against a stub (which is how it is tested) and pointed at the real
 * carrier by simply not setting it.
 */

import { decryptSecret, markCarrierUse, type CarrierDoc } from '../carriers';

const DEFAULT_BASE = 'https://api.twilio.com';

function baseUrl() {
  return (process.env.TWILIO_API_BASE ?? DEFAULT_BASE).replace(/\/$/, '');
}

export type TwilioResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

async function request<T>(
  carrier: CarrierDoc,
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  form?: Record<string, string>
): Promise<TwilioResult<T>> {
  if (carrier.provider !== 'twilio') {
    return { ok: false, status: 0, error: `No ${carrier.provider} carrier adapter is implemented.` };
  }
  const token = decryptSecret(carrier);
  if (!token) {
    markCarrierUse(carrier.id, { ok: false, error: 'stored credentials could not be decrypted' });
    return { ok: false, status: 0, error: 'Stored credentials could not be decrypted. Reconnect the carrier.' };
  }

  const url = `${baseUrl()}/2010-04-01/Accounts/${carrier.accountSid}${endpoint}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${carrier.accountSid}:${token}`).toString('base64')}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `Twilio returned ${res.status}`;
      markCarrierUse(carrier.id, { ok: false, error: message });
      return { ok: false, status: res.status, error: message, code: typeof json.code === 'number' ? String(json.code) : undefined };
    }
    markCarrierUse(carrier.id, { ok: true });
    return { ok: true, data: json as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'carrier unreachable';
    markCarrierUse(carrier.id, { ok: false, error: message });
    return { ok: false, status: 0, error: `Could not reach the carrier: ${message}` };
  }
}

/* ------------------------------------------------------------------- account */

export type TwilioAccount = {
  sid: string;
  friendly_name: string;
  status: string;
  type: string;
  balance?: string;
};

export async function verifyAccount(carrier: CarrierDoc) {
  const account = await request<TwilioAccount>(carrier, 'GET', '.json');
  if (!account.ok) return account;

  const balance = await request<{ balance: string; currency: string }>(carrier, 'GET', '/Balance.json');
  return {
    ok: true as const,
    data: {
      sid: account.data.sid,
      name: account.data.friendly_name,
      status: account.data.status,
      type: account.data.type,
      balance: balance.ok ? `${balance.data.balance} ${balance.data.currency}` : undefined,
    },
  };
}

/* ------------------------------------------------------------------- numbers */

export type TwilioNumber = {
  sid: string;
  phone_number: string;
  friendly_name: string;
  status?: string;
  monthly_cost?: string;
  date_created?: string;
  locality?: string;
  region?: string;
  iso_country?: string;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
  voice_url?: string;
  sms_url?: string;
  status_callback?: string;
};

/** Local numbers the account could buy, filtered by area code or country. */
export async function searchNumbers(carrier: CarrierDoc, opts: { country?: string; areaCode?: string; contains?: string; limit?: number }) {
  const country = (opts.country ?? 'US').toUpperCase();
  const query = new URLSearchParams({ PageSize: String(Math.min(opts.limit ?? 10, 20)) });
  if (opts.areaCode) query.set('AreaCode', opts.areaCode);
  if (opts.contains) query.set('Contains', opts.contains);
  const res = await request<{ available_phone_numbers: TwilioNumber[] }>(
    carrier,
    'GET',
    `/AvailablePhoneNumbers/${country}/Local.json?${query.toString()}`
  );
  return res.ok ? { ok: true as const, data: res.data.available_phone_numbers ?? [] } : res;
}

export async function ownedNumbers(carrier: CarrierDoc) {
  const res = await request<{ incoming_phone_numbers: TwilioNumber[] }>(carrier, 'GET', '/IncomingPhoneNumbers.json?PageSize=50');
  return res.ok ? { ok: true as const, data: res.data.incoming_phone_numbers ?? [] } : res;
}

/** Buys a number and points it straight at this deployment's agent. */
export async function buyNumber(
  carrier: CarrierDoc,
  opts: { phoneNumber: string; label: string; voiceUrl: string; statusCallback: string; smsUrl?: string; inboundMethod?: 'POST' | 'GET' }
) {
  const res = await request<TwilioNumber>(carrier, 'POST', '/IncomingPhoneNumbers.json', {
    PhoneNumber: opts.phoneNumber,
    FriendlyName: opts.label,
    VoiceUrl: opts.voiceUrl,
    VoiceMethod: opts.inboundMethod ?? 'POST',
    // Where replies land. A number that answers calls but drops texts silently
    // breaks the opt-out line printed on every message.
    ...(opts.smsUrl ? { SmsUrl: opts.smsUrl, SmsMethod: 'POST' } : {}),
    StatusCallback: opts.statusCallback,
    StatusCallbackMethod: 'POST',
  });
  return res;
}

/** Re-points an existing number's webhooks (used when a number is imported). */
export async function configureNumber(
  carrier: CarrierDoc,
  sid: string,
  opts: { voiceUrl: string; statusCallback: string; smsUrl?: string; voiceMethod?: 'POST' | 'GET' }
) {
  return request<TwilioNumber>(carrier, 'POST', `/IncomingPhoneNumbers/${sid}.json`, {
    VoiceUrl: opts.voiceUrl,
    VoiceMethod: opts.voiceMethod ?? 'POST',
    // Empty is deliberate during detach: Twilio clears this deployment's SMS
    // route rather than continuing to send replies after the local claim is gone.
    SmsUrl: opts.smsUrl ?? '',
    SmsMethod: 'POST',
    StatusCallback: opts.statusCallback,
    StatusCallbackMethod: 'POST',
  });
}

export async function releaseNumber(carrier: CarrierDoc, sid: string) {
  return request<Record<string, never>>(carrier, 'DELETE', `/IncomingPhoneNumbers/${sid}.json`);
}

/* --------------------------------------------------------------------- calls */

export type TwilioCall = {
  sid: string;
  status: string;
  to: string;
  from: string;
  duration?: string;
  start_time?: string;
  price?: string;
};

export async function placeCall(
  carrier: CarrierDoc,
  opts: {
    to: string;
    from: string;
    voiceUrl: string;
    statusCallback: string;
    machineDetection?: boolean;
    record?: boolean;
    timeoutSeconds?: number;
  }
) {
  const form: Record<string, string> = {
    To: opts.to,
    From: opts.from,
    Url: opts.voiceUrl,
    Method: 'POST',
    StatusCallback: opts.statusCallback,
    StatusCallbackMethod: 'POST',
    Timeout: String(opts.timeoutSeconds ?? 30),
  };
  if (opts.machineDetection) form.MachineDetection = 'Enable';
  if (opts.record) {
    form.Record = 'true';
    form.RecordingStatusCallback = `${opts.statusCallback.replace(/\/status$/, '/recording')}`;
  }
  return request<TwilioCall>(carrier, 'POST', '/Calls.json', form);
}

export async function fetchCall(carrier: CarrierDoc, sid: string) {
  return request<TwilioCall>(carrier, 'GET', `/Calls/${sid}.json`);
}

export async function hangupCall(carrier: CarrierDoc, sid: string) {
  return request<TwilioCall>(carrier, 'POST', `/Calls/${sid}.json`, { Status: 'completed' });
}

/** The carrier's own view of recent calls — used to reconcile call records. */
export async function recentCalls(carrier: CarrierDoc, limit = 20) {
  const res = await request<{ calls: TwilioCall[] }>(carrier, 'GET', `/Calls.json?PageSize=${Math.min(limit, 100)}`);
  return res.ok ? { ok: true as const, data: res.data.calls ?? [] } : res;
}

/* ------------------------------------------------------------------- messages */

export type TwilioMessage = {
  sid: string;
  status: string;
  to: string;
  from: string;
  body?: string;
  num_segments?: string;
  error_code?: number | null;
  error_message?: string | null;
  price?: string | null;
};

/**
 * Sends one SMS.
 *
 * The carrier is the one the workspace connected; the number it sends from is a
 * number the workspace owns, because a message from a number nobody answers is a
 * message that generates a phone call to somebody else. The body is passed through
 * exactly as given — the STOP line and the template work happen before this, where
 * they can be seen and asserted, rather than inside a transport.
 */
export async function sendMessage(
  carrier: CarrierDoc,
  opts: { to: string; from: string; body: string; statusCallback?: string }
) {
  const form: Record<string, string> = {
    To: opts.to,
    From: opts.from,
    Body: opts.body,
  };
  if (opts.statusCallback) {
    form.StatusCallback = opts.statusCallback;
  }
  return request<TwilioMessage>(carrier, 'POST', '/Messages.json', form);
}
