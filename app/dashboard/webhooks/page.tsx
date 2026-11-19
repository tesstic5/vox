'use client';

/**
 * Webhooks — the delivery log, straight from the server.
 *
 * Endpoints created here are real subscriptions: ending a call fires a signed
 * POST to them with retries and backoff, and every attempt is recorded. Nothing
 * on this page is mocked — the deliveries you see are the requests the platform
 * actually made.
 */

import * as React from 'react';
import { PageHeader } from '@/components/dash/Shell';
import { Icons } from '@/components/icons';
import { Button, CopyButton, Pill, useToast, Modal } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';

type Subscription = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  hasSecret?: boolean;
};

/** One try at delivering an event, as the server records it. */
type Attempt = { at?: string; status?: number | null; error?: string; ms?: number };

type Delivery = {
  id: string;
  subscriptionId?: string;
  event: string;
  url: string;
  status: string;
  /** The server stores the tries themselves; older rows carry just a count. */
  attempts: number | Attempt[];
  statusCode?: number;
  error?: string;
  at: string;
  durationMs?: number;
};

const attemptCount = (d: Delivery) => (Array.isArray(d.attempts) ? d.attempts.length : d.attempts);
/** Why the last try did not land — the useful half of a failed delivery. */
const attemptReason = (d: Delivery) =>
  Array.isArray(d.attempts) ? d.attempts[d.attempts.length - 1]?.error ?? d.error ?? null : d.error ?? null;

const EVENTS = [
  'call.ended',
  'assistant.updated',
  'booking.confirmed',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.declined',
  'booking.no_answer',
  'booking.voicemail',
  'booking.failed',
  'appointment.moved',
  'appointment.confirmed',
  'appointment.arrived',
  'appointment.completed',
  'appointment.cancelled',
  'appointment.no_show',
];

