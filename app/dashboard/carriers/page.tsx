'use client';

/**
 * Carriers.
 *
 * This page is where telephony becomes real: connect a carrier account, verify
 * the credentials against the carrier itself, buy a number (which arrives already
 * wired to an assistant), adopt a number you already own, and see whether the
 * raw-audio pipeline is ready on this deployment.
 *
 * Everything here talks to the authenticated `/api/v1/carriers*` routes. Those
 * routes require a signed-in workspace administrator because they hold and use
 * external carrier credentials.
 */

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, CopyButton, EmptyState, Pill, Tabs, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { DataTable, StatCard, StatusDot } from '@/components/dash/bits';

type Carrier = {
  id: string;
  provider: 'twilio';
  label: string;
  accountSid: string;
  verified: boolean;
  verifiedAt?: string;
  verifiedAccountName?: string;
  balance?: string;
  capabilities?: string[];
  lastError?: string;
  numbers?: number;
};

type Available = { number: string; locality?: string; region?: string; country?: string; voice?: boolean; monthlyCost?: string | null };
type Owned = { sid: string; number: string; label?: string; locality?: string; voiceUrl?: string; adopted?: boolean };

type MediaStatus = {
  ready: boolean;
  providers: {
    transcriber: { configured: boolean; provider: string | null; detail: string };
    voice: { configured: boolean; provider: string | null; detail: string };
  };
  telephonyCredentials: boolean;
  inbound: { frameMs: number; sampleRate: number; encoding: string };
};

const PROVIDERS: { id: Carrier['provider']; label: string; hint: string; fields: { sid: string; token: string } }[] = [
  { id: 'twilio', label: 'Twilio', hint: 'Console → Account Info', fields: { sid: 'Account SID', token: 'Auth token' } },
];

