/**
 * A stand-in for the Twilio REST API, so the carrier flow can be tested end to
 * end without an account.
 *
 *   tsx scripts/twilio-stub.ts        # listens on 4010
 *   TWILIO_API_BASE=http://127.0.0.1:4010 npm start
 *
 * It is deliberately picky: wrong credentials get a 401 in Twilio's own error
 * envelope, which is how the "verify fails loudly" path gets covered.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4010);
const ESID = process.env.STUB_SID ?? ('AC' + '0123456789abcdef0123456789abcdef');
const TOKEN = process.env.STUB_TOKEN ?? 'stub-auth-token';

type StubNumber = {
  sid: string;
  phone_number: string;
  friendly_name: string;
  status: string;
  monthly_cost: string;
  date_created: string;
  locality: string;
  region: string;
  iso_country: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  voice_url?: string;
  /** Where inbound texts are delivered — the other half of the opt-out line. */
  sms_url?: string;
  status_callback?: string;
};

// One number the account already owns, so "adopt an existing number" is a real
// path in the tests rather than a bought number in disguise.
const SEEDED_NUMBER: StubNumber = {
  sid: 'PNstub000900',
  phone_number: '+14155550999',
  friendly_name: 'Existing line',
  status: 'in-use',
  monthly_cost: '1.15',
  date_created: '2025-11-02T00:00:00Z',
  locality: 'San Francisco',
  region: 'CA',
  iso_country: 'US',
  capabilities: { voice: true, sms: true, mms: true },
  voice_url: 'https://old-ivr.example.com/answer',
  status_callback: undefined,
};

const owned: StubNumber[] = [{ ...SEEDED_NUMBER }];
const placedCalls: Record<string, unknown>[] = [];
const sentMessages: Record<string, unknown>[] = [];
const sentEmails: Record<string, unknown>[] = [];
const requests: string[] = [];
const failNext: Record<'purchase' | 'configure' | 'release' | 'call' | 'message', number> = {
  purchase: 0,
  configure: 0,
  release: 0,
  call: 0,
  message: 0,
};

function consumeFailure(kind: keyof typeof failNext) {
  if (failNext[kind] <= 0) return false;
  failNext[kind] -= 1;
  return true;
}

let seq = 100;

