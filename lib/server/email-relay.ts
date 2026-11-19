export type EmailProvider = 'relay' | 'resend';
export type EmailRelayResult = { ok: true; id?: string } | { ok: false; reason: string };

export function configuredEmailProvider(): EmailProvider {
  return process.env.VOXERA_EMAIL_PROVIDER?.trim().toLowerCase() === 'resend' ? 'resend' : 'relay';
}

export function emailRelayAvailable() {
  return Boolean(process.env.VOXERA_EMAIL_API_BASE?.trim());
}

function tagPart(value: unknown) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 256);
}

/**
 * Deliver one plain-text transactional message through the configured HTTP API.
 *
 * `relay` preserves Voxera's documented generic contract, including `metadata`.
 * Resend uses the same POST /emails endpoint and Bearer authentication but does
 * not accept that generic field, so metadata is translated into provider-native
 * tags and uses the durable queue message id as Resend's idempotency key. Keeping
 * this adapter explicit prevents a stub-shaped payload from being mistaken for
 * evidence that a real provider will accept it.
 */
export async function sendRelayEmail(input: {
  to: string;
  subject: string;
  text: string;
  metadata?: Record<string, string>;
}): Promise<EmailRelayResult> {
  const base = process.env.VOXERA_EMAIL_API_BASE?.trim().replace(/\/$/, '');
  if (!base) return { ok: false, reason: 'no email relay configured (set VOXERA_EMAIL_API_BASE)' };

  const provider = configuredEmailProvider();
  const metadata = input.metadata ?? {};
  const resendIdempotencyKey = provider === 'resend' && metadata.messageId
    ? `voxera-message/${metadata.messageId}`.slice(0, 256)
    : undefined;
  const body =
    provider === 'resend'
      ? {
          from: process.env.VOXERA_EMAIL_FROM ?? 'no-reply@voxera.email',
          to: input.to,
          subject: input.subject,
          text: input.text,
          tags: Object.entries(metadata)
            .map(([name, value]) => ({ name: tagPart(name), value: tagPart(value) }))
            .filter((tag) => tag.name && tag.value),
        }
      : {
          from: process.env.VOXERA_EMAIL_FROM ?? 'no-reply@voxera.email',
          to: input.to,
          subject: input.subject,
          text: input.text,
          metadata,
        };

  try {
    const response = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.VOXERA_EMAIL_API_KEY ? { authorization: `Bearer ${process.env.VOXERA_EMAIL_API_KEY}` } : {}),
        ...(resendIdempotencyKey ? { 'idempotency-key': resendIdempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // A non-JSON error is still an upstream refusal, not an unreachable relay.
    }
    if (!response.ok) {
      const reason = typeof json.message === 'string' ? json.message : `email provider returned ${response.status}`;
      return { ok: false, reason };
    }
    return { ok: true, id: typeof json.id === 'string' ? json.id : undefined };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? `email provider unreachable: ${error.message}` : 'email provider unreachable' };
  }
}