export default function CarriersPage() {
  const store = useStore();
  const toast = useToast();

  const [carriers, setCarriers] = React.useState<Carrier[] | null>(null);
  const [webhookBase, setWebhookBase] = React.useState('');
  const [media, setMedia] = React.useState<MediaStatus | null>(null);
  const [error, setError] = React.useState('');
  const [needsAuth, setNeedsAuth] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [tab, setTab] = React.useState<'connect' | 'buy' | 'owned'>('connect');

  const [form, setForm] = React.useState({ provider: 'twilio' as Carrier['provider'], label: '', accountSid: '', authToken: '' });
  const [search, setSearch] = React.useState({ country: 'US', areaCode: '415', contains: '' });
  const [available, setAvailable] = React.useState<Available[] | null>(null);
  const [owned, setOwned] = React.useState<Owned[] | null>(null);
  const [activeCarrier, setActiveCarrier] = React.useState('');
  const [assignTo, setAssignTo] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const res = await request<{ data: Carrier[]; webhookBase: string }>('GET', '/api/v1/carriers');
      // Each carrier's local number count is worth showing next to it.
      const counts = await Promise.all(
        res.data.map(async (c) => {
          try {
            const detail = await request<{ numbers: unknown[] }>('GET', `/api/v1/carriers/${c.id}`);
            return [c.id, detail.numbers.length] as const;
          } catch {
            return [c.id, 0] as const;
          }
        })
      );
      const withCounts = res.data.map((c) => ({ ...c, numbers: counts.find(([id]) => id === c.id)?.[1] ?? 0 }));
      setCarriers(withCounts);
      setWebhookBase(res.webhookBase);
      setActiveCarrier((current) => current || withCounts[0]?.id || '');
      setError('');
    } catch (err) {
      setCarriers([]);
      // A signed-out or expired session is not an error state to shout about.
      if (err instanceof ApiError && err.status === 401) {
        setNeedsAuth(true);
        setError('');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load carriers');
    }
  }, []);

  React.useEffect(() => {
    void load();
    request<MediaStatus>('GET', '/api/telephony/media/status')
      .then(setMedia)
      .catch(() => setMedia(null));
  }, [load]);

  const providerMeta = PROVIDERS.find((p) => p.id === form.provider) ?? PROVIDERS[0];
  const carrier = carriers?.find((c) => c.id === activeCarrier);

  /* ------------------------------------------------------------- actions */

  const connect = async () => {
    setBusy('connect');
    setError('');
    try {
      const res = await request<Carrier & { verification: { accountName?: string; balance?: string } }>('POST', '/api/v1/carriers', {
        provider: form.provider,
        label: form.label || `${providerMeta.label} account`,
        accountSid: form.accountSid.trim(),
        authToken: form.authToken.trim(),
      });
      toast(`${providerMeta.label} connected — ${res.verification?.accountName ?? 'verified'}.`);
      setForm({ provider: form.provider, label: '', accountSid: '', authToken: '' });
      setActiveCarrier(res.id);
      setTab('buy');
      await load();
      void store.refreshFromServer();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Connect failed';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy('');
    }
  };

  const verify = async (id: string) => {
    setBusy(`verify:${id}`);
    try {
      const res = await request<{ verified: boolean; balance?: string; error?: string }>('POST', `/api/v1/carriers/${id}/verify`, {});
      toast(res.verified ? `Verified — balance ${res.balance ?? 'unknown'}.` : `Still failing: ${res.error}`, res.verified ? 'success' : 'error');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Verify failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const reconcile = async (id: string) => {
    setBusy(`reconcile:${id}`);
    try {
      const res = await request<{ atCarrier: number; inWorkspace: number; missingAtCarrier: string[]; notAdopted: string[] }>(
        'POST',
        `/api/v1/carriers/${id}`,
        {}
      );
      toast(
        res.missingAtCarrier.length || res.notAdopted.length
          ? `At carrier ${res.atCarrier}, in workspace ${res.inWorkspace}. ${res.notAdopted.length} adoptable, ${res.missingAtCarrier.length} released elsewhere.`
          : 'Carrier and workspace agree on every number.'
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Reconcile failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (c: Carrier) => {
    if (!window.confirm(`Disconnect ${c.label}? Numbers stay on the carrier and in this workspace, but outbound calls will stop until you connect a carrier again.`)) return;
    setBusy(`disconnect:${c.id}`);
    try {
      const res = await request<{ numbersKept: number }>('DELETE', `/api/v1/carriers/${c.id}`);
      toast(`Disconnected. ${res.numbersKept} number(s) kept; release them individually if you want.`);
      setActiveCarrier('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Disconnect failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const runSearch = async () => {
    if (!activeCarrier) return;
    setBusy('search');
    try {
      const q = new URLSearchParams({ mode: 'available', country: search.country, areaCode: search.areaCode });
      if (search.contains) q.set('contains', search.contains);
      const res = await request<{ data: Available[] }>('GET', `/api/v1/carriers/${activeCarrier}/numbers?${q.toString()}`);
      setAvailable(res.data);
      toast(res.data.length ? `${res.data.length} numbers available.` : 'No numbers matched — try another area code.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Search failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const loadOwned = React.useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        const res = await request<{ data: Owned[] }>('GET', `/api/v1/carriers/${id}/numbers?mode=owned`);
        setOwned(res.data);
      } catch (err) {
        setOwned([]);
        toast(err instanceof Error ? err.message : 'Could not list carrier numbers', 'error');
      }
    },
    [toast]
  );

  React.useEffect(() => {
    if (tab === 'owned' && activeCarrier) void loadOwned(activeCarrier);
  }, [tab, activeCarrier, loadOwned]);

  const buy = async (number: string) => {
    if (!activeCarrier) return;
    setBusy(`buy:${number}`);
    try {
      const res = await request<{ number: { id: string }; warning?: string }>('POST', `/api/v1/carriers/${activeCarrier}/purchase`, {
        number,
        label: assignTo ? 'Assigned line' : 'Voxera line',
        assistantId: assignTo || undefined,
      });
      toast(res.warning ? `${number} purchased — ${res.warning}` : `${number} purchased and answering with your assistant.`);
      setAvailable((list) => (list ?? []).filter((n) => n.number !== number));
      await load();
      void store.refreshFromServer();
      setTab('owned');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Purchase failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const adopt = async (n: Owned) => {
    if (!activeCarrier) return;
    setBusy(`adopt:${n.number}`);
    try {
      const res = await request<{ warning?: string }>('POST', `/api/v1/carriers/${activeCarrier}/numbers`, {
        number: n.number,
        sid: n.sid,
        label: n.label ?? 'Adopted line',
        assistantId: assignTo || undefined,
      });
      toast(res.warning ? `${n.number} adopted — ${res.warning}` : `${n.number} adopted; webhooks now point at this deployment.`);
      await loadOwned(activeCarrier);
      await load();
      void store.refreshFromServer();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Adopt failed', 'error');
    } finally {
      setBusy('');
    }
  };

  /* --------------------------------------------------------------- render */

  const assistants = store.assistants ?? [];
  const connected = carriers ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Carriers"
        desc="Connect a Twilio account. Credentials are encrypted at rest and verified on connect; number purchase, adoption and calling still require a deployment HTTPS origin and end-to-end carrier tests."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Carriers' }]}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <Icons.terminal size={13} /> Refresh
            </Button>
            <Button
              variant="brand"
              size="sm"
              onClick={() => {
                setTab('connect');
                document.getElementById('carrier-connect')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
            >
              <Icons.plus size={14} /> Connect carrier
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Carriers"
          value={String(connected.length)}
          sub={connected.filter((c) => c.verified).length + ' verified'}
          icon="server"
          tone="brand"
        />
        <StatCard
          label="Numbers on carriers"
          value={String(connected.reduce((s, c) => s + (c.numbers ?? 0), 0))}
          sub="bought or adopted through Voxera"
          icon="globe"
        />
        <StatCard
          label="Balance"
          value={connected.find((c) => c.balance)?.balance?.split(' ')[0] ?? '—'}
          sub={connected.find((c) => c.balance)?.balance?.split(' ')[1] ?? 'as reported by the carrier'}
          icon="dollar"
        />
        <StatCard
          label="Raw audio"
          value={media?.providers.transcriber.configured ? 'Ready' : 'Needs a key'}
          sub={media?.providers.transcriber.provider ? `transcriber: ${media.providers.transcriber.provider}` : 'set DEEPGRAM_API_KEY for live streaming transcription'}
          icon="bolt"
          tone={media?.ready ? 'brand' : undefined}
        />
      </div>

      {needsAuth && (
        <EmptyState
          icon="lock"
          title="Sign in to connect a carrier"
          desc="Carrier credentials belong to a workspace and can be managed only by a signed-in owner, admin or developer."
          action={
            <Link href="/login?next=/dashboard/carriers" className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-4 py-2 text-[13px] font-medium text-slate-900">
              Sign in
            </Link>
          }
        />
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-500/25 bg-red-500/[0.06] px-4 py-3 text-[13px] text-red-700">
          <Icons.shield size={15} className="mt-0.5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {connected.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {connected.map((c) => (
            <div key={c.id} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusDot status={c.verified ? 'active' : 'draft'} />
                    <h3 className="text-[15px] font-medium text-slate-900">{c.label}</h3>
                    <Pill tone={c.verified ? 'brand' : 'warn'}>{c.verified ? 'verified' : 'unverified'}</Pill>
                  </div>
                  <p className="mt-1 font-mono text-[11.5px] text-slateink-400">
                    {c.provider} · {c.accountSid} · {c.numbers ?? 0} number{(c.numbers ?? 0) === 1 ? '' : 's'}
                  </p>
                  <p className="mt-1 text-[12px] text-slateink-400">
                    {c.verifiedAccountName ? `${c.verifiedAccountName} · ` : ''}
                    {c.balance ? `balance ${c.balance} · ` : ''}
                    {c.verifiedAt ? <>checked <Ago at={c.verifiedAt} /></> : 'never verified'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => void verify(c.id)} disabled={busy === `verify:${c.id}`}>
                    {busy === `verify:${c.id}` ? 'Checking…' : 'Verify'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void reconcile(c.id)} disabled={busy === `reconcile:${c.id}`}>
                    {busy === `reconcile:${c.id}` ? 'Comparing…' : 'Reconcile'}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => void disconnect(c)} disabled={busy === `disconnect:${c.id}`}>
                    Disconnect
                  </Button>
                </div>
              </div>

              {c.lastError && (
                <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 font-mono text-[11.5px] text-amber-800">
                  last error: {c.lastError}
                </p>
              )}

              <div className="mt-4 space-y-2 rounded-xl border border-slate-900/[0.04] bg-ink-900/50 p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">Point the carrier&apos;s webhooks here</p>
                {[
                  { label: 'A call comes in', url: `${webhookBase}/api/telephony/twilio/voice` },
                  { label: 'Call status changes', url: `${webhookBase}/api/telephony/twilio/status` },
                  { label: 'Raw audio stream', url: `${webhookBase.replace(/^http/, 'ws')}/api/telephony/twilio/media` },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-slateink-400">{row.label}</span>
                    <span className="flex items-center gap-2 overflow-hidden">
                      <code className="truncate font-mono text-[11px] text-slateink-300">{row.url}</code>
                      <CopyButton value={row.url} />
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-[11.5px] text-slateink-400">
                  Numbers bought here are wired automatically. Adopting re-points an existing number away from whatever answered it before.
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <Tabs
        tabs={[
          { id: 'connect', label: 'Connect' },
          { id: 'buy', label: 'Buy a number' },
          { id: 'owned', label: 'Your carrier numbers' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
      />

      {tab === 'connect' && (
        <div id="carrier-connect" className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
            <h3 className="h4">Connect a carrier account</h3>
            <p className="mt-1 text-[13px] text-slateink-400">
              We verify the credentials before storing them, so a typo fails here instead of on a live call. Nothing is dialled without your say-so.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-slateink-400">Provider</span>
                <select className="field" value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value as Carrier['provider'] }))}>
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-slateink-400">Label</span>
                <input className="field" placeholder="Northwind voice" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-slateink-400">{providerMeta.fields.sid}</span>
                <input
                  className="field font-mono text-[12.5px]"
                  placeholder={form.provider === 'twilio' ? 'AC…' : 'account id'}
                  value={form.accountSid}
                  onChange={(e) => setForm((f) => ({ ...f, accountSid: e.target.value }))}
                  spellCheck={false}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-slateink-400">{providerMeta.fields.token}</span>
                <input
                  className="field font-mono text-[12.5px]"
                  type="password"
                  placeholder="••••••••"
                  value={form.authToken}
                  onChange={(e) => setForm((f) => ({ ...f, authToken: e.target.value }))}
                  spellCheck={false}
                />
              </label>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="brand" size="sm" onClick={() => void connect()} disabled={busy === 'connect' || !form.accountSid || !form.authToken}>
                {busy === 'connect' ? 'Verifying with the carrier…' : 'Connect & verify'}
              </Button>
              <span className="text-[12px] text-slateink-400">
                {providerMeta.label} · {providerMeta.hint}
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <h3 className="h4">How credentials are handled</h3>
              <ul className="mt-3 space-y-2.5 text-[13px] text-slateink-400">
                {[
                  'Encrypted with AES-256-GCM before they touch disk; the key never leaves the server.',
                  'Never returned by any API read — the dashboard only ever sees a masked account id.',
                  'Reconnecting with a fresh token rotates the stored secret in place.',
                  'Disconnecting deletes the credentials immediately. Your numbers stay yours.',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5">
                    <Icons.shield size={14} className="mt-0.5 shrink-0 text-brand-700" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="flex items-center gap-2">
                <StatusDot status={media?.ready ? 'active' : 'draft'} />
                <h3 className="h4">Raw-audio pipeline</h3>
              </div>
              <p className="mt-2 text-[13px] text-slateink-400">{media?.providers.transcriber.detail ?? 'Checking…'}</p>
              <p className="mt-1.5 text-[13px] text-slateink-400">{media?.providers.voice.detail ?? ''}</p>
              <p className="mt-3 font-mono text-[11.5px] text-slateink-400">
                {media ? `${media.inbound.encoding} · ${media.inbound.sampleRate} Hz · ${media.inbound.frameMs} ms frames` : ''}
              </p>
              <p className="mt-3 text-[12px] text-slateink-400">
                Numbers answered in raw-audio mode stream to <code className="font-mono text-slateink-300">/api/telephony/twilio/media</code>, where the agent can be
                interrupted mid-sentence. Set the kill-switch per number with <code className="font-mono text-slateink-300">answerMode: &quot;media&quot;</code>, or leave it off and
                the carrier transcribes instead.
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === 'buy' && (
        <div className="space-y-4">
          {connected.length === 0 ? (
            <EmptyState
              icon="server"
              title="No carrier connected"
              desc="Buying numbers needs a carrier account: we search its inventory, buy the number, and point its webhooks at this deployment in one step."
              action={
                <Button variant="brand" size="sm" onClick={() => setTab('connect')}>
                  Connect a carrier
                </Button>
              }
            />
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Carrier</span>
                  <select className="field" value={activeCarrier} onChange={(e) => setActiveCarrier(e.target.value)}>
                    {connected.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Country</span>
                  <select className="field" value={search.country} onChange={(e) => setSearch((s) => ({ ...s, country: e.target.value }))}>
                    {['US', 'CA', 'GB', 'AU', 'DE', 'PK'].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Area code</span>
                  <input className="field w-28" value={search.areaCode} onChange={(e) => setSearch((s) => ({ ...s, areaCode: e.target.value }))} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Contains</span>
                  <input
                    className="field w-32"
                    placeholder="e.g. 0301"
                    value={search.contains}
                    onChange={(e) => setSearch((s) => ({ ...s, contains: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Answer with</span>
                  <select className="field" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">No assistant (still answers politely)</option>
                    {assistants.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="brand" size="sm" onClick={() => void runSearch()} disabled={busy === 'search'}>
                  {busy === 'search' ? 'Searching…' : 'Search inventory'}
                </Button>
              </div>

              {available && available.length === 0 && (
                <EmptyState icon="globe" title="No numbers matched" desc="Carriers only hold so many per area code. Try another code, or search a different country." />
              )}

              {available && available.length > 0 && (
                <DataTable
                  columns={[
                    { key: 'number', label: 'Number' },
                    { key: 'where', label: 'Where' },
                    { key: 'cost', label: 'Monthly', align: 'right' },
                    { key: 'action', label: '', align: 'right' },
                  ]}
                >
                  {available.map((n) => (
                    <tr key={n.number} className="transition-colors hover:bg-slate-900/[0.02]">
                      <td className="px-4 py-3 font-mono text-[12.5px] text-slate-900">{n.number}</td>
                      <td className="px-4 py-3 text-[13px] text-slateink-400">
                        {[n.locality, n.region, n.country].filter(Boolean).join(', ')}
                      </td>
                      <td className="px-4 py-3 text-right text-[13px] text-slateink-400">{n.monthlyCost ? `$${n.monthlyCost}` : '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => void buy(n.number)} disabled={busy === `buy:${n.number}`}>
                          {busy === `buy:${n.number}` ? 'Buying…' : 'Buy & wire'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}

              {!available && (
                <p className="text-[13px] text-slateink-400">
                  Search your carrier&apos;s inventory above. A bought number arrives with its voice webhook already pointing here, so it answers on the first call.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'owned' && (
        <div className="space-y-4">
          {owned === null ? (
            <p className="text-[13px] text-slateink-400">{activeCarrier ? 'Loading numbers from the carrier…' : 'Connect a carrier first.'}</p>
          ) : owned.length === 0 ? (
            <EmptyState icon="globe" title="The carrier holds no numbers" desc="Buy one from the inventory and it will appear here, already wired to this deployment." />
          ) : (
            <DataTable
              columns={[
                { key: 'number', label: 'Number' },
                { key: 'label', label: 'Label' },
                { key: 'voice', label: 'Currently answers with' },
                { key: 'state', label: 'State' },
                { key: 'action', label: '', align: 'right' },
              ]}
            >
              {owned.map((n) => (
                <tr key={n.sid} className="transition-colors hover:bg-slate-900/[0.02]">
                  <td className="px-4 py-3 font-mono text-[12.5px] text-slate-900">{n.number}</td>
                  <td className="px-4 py-3 text-[13px] text-slateink-400">{n.label ?? '—'}</td>
                  <td className="max-w-[22rem] truncate px-4 py-3 font-mono text-[11.5px] text-slateink-400">{n.voiceUrl ?? 'carrier default'}</td>
                  <td className="px-4 py-3">
                    {n.adopted ? <Pill tone="brand">in this workspace</Pill> : <Pill tone="warn">not adopted</Pill>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {n.adopted ? (
                      <Link href="/dashboard/numbers" className="text-[13px] text-brand-700 hover:text-brand-700">
                        Manage
                      </Link>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => void adopt(n)} disabled={busy === `adopt:${n.number}`}>
                        {busy === `adopt:${n.number}` ? 'Adopting…' : 'Adopt'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          <p className={cn('text-[12px] text-slateink-400')}>
            Adopting keeps the number on your carrier account and re-points its voice webhook here — the fastest way to put an assistant on a line that already rings.
          </p>
        </div>
      )}
    </div>
  );
}
