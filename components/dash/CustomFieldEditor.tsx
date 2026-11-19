'use client';

import * as React from 'react';
import { Button, Pill } from '@/components/ui';

export type CustomFieldEntry = {
  definition: {
    id: string;
    key: string;
    label: string;
    valueType: 'text' | 'long_text' | 'number' | 'date' | 'boolean' | 'single_choice' | 'multiple_choice';
    options?: Array<{ value: string; label: string }>;
    sensitivity: 'administrative' | 'sensitive' | 'clinical';
    required: boolean;
  };
  value?: {
    id: string;
    value: unknown;
    source?: string;
    verificationStatus: string;
    revision: number;
  };
};

type Props = {
  entries: CustomFieldEntry[];
  drafts: Record<string, unknown>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  busy: boolean;
  onSave(entry: CustomFieldEntry): void | Promise<void>;
  idPrefix: string;
  emptyText: string;
};

export function draftsForCustomFields(entries: CustomFieldEntry[]) {
  return Object.fromEntries(entries.map((entry) => [
    entry.definition.id,
    entry.value?.value ?? (entry.definition.valueType === 'multiple_choice' ? [] : ''),
  ]));
}

export function CustomFieldEditor({ entries, drafts, setDrafts, busy, onSave, idPrefix, emptyText }: Props) {
  return <div className="divide-y divide-slate-900/[0.05]">
    {entries.map((entry) => {
      const definition = entry.definition;
      const value = drafts[definition.id];
      const inputId = `${idPrefix}-${definition.id}`;
      return <div key={definition.id} className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="text-[11.5px] font-semibold">{definition.label}</label>
          {definition.required && <Pill tone="warn">required</Pill>}
          <Pill tone={definition.sensitivity === 'clinical' ? 'danger' : definition.sensitivity === 'sensitive' ? 'warn' : 'default'}>{definition.sensitivity}</Pill>
          {entry.value && <Pill tone={entry.value.verificationStatus === 'verified' ? 'brand' : 'warn'}>{entry.value.verificationStatus}</Pill>}
        </div>
        <div className="mt-2 flex items-start gap-2">
          {definition.valueType === 'boolean' ? <select
            id={inputId}
            value={value === true ? 'true' : value === false ? 'false' : ''}
            onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value === '' ? '' : event.target.value === 'true' }))}
            className="min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"
          ><option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option></select>
            : definition.valueType === 'single_choice' ? <select
              id={inputId}
              value={String(value ?? '')}
              onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value }))}
              className="min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"
            ><option value="">Choose…</option>{definition.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : definition.valueType === 'multiple_choice' ? <select
                id={inputId}
                multiple
                value={Array.isArray(value) ? value.map(String) : []}
                onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: Array.from(event.target.selectedOptions, (option) => option.value) }))}
                className="min-h-24 min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"
              >{definition.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                : definition.valueType === 'long_text' ? <textarea
                  id={inputId}
                  value={String(value ?? '')}
                  onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value }))}
                  className="min-h-20 min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"
                />
                  : <input
                    id={inputId}
                    type={definition.valueType === 'number' ? 'number' : definition.valueType === 'date' ? 'date' : 'text'}
                    value={String(value ?? '')}
                    onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value }))}
                    className="min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"
                  />}
          <Button size="sm" disabled={busy} onClick={() => void onSave(entry)}>Save</Button>
        </div>
        {entry.value?.source && <p className="mt-1.5 text-[9.5px] text-slateink-400">Source: {entry.value.source}</p>}
      </div>;
    })}
    {!entries.length && <p className="px-5 py-8 text-center text-[12px] text-slateink-400">{emptyText}</p>}
  </div>;
}
