'use client';

import * as React from 'react';
import { Button, Pill } from '@/components/ui';
import type { StructuredAddress, StructuredAddressInput } from '@/lib/addresses';

const EMPTY: StructuredAddressInput = { line1: '', line2: '', city: '', county: '', postcode: '', countryCode: 'GB' };

type Props = {
  value?: StructuredAddress;
  legacyAddress?: string;
  busy: boolean;
  onSave(address: StructuredAddressInput): void | Promise<void>;
  idPrefix: string;
};

export function StructuredAddressEditor({ value, legacyAddress, busy, onSave, idPrefix }: Props) {
  const [draft, setDraft] = React.useState<StructuredAddressInput>(EMPTY);
  React.useEffect(() => {
    setDraft({
      line1: value?.line1 ?? '',
      line2: value?.line2 ?? '',
      city: value?.city ?? '',
      county: value?.county ?? '',
      postcode: value?.postcode ?? '',
      countryCode: value?.countryCode ?? 'GB',
    });
  }, [value?.line1, value?.line2, value?.city, value?.county, value?.postcode, value?.countryCode]);
  const legacyText = value?.legacyText ?? legacyAddress;
  const reviewed = value?.reviewStatus === 'reviewed';

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <Pill tone={reviewed ? 'brand' : legacyText ? 'warn' : 'default'}>{reviewed ? 'reviewed' : legacyText ? 'review needed' : 'not recorded'}</Pill>
      {reviewed && value?.reviewedAt && <span className="text-[10px] text-slateink-400">Reviewed {new Date(value.reviewedAt).toLocaleDateString('en-GB')}{value.reviewedBy ? ` by ${value.reviewedBy}` : ''}</span>}
    </div>
    {legacyText && <div className="rounded-xl border border-amber-300/45 bg-amber-50/70 p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-800">Preserved legacy text</p>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[11.5px] text-amber-950">{legacyText}</p>
      {!reviewed && <p className="mt-2 text-[10.5px] leading-relaxed text-amber-800">This source has not been parsed automatically. Compare it with the fields below, then save an explicit review.</p>}
    </div>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-[10.5px] font-medium text-slateink-500 sm:col-span-2" htmlFor={`${idPrefix}-line1`}>Address line 1<input id={`${idPrefix}-line1`} value={draft.line1 ?? ''} onChange={(event) => setDraft((current) => ({ ...current, line1: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" /></label>
      <label className="text-[10.5px] font-medium text-slateink-500 sm:col-span-2" htmlFor={`${idPrefix}-line2`}>Address line 2<input id={`${idPrefix}-line2`} value={draft.line2 ?? ''} onChange={(event) => setDraft((current) => ({ ...current, line2: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" /></label>
      <label className="text-[10.5px] font-medium text-slateink-500" htmlFor={`${idPrefix}-city`}>City or locality<input id={`${idPrefix}-city`} value={draft.city ?? ''} onChange={(event) => setDraft((current) => ({ ...current, city: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" /></label>
      <label className="text-[10.5px] font-medium text-slateink-500" htmlFor={`${idPrefix}-county`}>County or region<input id={`${idPrefix}-county`} value={draft.county ?? ''} onChange={(event) => setDraft((current) => ({ ...current, county: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" /></label>
      <label className="text-[10.5px] font-medium text-slateink-500" htmlFor={`${idPrefix}-postcode`}>Postcode<input id={`${idPrefix}-postcode`} value={draft.postcode ?? ''} onChange={(event) => setDraft((current) => ({ ...current, postcode: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px] uppercase" /></label>
      <label className="text-[10.5px] font-medium text-slateink-500" htmlFor={`${idPrefix}-country`}>Country code<input id={`${idPrefix}-country`} value={draft.countryCode ?? ''} onChange={(event) => setDraft((current) => ({ ...current, countryCode: event.target.value.toUpperCase().slice(0, 2) }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 font-mono text-[11px] uppercase" maxLength={2} /></label>
    </div>
    <Button size="sm" disabled={busy || !String(draft.line1 ?? '').trim() || !String(draft.city ?? '').trim()} onClick={() => void onSave(draft)}>{busy ? 'Saving…' : reviewed ? 'Save reviewed address' : 'Review and save address'}</Button>
  </div>;
}
