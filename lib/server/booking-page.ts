/**
 * The public booking page's own layer.
 *
 * Two rules shape everything here.
 *
 * **Public means public.** Nothing in this file returns a client record, a price
 * history, another client's appointment, or anything else the person booking has
 * no business seeing. The slot list is the diary's *free* time — showing which
 * slots are taken would leak that somebody else is in the building at 10:20.
 *
 * **Booking is the same act everywhere.** The page does not have its own booking
 * engine: it calls the same availability search, the same conflict check and the
 * same `upsertBooking` the phone agent and the dashboard use, so a slot taken on
 * the web cannot be double-sold by a caller.
 */

import type { BookingDoc } from './bookings';
import { scheduleGatewayFor } from './schedule-gateway';
import { ScheduleError, stableHash } from './schedule-core';
import { ensureClientForBooking, findClientByNumber, normaliseNumber, setConsent, type ClientDoc } from './clients';
import { locationsFor, practiceProfile, providerById, serviceById, type ProviderDoc, type ServiceDoc } from './practice';
import { rateLimit } from './ratelimit';
import { list, update, type Doc } from './db';
import { audit } from './audit';

export type OrgRow = Doc & { name?: string; slug?: string };

const DEFAULT_BOOKING_SETTINGS = {
  /** Booking through the page is on when a workspace exists; a spam wave turns it off. */
  enabled: true,
  /** How many appointments one number may make in the window below. */
  maxPerNumber: 5,
  windowDays: 30,
  /** What the page says about who it is booking with. */
  showProviders: true,
};

export type BookingSettings = typeof DEFAULT_BOOKING_SETTINGS;

export function orgBySlug(slug: string): OrgRow | undefined {
  const wanted = slug.trim().toLowerCase();
  if (!wanted) return undefined;
  return list<OrgRow>('orgs', (org) => String(org.slug ?? '').toLowerCase() === wanted)[0];
}

export function bookingSettings(org: OrgRow): BookingSettings {
  const stored = (org as { booking?: Partial<BookingSettings> }).booking ?? {};
  return { ...DEFAULT_BOOKING_SETTINGS, ...stored };
}

/** Staff-facing edit of those settings — used by the dashboard route. */
export function setBookingSettings(orgId: string, patch: Partial<BookingSettings>, actor: string) {
  const org = list<OrgRow>('orgs', (o) => o.id === orgId)[0];
  if (!org) return undefined;
  const next = { ...bookingSettings(org), ...patch };
  update<OrgRow>('orgs', orgId, { booking: next } as never);
  audit({ orgId, actor, action: 'booking.settings_updated', detail: Object.keys(patch).join(', ') });
  return next;
}

/* ------------------------------------------------------------- public reads */

export type PublicService = {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  price: number;
  colour: string;
  /** Who can deliver it, so the page can say before asking anyone to pick. */
  providerNames: string[];
};

export type PublicProvider = { id: string; name: string; title?: string; colour: string; locationIds: string[] };

export type PublicSite = { id: string; name: string; address?: string; timezone: string };

export function publicServices(orgId: string): PublicService[] {
  const providers = list<ProviderDoc>('providers', (p) => p.orgId === orgId && p.active);
  return list<ServiceDoc>('services', (s) => s.orgId === orgId && s.active)
    .map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      price: service.price,
      colour: service.colour,
      providerNames: providers
        .filter((p) => !p.serviceIds.length || p.serviceIds.includes(service.id))
        .map((p) => p.name),
    }))
    .filter((service) => service.providerNames.length > 0);
}

export function publicProviders(orgId: string, serviceId?: string): PublicProvider[] {
  const service = serviceId ? serviceById(orgId, serviceId) : undefined;
  return list<ProviderDoc>('providers', (p) => p.orgId === orgId && p.active)
    .filter((p) => !service || !p.serviceIds.length || p.serviceIds.includes(service.id))
    .map((p) => ({ id: p.id, name: p.name, title: p.title, colour: p.colour, locationIds: p.locationIds }));
}

export function publicSites(orgId: string): PublicSite[] {
  return locationsFor(orgId)
    .filter((l) => l.active)
    .map((l) => ({ id: l.id, name: l.name, address: l.address, timezone: l.timezone }));
}

