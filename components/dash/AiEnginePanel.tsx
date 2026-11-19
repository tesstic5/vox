'use client';

/**
 * Model keys.
 *
 * The engine that answers a call is a property of the workspace: connect an
 * Anthropic or OpenAI key and every assistant pinned to that provider answers with
 * a real model, tools and all. Without one, assistants answer with the built-in
 * rule engine — which is a working agent, just a less clever one, and this panel
 * says so plainly rather than pretending.
 *
 * Keys are never rendered back: the API returns a masked hint and a verification
 * result, and this component only ever displays what it is given.
 */

import * as React from 'react';
import Link from 'next/link';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Pill, useToast } from '@/components/ui';
import { DataTable } from '@/components/dash/bits';

type Provider = {
  id: string;
  label: string;
  wire: string;
  byo?: boolean;
  docs: string;
  keyEnv: string;
  authStyle?: string;
  endpointModels?: string[];
  headerNames?: string[];
  note?: string;
  baseUrl: string;
  hasWorkspaceKey: boolean;
  hasEnvKey: boolean;
  keyHint?: string;
  verified: boolean;
  verifiedAt?: string;
  lastError?: string;
  lastUsedAt?: string;
  ready: boolean;
  source?: 'workspace' | 'env';
  defaultModel?: string;
};

type Credential = {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  keyHint: string;
  baseUrl?: string;
  wire?: string;
  authStyle?: string;
  headerNames?: string[];
  models?: string[];
  note?: string;
  verified: boolean;
  verifiedAt?: string;
  modelCount?: number;
  lastError?: string;
  lastUsedAt?: string;
};

type ModelRow = {
  id: string;
  label: string;
  provider: string;
  context: string;
  latency: string;
  inputCost: number;
  outputCost: number;
  pricingAvailable: boolean;
  ready: boolean;
  isDefaultForProvider: boolean;
};

type ModelsResponse = {
  engine: 'model' | 'rules';
  note: string;
  providers: Provider[];
  models: ModelRow[];
  custom: { baseUrl: string; wire: string; authStyle: string; verified: boolean; models: string[]; error?: string; note?: string } | null;
};

/**
 * Extra headers, typed one per line as `name: value`.
 *
 * A textarea rather than a key/value repeater: what people actually paste is a
 * block from their gateway's docs, and this keeps it copy-pasteable.
 */
