'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { Icons } from '@/components/icons';
import { Button, CopyButton, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

const PRESETS = [
  { label: 'List assistants', method: 'GET', path: '/api/v1/assistants', body: '' },
  { label: 'List recent calls', method: 'GET', path: '/api/v1/calls?limit=10', body: '' },
  { label: 'List registered tools', method: 'GET', path: '/api/v1/tools', body: '' },
  { label: 'Read usage', method: 'GET', path: '/api/v1/usage', body: '' },
  { label: 'Read analytics overview', method: 'GET', path: '/api/v1/analytics/overview?days=14', body: '' },
] as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Result = {
  method: Method;
  path: string;
  requestBody: string;
  status: number;
  statusText: string;
  latencyMs: number;
  requestId?: string;
  at: string;
  response: unknown;
};

export default function PlaygroundPage() {
  const store = useStore();
  const toast = useToast();
  const [method, setMethod] = React.useState<Method>('GET');
  const [path, setPath] = React.useState('/api/v1/assistants');
  const [body, setBody] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [active, setActive] = React.useState<Result | null>(null);
  const [history, setHistory] = React.useState<Result[]>([]);

  const loadPreset = (index: number) => {
    const preset = PRESETS[index] ?? PRESETS[0];
    setMethod(preset.method);
    setPath(preset.path);
    setBody(preset.body);
    setActive(null);
  };

  const send = async () => {
    let target: URL;
    try {
      target = new URL(path.trim(), window.location.origin);
    } catch {
      toast('Enter a valid API path.', 'error');
      return;
    }
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/v1/')) {
      toast('This console sends only same-origin /api/v1 requests.', 'error');
      return;
    }

    let parsedBody: unknown;
    if (method !== 'GET' && body.trim()) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        toast('The request body is not valid JSON.', 'error');
        return;
      }
    }

    setSending(true);
    const started = performance.now();
    try {
      const response = await fetch(`${target.pathname}${target.search}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: method === 'GET' || parsedBody === undefined ? undefined : { 'content-type': 'application/json' },
        body: method === 'GET' || parsedBody === undefined ? undefined : JSON.stringify(parsedBody),
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      const item: Result = {
        method,
        path: `${target.pathname}${target.search}`,
        requestBody: body,
        status: response.status,
        statusText: response.statusText,
        latencyMs: Math.round(performance.now() - started),
        requestId: response.headers.get('x-request-id') ?? undefined,
        at: new Date().toISOString(),
        response: payload,
      };
      setActive(item);
      setHistory((current) => [item, ...current].slice(0, 12));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The request failed before a response arrived.', 'error');
    } finally {
      setSending(false);
    }
  };

  const responseText = active ? JSON.stringify(active.response, null, 2) : '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="API console"
        desc="Send an actual request to this deployment with your current dashboard session. The normal tenant, role and validation checks still apply."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'API console' }]}
      />

      <div className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.06] p-4 text-[12.5px] leading-relaxed text-slateink-300">
        This is not an API-key simulator and it does not invent responses, quotas or request logs. Requests go to the selected <code className="font-mono text-slate-900">/api/v1</code> route as <span className="text-slate-900">{store.connection.user?.email ?? 'the signed-in user'}</span>. Mutating methods change real workspace data.
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:items-start">
        <div className="panel p-5">
          <label className="label" htmlFor="console-preset">Safe read presets</label>
          <select id="console-preset" className="field" defaultValue="0" onChange={(event) => loadPreset(Number(event.target.value))}>
            {PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}
          </select>

          <div className="mt-5 grid grid-cols-[110px_minmax(0,1fr)] gap-3">
            <div>
              <label className="label" htmlFor="console-method">Method</label>
              <select id="console-method" className="field font-mono" value={method} onChange={(event) => setMethod(event.target.value as Method)}>
                <option>GET</option>
                <option>POST</option>
                <option>PATCH</option>
                <option>DELETE</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="console-path">Same-origin path</label>
              <input id="console-path" className="field font-mono text-[11.5px]" value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} />
            </div>
          </div>

          {method !== 'GET' && (
            <div className="mt-4">
              <label className="label" htmlFor="console-body">JSON body</label>
              <textarea id="console-body" rows={12} className="field font-mono text-[11.5px] leading-relaxed" placeholder="{}" value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="brand" size="sm" disabled={sending} onClick={() => void send()}>
              <Icons.send size={13} /> {sending ? 'Sending…' : 'Send actual request'}
            </Button>
            <CopyButton value={`${method} ${path}`} label="Copy request line" />
          </div>
        </div>

        <div className="space-y-4">
          <div className="panel overflow-hidden">
            <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-slate-900/[0.04] px-4 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Actual response</span>
              {active && (
                <span className="flex flex-wrap items-center gap-3">
                  <Pill tone={active.status < 300 ? 'brand' : active.status < 500 ? 'warn' : 'danger'}>{active.status}</Pill>
                  <span className="font-mono text-[10.5px] text-slateink-400">{active.latencyMs}ms</span>
                  {active.requestId && <span className="font-mono text-[10.5px] text-slateink-400">{active.requestId}</span>}
                  <CopyButton value={responseText} label="Copy JSON" />
                </span>
              )}
            </div>
            <pre className="min-h-56 max-h-[620px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11.5px] leading-relaxed text-slateink-200">
              {active ? responseText : '// Send a request and its server response will appear here.'}
            </pre>
          </div>

          {history.length > 0 && (
            <div className="panel overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-slate-900/[0.04] px-4 py-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">This browser session</span>
                <Button variant="quiet" size="sm" onClick={() => { setHistory([]); setActive(null); }}>Clear</Button>
              </div>
              {history.map((item, index) => (
                <button
                  key={`${item.at}-${index}`}
                  type="button"
                  onClick={() => setActive(item)}
                  className="flex w-full flex-wrap items-center gap-3 border-b border-slate-900/[0.035] px-4 py-2.5 text-left last:border-0 hover:bg-slate-900/[0.02]"
                >
                  <Pill tone={item.method === 'GET' ? 'info' : item.method === 'DELETE' ? 'danger' : 'brand'}>{item.method}</Pill>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slateink-200">{item.path}</span>
                  <span className={`font-mono text-[11.5px] ${item.status < 300 ? 'text-brand-700' : 'text-rose-700'}`}>{item.status}</span>
                  <span className="font-mono text-[10.5px] text-slateink-400">{item.latencyMs}ms</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
