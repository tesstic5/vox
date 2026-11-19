/**
 * Webhook delivery.
 *
 * When a call ends (or an assistant is published) the event is POSTed for real,
 * with the signature header the docs describe, exponential backoff on failure,
 * and every attempt written to `webhookDeliveries` so the dashboard can show
 * what happened instead of claiming it worked.
 *
 * Delivery is fire-and-forget: the response to the API caller is not held open
 * waiting on someone else's endpoint.
 */

import crypto from 'node:crypto';
import { find, insert, list, listBy, newId, nowIso, update, type Doc } from './db';
import { safeFetch, UrlBlockedError } from './net';
import { openSecret, sealSecret, type Sealed } from './secrets';

export type WebhookSubscription = Doc & {
  orgId: string;
  url: string;
  events: string[];
  /** Legacy plaintext value; startup migration seals and clears it. */
  secret?: string;
  secretSealed?: Sealed;
  active: boolean;
  createdAt: string;
};

export type WebhookDelivery = Doc & {
  orgId: string;
  subscriptionId?: string;
  url: string;
  event: string;
  attempts: { at: string; status: number | null; error?: string; ms: number }[];
  status: 'delivered' | 'failed' | 'retrying';
  payload: unknown;
  at: string;
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 500, 2000];

function sign(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function webhookSecret(subscription: WebhookSubscription): string | undefined {
  return subscription.secretSealed ? openSecret(subscription.secretSealed) : subscription.secret;
}

export function sealWebhookSecret(secret: string): Sealed {
  return sealSecret(secret);
}

export function publicWebhook(subscription: WebhookSubscription) {
  const { secret: _legacySecret, secretSealed: _secretSealed, ...safe } = subscription;
  return { ...safe, hasSecret: Boolean(webhookSecret(subscription)) };
}

export function normalizeLegacyWebhookSecrets() {
  let migrated = 0;
  for (const subscription of list<WebhookSubscription>('webhooks')) {
    if (!subscription.secret || subscription.secretSealed) continue;
    update<WebhookSubscription>('webhooks', subscription.id, {
      secret: undefined,
      secretSealed: sealSecret(subscription.secret),
    });
    migrated += 1;
  }
  return { migrated };
}

export function subscriptionsFor(orgId: string, event: string) {
  return list<WebhookSubscription>('webhooks', (w) => w.orgId === orgId && w.active !== false).filter((w) =>
    (w.events ?? []).includes(event) || (w.events ?? []).includes('*')
  );
}

export async function deliverWebhook(input: { orgId: string; event: string; payload: unknown; subscriptionId?: string }) {
  const subs = subscriptionsFor(input.orgId, input.event).filter(
    (subscription) => !input.subscriptionId || subscription.id === input.subscriptionId
  );

  if (!subs.length) return [];

  const results: WebhookDelivery[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      const signingSecret = webhookSecret(sub);
      const delivery = insert<WebhookDelivery>('webhookDeliveries', {
        id: newId('whd_'),
        orgId: input.orgId,
        subscriptionId: sub.id,
        url: sub.url,
        event: input.event,
        attempts: [],
        status: 'retrying',
        payload: input.payload,
        at: nowIso(),
      } as WebhookDelivery);

      const body = JSON.stringify({ ...(input.payload as object), deliveryId: delivery.id, at: nowIso() });
      if ((sub.secret || sub.secretSealed) && !signingSecret) {
        delivery.status = 'failed';
        delivery.attempts.push({ at: nowIso(), status: null, error: 'stored signing secret could not be decrypted', ms: 0 });
        update<WebhookDelivery>('webhookDeliveries', delivery.id, { attempts: delivery.attempts, status: delivery.status });
        results.push(delivery);
        return;
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        const started = Date.now();
        try {
          // Every hop is checked against the outbound URL policy, so a redirect
          // into the private network cannot smuggle a request past the check.
          const { response: res } = await safeFetch(sub.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-voxera-event': input.event,
              'x-voxera-delivery': delivery.id,
              ...(signingSecret ? { 'x-voxera-signature': `sha256=${sign(signingSecret, body)}` } : {}),
            },
            body,
            signal: AbortSignal.timeout(6000),
          });
          delivery.attempts.push({ at: nowIso(), status: res.status, ms: Date.now() - started });
          if (res.status < 400) {
            delivery.status = 'delivered';
            break;
          }
          if (res.status < 500) {
            // 4xx means the receiver rejected the payload: retrying will not help.
            delivery.status = 'failed';
            delivery.attempts[delivery.attempts.length - 1].error = `receiver returned ${res.status}`;
            break;
          }
        } catch (err) {
          const blocked = err instanceof UrlBlockedError;
          delivery.attempts.push({
            at: nowIso(),
            status: null,
            error: blocked ? `blocked by URL policy: ${err.reason}` : err instanceof Error ? err.message : 'network error',
            ms: Date.now() - started,
          });
          // A policy block is not a transient network failure: retrying the same
          // private address will never succeed, so stop after the first attempt
          // and leave a reason a customer can act on.
          if (blocked) {
            delivery.status = 'failed';
            break;
          }
        }
        if (attempt === MAX_ATTEMPTS - 1) delivery.status = 'failed';
      }

      update<WebhookDelivery>('webhookDeliveries', delivery.id, {
        attempts: delivery.attempts,
        status: delivery.status,
      });
      results.push(delivery);
    })
  );

  return results;
}

export function deliveriesFor(orgId: string, limit = 25) {
  return listBy<WebhookDelivery>('webhookDeliveries', { orgId }, { limit });
}

export function redeliver(orgId: string, deliveryId: string) {
  const delivery = find<WebhookDelivery>('webhookDeliveries', (d) => d.id === deliveryId && d.orgId === orgId);
  if (!delivery?.subscriptionId) return undefined;
  const subscription = find<WebhookSubscription>(
    'webhooks',
    (row) => row.id === delivery.subscriptionId && row.orgId === orgId && row.active !== false
  );
  if (!subscription) return undefined;
  return deliverWebhook({ orgId, event: delivery.event, payload: delivery.payload, subscriptionId: subscription.id });
}
