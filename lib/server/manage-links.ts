/**
 * The client link's plumbing, in a module that imports nothing of ours.
 *
 * Both the calendar's messages and the self-service page need to build and check
 * these links, and one of those two also queues texts — so if the link helpers
 * lived beside the page's actions there would be a cycle between the two files.
 * They live here instead: crypto and the database, nothing else, importable from
 * anywhere without dragging a graph along.
 */

import crypto from 'node:crypto';
import { list, update as updateDoc, type Doc } from './db';

/**
 * What signs a client's own link.
 *
 * This was `process.env.VOXERA_MEDIA_SECRET ?? 'voxera-unsafe-default-secret'` —
 * a constant, in the source, named unsafe by whoever wrote it. A manage token is
 * `bookingId.signature`, so anyone with the constant can mint a valid link for any
 * appointment id they can guess or observe, and that link can confirm, move or
 * cancel somebody's visit. The production pass found it; the gates could not,
 * because they ran with the variable set and never exercised the fallback.
 *
 * The order below is stable-first on purpose: a link lives in a text message and
 * must still work after a deploy, so a shared, configured secret is preferred —
 * and only when none is configured does production fall back to a per-process
 * random value, which is unguessable but *does* invalidate links on restart. That
 * trade-off is logged loudly rather than made silently.
 */
let ephemeralLinkSecret: string | undefined;
function linkSecret(): string {
  const dedicated = process.env.VOXERA_MANAGE_SECRET?.trim();
  if (dedicated) return dedicated;
  const media = process.env.VOXERA_MEDIA_SECRET?.trim();
  if (media) return media;
  const master = process.env.VOXERA_SECRET_KEY?.trim();
  if (master) return crypto.createHash('sha256').update(`manage:${master}`).digest('hex');
  if (process.env.NODE_ENV === 'production') {
    if (!ephemeralLinkSecret) {
      ephemeralLinkSecret = crypto.randomBytes(32).toString('hex');
      console.error(
        '[links] no VOXERA_MANAGE_SECRET, VOXERA_MEDIA_SECRET or VOXERA_SECRET_KEY — ' +
          'client links are signed with a per-process key and will stop working on restart. Set one.'
      );
    }
    return ephemeralLinkSecret;
  }
  return 'voxera-unsafe-default-secret';
}

/** A short, stable, unguessable handle for one appointment. */
export function manageToken(bookingId: string): string {
  const mac = crypto.createHmac('sha256', linkSecret()).update(`manage:${bookingId}`).digest('base64url');
  return `${bookingId.replace(/^bkg_/, '')}.${mac.slice(0, 22)}`;
}

/** The part of a token that names the appointment, without its signature. */
export function tokenHandle(token: string): string {
  return String(token ?? '').split('.')[0] ?? '';
}

/** Whether a presented signature is the one this deployment would have minted. */
export function signatureMatches(bookingId: string, token: string): boolean {
  const expected = manageToken(bookingId).split('.')[1] ?? '';
  const given = String(token ?? '').split('.')[1] ?? '';
  // Constant-time, and the length is compared first so `timingSafeEqual` cannot throw.
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function manageUrl(origin: string, bookingId: string): string {
  return `${origin}/m/${manageToken(bookingId)}`;
}

/**
 * Where this workspace lives, for a link that has to survive an SMS.
 *
 * A message is queued by a scheduler with no request in sight, so there is no
 * `Host` header to read and no visitor to ask. The order is: the deployment's own
 * `VOXERA_PUBLIC_URL` if it is set, then the origin the workspace was last seen
 * at (recorded on bootstrap and whenever its public pages are served), then
 * nothing — and "nothing" means the link is left out of the text rather than
 * printed as a broken relative path in somebody's inbox.
 */
export function publicBaseUrl(orgId?: string): string {
  const configured = process.env.VOXERA_PUBLIC_URL?.replace(/\/$/, '');
  if (configured) return configured;
  if (!orgId) return '';
  const org = list<Doc & { publicOrigin?: string }>('orgs', (o) => o.id === orgId)[0];
  return String(org?.publicOrigin ?? '').replace(/\/$/, '');
}

/** Remembers where a workspace was reached from, so later texts can link back. */
export function rememberOrigin(orgId: string, origin: string) {
  const clean = String(origin ?? '').replace(/\/$/, '');
  if (!clean || !/^https?:\/\//.test(clean)) return;
  const org = list<Doc & { publicOrigin?: string }>('orgs', (o) => o.id === orgId)[0];
  if (!org || org.publicOrigin === clean) return;
  updateDoc('orgs', org.id, { publicOrigin: clean });
}

/**
 * The client's own link for one appointment — or nothing.
 *
 * "Nothing" is a real answer: a deployment that does not know its own public
 * address sends a text without the line rather than a broken one, and every
 * caller treats the absence the same way.
 */
export function manageLinkFor(orgId: string, bookingId: string): string | undefined {
  const base = publicBaseUrl(orgId);
  return base ? manageUrl(base, bookingId) : undefined;
}

/* ------------------------------------------------- the freed-slot offer link */

/**
 * The link that offers one freed slot to one person on the wait list.
 *
 * A different HMAC domain on purpose (`offer:` rather than `manage:`), so a link
 * texted for a cancelled appointment can never be presented as an offer, or the
 * other way round. If that were possible, a client holding yesterday's reminder
 * would be able to lift a slot they were never offered.
 */
export function offerToken(offerId: string): string {
  const mac = crypto.createHmac('sha256', linkSecret()).update(`offer:${offerId}`).digest('base64url');
  return `${offerId}.${mac.slice(0, 22)}`;
}

export function offerUrl(origin: string, offerId: string): string {
  return `${origin}/offer/${offerToken(offerId)}`;
}

/** The offer id a token names — or `undefined` when the signature is not ours. */
export function offerIdFromToken(token: string): string | undefined {
  const raw = String(token ?? '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const id = raw.slice(0, dot);
  const given = raw.slice(dot + 1);
  const expected = offerToken(id).slice(id.length + 1);
  if (!id || given.length !== expected.length) return undefined;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? id : undefined;
}

/** The offer link for a text or an email, or nothing when the base is unknown. */
export function offerLinkFor(orgId: string, offerId: string): string | undefined {
  const base = publicBaseUrl(orgId);
  return base ? offerUrl(base, offerId) : undefined;
}