/**
 * The one public workspace lookup, by slug.
 *
 * A booking page that answers differently for "no such workspace" and "booking
 * is off" is a page that tells a stranger which slugs exist. It says the same
 * thing to both.
 */
export function publicWorkspace(slug: string): { org: OrgRow; settings: BookingSettings; notice?: string } | undefined {
  const org = orgBySlug(slug);
  if (!org) return undefined;
  const settings = bookingSettings(org);
  return {
    org,
    settings,
    notice: settings.enabled ? undefined : 'Online booking is switched off for this workspace. Please call instead.',
  };
}

/* ---------------------------------------------------------- public booking */

export type PublicBookingInput = {
  slug: string;
  startsAt: string;
  serviceId: string;
  providerId?: string;
  locationId?: string;
  name: string;
  number: string;
  email?: string;
  notes?: string;
  /** The box under the form. Optional, but the record is honest either way. */
  consentSms?: boolean;
  consentEmail?: boolean;
  ip: string;
};

export type PublicBookingResult =
  | { ok: true; booking: BookingDoc; client: ClientDoc; reference: string; termPack: string }
  /**
   * `code` decides the HTTP status (the route maps it) — carrying a separate
   * number here invited the two to disagree, and one already did.
   */
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'RATE_LIMITED' | 'FORBIDDEN' | 'SCHEDULE_UNAVAILABLE'; message: string; param?: string };

const emailLooksReal = (value: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value);