function ok(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function twilioError(res: import('node:http').ServerResponse, status: number, message: string, code: number) {
  ok(res, status, { code, message, more_info: 'https://www.twilio.com/docs/errors/' + code, status });
}

/**
 * The numbers "available to buy".
 *
 * Stable for the first three so tests can assert on them, then minted on demand —
 * and anything already owned is filtered out, because a real carrier does not
 * offer you a number you already have. Without that filter a second purchase in
 * the same run fails for a reason no real customer would ever hit.
 */
function available(areaCode: string) {
  const seeded = [1, 2, 3].map((i) => `+1${areaCode}555030${i}`);
  const minted = Array.from({ length: 12 }, (_, i) => `+1${areaCode}55504${String(i + 10)}`);
  return [...seeded, ...minted]
    .filter((phone_number) => !owned.some((n) => n.phone_number === phone_number))
    .map((phone_number) => ({
      phone_number,
      locality: 'San Francisco',
      region: 'CA',
      friendly_name: phone_number,
      iso_country: 'US',
      capabilities: { voice: true, sms: true, mms: true },
    }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c as Buffer));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const form = new URLSearchParams(body);
    const auth = req.headers.authorization ?? '';
    const accountPrefix = `/2010-04-01/Accounts/${ESID}`;
    const rawPath = url.pathname.startsWith(accountPrefix) ? url.pathname.slice(accountPrefix.length) : url.pathname;
    const path = rawPath === '' ? '.json' : rawPath;

    // Test-only introspection and reset, deliberately outside the auth check.
    if (path === '/__reset') {
      owned.splice(0, owned.length, { ...SEEDED_NUMBER });
      placedCalls.length = 0;
      requests.length = 0;
      sentMessages.length = 0;
      sentEmails.length = 0;
      for (const key of Object.keys(failNext) as (keyof typeof failNext)[]) failNext[key] = 0;
      return ok(res, 200, { reset: true, owned: owned.length });
    }
    if (path === '/__control' && req.method === 'POST') {
      let control: { failNext?: Partial<Record<keyof typeof failNext, number>> } = {};
      try {
        control = JSON.parse(body || '{}') as typeof control;
      } catch {
        return ok(res, 400, { error: 'invalid JSON' });
      }
      for (const key of Object.keys(failNext) as (keyof typeof failNext)[]) {
        if (control.failNext?.[key] !== undefined) failNext[key] = Math.max(0, Math.floor(Number(control.failNext[key]) || 0));
      }
      return ok(res, 200, { failNext });
    }
    if (path === '/__state') {
      return ok(res, 200, { owned, placedCalls, sentMessages, sentEmails, requests: requests.slice(-80), failNext });
    }

    // ---- email relay ------------------------------------------------------
    // The email transport posts here when VOXERA_EMAIL_API_BASE points at the
    // stub, so a test can prove the relay branch without a mail provider.
    if (path === '/emails' || path === '/v1/emails') {
      const payload = JSON.parse(body || '{}') as { to?: string; subject?: string; text?: string };
      if (!payload.to) return ok(res, 422, { message: 'to is required' });
      const id = `eml_stub_${String(++seq).padStart(6, '0')}`;
      sentEmails.unshift({ id, to: payload.to, subject: payload.subject ?? '', text: payload.text ?? '', at: new Date().toISOString() });
      return ok(res, 201, { id, status: 'accepted' });
    }


    const expected = `Basic ${Buffer.from(`${ESID}:${TOKEN}`).toString('base64')}`;
    requests.push(`${req.method} ${url.pathname}${url.search}`);

    // Unauthorised: Twilio answers 401 with code 20003.
    if (auth !== expected) {
      twilioError(res, 401, 'Authentication Error - invalid username', 20003);
      return;
    }

    if (path === '.json') {
      return ok(res, 200, { sid: ESID, friendly_name: 'Voxera Stub Account', status: 'active', type: 'Full', date_created: '2026-01-04T00:00:00Z' });
    }

    if (path === '/Balance.json') {
      return ok(res, 200, { account_sid: ESID, balance: '412.38000', currency: 'USD' });
    }

    // ---- available numbers ------------------------------------------------
    if (path.startsWith('/AvailablePhoneNumbers/') && path.endsWith('/Local.json')) {
      const country = path.split('/')[2];
      if (country !== 'US') return ok(res, 200, { available_phone_numbers: [] });
      const area = url.searchParams.get('AreaCode') ?? '415';
      return ok(res, 200, { available_phone_numbers: available(area), uri: path });
    }

    // ---- owned numbers ----------------------------------------------------
    if (path === '/IncomingPhoneNumbers.json') {
      if (req.method === 'POST') {
        if (consumeFailure('purchase')) return twilioError(res, 503, 'Injected purchase failure', 20500);
        const phoneNumber = form.get('PhoneNumber') ?? '';
        if (!phoneNumber) return twilioError(res, 400, 'PhoneNumber is required', 21219);
        if (owned.some((n) => n.phone_number === phoneNumber)) {
          return twilioError(res, 400, `${phoneNumber} is not available`, 21422);
        }
        seq += 1;
        const created: StubNumber = {
          sid: `PNstub${String(seq).padStart(6, '0')}`,
          phone_number: phoneNumber,
          friendly_name: form.get('FriendlyName') ?? phoneNumber,
          status: 'in-use',
          monthly_cost: '1.15',
          date_created: new Date().toISOString(),
          locality: 'San Francisco',
          region: 'CA',
          iso_country: 'US',
          capabilities: { voice: true, sms: true, mms: true },
          voice_url: form.get('VoiceUrl') ?? undefined,
          sms_url: form.get('SmsUrl') ?? undefined,
          status_callback: form.get('StatusCallback') ?? undefined,
        };
        owned.push(created);
        return ok(res, 201, created);
      }
      return ok(res, 200, { incoming_phone_numbers: owned, page_size: 50 });
    }

    const numberMatch = path.match(/^\/IncomingPhoneNumbers\/(PN[^/]+)\.json$/);
    if (numberMatch) {
      const target = owned.find((n) => n.sid === numberMatch[1]);
      if (!target) return twilioError(res, 404, `The requested resource was not found: ${numberMatch[1]}`, 20404);
      if (req.method === 'POST') {
        if (consumeFailure('configure')) return twilioError(res, 503, 'Injected configure failure', 20500);
        if (form.has('VoiceUrl')) target.voice_url = form.get('VoiceUrl') || undefined;
        if (form.has('SmsUrl')) target.sms_url = form.get('SmsUrl') || undefined;
        if (form.has('StatusCallback')) target.status_callback = form.get('StatusCallback') || undefined;
        if (form.has('FriendlyName')) target.friendly_name = form.get('FriendlyName') || target.friendly_name;
        return ok(res, 200, target);
      }
      if (req.method === 'DELETE') {
        if (consumeFailure('release')) return twilioError(res, 503, 'Injected release failure', 20500);
        owned.splice(owned.indexOf(target), 1);
        return ok(res, 204, {});
      }
      return ok(res, 200, target);
    }

    // ---- messages ---------------------------------------------------------
    // Real enough to prove the send path: a POST is accepted, given a sid, and
    // comes back as it would from Twilio (201 + `queued`, or an error document).
    // The status callback still has to be *posted*, so a "delivered" row in the
    // product means the product's own callback handler ran — not a stub's kindness.
    if (path === '/Messages.json') {
      if (req.method === 'POST') {
        if (consumeFailure('message')) return twilioError(res, 503, 'Injected message failure', 20500);
        const to = form.get('To') ?? '';
        const from = form.get('From') ?? '';
        const body = form.get('Body') ?? '';
        if (!to) return twilioError(res, 400, 'To is required', 21604);
        if (!from) return twilioError(res, 400, 'From is required', 21603);
        if (!body) return twilioError(res, 400, 'Body is required', 21602);
        const sid = `SMstub${String(++seq).padStart(6, '0')}`;
        const message = {
          sid,
          status: 'queued',
          to,
          from,
          body,
          direction: 'outbound-api',
          num_segments: String(Math.max(1, Math.ceil(body.length / 160))),
          date_created: new Date().toISOString(),
          error_code: null,
          error_message: null,
          price: null,
          status_callback: form.get('StatusCallback') ?? null,
        };
        sentMessages.unshift(message);
        return ok(res, 201, message);
      }
      return ok(res, 200, { messages: sentMessages.slice(0, Number(url.searchParams.get('PageSize') ?? 50)) });
    }

    const messageMatch = path.match(/^\/Messages\/(SM[^/]+)\.json$/);
    if (messageMatch) {
      const message = sentMessages.find((m) => m.sid === messageMatch[1]);
      if (!message) return twilioError(res, 404, `The requested resource was not found: ${messageMatch[1]}`, 20404);
      return ok(res, 200, message);
    }

    // ---- calls ------------------------------------------------------------
    if (path === '/Calls.json') {
      if (req.method === 'POST') {
        if (consumeFailure('call')) return twilioError(res, 503, 'Injected call failure', 20500);
        const to = form.get('To') ?? '';
        if (!to) return twilioError(res, 400, 'To is required', 21205);
        const sid = `CAstub${String(++seq).padStart(6, '0')}`;
        const call = {
          sid,
          status: 'queued',
          to,
          from: form.get('From') ?? '',
          direction: 'outbound-api',
          date_created: new Date().toISOString(),
          machine_detection: form.get('MachineDetection') ?? undefined,
          record: form.get('Record') === 'true',
          url: form.get('Url'),
          status_callback: form.get('StatusCallback'),
        };
        placedCalls.unshift(call);
        return ok(res, 201, call);
      }
      return ok(res, 200, { calls: placedCalls.slice(0, Number(url.searchParams.get('PageSize') ?? 50)) });
    }

    const callMatch = path.match(/^\/Calls\/(CA[^/]+)\.json$/);
    if (callMatch) {
      const call = placedCalls.find((c) => c.sid === callMatch[1]);
      if (!call) return twilioError(res, 404, `The requested resource was not found: ${callMatch[1]}`, 20404);
      if (req.method === 'POST') {
        call.status = 'completed';
        call.duration = '42';
        return ok(res, 200, call);
      }
      return ok(res, 200, call);
    }

    return twilioError(res, 404, `No stub route for ${req.method} ${path}`, 20404);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`twilio stub listening on http://127.0.0.1:${PORT} (account ${ESID}, token ${TOKEN})`);
});
