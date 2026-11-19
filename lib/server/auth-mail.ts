/**
 * Transactional mail for the auth flows — reset links, magic links,
 * verification codes, invitations.
 *
 * This is deliberately *not* the messaging pipeline. `messages` is the record of
 * what a practice told a client, and it shows up in the dashboard's inbox with
 * delivery status, templates and quiet hours. A password reset is operational
 * mail about the platform itself, sent to a member of staff, and must never
 * appear in a client's conversation history — so it goes out on its own path
 * with its own function.
 *
 * It reuses the same provider configuration (`VOXERA_EMAIL_PROVIDER`,
 * `VOXERA_EMAIL_API_BASE`, `VOXERA_EMAIL_API_KEY`, `VOXERA_EMAIL_FROM`) because that is the one channel a
 * deployment has already proved it can send through.
 *
 * **No relay, no pretending.** When nothing is configured, the send fails and
 * says so, and the calling route answers 503. The alternative — reporting
 * success while the mail goes nowhere — is exactly the theatre this work
 * removed: a reset screen that says "check your inbox" when no inbox will ever
 * receive anything.
 */

import { emailRelayAvailable, sendRelayEmail, type EmailRelayResult } from './email-relay';

export function emailRelayConfigured() {
  return emailRelayAvailable();
}

export type MailResult = EmailRelayResult;

export async function sendAuthEmail(input: { to: string; subject: string; text: string }): Promise<MailResult> {
  if (!emailRelayAvailable()) {
    console.warn(`[auth-mail] no relay configured (VOXERA_EMAIL_API_BASE) — "${input.subject}" to ${input.to} was NOT sent`);
  }
  return sendRelayEmail({ ...input, metadata: { kind: 'auth' } });
}

/**
 * The origin to put in a link.
 *
 * `VOXERA_PUBLIC_URL` wins because a deployment behind a proxy knows its own
 * public name better than the request does; otherwise the request's origin is
 * used, which is correct for the sandbox and for a plain server on a LAN.
 */
export function publicBase(reqOrigin: string) {
  const configured = process.env.VOXERA_PUBLIC_URL?.replace(/\/$/, '');
  return configured || reqOrigin.replace(/\/$/, '');
}
