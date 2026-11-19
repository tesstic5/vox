'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { EmptyState, LinkButton, Pill } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

export default function ToolsPage() {
  const store = useStore();
  const [selectedId, setSelectedId] = React.useState<string | null>(store.tools[0]?.id ?? null);
  const [query, setQuery] = React.useState('');
  const rows = store.tools.filter((tool) => {
    const text = query.trim().toLowerCase();
    return !text || `${tool.name} ${tool.description} ${tool.endpoint ?? tool.url ?? ''}`.toLowerCase().includes(text);
  });
  const selected = store.tools.find((tool) => tool.id === selectedId) ?? rows[0];
  const usedBy = (name: string) => store.assistants.filter((assistant) => assistant.tools.includes(name));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Registered tools"
        desc="The workspace-scoped functions assistants may call. This screen reads the persisted registry; create, edit and test HTTP tools through the documented API."
        actions={<LinkButton href="/docs" variant="ghost" size="sm"><Icons.book size={13} /> Tool API</LinkButton>}
      />

      <div className="panel p-4">
        <label className="relative flex max-w-md items-center">
          <Icons.search size={14} className="pointer-events-none absolute left-3 text-slateink-400" />
          <input className="field w-full pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, descriptions or endpoints…" aria-label="Search registered tools" />
        </label>
      </div>

      {store.tools.length === 0 ? (
        <EmptyState icon="puzzle" title="No tools registered" desc="Register an HTTP tool through POST /api/v1/tools, then attach its name to an assistant." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
          <section className="panel overflow-hidden" aria-label="Tool list">
            {rows.map((tool) => (
              <button
                key={tool.id}
                onClick={() => setSelectedId(tool.id)}
                className={cn('block w-full border-b border-slate-900/[0.04] px-4 py-3 text-left last:border-0', selected?.id === tool.id ? 'bg-brand-500/[0.06]' : 'hover:bg-slate-900/[0.025]')}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12px] text-slate-900">{tool.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-slateink-400">{usedBy(tool.name).length} assistant{usedBy(tool.name).length === 1 ? '' : 's'}</span>
                </span>
                <span className="mt-1.5 line-clamp-2 block text-[11.5px] leading-snug text-slateink-400">{tool.description || 'No description saved.'}</span>
              </button>
            ))}
            {rows.length === 0 && <p className="p-8 text-center text-[12.5px] text-slateink-400">No registered tool matches that search.</p>}
          </section>

          {selected && (
            <section className="panel p-5" aria-labelledby="tool-detail-title">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="tool-detail-title" className="font-mono text-[15px] font-semibold text-slate-900">{selected.name}</h2>
                  <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-slateink-300">{selected.description || 'No description saved.'}</p>
                </div>
                <Pill tone={selected.endpoint || selected.url ? 'brand' : 'default'}>{selected.endpoint || selected.url ? 'HTTP' : 'built-in'}</Pill>
              </div>

              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
                  <dt className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Method</dt>
                  <dd className="mt-1.5 font-mono text-[12px] text-slate-900">{selected.method ?? (selected.endpoint || selected.url ? 'POST' : 'runtime')}</dd>
                </div>
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
                  <dt className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Attached assistants</dt>
                  <dd className="mt-1.5 font-mono text-[12px] text-slate-900">{usedBy(selected.name).length}</dd>
                </div>
              </dl>

              {(selected.endpoint || selected.url) && (
                <div className="mt-4 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
                  <div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Endpoint</div>
                  <div className="mt-1.5 break-all font-mono text-[11.5px] text-brand-700">{selected.endpoint ?? selected.url}</div>
                </div>
              )}

              <div className="mt-5">
                <div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Used by</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {usedBy(selected.name).length ? usedBy(selected.name).map((assistant) => (
                    <a key={assistant.id} href={`/dashboard/assistants/${assistant.id}`} className="rounded-full border border-slate-900/[0.05] px-3 py-1.5 text-[11.5px] text-slateink-300 hover:border-brand-500/35 hover:text-slate-900">{assistant.name}</a>
                  )) : <span className="text-[12px] text-slateink-400">No assistant currently allows this tool.</span>}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.055] p-4 text-[12.5px] leading-relaxed text-amber-900">
        There is no organisation-wide enabled switch: a tool is available only to assistants whose saved tool list includes its exact name. No toggle on this screen claims otherwise.
      </div>
    </div>
  );
}
