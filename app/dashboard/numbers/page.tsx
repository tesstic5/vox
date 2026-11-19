'use client';

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { ApiError, request } from '@/lib/server-sync';
import { NUMBER_COUNTRIES } from '@/lib/dash-data';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Modal, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { DataTable, StatCard, StatusDot } from '@/components/dash/bits';

export default function NumbersPage() {
  const store = useStore();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [country, setCountry] = React.useState(NUMBER_COUNTRIES[0].code);
  const [areaCode, setAreaCode] = React.useState(NUMBER_COUNTRIES[0].areaCodes[0]);
  const [label, setLabel] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [assigning, setAssigning] = React.useState<string | null>(null);
  const [provisioning, setProvisioning] = React.useState<string | null>(null);
  const [releaseAtCarrier, setReleaseAtCarrier] = React.useState(true);
  const [carriers, setCarriers] = React.useState<{ id: string; label: string; provider: string; verified: boolean }[]>([]);
  const [releasing, setReleasing] = React.useState(false);

  // Numbers bought through a carrier can be released at the carrier too; the
  // page needs to know whether one is connected to offer that.
  React.useEffect(() => {
    request<{ data: { id: string; label: string; provider: string; verified: boolean }[] }>('GET', '/api/v1/carriers')
      .then((res) => setCarriers(res.data))
      .catch(() => setCarriers([]));
  }, []);

  const meta = NUMBER_COUNTRIES.find((c) => c.code === country) ?? NUMBER_COUNTRIES[0];
  const numbers = store.numbers;
  const inbound = numbers.reduce((s, n) => s + n.inboundCalls30d, 0);
  const quotedNumbers = numbers.filter((number) => Boolean(number.monthlyCostSource));
  const monthly = quotedNumbers.reduce((sum, number) => sum + number.monthlyCost, 0);
  const releasingNumber = provisioning ? numbers.find((n) => n.id === provisioning) : undefined;
  const carrierBacked = Boolean((releasingNumber as unknown as { carrierId?: string } | undefined)?.carrierId);
  const carrierNumbers = numbers.filter((n) => (n as unknown as { carrierId?: string }).carrierId);

  const buy = async () => {
    setCreating(true);
    try {
      const number = await request<{ number: string }>('POST', '/api/v1/numbers', { areaCode, country, label: label.trim() || 'Sandbox line' });
      await store.refreshFromServer();
      setOpen(false);
      setLabel('');
      toast(`${number.number} created as a non-dialable sandbox record.`);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The sandbox record could not be created.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const assign = async (id: string, assistantId: string | null) => {
    setAssigning(id);
    try {
      await request('PATCH', `/api/v1/numbers/${id}`, { assistantId });
      await store.refreshFromServer();
      const number = numbers.find((item) => item.id === id);
      toast(assistantId ? `${number?.number ?? 'Line'} assigned to ${store.assistantById(assistantId)?.name ?? 'the selected assistant'}.` : `${number?.number ?? 'Line'} unassigned.`, 'info');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The assignment could not be saved.', 'error');
    } finally {
      setAssigning(null);
    }
  };

  /**
   * Release a number the way the customer means it: real carrier numbers are
   * handed back to the carrier, sandbox numbers just leave the workspace.
   */
  const release = async (id: string) => {
    const number = numbers.find((n) => n.id === id);
    if (!number) return;
    const carrierBacked = Boolean((number as unknown as { carrierId?: string }).carrierId);
    if (!carrierBacked) {
      setReleasing(true);
      try {
        await request('DELETE', `/api/v1/numbers/${id}`);
        await store.refreshFromServer();
        setProvisioning(null);
        toast(`${number.number} removed from the workspace.`);
      } catch (error) {
        toast(error instanceof ApiError ? error.message : 'The sandbox record could not be removed.', 'error');
      } finally {
        setReleasing(false);
      }
      return;
    }
    setReleasing(true);
    try {
      const res = await request<{ releasedAtCarrier: boolean; note: string }>('POST', `/api/v1/phone-numbers/${id}/release`, { atCarrier: releaseAtCarrier });
      setProvisioning(null);
      toast(`${number.number}: ${res.note}`);
      await store.refreshFromServer();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Release failed', 'error');
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone numbers"
        desc="Inbound and outbound telephony attached to your assistants. Bring your own carrier or provision here."
        actions={
          <>
            <Link href="/dashboard/carriers" className="btn-ghost btn-sm inline-flex items-center gap-1.5">
              <Icons.server size={13} /> Carrier connections
            </Link>
            <Button variant="brand" size="sm" onClick={() => setOpen(true)}>
              <Icons.plus size={14} /> Add sandbox number
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Numbers" value={String(numbers.length)} sub={`${numbers.filter((n) => n.assistantId).length} assigned`} icon="globe" />
        <StatCard label="Inbound (30d)" value={inbound.toLocaleString()} sub="sum stored on number records" icon="phone" tone="brand" />
        <StatCard label="Monthly rental on record" value={quotedNumbers.length ? `$${monthly.toFixed(2)}` : '—'} sub={quotedNumbers.length ? `${quotedNumbers.length} carrier-quoted record(s); excluding usage and settlement` : 'no carrier monthly quote stored'} icon="dollar" />
        <StatCard label="Carrier connections" value={String(carriers.length)} sub={`${carriers.filter((carrier) => carrier.verified).length} verified`} icon="server" />
      </div>

      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-4 py-3.5',
          carriers.length ? 'border-brand-500/25 bg-brand-500/[0.05]' : 'border-slate-900/[0.045] bg-ink-850/40'
        )}
      >
        <div className="flex items-start gap-3">
          <Icons.server size={16} className={cn('mt-0.5 shrink-0', carriers.length ? 'text-brand-700' : 'text-slateink-400')} />
          <div>
            <p className="text-[13px] text-slate-900">
              {carriers.length
                ? `${carriers[0].label} is connected — ${carrierNumbers.length} number${carrierNumbers.length === 1 ? '' : 's'} of ${numbers.length} come from your carrier.`
                : 'No carrier connected yet.'}
            </p>
            <p className="mt-1 text-[12px] text-slateink-400">
              {carriers.length
                ? 'Buy real numbers from your own carrier inventory, adopt lines that already ring, and release them back when you are done.'
                : 'The numbers below are sandbox lines: they answer, but they are not dialable. Connect a carrier to buy real ones and place outbound calls.'}
            </p>
          </div>
        </div>
        <Link
          href="/dashboard/carriers"
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-900/[0.04] px-3.5 py-1.5 text-[12.5px] text-slateink-200 transition-colors hover:border-brand-500/40 hover:text-slate-900"
        >
          {carriers.length ? 'Manage carriers' : 'Connect a carrier'}
          <Icons.arrowRight size={13} />
        </Link>
      </div>

      {numbers.length === 0 ? (
        <EmptyState
          icon="globe"
          title="No numbers yet"
          desc={carriers.length ? 'Choose a verified carrier connection to provision or import a real number.' : 'No carrier is connected. A locally created line is a sandbox record and is not dialable.'}
          action={
            <Button variant="brand" size="sm" onClick={() => setOpen(true)}>
              Add sandbox number
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={[
            { key: 'number', label: 'Number' },
            { key: 'label', label: 'Label' },
            { key: 'assistant', label: 'Assigned assistant' },
            { key: 'provider', label: 'Provider' },
            { key: 'status', label: 'Status' },
            { key: 'calls', label: 'Calls (30d)', align: 'right' },
            { key: 'cost', label: 'Rental', align: 'right' },
            { key: 'created', label: 'Added', align: 'right' },
            { key: 'actions', label: '', align: 'right' },
          ]}
        >
          {numbers.map((n) => (
            <tr key={n.id} className="transition-colors hover:bg-slate-900/[0.03]">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <StatusDot status={n.status} />
                  <Link href={`/dashboard/numbers/${n.id}`} className="font-mono text-[12.5px] text-slate-900 hover:text-brand-700">
                    {n.number}
                  </Link>
                </div>
              </td>
              <td className="px-4 py-3 text-[12.5px] text-slateink-300">{n.label}</td>
              <td className="px-4 py-3">
                <select
                  aria-label={`Assigned assistant for ${n.number}`}
                  value={n.assistantId ?? ''}
                  disabled={assigning === n.id}
                  onChange={(e) => void assign(n.id, e.target.value || null)}
                  className="rounded-lg border border-slate-900/[0.035] bg-ink-900/70 px-2.5 py-1.5 text-[11.5px] text-slateink-200 focus:border-brand-500/40 focus:outline-none"
                >
                  <option value="" className="bg-ink-900">
                    Unassigned
                  </option>
                  {store.assistants.map((a) => (
                    <option key={a.id} value={a.id} className="bg-ink-900">
                      {a.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3">
                <Pill tone={n.provider === 'twilio' ? 'info' : 'default'}>{n.provider}</Pill>
              </td>
              <td className="px-4 py-3">
                <Pill tone={n.status === 'active' ? 'brand' : n.status === 'provisioning' ? 'warn' : 'default'}>{n.status}</Pill>
              </td>
              <td className="tabular px-4 py-3 text-right font-mono text-[11.5px] text-slateink-300">
                {n.inboundCalls30d.toLocaleString()}
              </td>
              <td className="tabular px-4 py-3 text-right font-mono text-[11.5px] text-slateink-300">{n.monthlyCostSource ? `$${n.monthlyCost.toFixed(2)}` : '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right text-[11.5px] text-slateink-400"><Ago at={n.createdAt} /></td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Copy ${n.number}`}
                    onClick={() => {
                      navigator.clipboard?.writeText(n.number);
                      toast('Number copied.');
                    }}
                  >
                    <Icons.copy size={12} />
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="text-slateink-400 hover:text-red-700"
                    aria-label={`Release ${n.number}`}
                    onClick={() => {
                      setProvisioning(n.id);
                    }}
                  >
                    <Icons.trash size={12} />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-5 lg:col-span-2" aria-labelledby="connected-carriers-title">
          <h2 id="connected-carriers-title" className="text-[14.5px] font-semibold text-slate-900">Connected carriers</h2>
          <p className="mt-1.5 text-[12px] text-slateink-400">Read from the workspace carrier API. Open Carrier connections to verify credentials or buy a real number from carrier inventory.</p>
          {carriers.length ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {carriers.map((carrier) => (
                <div key={carrier.id} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[13.5px] font-medium text-slate-900">{carrier.label}</span>
                    <Pill tone={carrier.verified ? 'brand' : 'warn'}>{carrier.verified ? 'verified' : 'not verified'}</Pill>
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-slateink-400">{carrier.provider} · {carrier.id}</p>
                </div>
              ))}
            </div>
          ) : <p className="mt-5 text-[12.5px] text-slateink-400">No carrier connections are stored for this workspace.</p>}
        </section>

        <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5" aria-labelledby="carrier-compliance-title">
          <h2 id="carrier-compliance-title" className="text-[14.5px] font-semibold text-amber-900">Carrier compliance</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">STIR/SHAKEN, emergency-address and messaging-registration status are not returned by the current carrier API. Verify them in the carrier account; this dashboard does not assume they are complete.</p>
        </section>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a sandbox number"
        desc="This creates a workspace test record. It is not dialable and does not buy inventory from a carrier."
        width="max-w-lg"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" disabled={creating} onClick={() => void buy()}>
              {creating ? 'Creating…' : 'Create sandbox record'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label">Country</label>
            <select
              aria-label="Country"
              className="field"
              value={country}
              onChange={(e) => {
                const c = NUMBER_COUNTRIES.find((x) => x.code === e.target.value) ?? NUMBER_COUNTRIES[0];
                setCountry(c.code);
                setAreaCode(c.areaCodes[0]);
              }}
            >
              {NUMBER_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code} className="bg-ink-900">
                  {c.label} · {c.dial}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Area code</label>
            <div className="flex flex-wrap gap-2">
              {meta.areaCodes.map((ac) => (
                <button
                  key={ac}
                  onClick={() => setAreaCode(ac)}
                  className={cn(
                    'rounded-full border px-3.5 py-1.5 font-mono text-[11.5px] transition-colors',
                    areaCode === ac ? 'border-brand-500/40 bg-brand-500/[0.09] text-brand-700' : 'border-slate-900/[0.04] text-slateink-300 hover:text-slate-900'
                  )}
                >
                  {meta.dial} ({ac})
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Label</label>
            <input aria-label="Label" className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main support line" />
          </div>
          <p className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5 text-[11.5px] leading-relaxed text-slateink-400">
            The server stores this with provider and status set to <code className="font-mono text-slate-900">sandbox</code>, zero rental cost and a deliberately non-E.164 identifier. It cannot receive or place a carrier call. Assigning an assistant exercises workspace routing state only.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!provisioning}
        onClose={() => setProvisioning(null)}
        title="Release this number?"
        desc={
          carrierBacked
            ? 'This number lives on your carrier account. Releasing it gives it back to the carrier, and the rental stops.'
            : 'Sandbox numbers are free and hold no traffic. Existing call logs are retained.'
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setProvisioning(null)}>
              Keep it
            </Button>
            <Button
              variant="brand"
              size="sm"
              className="bg-red-500 text-slate-900 hover:bg-red-400"
              onClick={() => provisioning && void release(provisioning)}
              disabled={releasing}
            >
              {releasing ? 'Releasing…' : carrierBacked && releaseAtCarrier ? 'Release at carrier' : 'Detach from workspace'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-slateink-400">
            {carrierBacked
              ? 'Inbound calls stop the moment the carrier releases it. If the number is printed on anything, point a forwarding rule at a new number first.'
              : 'This identifier was never dialable. Removing it deletes only the sandbox routing record; historical call records remain.'}
          </p>
          {carrierBacked && (
            <label className="flex items-start gap-2.5 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
              <input
                type="checkbox"
                checked={releaseAtCarrier}
                onChange={(e) => setReleaseAtCarrier(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--brand-500,#7c5cff)]"
              />
              <span className="text-[12.5px] leading-relaxed text-slateink-300">
                Also release it at the carrier. Leave this off to keep the number on your carrier account and only detach it here.
              </span>
            </label>
          )}
        </div>
      </Modal>
    </div>
  );
}
