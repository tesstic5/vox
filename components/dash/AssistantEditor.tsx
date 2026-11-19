'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { MODELS } from '@/lib/content';
import { request } from '@/lib/server-sync';
import { cn, uid } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, CodeBlock, Tabs, useToast } from '@/components/ui';
import { PageHeader } from './Shell';
import { StatusDot } from './bits';

type TabId = 'overview' | 'prompt' | 'model' | 'tools' | 'knowledge' | 'versions';
type LocalTurn = { id: string; role: 'user' | 'assistant'; text: string };
type VersionRow = { id: string; version: number; message?: string; createdAt: string; current: boolean };

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'model', label: 'Model' },
  { id: 'tools', label: 'Tools' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'versions', label: 'Versions' },
];

export function AssistantEditor({ id }: { id: string }) {
  const store = useStore();
  const toast = useToast();
  const assistant = store.assistants.find((row) => row.id === id);
  const [tab, setTab] = React.useState<TabId>('overview');
  const [name, setName] = React.useState(assistant?.name ?? '');
  const [prompt, setPrompt] = React.useState(assistant?.systemPrompt ?? '');
  const [firstMessage, setFirstMessage] = React.useState(assistant?.firstMessage ?? '');
  const [temperature, setTemperature] = React.useState(assistant?.temperature ?? 0.4);
  const [model, setModel] = React.useState(assistant?.model ?? 'gpt-5-mini');
  const [tools, setTools] = React.useState<string[]>(assistant?.tools ?? []);
  const [knowledgeText, setKnowledgeText] = React.useState((assistant?.knowledge ?? []).join('\n'));
  const [versions, setVersions] = React.useState<VersionRow[]>([]);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [rollingBack, setRollingBack] = React.useState<number | null>(null);
  const [turns, setTurns] = React.useState<LocalTurn[]>([]);
  const [draft, setDraft] = React.useState('');
  const [thinking, setThinking] = React.useState(false);
  const callId = React.useRef<string | null>(null);
  const transcriptBox = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!assistant) return;
    setName(assistant.name);
    setPrompt(assistant.systemPrompt);
    setFirstMessage(assistant.firstMessage);
    setTemperature(assistant.temperature);
    setModel(assistant.model);
    setTools(assistant.tools ?? []);
    setKnowledgeText((assistant.knowledge ?? []).join('\n'));
  }, [assistant?.id, assistant?.updatedAt]);

  React.useEffect(() => {
    if (transcriptBox.current) transcriptBox.current.scrollTop = transcriptBox.current.scrollHeight;
  }, [turns, thinking]);

  const loadVersions = React.useCallback(async () => {
    if (!assistant) return;
    setVersionsLoading(true);
    try {
      const result = await request<{ data: VersionRow[] }>('GET', `/api/v1/assistants/${assistant.id}/versions?limit=30`);
      setVersions(result.data ?? []);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Version history could not be loaded.', 'error');
    } finally {
      setVersionsLoading(false);
    }
  }, [assistant, toast]);

  React.useEffect(() => {
    if (tab === 'versions') void loadVersions();
  }, [tab, loadVersions]);

  if (!assistant) {
    return (
      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-10 text-center">
        <p className="text-[14px] text-slate-900">Assistant not found.</p>
        <p className="mt-2 text-[12.5px] text-slateink-400">It may have been deleted or may belong to another workspace.</p>
        <a href="/dashboard/assistants" className="btn-brand btn-sm mt-5">Back to assistants</a>
      </div>
    );
  }

  const calls = store.calls.filter((call) => call.assistantId === assistant.id);
  const ended = calls.filter((call) => call.status === 'ended');
  const evaluated = ended.filter(
    (call) => call.analysis.successEvaluation === 'true' || call.analysis.successEvaluation === 'false'
  );
  const resolved = evaluated.filter((call) => call.analysis.successEvaluation === 'true').length;
  const knowledge = knowledgeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selectedModel = MODELS.find((entry) => entry.id === model);
  const provider = assistant.provider === 'custom' && model === assistant.model ? 'custom' : selectedModel?.provider ?? assistant.provider ?? 'openai';
  const availableTools = Array.from(
    new Map(
      [
        ...store.tools.map((entry) => [entry.name, entry.description] as const),
        ...tools.map((tool) => [tool, store.tools.some((entry) => entry.name === tool) ? 'Registered tool' : 'No longer registered — remove before saving'] as const),
      ]
    ).entries()
  ).map(([toolName, description]) => ({ name: toolName, description }));

  const configJson = JSON.stringify(
    {
      id: assistant.id,
      name,
      status: assistant.status,
      model: { provider, id: model, temperature },
      firstMessage,
      tools,
      knowledge: { snippets: knowledge.length, characters: knowledge.join(' ').length },
    },
    null,
    2
  );

  const save = async (publish = false) => {
    if (saving) return;
    if (!name.trim() || !prompt.trim() || !firstMessage.trim()) {
      toast('Name, prompt and opening message are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await request('PATCH', `/api/v1/assistants/${assistant.id}`, {
        name: name.trim(),
        systemPrompt: prompt.trim(),
        firstMessage: firstMessage.trim(),
        temperature,
        model,
        provider,
        tools,
        knowledge,
      });
      if (publish) {
        await request('POST', `/api/v1/assistants/${assistant.id}/publish`, {
          message: 'Reviewed and published from the assistant editor',
        });
      }
      store.refreshFromServer();
      toast(publish ? `${name.trim()} published.` : 'Draft saved to the workspace.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The assistant could not be saved.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const send = async (text: string) => {
    const clean = text.trim();
    if (!clean || thinking) return;
    setTurns((current) => [...current, { id: uid(), role: 'user', text: clean }]);
    setDraft('');
    setThinking(true);
    try {
      if (!callId.current) {
        const opened = await request<{ id: string }>('POST', '/api/v1/calls', {
          assistantId: assistant.id,
          type: 'web',
          source: 'dashboard',
          allowDraft: true,
          customer: { name: 'Dashboard test', number: '+14155550198' },
        });
        callId.current = opened.id;
      }
      const result = await request<{ turn: { reply?: string; modelError?: string } }>(
        'POST',
        `/api/v1/calls/${callId.current}/turn`,
        { text: clean }
      );
      const reply = result.turn?.reply?.trim() || 'The runtime returned no spoken reply. Check the call record for provider or tool errors.';
      setTurns((current) => [...current, { id: uid(), role: 'assistant', text: reply }]);
      store.refreshFromServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The test turn failed.';
      setTurns((current) => [...current, { id: uid(), role: 'assistant', text: `Test failed: ${message}` }]);
      toast(message, 'error');
    } finally {
      setThinking(false);
    }
  };

  const rollback = async (version: number) => {
    if (!window.confirm(`Restore assistant version ${version} as a new version?`)) return;
    setRollingBack(version);
    try {
      await request('POST', `/api/v1/assistants/${assistant.id}/rollback`, { version });
      toast(`Version ${version} restored as a new draft version.`);
      callId.current = null;
      store.refreshFromServer();
      await loadVersions();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That version could not be restored.', 'error');
    } finally {
      setRollingBack(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={name || assistant.name}
        desc={<>{calls.length} stored calls · {evaluated.length ? `${((resolved / evaluated.length) * 100).toFixed(0)}% resolved among ${evaluated.length} evaluated call(s)` : 'no outcome evaluations recorded'}</>}
        breadcrumb={[{ label: 'Assistants', href: '/dashboard/assistants' }, { label: assistant.id }]}
        actions={
          <>
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-900/[0.035] px-3 py-1.5 font-mono text-[10.5px] text-slateink-300">
              <StatusDot status={assistant.status} /> {assistant.status}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void save(false)} disabled={saving}>
              <Icons.download size={13} /> {saving ? 'Saving…' : 'Save draft'}
            </Button>
            <Button variant="brand" size="sm" onClick={() => void save(true)} disabled={saving}>
              <Icons.check size={13} /> {saving ? 'Saving…' : 'Publish'}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,390px)]">
        <div className="min-w-0">
          <Tabs tabs={TABS} active={tab} onChange={(value) => setTab(value as TabId)} size="sm" className="mb-5" />

          {tab === 'overview' && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  ['Stored calls', String(calls.length)],
                  ['Ended calls', String(ended.length)],
                  ['Resolved', evaluated.length ? `${((resolved / evaluated.length) * 100).toFixed(0)}%` : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="panel p-4">
                    <div className="font-mono text-[9.5px] uppercase tracking-wider text-slateink-400">{label}</div>
                    <div className="mt-2 text-[22px] font-semibold text-slate-900">{value}</div>
                  </div>
                ))}
              </div>
              <div className="panel space-y-4 p-5">
                <div>
                  <label className="label" htmlFor="assistant-name">Assistant name</label>
                  <input id="assistant-name" className="field" value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor="assistant-first-message">Opening message</label>
                  <textarea id="assistant-first-message" rows={4} className="field leading-relaxed" value={firstMessage} onChange={(event) => setFirstMessage(event.target.value)} />
                  <p className="mt-2 text-[11.5px] text-slateink-400">This exact text opens new calls. Review disclosure and consent wording for your jurisdiction.</p>
                </div>
              </div>
              <CodeBlock lang="json" filename="server-backed assistant configuration" code={configJson} />
            </div>
          )}

          {tab === 'prompt' && (
            <div className="panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[14.5px] font-semibold text-slate-900">System prompt</h2>
                  <p className="mt-1.5 text-[12px] text-slateink-400">Saved verbatim. No hidden optimiser rewrites it.</p>
                </div>
                <Button variant="quiet" size="sm" onClick={() => navigator.clipboard.writeText(prompt).then(() => toast('Prompt copied.'))}>
                  <Icons.copy size={12} /> Copy
                </Button>
              </div>
              <textarea className="field mt-4 min-h-[360px] font-mono text-[12px] leading-relaxed" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
              <div className="mt-3 text-right font-mono text-[10.5px] text-slateink-400">{prompt.length.toLocaleString()} characters</div>
            </div>
          )}

          {tab === 'model' && (
            <div className="space-y-4">
              <div className="panel p-5">
                <h2 className="text-[14.5px] font-semibold text-slate-900">Language model</h2>
                <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">
                  The selected model is used only when its provider or custom endpoint is connected. Otherwise calls fall back to the built-in rule engine and record that engine on the call.
                </p>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="assistant-model">Model id</label>
                    <select id="assistant-model" className="field" value={model} onChange={(event) => setModel(event.target.value)}>
                      {!MODELS.some((entry) => entry.id === model) && <option value={model}>{model} · current custom id</option>}
                      {MODELS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.provider}</option>) }
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="assistant-temperature">Temperature · {temperature.toFixed(1)}</label>
                    <input id="assistant-temperature" type="range" min="0" max="1" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} className="w-full accent-[#2BE38B]" />
                  </div>
                </div>
                <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[12px] leading-relaxed text-amber-900">
                  Voice and transcription are deployment-level media providers in this build. This editor does not pretend an assistant-specific voice or transcriber is active.
                </p>
                <a href="/dashboard/providers" className="btn-quiet btn-sm mt-4">Review connected model providers</a>
              </div>
            </div>
          )}

          {tab === 'tools' && (
            <div className="panel p-5">
              <h2 className="text-[14.5px] font-semibold text-slate-900">Allowed tools</h2>
              <p className="mt-1.5 text-[12px] text-slateink-400">The runtime can call only the checked names. Save the assistant to apply this set.</p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {availableTools.map((entry) => {
                  const checked = tools.includes(entry.name);
                  return (
                    <label key={entry.name} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-4">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => setTools((current) => event.target.checked ? Array.from(new Set([...current, entry.name])) : current.filter((name) => name !== entry.name))}
                        className="mt-0.5 h-4 w-4 accent-[#2BE38B]"
                      />
                      <span className="min-w-0">
                        <span className="block font-mono text-[12px] text-slate-900">{entry.name}</span>
                        <span className="mt-1 block text-[11.5px] leading-snug text-slateink-400">{entry.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'knowledge' && (
            <div className="panel p-5">
              <h2 className="text-[14.5px] font-semibold text-slate-900">Retrievable text snippets</h2>
              <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">
                One factual snippet per line. The runtime searches these literal lines; files, URLs, vector embeddings, Notion and Drive ingestion are not available in this deployment.
              </p>
              <textarea
                className="field mt-4 min-h-[320px] font-mono text-[12px] leading-relaxed"
                value={knowledgeText}
                onChange={(event) => setKnowledgeText(event.target.value)}
                placeholder={'Opening hours are Monday to Friday, 09:00–17:00.\nEmergency work requires a human dispatcher.'}
              />
              <div className="mt-3 flex flex-wrap justify-between gap-2 font-mono text-[10.5px] text-slateink-400">
                <span>{knowledge.length} snippet{knowledge.length === 1 ? '' : 's'}</span>
                <span>{knowledge.join(' ').length.toLocaleString()} characters</span>
              </div>
            </div>
          )}

          {tab === 'versions' && (
            <div className="panel p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[14.5px] font-semibold text-slate-900">Immutable version history</h2>
                  <p className="mt-1.5 text-[12px] text-slateink-400">Edits and publishes create server snapshots. Restoring creates another version; it does not erase history.</p>
                </div>
                <Button variant="quiet" size="sm" onClick={() => void loadVersions()} disabled={versionsLoading}>
                  <Icons.refresh size={12} /> Refresh
                </Button>
              </div>
              {versionsLoading && !versions.length ? (
                <p className="mt-5 text-[12.5px] text-slateink-400">Loading versions…</p>
              ) : versions.length === 0 ? (
                <p className="mt-5 rounded-xl border border-dashed border-slate-900/[0.06] p-6 text-center text-[12.5px] text-slateink-400">No snapshots exist yet. Save or publish an edit to create one.</p>
              ) : (
                <div className="mt-5 divide-y divide-slate-900/[0.04]">
                  {versions.map((version) => (
                    <div key={version.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
                      <span className="font-mono text-[12.5px] text-slate-900">v{version.version}</span>
                      {version.current && <span className="badge border-brand-500/25 text-brand-700">current</span>}
                      <span className="min-w-0 flex-1 text-[12px] text-slateink-300">{version.message || 'Assistant snapshot'}</span>
                      <span className="font-mono text-[10.5px] text-slateink-400"><Ago at={version.createdAt} /></span>
                      {!version.current && (
                        <Button variant="quiet" size="sm" onClick={() => void rollback(version.version)} disabled={rollingBack !== null}>
                          <Icons.refresh size={12} /> {rollingBack === version.version ? 'Restoring…' : 'Restore'}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="xl:sticky xl:top-[74px] xl:h-fit">
          <div className="overflow-hidden rounded-2xl border border-slate-900/[0.045] bg-ink-850/50">
            <div className="flex items-center gap-2.5 border-b border-slate-900/[0.045] px-4 py-3">
              <Icons.waveform size={15} className="text-brand-700" />
              <span className="text-[13px] font-medium text-slate-900">Live runtime test</span>
              <span className="ml-auto font-mono text-[10px] text-slateink-400">stored as a web call</span>
            </div>
            <div ref={transcriptBox} className="no-scrollbar h-[330px] space-y-3 overflow-y-auto p-4" aria-live="polite">
              {turns.length === 0 && !thinking && (
                <div className="grid h-full place-items-center px-4 text-center">
                  <div>
                    <p className="text-[13px] leading-relaxed text-slateink-300">Test the saved server configuration. Tools use the same tenant-scoped runtime as other web calls.</p>
                    <p className="mt-2 text-[11.5px] text-amber-800">Unsaved edits above are not used until you save them.</p>
                  </div>
                </div>
              )}
              {turns.map((turn) => (
                <div key={turn.id} className={cn('flex', turn.role === 'user' && 'justify-end')}>
                  <div className={cn('max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[12.5px] leading-relaxed', turn.role === 'user' ? 'bg-slate-900 text-white' : 'border border-slate-900/[0.05] bg-ink-900/60 text-slateink-200')}>
                    {turn.text}
                  </div>
                </div>
              ))}
              {thinking && <p className="text-[11.5px] text-slateink-400">Runtime is answering…</p>}
            </div>
            <form
              className="border-t border-slate-900/[0.045] p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <label className="sr-only" htmlFor="assistant-test-message">Test message</label>
              <div className="flex gap-2">
                <input id="assistant-test-message" className="field min-w-0 flex-1" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type what the caller says…" disabled={thinking} />
                <Button type="submit" variant="brand" size="sm" disabled={!draft.trim() || thinking}><Icons.send size={13} /> Send</Button>
              </div>
            </form>
          </div>
        </aside>
      </div>
    </div>
  );
}
