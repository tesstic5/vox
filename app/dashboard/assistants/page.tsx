'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, LinkButton, Modal, useToast } from '@/components/ui';
import { Filters, StatCard, StatusDot } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

export default function AssistantsPage() {
  const store = useStore();
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<Record<string, string>>({ status: 'All' });
  const [dupe, setDupe] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);

  const filtered = store.assistants.filter((a) => {
    const q = query.trim().toLowerCase();
    const qOk = !q || a.name.toLowerCase().includes(q) || a.template.toLowerCase().includes(q);
    const sOk =
      !active.status || active.status === 'All' || (active.status === 'Published' ? a.status === 'published' : a.status === 'draft');
    return qOk && sOk;
  });

  const target = store.assistants.find((a) => a.id === deleteTarget);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assistants"
        desc="Workspace assistant records with their published state, prompt, model, voice, factual snippets and allowed tools."
        actions={
          <LinkButton href="/dashboard/assistants/new" variant="brand" size="sm">
            <Icons.plus size={14} /> New assistant
          </LinkButton>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total" value={String(store.assistants.length)} sub="in this organization" icon="sparkles" />
        <StatCard
          label="Published"
          value={String(store.assistants.filter((a) => a.status === 'published').length)}
          sub="eligible for runtime use"
          icon="check"
          tone="brand"
        />
        <StatCard label="Drafts" value={String(store.assistants.filter((a) => a.status === 'draft').length)} sub="not yet deployed" icon="book" />
        <StatCard label="Calls loaded" value={String(store.calls.length)} sub="newest browser snapshot" icon="phone" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[240px] flex-1 items-center gap-2.5 rounded-xl border border-slate-900/[0.035] bg-ink-900/70 px-3.5 py-2.5 sm:max-w-sm">
          <Icons.search size={15} className="text-slateink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search assistants…"
            className="w-full bg-transparent text-[12.5px] text-slate-900 placeholder:text-slateink-400 focus:outline-none"
          />
        </div>
        <Filters
          filters={[{ id: 'status', label: 'Status', options: ['All', 'Published', 'Draft'] }]}
          active={active}
          onChange={(id, v) => setActive((s) => ({ ...s, [id]: v }))}
        />
        <span className="ml-auto font-mono text-[11px] text-slateink-400">
          {filtered.length} of {store.assistants.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="sparkles"
          title="No assistants match"
          desc="Clear the filters or create a new draft assistant."
          action={
            <LinkButton href="/dashboard/assistants/new" variant="brand" size="sm">
              Browse templates
            </LinkButton>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a) => {
            const calls = store.calls.filter((c) => c.assistantId === a.id);
            const evaluated = calls.filter(
              (c) => c.analysis.successEvaluation === 'true' || c.analysis.successEvaluation === 'false'
            );
            const contained = evaluated.filter((c) => c.analysis.successEvaluation === 'true').length;
            const rate = evaluated.length ? (contained / evaluated.length) * 100 : null;
            return (
              <div key={a.id} className="group flex flex-col rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5 transition-colors hover:border-brand-500/25">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <StatusDot status={a.status} />
                      <Link
                        href={`/dashboard/assistants/${a.id}`}
                        className="truncate text-[14.5px] font-medium text-slate-900 hover:text-brand-700"
                      >
                        {a.name}
                      </Link>
                    </div>
                    <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-slateink-400">
                      {a.id} · edited <Ago at={a.updatedAt} />
                    </div>
                  </div>
                  <span className={cn('badge shrink-0', a.status === 'published' && 'border-brand-500/25 text-brand-700')}>
                    {a.status}
                  </span>
                </div>

                <p className="mt-4 line-clamp-2 text-[12.5px] leading-relaxed text-slateink-400">
                  {a.firstMessage || 'No first message configured.'}
                </p>

                <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
                  {[
                    ['Calls', String(calls.length)],
                    ['Evaluated success', rate === null ? '—' : `${rate.toFixed(0)}%`],
                    ['Tools', String(a.tools.length)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div className="font-mono text-[9.5px] uppercase tracking-wider text-slateink-400">{k}</div>
                      <div className="mt-1 text-[13px] font-medium text-slate-900">{v}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  <span className="code-chip">{a.model || 'model not configured'}</span>
                  <span className="code-chip">{a.voiceId || 'voice not configured'}</span>
                  <span className="code-chip">{a.transcriber || 'transcriber not configured'}</span>
                </div>

                <div className="mt-auto flex items-center gap-2 pt-5">
                  <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/assistants/${a.id}`)}>
                    <Icons.settings size={13} /> Edit
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => setDupe(a.id)}>
                    <Icons.copy size={13} /> Duplicate
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="ml-auto text-slateink-400 hover:text-red-700"
                    onClick={() => setDeleteTarget(a.id)}
                  >
                    <Icons.trash size={13} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!dupe}
        onClose={() => setDupe(null)}
        title="Duplicate assistant"
        desc="Creates a draft copy. Nothing goes live until you publish it."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDupe(null)}>
              Cancel
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={working}
              onClick={async () => {
                const source = store.assistants.find((assistant) => assistant.id === dupe);
                if (!source) return;
                setWorking(true);
                try {
                  const copy = await request<{ id: string; name: string }>('POST', '/api/v1/assistants', {
                    name: `${source.name} (copy)`,
                    firstMessage: source.firstMessage,
                    systemPrompt: source.systemPrompt,
                    model: source.model,
                    provider: source.provider,
                    voiceId: source.voiceId,
                    temperature: source.temperature,
                    transcriber: source.transcriber,
                    language: source.language,
                    tools: source.tools,
                    knowledge: source.knowledge ?? [],
                    serverUrl: source.serverUrl,
                  });
                  await store.refreshFromServer();
                  setDupe(null);
                  toast(`Duplicated as ${copy.name}.`);
                  router.push(`/dashboard/assistants/${copy.id}`);
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : 'The assistant could not be duplicated.', 'error');
                } finally {
                  setWorking(false);
                }
              }}
            >
              {working ? 'Duplicating…' : 'Duplicate'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-slateink-400">
          The server creates a new draft ID and copies the prompt, runtime settings, allowed tools and factual snippets. The copy starts unpublished with its own version history.
        </p>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete assistant"
        desc={target ? `“${target.name}” will be removed. Assigned number records will be kept and unassigned.` : ''}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={working}
              className="bg-red-500 text-slate-900 hover:bg-red-400"
              onClick={async () => {
                if (!target) return;
                setWorking(true);
                try {
                  await request('DELETE', `/api/v1/assistants/${target.id}`);
                  await store.refreshFromServer();
                  toast(`Deleted ${target.name}.`, 'info');
                  setDeleteTarget(null);
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : 'The assistant could not be deleted.', 'error');
                } finally {
                  setWorking(false);
                }
              }}
            >
              {working ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-slateink-400">
          Call history is retained. This action cannot be undone from the dashboard.
        </p>
      </Modal>
    </div>
  );
}