export async function bookFromPublicPage(input: PublicBookingInput): Promise<PublicBookingResult> {
  const org = orgBySlug(input.slug);
  if (!org) return { ok: false, code: 'NOT_FOUND', message: 'That booking page does not exist.' };
  const settings = bookingSettings(org);
  if (!settings.enabled) {
    return { ok: false, code: 'FORBIDDEN', message: 'Online booking is switched off for this workspace. Please call instead.' };
  }

  // Rate limits, in this order: by address first (one person cannot fill the
  // diary), then by number (one phone cannot have a hundred appointments).
  const byIp = rateLimit(`pub-book:ip:${input.ip}`, 20, 10 * 60_000);
  if (!byIp.allowed) {
    return { ok: false, code: 'RATE_LIMITED', message: 'Too many booking attempts from this connection. Try again in a few minutes.' };
  }

  const name = String(input.name ?? '').trim();
  const number = normaliseNumber(String(input.number ?? ''));
  const email = String(input.email ?? '').trim();
  if (name.length < 2) return { ok: false, code: 'VALIDATION_ERROR', message: 'Please give a name we can call you by.', param: 'name' };
  if (number.replace(/\D/g, '').length < 7) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'That phone number does not look complete.', param: 'number' };
  }
  if (email && !emailLooksReal(email)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'That email address does not look complete.', param: 'email' };
  }
  const startsAt = String(input.startsAt ?? '').trim();
  const startMs = new Date(startsAt).getTime();
  if (!startsAt || Number.isNaN(startMs)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Pick a time from the list.', param: 'startsAt' };
  }
  if (startMs < Date.now()) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'That time has already passed. Pick another.', param: 'startsAt' };
  }

  const service = serviceById(org.id, String(input.serviceId ?? ''));
  if (!service || !service.active) {
    return { ok: false, code: 'NOT_FOUND', message: 'That service is not available.', param: 'serviceId' };
  }
  const provider = input.providerId ? providerById(org.id, input.providerId) : undefined;
  if (input.providerId && (!provider || !provider.active)) {
    return { ok: false, code: 'NOT_FOUND', message: 'That provider is not available.', param: 'providerId' };
  }
  // A provider who does not deliver this service is a 404 rather than a quiet
  // fallback: silently booking somebody else is how a person ends up with the
  // wrong practitioner.
  if (provider && provider.serviceIds.length && !provider.serviceIds.includes(service.id)) {
    return { ok: false, code: 'NOT_FOUND', message: 'That provider does not offer this service.', param: 'providerId' };
  }

  /**
   * Who is free at that time.
   *
   * Without a named provider the page offers "first available", so the server
   * picks from the people who actually deliver the service — and only then
   * checks whether the slot is free for them.
   */
  const candidates = provider ? [provider] : publicProviders(org.id, service.id).map((p) => providerById(org.id, p.id)!).filter(Boolean);
  const gateway = scheduleGatewayFor(org.id);
  let free: ProviderDoc | undefined;
  try {
    for (const candidate of candidates) {
      const verdict = await gateway.isFree({
        providerId: candidate.id,
        startsAt: new Date(startMs).toISOString(),
        durationMinutes: service.durationMinutes,
        serviceId: service.id,
        locationId: input.locationId,
      }, { origin: 'public', idempotencyKey: `availability:${org.id}:${candidate.id}:${startMs}` });
      if (verdict.free) {
        free = candidate;
        break;
      }
    }
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { ok: false, code: 'SCHEDULE_UNAVAILABLE', message: 'That appointment time could not be checked. Please call the practice; no appointment has been made.', param: 'startsAt' };
    }
    throw error;
  }
  if (!free) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: 'That time was taken while you were filling the form. Pick another slot and it will go through.',
      param: 'startsAt',
    };
  }

  const alreadyOnFile = Boolean(findClientByNumber(org.id, number));
  const existingClient = ensureClientForBooking(org.id, { name, number, email: email || undefined }, 'online-booking', { source: 'online' });

  /**
   * Consent is what the person ticked, read in context.
   *
   * A tick records permission. A blank box means different things depending on who
   * is filling the form in:
   *
   *  - **A record already on file** — they agreed to texts on the phone last week.
   *    A blank box on a web form must not silently revoke that, or their reminder
   *    never arrives and their record says "opted out" when nobody opted out.
   *  - **A new record** — nobody has been asked before, so a blank box is the
   *    answer: no consent on that channel, recorded as such, so the send path can
   *    say why rather than guessing.
   */
  const record = (channel: 'sms' | 'email', ticked: boolean, hadAddress: boolean) => {
    if (ticked) {
      setConsent(org.id, existingClient.id, channel, true, { source: 'online-booking', note: 'ticked on the booking form', actor: 'online-booking' });
      return;
    }
    if (alreadyOnFile || !hadAddress) return;
    setConsent(org.id, existingClient.id, channel, false, { source: 'online-booking-form', note: 'not ticked on the booking form', actor: 'online-booking' });
  };
  record('sms', Boolean(input.consentSms), true);
  record('email', Boolean(input.consentEmail), Boolean(email));

  const count = list<Doc & { orgId?: string; customer?: { number?: string }; startsAt?: string }>(
    'bookings',
    (b) =>
      b.orgId === org.id &&
      normaliseNumber(String(b.customer?.number ?? '')) === number &&
      new Date(String(b.startsAt ?? 0)).getTime() > Date.now() - settings.windowDays * 86_400_000
  ).length;
  if (count >= settings.maxPerNumber) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: `This number already has ${count} bookings in the next ${settings.windowDays} days. Please call us to change them.`,
      param: 'number',
    };
  }

  const bookingKey = stableHash([org.id, existingClient.id, service.id, free.id, input.locationId ?? '', new Date(startMs).toISOString()]);
  try {
    const result = await gateway.createAppointment({
      externalId: `WEB-${bookingKey.slice(0, 16).toUpperCase()}`,
      customer: { name, number, email: email || undefined },
      service: service.name,
      startsAt: new Date(startMs).toISOString(),
      durationMinutes: service.durationMinutes,
      status: 'confirmed',
      notes: input.notes?.slice(0, 500),
      value: service.price,
      providerId: free.id,
      serviceId: service.id,
      locationId: input.locationId,
      source: 'online',
      clientId: existingClient.id,
    }, {
      origin: 'public',
      actor: 'online-booking',
      idempotencyKey: `public-booking:${bookingKey}`,
    });
    return {
      ok: true,
      booking: result.booking,
      client: existingClient,
      reference: result.booking.externalId,
      termPack: practiceProfile(org.id).termPack,
    };
  } catch (error) {
    if (error instanceof ScheduleError) {
      const unavailable = !['SLOT_TAKEN', 'CONFLICT'].includes(error.code);
      return {
        ok: false,
        code: unavailable ? 'SCHEDULE_UNAVAILABLE' : 'CONFLICT',
        message: unavailable
          ? 'The appointment could not be saved. Please call the practice; no booking confirmation has been issued.'
          : 'That time is no longer available. Pick another slot.',
        param: 'startsAt',
      };
    }
    throw error;
  }
}