function parseHeaders(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

export function AiEnginePanel() {
  const toast = useToast();
  const [data, setData] = React.useState<ModelsResponse | null>(null);
  const [credentials, setCredentials] = React.useState<Credential[]>([]);
  const [form, setForm] = React.useState({
    provider: 'anthropic',
    apiKey: '',
    label: '',
    baseUrl: '',
    wire: 'openai' as 'openai' | 'anthropic',
    authStyle: 'bearer' as 'bearer' | 'x-api-key' | 'none',
    headers: '',
  });
  const [test, setTest] = React.useState<{ reply: string; model: string; latencyMs: number } | null>(null);
  const [busy, setBusy] = React.useState('');
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [models, creds] = await Promise.all([
        request<ModelsResponse>('GET', '/api/v1/ai/models'),
        request<{ data: Credential[] }>('GET', '/api/v1/ai/credentials'),
      ]);
      setData(models);
      setCredentials(creds.data ?? []);
    } catch {
      setData(null);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy('connect');
    try {
      const byo = (data?.providers ?? []).find((p) => p.id === form.provider)?.byo;
      const res = await request<Credential & { verification: { models: number; note: string } }>('POST', '/api/v1/ai/credentials', {
        provider: form.provider,
        apiKey: form.apiKey.trim(),
        label: form.label || undefined,
        ...(byo
          ? {
              baseUrl: form.baseUrl.trim(),
              wire: form.wire,
              authStyle: form.authStyle,
              headers: parseHeaders(form.headers),
            }
          : {}),
      });
      toast(res.verification?.note ?? 'Key connected.');
      setForm({ ...form, apiKey: '', label: '', headers: '' });
      setOpen(false);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not connect the key', 'error');
    } finally {
      setBusy('');
    }
  };

  const verify = async (id: string) => {
    setBusy(`verify:${id}`);
    try {
      const res = await request<{ models: number; note: string }>('POST', `/api/v1/ai/credentials/${id}`, {});
      toast(res.note);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Re-verify failed', 'error');
      await load();
    } finally {
      setBusy('');
    }
  };

  /** One real completion, on the customer's key — the honest end-to-end proof. */
  const sendTest = async (credential: Credential) => {
    setBusy(`test:${credential.id}`);
    setTest(null);
    try {
      const res = await request<{ reply: string; model: string; latencyMs: number }>('POST', `/api/v1/ai/credentials/${credential.id}`, {
        action: 'test',
      });
      setTest(res);
      toast(`${res.model} answered in ${res.latencyMs} ms.`);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The endpoint did not answer', 'error');
      await load();
    } finally {
      setBusy('');
    }
  };

  const remove = async (credential: Credential) => {
    if (!window.confirm(`Delete the ${credential.providerLabel} key? Assistants on it fall back to the rule engine immediately.`)) return;
    setBusy(`delete:${credential.id}`);
    try {
      await request('DELETE', `/api/v1/ai/credentials/${credential.id}`);
      toast(`${credential.providerLabel} key deleted.`);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Delete failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const ready = (data?.providers ?? []).filter((p) => p.ready);
  const engine = data?.engine ?? 'rules';
  const byo = (data?.providers ?? []).find((p) => p.id === form.provider)?.byo === true;
  const verification = data?.custom && form.provider === 'custom' ? data.custom : null;
  const customCredential = credentials.find((c) => c.provider === 'custom');

  return (
    <div className="space-y-4">
      <div className={cn('flex flex-wrap items-start justify-between gap-4 rounded-2xl border px-5 py-4', engine === 'model' ? 'border-brand-500/25 bg-brand-500/[0.05]' : 'border-amber-400/25 bg-amber-400/[0.05]')}>
        <div className="flex items-start gap-3">
          <Icons.sparkles size={17} className={cn('mt-0.5 shrink-0', engine === 'model' ? 'text-brand-700' : 'text-amber-800')} />
          <div>
            <p className="text-[13.5px] text-slate-900">
              {engine === 'model' ? `Real models are answering: ${ready.map((p) => p.label).join(', ')}` : 'Running on the built-in rule engine'}
            </p>
            <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">{data?.note ?? 'Checking which engines are configured…'}</p>
          </div>
        </div>
        <Button variant="brand" size="sm" onClick={() => setOpen((v) => !v)}>
          <Icons.plus size={13} /> {open ? 'Close' : 'Connect a model key'}
        </Button>
      </div>

      {test && (
        <div className="rounded-2xl border border-brand-500/25 bg-brand-500/[0.05] px-5 py-4">
          <div className="flex items-center gap-2">
            <Icons.sparkles size={14} className="text-brand-700" />
            <span className="text-[13px] text-slate-900">
              {test.model} answered in {test.latencyMs} ms
            </span>
          </div>
          <p className="mt-1.5 font-mono text-[12px] text-slateink-200">{test.reply}</p>
          <p className="mt-1.5 text-[11.5px] text-slateink-400">
            A real completion on your key — this is the same path a call takes. Nothing was billed by Voxera for it.
          </p>
        </div>
      )}

      {open && (
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Provider</span>
              <select className="field" value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}>
                {(data?.providers ?? []).map((p) => (
                  <option key={p.id} value={p.id} className="bg-ink-900">
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Label</span>
              <input className="field" placeholder="Northwind Claude" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">API key</span>
              <input
                className="field font-mono text-[12.5px]"
                type="password"
                spellCheck={false}
                placeholder={form.authStyle === 'none' ? 'not needed' : 'sk-…'}
                value={form.apiKey}
                disabled={form.authStyle === 'none'}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            </label>
          </div>

          {/* Bring-your-own endpoint: everything we cannot know on their behalf. */}
          {byo && (
            <div className="mt-5 space-y-4 rounded-xl border border-slate-900/[0.045] bg-ink-900/40 p-4">
              <div>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Base URL</span>
                  <input
                    className="field font-mono text-[12.5px]"
                    spellCheck={false}
                    placeholder="https://ai.yourcompany.com/v1"
                    value={form.baseUrl}
                    onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  />
                </label>
                <p className="mt-1.5 text-[11.5px] text-slateink-400">
                  Anything that speaks an OpenAI or Anthropic API: your own service, LiteLLM, vLLM, Ollama, OpenRouter, a regional gateway.
                  {form.baseUrl.trim() ? (
                    <>
                      {' '}
                      Voxera will POST to <span className="font-mono text-slateink-300">{form.baseUrl.trim().replace(/\/+$/, '')}{form.wire === 'anthropic' ? '/v1/messages' : '/chat/completions'}</span>.
                    </>
                  ) : null}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">Wire format</span>
                  <select className="field" value={form.wire} onChange={(e) => setForm((f) => ({ ...f, wire: e.target.value as 'openai' | 'anthropic' }))}>
                    <option value="openai" className="bg-ink-900">OpenAI chat completions</option>
                    <option value="anthropic" className="bg-ink-900">Anthropic Messages</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-slateink-400">How the key travels</span>
                  <select
                    className="field"
                    value={form.authStyle}
                    onChange={(e) => setForm((f) => ({ ...f, authStyle: e.target.value as 'bearer' | 'x-api-key' | 'none' }))}
                  >
                    <option value="bearer" className="bg-ink-900">Authorization: Bearer &lt;key&gt;</option>
                    <option value="x-api-key" className="bg-ink-900">x-api-key: &lt;key&gt;</option>
                    <option value="none" className="bg-ink-900">No key (local server)</option>
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-slateink-400">Extra headers — one per line, <span className="font-mono">name: value</span></span>
                <textarea
                  className="field h-20 font-mono text-[12px]"
                  spellCheck={false}
                  placeholder={'x-tenant: northwind\nx-litellm-key: …'}
                  value={form.headers}
                  onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                />
              </label>
              <p className="text-[11.5px] text-slateink-400">
                The key and these headers are encrypted at rest and never returned by any read — the API hands back header <em>names</em> only.
              </p>
            </div>
          )}

          {verification && (
            <div className={cn('mt-4 rounded-xl border px-4 py-3 text-[12.5px]', verification.verified ? 'border-brand-500/25 bg-brand-500/[0.05] text-slateink-200' : 'border-amber-400/25 bg-amber-400/[0.05] text-amber-800')}>
              {verification.note}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="brand"
              size="sm"
              onClick={() => void connect()}
              disabled={busy === 'connect' || (byo ? !form.baseUrl.trim() || (form.authStyle !== 'none' && form.apiKey.trim().length < 8) : form.apiKey.trim().length < 12)}
            >
              {busy === 'connect' ? 'Checking with the provider…' : 'Connect & verify'}
            </Button>
            <span className="text-[12px] text-slateink-400">
              {byo
                ? 'Verified by asking the endpoint for its model list (free). If it does not publish one, the key is saved unverified — use “Send a test message”.'
                : `${(data?.providers ?? []).find((p) => p.id === form.provider)?.docs ?? ''} — the key is verified by listing models (free) and stored encrypted.`}
            </span>
          </div>
        </div>
      )}

      <DataTable
        columns={[
          { key: 'provider', label: 'Provider' },
          { key: 'key', label: 'Key' },
          { key: 'source', label: 'Source' },
          { key: 'state', label: 'State' },
          { key: 'used', label: 'Last used', align: 'right' },
          { key: 'actions', label: '', align: 'right' },
        ]}
      >
        {(data?.providers ?? []).map((p) => {
          const credential = credentials.find((c) => c.provider === p.id);
          return (
            <tr key={p.id} className="transition-colors hover:bg-slate-900/[0.02]">
              <td className="px-4 py-3">
                <div className="text-[13px] text-slate-900">{p.label}</div>
                <div className="font-mono text-[10.5px] text-slateink-400">
                  {p.byo
                    ? p.baseUrl
                      ? `${p.baseUrl} · ${p.wire === 'anthropic' ? 'Messages API' : 'chat completions'}`
                      : 'no endpoint connected yet'
                    : `${p.wire === 'anthropic' ? 'Messages API' : 'chat completions'} · default ${p.defaultModel}`}
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-[11.5px] text-slateink-300">{credential?.keyHint ?? (p.hasEnvKey ? 'deployment key' : '—')}</td>
              <td className="px-4 py-3">
                {p.hasWorkspaceKey ? (
                  <Pill tone="brand">workspace</Pill>
                ) : p.hasEnvKey ? (
                  <Pill tone="info">environment</Pill>
                ) : (
                  <Pill>not configured</Pill>
                )}
              </td>
              <td className="px-4 py-3">
                {p.ready ? (
                  <div className="flex items-center gap-2">
                    <Pill tone="brand">ready</Pill>
                    {credential?.modelCount ? <span className="text-[11.5px] text-slateink-400">{credential.modelCount} models</span> : null}
                    {p.byo && credential && !credential.verified && <Pill tone="warn">unverified</Pill>}
                  </div>
                ) : (
                  <Pill tone="warn">rules fallback</Pill>
                )}
                {p.byo && credential?.models?.length ? (
                  <div className="mt-1 font-mono text-[10.5px] text-slateink-400">
                    {credential.models.slice(0, 3).join(', ')}
                    {credential.models.length > 3 ? ` +${credential.models.length - 3} more` : ''}
                  </div>
                ) : null}
                {p.lastError && <div className="mt-1 font-mono text-[10.5px] text-amber-800">{p.lastError.slice(0, 90)}</div>}
                {p.byo && credential?.note && !credential.verified ? (
                  <div className="mt-1 text-[10.5px] text-amber-800">{credential.note.slice(0, 120)}</div>
                ) : null}
              </td>
              <td className="px-4 py-3 text-right text-[11.5px] text-slateink-400">{credential?.lastUsedAt ? <Ago at={credential.lastUsedAt} /> : '—'}</td>
              <td className="px-4 py-3 text-right">
                {credential ? (
                  <div className="flex justify-end gap-2">
                    {p.byo && (
                      <Button variant="ghost" size="sm" onClick={() => void sendTest(credential)} disabled={busy === `test:${credential.id}`}>
                        {busy === `test:${credential.id}` ? 'Asking…' : 'Send a test message'}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void verify(credential.id)} disabled={busy === `verify:${credential.id}`}>
                      {busy === `verify:${credential.id}` ? 'Checking…' : 'Verify'}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void remove(credential)} disabled={busy === `delete:${credential.id}`}>
                      Delete
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => { setForm((f) => ({ ...f, provider: p.id })); setOpen(true); }}>
                    Connect
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </DataTable>

      {credentials.length === 0 && !(data?.providers ?? []).some((p) => p.hasEnvKey) && (
        <EmptyState
          icon="sparkles"
          title="No model key connected"
          desc="Every assistant works right now on the built-in rule engine — intents, guardrails, tools and bookings all run. Connect a hosted key, or point Voxera at your own endpoint to have a real model decide instead, with the same tools."
          action={
            <Button variant="brand" size="sm" onClick={() => setOpen(true)}>
              Connect a model key
            </Button>
          }
        />
      )}

      {customCredential?.baseUrl && (
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
          <h3 className="h4">Your own endpoint</h3>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">
            Assistants pinned to <span className="font-mono text-slateink-300">provider: &quot;custom&quot;</span> — or naming a model no hosted provider
            publishes — run on <span className="font-mono text-slateink-300">{customCredential.baseUrl}</span>. Pricing is yours, not ours: Voxera cannot know what your
            endpoint costs per token, so these turns are metered at zero provider cost and the platform minute is the only thing on the Voxera invoice.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {(customCredential.models ?? []).map((id) => (
              <div key={id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-3">
                <span className="truncate font-mono text-[12px] text-slate-900">{id}</span>
                <Pill tone="brand">ready</Pill>
              </div>
            ))}
            {!(customCredential.models ?? []).length && (
              <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-3 text-[12px] text-slateink-400">
                The endpoint did not publish a model list — type the model id on an assistant, or send a test message to confirm.
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => void sendTest(customCredential)} disabled={busy === `test:${customCredential.id}`}>
              {busy === `test:${customCredential.id}` ? 'Asking…' : 'Send a test message'}
            </Button>
            <Link href="/dashboard/assistants" className="self-center text-[12.5px] text-brand-700 hover:text-brand-700">
              Pick it on an assistant →
            </Link>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="h4">Catalogue</h3>
            <p className="mt-1 text-[12.5px] text-slateink-400">
              Stored model identifiers for assistant configuration. A credential marker does not prove that the provider account can use a particular model; verify it in the target environment.
            </p>
          </div>
          <Link href="/dashboard/assistants" className="text-[12.5px] text-brand-700 hover:text-brand-700">
            Choose a model per assistant →
          </Link>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {(data?.models ?? []).map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] text-slate-900">{m.label}</span>
                  {m.isDefaultForProvider && <Pill>default</Pill>}
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] text-slateink-400">
                  {m.provider} · context, latency and pricing are provider-defined
                </div>
              </div>
              <Pill tone={m.ready ? 'brand' : 'default'}>{m.ready ? 'credential present' : 'needs key'}</Pill>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