export default function WebhooksPage() {
  const toast = useToast();
  const [subs, setSubs] = React.useState<Subscription[]>([]);
  const [deliveries, setDeliveries] = React.useState<Delivery[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [url, setUrl] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>(['call.ended']);
  const [createdSecret, setCreatedSecret] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [busyWebhook, setBusyWebhook] = React.useState<string | null>(null);

  const closeCreator = () => {
    setCreating(false);
    setCreatedSecret('');
    setUrl('');
    setSelected(['call.ended']);
  };

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/v1/webhooks', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Could not load webhook endpoints.');
      }
      const json = (await res.json()) as { subscriptions?: Subscription[]; deliveries?: Delivery[] };
      setSubs(json.subscriptions ?? []);
      setDeliveries(json.deliveries ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load webhook endpoints.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!/^https?:\/\//.test(url) || !selected.length) return;
    setBusy(true);
    try {
      const res = await fetch('/api/v1/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ url, events: selected }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Could not create the endpoint.');
      toast(`Endpoint saved — ${json.events.length} events subscribed.`);
      setCreatedSecret(String(json.signingSecret ?? ''));
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the endpoint.');
    } finally {
      setBusy(false);
    }
  };

  const redeliver = async (id: string) => {
    const res = await fetch('/api/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ redeliverId: id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(json?.error?.message ?? 'Redelivery failed.');
      return;
    }
    toast('Redelivery attempted — the result is in the log.');
    await load();
  };

  const setActive = async (subscription: Subscription, active: boolean) => {
    setBusyWebhook(subscription.id);
    try {
      const res = await fetch('/api/v1/webhooks', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: subscription.id, active }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? 'Could not update the endpoint.');
      toast(active ? 'Endpoint resumed.' : 'Endpoint paused.');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the endpoint.');
    } finally {
      setBusyWebhook(null);
    }
  };

  const deleteEndpoint = async (subscription: Subscription) => {
    if (!window.confirm(`Delete webhook endpoint ${subscription.url}? Delivery history will be kept.`)) return;
    setBusyWebhook(subscription.id);
    try {
      const res = await fetch('/api/v1/webhooks', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: subscription.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? 'Could not delete the endpoint.');
      toast('Endpoint deleted. Delivery history was kept.');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the endpoint.');
    } finally {
      setBusyWebhook(null);
    }
  };

  const delivered = deliveries.filter((d) => d.status === 'delivered').length;
  const failed = deliveries.filter((d) => d.status !== 'delivered').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        desc="Every event the platform emits, signed with HMAC-SHA256 and retried with backoff. Deliveries below are real requests, not samples."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <Icons.refresh size={13} /> Refresh
            </Button>
            <Button variant="brand" size="sm" onClick={() => setCreating(true)}>
              <Icons.plus size={14} /> New endpoint
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { l: 'Endpoints', v: String(subs.length), s: `${subs.filter((x) => x.active).length} active` },
          { l: 'Delivered', v: String(delivered), s: 'last 20 attempts' },
          { l: 'Retrying or failed', v: String(failed), s: '4xx responses are not retried' },
        ].map((k) => (
          <div key={k.l} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">{k.l}</div>
            <div className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-slate-900">{k.v}</div>
            <div className="mt-1 text-[12px] text-slateink-400">{k.s}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-5">
          <div className="text-[14px] font-medium text-slate-900">No connection to the API</div>
          <p className="mt-1.5 text-[13px] text-slateink-300">
            {error} — sign in on a deployment with the server layer running to manage endpoints here.
          </p>
        </div>
      )}

      <div className="panel overflow-hidden">
        <div className="border-b border-slate-900/[0.04] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-slate-900">Endpoints</h2>
          <p className="mt-1 text-[12.5px] text-slateink-400">
            Voxera POSTs a JSON body with an <span className="font-mono text-slateink-300">x-voxera-signature</span> header.
            Verify it against the endpoint secret before trusting the payload.
          </p>
        </div>
        {loading ? (
          <div className="px-5 py-8 font-mono text-[11.5px] text-slateink-400">loading endpoints…</div>
        ) : subs.length === 0 ? (
          <div className="px-5 py-8 text-[13px] text-slateink-400">
            No endpoints yet. Add one and the next call you end will hit it within a second.
          </div>
        ) : (
          <div className="divide-y divide-slate-900/[0.03]">
            {subs.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl border border-brand-500/20 bg-brand-500/[0.07] text-brand-700">
                  <Icons.globe size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-slate-900">{s.url}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {s.events.map((e) => (
                      <span key={e} className="rounded-full border border-slate-900/[0.035] px-2 py-0.5 font-mono text-[9.5px] text-slateink-300">
                        {e}
                      </span>
                    ))}
                  </div>
                </div>
                <Pill tone={s.active ? 'brand' : 'default'}>{s.active ? 'active' : 'paused'}</Pill>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busyWebhook === s.id}
                    onClick={() => void setActive(s, !s.active)}
                    aria-label={`${s.active ? 'Pause' : 'Resume'} webhook ${s.url}`}
                  >
                    {busyWebhook === s.id ? 'Saving…' : s.active ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busyWebhook === s.id}
                    onClick={() => void deleteEndpoint(s)}
                    aria-label={`Delete webhook ${s.url}`}
                  >
                    Delete
                  </Button>
                </div>
                <span className="font-mono text-[10.5px] text-slateink-400"><Ago at={s.createdAt} /></span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel overflow-hidden">
        <div className="border-b border-slate-900/[0.04] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-slate-900">Recent deliveries</h2>
          <p className="mt-1 text-[12.5px] text-slateink-400">
            Three attempts with exponential backoff. A 4xx means your endpoint rejected the event, so it is not retried.
          </p>
        </div>
        {deliveries.length === 0 ? (
          <div className="px-5 py-8 text-[13px] text-slateink-400">
            Nothing delivered yet. End a call — or use the test call widget — and it will appear here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-slate-900/[0.04] font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">
                  <th className="px-5 py-3">Event</th>
                  <th className="px-3 py-3">Endpoint</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Attempts</th>
                  <th className="px-3 py-3">When</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/[0.03]">
                {deliveries.map((d) => (
                  <tr key={d.id} className="text-[12.5px]">
                    <td className="px-5 py-3 font-mono text-slate-900">{d.event}</td>
                    <td className="max-w-[240px] truncate px-3 py-3 font-mono text-slateink-300">{d.url}</td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 font-mono text-[10px]',
                          d.status === 'delivered'
                            ? 'border-brand-500/25 bg-brand-500/[0.08] text-brand-700'
                            : d.status === 'failed'
                              ? 'border-red-500/25 bg-red-500/[0.08] text-red-700'
                              : 'border-amber-500/25 bg-amber-500/[0.08] text-amber-800'
                        )}
                      >
                        {d.status}
                        {d.statusCode ? ` · ${d.statusCode}` : ''}
                      </span>
                      {attemptReason(d) && (
                        <div className="mt-1 max-w-[220px] truncate font-mono text-[10px] text-amber-800" title={attemptReason(d) ?? undefined}>
                          {attemptReason(d)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-slateink-300">{attemptCount(d)}</td>
                    <td className="px-3 py-3 text-slateink-400"><Ago at={d.at} /></td>
                    <td className="px-5 py-3 text-right">
                      <Button variant="quiet" size="sm" onClick={() => void redeliver(d.id)}>
                        <Icons.refresh size={12} /> Redeliver
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-5">
        <h2 className="text-[15px] font-semibold text-slate-900">Verifying a signature</h2>
        <p className="mt-1.5 text-[13px] text-slateink-400">
          The header is <span className="font-mono text-slateink-300">sha256=&lt;hex&gt;</span> over the raw request body,
          keyed with the endpoint secret. Compute it before parsing.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-slate-900/[0.045] bg-ink-950/70 p-4 font-mono text-[11.5px] leading-relaxed text-slateink-200">
{`import crypto from 'node:crypto';

const expected = 'sha256=' + crypto
  .createHmac('sha256', process.env.VOXERA_WEBHOOK_SECRET)
  .update(rawBody)            // the raw string, before JSON.parse
  .digest('hex');

const valid = crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(req.headers['x-voxera-signature'])
);`}
        </pre>
      </div>

      <Modal
        open={creating}
        onClose={closeCreator}
        title={createdSecret ? 'Save the signing secret' : 'New webhook endpoint'}
        desc={createdSecret ? 'This value is shown once and cannot be retrieved later.' : 'It starts receiving selected events as soon as you save.'}
        footer={
          <div className="flex w-full justify-end gap-2">
            {createdSecret ? (
              <Button variant="brand" size="sm" onClick={closeCreator}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={closeCreator}>Cancel</Button>
                <Button variant="brand" size="sm" onClick={() => void create()} disabled={busy || !/^https?:\/\//.test(url) || !selected.length}>
                  {busy ? <Icons.refresh size={13} className="animate-spin" /> : <Icons.plus size={13} />} Create endpoint
                </Button>
              </>
            )}
          </div>
        }
      >
        {createdSecret ? (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
            <p className="text-[12.5px] leading-relaxed text-amber-900">Store this in your receiver's secret manager before closing.</p>
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-white/70 px-3 py-2 font-mono text-[12px] text-slate-900">{createdSecret}</code>
              <CopyButton value={createdSecret} />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">Endpoint URL</label>
              <input
                className="field font-mono text-[12.5px]"
                placeholder="https://api.yourcompany.com/voxera/events"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Events</label>
              <div className="mt-1 max-h-72 space-y-2 overflow-y-auto pr-1">
                {EVENTS.map((e) => (
                  <label key={e} className="flex items-center gap-3 rounded-xl border border-slate-900/[0.045] px-3.5 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.includes(e)}
                      onChange={() => setSelected((s) => (s.includes(e) ? s.filter((x) => x !== e) : [...s, e]))}
                    />
                    <span className="font-mono text-[12px] text-slateink-200">{e}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
