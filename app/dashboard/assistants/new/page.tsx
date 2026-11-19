'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { ApiError, request } from '@/lib/server-sync';
import { MODELS, STARTER_TEMPLATES } from '@/lib/content';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, LinkButton, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

export default function NewAssistantPage() {
  const store = useStore();
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [model, setModel] = React.useState('gpt-5-chat');
  const [creating, setCreating] = React.useState(false);

  const template = STARTER_TEMPLATES.find((entry) => entry.id === selected);

  // Retired public template links can deep-link only to the small verified
  // in-product starter set; unsupported catalogue entries are ignored.
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('template');
    if (!id) return;
    const imported = STARTER_TEMPLATES.find((entry) => entry.id === id);
    if (!imported) return;
    setSelected(imported.id);
    setName(imported.name);
    setModel(imported.model);
  }, []);

  const create = async () => {
    const assistantName = name.trim() || template?.name || 'New Assistant';
    const registered = new Set(store.tools.map((tool) => tool.name));
    const requestedTools = template ? [...template.tools] : [];
    const tools = requestedTools.filter((tool) => registered.has(tool));
    setCreating(true);
    try {
      const assistant = await request<{ id: string; name: string }>('POST', '/api/v1/assistants', {
        name: assistantName,
        model,
        firstMessage: template?.firstMessage ?? `Hi, this is ${assistantName}. How can I help?`,
        systemPrompt: template?.prompt ?? 'Be concise and factual. Use only information and tools this workspace has explicitly provided. Ask one question at a time and transfer when unsure.',
        tools,
        knowledge: [],
      });
      await store.refreshFromServer();
      if (tools.length < requestedTools.length) {
        toast(`Draft created. ${requestedTools.length - tools.length} template tool${requestedTools.length - tools.length === 1 ? '' : 's'} were omitted because they are not registered in this workspace.`, 'info');
      } else {
        toast(`${assistant.name} created as a draft. Review it before publishing.`);
      }
      router.push(`/dashboard/assistants/${assistant.id}`);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The assistant could not be created.', 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="New assistant"
        desc="Start from a bounded draft recommendation or a blank configuration. Only tools already registered in this workspace are attached."
        breadcrumb={[{ label: 'Assistants', href: '/dashboard/assistants' }, { label: 'New' }]}
        actions={
          <LinkButton href="/dashboard/assistants" variant="ghost" size="sm">
            Cancel
          </LinkButton>
        }
      />

      <div>
        <h2 className="text-[14.5px] font-semibold text-slate-900">1 · Choose a starting point</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <button
            onClick={() => setSelected(null)}
            className={cn(
              'rounded-2xl border p-5 text-left transition-colors',
              selected === null ? 'border-brand-500/40 bg-brand-500/[0.07]' : 'border-slate-900/[0.045] bg-ink-850/50 hover:border-slate-900/[0.035]'
            )}
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.03] text-brand-700">
              <Icons.plus size={18} />
            </span>
            <div className="mt-4 text-[14.5px] font-medium text-slate-900">Blank assistant</div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">
              A conservative draft prompt with no tools attached. Configure and review it before publishing.
            </p>
          </button>

          {STARTER_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelected(t.id);
                setName(t.name);
                setModel(t.model);
              }}
              className={cn(
                'rounded-2xl border p-5 text-left transition-colors',
                selected === t.id ? 'border-brand-500/40 bg-brand-500/[0.07]' : 'border-slate-900/[0.045] bg-ink-850/50 hover:border-slate-900/[0.035]'
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="badge">{t.category}</span>
                {selected === t.id && <Icons.check size={16} className="text-brand-700" />}
              </div>
              <div className="mt-4 text-[14.5px] font-medium text-slate-900">{t.name}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">{t.desc}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {t.tools.slice(0, 3).map((tool) => (
                  <span key={tool} className="code-chip">
                    {tool}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <h2 className="text-[14.5px] font-semibold text-slate-900">2 · Name and defaults</h2>
          <div className="mt-5 space-y-4">
            <div>
              <label className="label">Assistant name</label>
              <input
                className="field"
                placeholder={template?.name ?? 'Support Concierge'}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Model identifier</label>
              <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id} className="bg-ink-900">
                    {m.label} · {m.provider} · verify availability
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.05] p-3.5">
              <span className="block text-[13px] font-medium text-slate-900">Starts as a draft</span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-slateink-400">
                The model identifier is stored configuration, not proof that a provider account can use it. Speech currently uses the deployment-level media provider and voice; this form does not imply assistant-specific voice routing.
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <h2 className="text-[14.5px] font-semibold text-slate-900">3 · What you get</h2>
          <ul className="mt-5 space-y-3">
            {[
              template ? `Prompt starting text: ${template.prompt.slice(0, 90)}…` : 'A conservative default prompt you can rewrite',
              template ? `${template.tools.filter((tool) => store.tools.some((registered) => registered.name === tool)).length} template tools currently registered in this workspace` : 'No tools attached by default',
              'An empty factual-snippet list; no sample business policies are invented',
              'A server-created draft that cannot receive published traffic yet',
              'Version snapshots when later edits or publishes occur',
            ].map((x) => (
              <li key={x} className="flex gap-2.5 text-[12.5px] leading-relaxed text-slateink-300">
                <Icons.check size={15} className="mt-0.5 shrink-0 text-brand-400" />
                {x}
              </li>
            ))}
          </ul>
          <Button variant="brand" className="mt-6 w-full py-3" disabled={creating} onClick={() => void create()}>
            <Icons.sparkles size={15} /> {creating ? 'Creating draft…' : 'Create draft assistant'}
          </Button>
          <p className="mt-3 text-center text-[11px] leading-relaxed text-slateink-400">
            The server validates role, tenant and tool registration before creating the record.
          </p>
        </div>
      </div>
    </div>
  );
}
