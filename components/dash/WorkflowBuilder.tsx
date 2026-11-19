'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import type { WorkflowEdge, WorkflowNode, WorkflowNodeKind } from '@/lib/types';
import { NODE_KINDS, nodeKind, validateWorkflow, workflowStats } from '@/lib/workflows';
import { Icons } from '../icons';
import { Button, EmptyState, Modal, Pill, useToast } from '../ui';
import { PageHeader } from './Shell';

const NODE_W = 196;
const NODE_H = 92;

const ICON_FOR: Record<WorkflowNodeKind, keyof typeof Icons> = {
  start: 'play',
  prompt: 'sparkles',
  dtmf: 'hash',
  api: 'cloud',
  branch: 'branch',
  validate: 'shield',
  transfer: 'phoneForwarded',
  end: 'check',
};

const STATUS_TONE: Record<string, 'brand' | 'warn' | 'info' | 'default'> = {
  published: 'brand',
  staged: 'info',
  draft: 'warn',
};

export function WorkflowBuilder({ id }: { id: string }) {
  const store = useStore();
  const toast = useToast();
  const router = useRouter();
  const wf = store.workflows.find((w) => w.id === id);

  const [selected, setSelected] = React.useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = React.useState<string | null>(null);
  const [connectFrom, setConnectFrom] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [showIssues, setShowIssues] = React.useState(true);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [drag, setDrag] = React.useState<{ id: string; dx: number; dy: number } | null>(null);
  const canvasRef = React.useRef<HTMLDivElement>(null);

  const issues = React.useMemo(
    () => (wf ? validateWorkflow(wf) : []),
    [wf?.nodes, wf?.edges, wf?.name] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const stats = wf ? workflowStats(wf) : null;

  // Pointer-driven node dragging, committed to the store on release.
  React.useEffect(() => {
    if (!drag || !wf) return;
    const move = (e: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(8, Math.round((e.clientX - rect.left) / zoom - drag.dx));
      const y = Math.max(8, Math.round((e.clientY - rect.top) / zoom - drag.dy));
      store.updateWorkflowNode(wf.id, drag.id, { x: x - (x % 8), y: y - (y % 8) });
    };
    const up = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, wf?.id, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConnectFrom(null);
        setSelectedEdge(null);
      }
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  if (!wf) {
    return (
      <EmptyState
        icon="branch"
        title="Workflow not found"
        desc="It may have been deleted, or this link came from a different browser profile — the dashboard stores its demo data locally."
        action={
          <Button variant="brand" size="sm" onClick={() => router.push('/dashboard/workflows')}>
            Back to workflows
          </Button>
        }
      />
    );
  }

  const nodeById = new Map(wf.nodes.map((n) => [n.id, n]));
  const selNode = selected ? nodeById.get(selected) ?? null : null;
  const selEdge = selectedEdge ? wf.edges.find((e) => e.id === selectedEdge) ?? null : null;

  const addNode = (kind: WorkflowNodeKind, at?: { x: number; y: number }) => {
    const cols = Math.floor((wf.nodes.length || 1) / 4);
    const node = store.addWorkflowNode(wf.id, kind, at?.x ?? 40 + cols * 240, at?.y ?? 80 + ((wf.nodes.length % 4) * 120));
    if (node) {
      setSelected(node.id);
      setSelectedEdge(null);
    }
  };

  const handleNodeClick = (node: WorkflowNode) => {
    if (connectFrom && connectFrom !== node.id) {
      store.addWorkflowEdge(wf.id, { from: connectFrom, to: node.id, label: '' });
      toast(`Path added: ${nodeById.get(connectFrom)?.label} → ${node.label}`);
      setConnectFrom(null);
      return;
    }
    setSelected(node.id);
    setSelectedEdge(null);
  };

  const removeNode = () => {
    if (!selNode) return;
    store.removeWorkflowNode(wf.id, selNode.id);
    setSelected(null);
    toast(`Removed ${selNode.label} and its paths.`);
  };

  const centre = (n: WorkflowNode) => ({ x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });

  return (
    <div className="space-y-5">
      <PageHeader
        title={wf.name}
        desc={wf.description}
        breadcrumb={[{ label: 'Workflows', href: '/dashboard/workflows' }, { label: `v${wf.version}` }]}
        actions={
          <>
            <Link
              href="/docs"
              className="btn-ghost btn-sm inline-flex items-center gap-1.5"
            >
              <Icons.book size={13} /> Docs
            </Link>
            <Button variant="ghost" size="sm" onClick={() => setShowIssues((v) => !v)}>
              <Icons.shield size={13} /> {errors.length} errors · {warnings.length} warnings
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={errors.length > 0}
              title={errors.length ? 'Fix the blocking errors before publishing' : 'Publish this version'}
              onClick={() => {
                store.publishWorkflow(wf.id, 'published');
                toast(`Published v${wf.version.split('.').slice(0, 2).join('.')} — live on the next call.`);
              }}
            >
              <Icons.check size={14} /> Publish
            </Button>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_320px]">
        {/* palette */}
        <div className="panel h-fit p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Nodes</div>
          <div className="mt-3 space-y-1.5">
            {NODE_KINDS.map((k) => {
              const Icon = Icons[k.icon];
              return (
                <button
                  key={k.kind}
                  onClick={() => addNode(k.kind)}
                  className="group flex w-full items-start gap-2.5 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-2.5 text-left transition-colors hover:border-brand-500/30 hover:bg-ink-850"
                >
                  <Icon size={14} className={cn('mt-0.5 shrink-0', k.tone)} />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-slate-900">{k.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-slateink-400">{k.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="hairline my-4" />
          <div className="grid grid-cols-3 gap-1.5">
            {[
              [String(stats?.nodes ?? 0), 'nodes'],
              [String(stats?.edges ?? 0), 'paths'],
              [String(stats?.deterministic ?? 0), 'fixed'],
            ].map(([v, l]) => (
              <div key={l} className="rounded-lg border border-slate-900/[0.04] bg-ink-900/40 p-2 text-center">
                <div className="text-[14px] font-semibold text-slate-900">{v}</div>
                <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-slateink-400">{l}</div>
              </div>
            ))}
          </div>

          <div className="hairline my-4" />
          <label className="label" htmlFor="wf-assistant">
            Attached assistant
          </label>
          <select
            id="wf-assistant"
            className="field text-[12.5px]"
            value={wf.assistantId ?? ''}
            onChange={(e) => store.updateWorkflow(wf.id, { assistantId: e.target.value || null })}
          >
            <option value="">Not attached</option>
            {store.assistants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-relaxed text-slateink-400">
            A workflow only runs on calls handled by this assistant.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="quiet" size="sm" onClick={() => router.push(`/dashboard/simulations?assistant=${wf.assistantId ?? ''}&scenario=${encodeURIComponent(wf.name)}`)}>
              <Icons.flask size={13} /> Simulate
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setConfirmDelete(true)}>
              <Icons.trash size={13} /> Delete
            </Button>
          </div>
        </div>

        {/* canvas */}
        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-slate-900/[0.04] px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Pill tone={STATUS_TONE[wf.status] ?? 'default'}>{wf.status}</Pill>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">
                v{wf.version} · edited <Ago at={wf.updatedAt} />
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {connectFrom && (
                <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-700">
                  pick a target · esc to cancel
                </span>
              )}
              <button
                onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))}
                className="rounded-md border border-slate-900/[0.035] px-2 py-1 text-[12px] text-slateink-300 hover:text-slate-900"
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="w-10 text-center font-mono text-[10.5px] text-slateink-400">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(1.3, +(z + 0.1).toFixed(2)))}
                className="rounded-md border border-slate-900/[0.035] px-2 py-1 text-[12px] text-slateink-300 hover:text-slate-900"
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
          </div>

          <div className="relative overflow-auto bg-grid" style={{ maxHeight: 620 }}>
            <div
              ref={canvasRef}
              className="relative"
              style={{ width: 2100 * zoom, height: 1000 * zoom }}
              onClick={() => {
                setSelected(null);
                setSelectedEdge(null);
              }}
            >
              <div
                className="absolute left-0 top-0"
                style={{ width: 2100, height: 1000, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
              >
                <svg width={2100} height={1000} className="absolute left-0 top-0" aria-hidden>
                  <defs>
                    <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#3E4A5B" />
                    </marker>
                    <marker id="wf-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#2BE38B" />
                    </marker>
                  </defs>
                  {wf.edges.map((e) => {
                    const a = nodeById.get(e.from);
                    const b = nodeById.get(e.to);
                    if (!a || !b) return null;
                    const from = centre(a);
                    const to = centre(b);
                    const startX = from.x + NODE_W / 2 - 6;
                    const endX = to.x - NODE_W / 2 + 6;
                    const midX = (startX + endX) / 2;
                    const isSel = selectedEdge === e.id;
                    const d =
                      endX > startX
                        ? `M ${startX} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${endX} ${to.y}`
                        : `M ${from.x + NODE_W / 2 - 6} ${from.y} C ${from.x + 60} ${from.y}, ${to.x + NODE_W / 2 + 60} ${to.y}, ${to.x + NODE_W / 2 + 4} ${to.y}`;
                    return (
                      <g key={e.id} className="cursor-pointer" onClick={(ev) => { ev.stopPropagation(); setSelectedEdge(e.id); setSelected(null); }}>
                        <path d={d} fill="none" stroke={isSel ? '#2BE38B' : '#3E4A5B'} strokeWidth={isSel ? 2 : 1.4} markerEnd={isSel ? 'url(#wf-arrow-sel)' : 'url(#wf-arrow)'} />
                        {e.label && (
                          <text x={midX} y={(from.y + to.y) / 2 - 8} textAnchor="middle" className="fill-slateink-400" style={{ fontSize: 10.5, fontFamily: 'ui-monospace, monospace' }}>
                            {e.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>

                {wf.nodes.map((n) => {
                  const meta = nodeKind(n.kind);
                  const Icon = Icons[ICON_FOR[n.kind]] ?? Icons.sparkles;
                  const isSel = selected === n.id;
                  const isConnectSource = connectFrom === n.id;
                  const issueCount = issues.filter((i) => i.nodeId === n.id).length;
                  const hasError = issues.some((i) => i.nodeId === n.id && i.severity === 'error');
                  return (
                    <div
                      key={n.id}
                      className={cn(
                        'absolute select-none rounded-xl border bg-ink-850/95 p-3 text-left shadow-panel backdrop-blur transition-colors',
                        isSel ? 'border-brand-400/70' : hasError ? 'border-rose-400/50' : 'border-slate-900/[0.035] hover:border-slate-900/[0.09]',
                        isConnectSource && 'ring-2 ring-brand-400/60'
                      )}
                      style={{ left: n.x, top: n.y, width: NODE_W, minHeight: NODE_H }}
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).closest('button')) return;
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setDrag({ id: n.id, dx: e.clientX - rect.left, dy: e.clientY - rect.top });
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNodeClick(n);
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <Icon size={13} className={cn('shrink-0', meta.tone)} />
                          <span className="truncate text-[12.5px] font-medium text-slate-900">{n.label}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {issueCount > 0 && (
                            <span className={cn('font-mono text-[9.5px]', hasError ? 'text-rose-700' : 'text-amber-800')}>
                              {issueCount}
                            </span>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConnectFrom(isConnectSource ? null : n.id);
                            }}
                            className="rounded border border-slate-900/[0.04] px-1 text-[10px] text-slateink-300 hover:border-brand-400/40 hover:text-brand-700"
                            title="Start a path from this node"
                          >
                            ⤳
                          </button>
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-slateink-400">{n.text}</p>
                      <div className="mt-2 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-slateink-400">
                        <span>{n.kind}</span>
                        {n.config.writes && <span className="text-brand-700">→ {n.config.writes}</span>}
                        {n.config.onError && <span className="text-emerald-800">err</span>}
                        {n.kind === 'api' && n.config.timeoutMs && <span>{n.config.timeoutMs}ms</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-900/[0.04] px-4 py-2.5">
            <p className="text-[11.5px] text-slateink-400">
              Drag to move · <span className="font-mono text-slateink-300">⤳</span> then click a node to connect · click a path to rename it
            </p>
            <div className="flex items-center gap-2">
              <Link href={`/dashboard/simulations`} className="btn-ghost btn-sm">
                <Icons.flask size={13} /> Run simulations
              </Link>
              <Button variant="ghost" size="sm" onClick={() => addNode('prompt')}>
                <Icons.plus size={13} /> Prompt
              </Button>
            </div>
          </div>
        </div>

        {/* inspector */}
        <div className="space-y-4">
          <div className="panel p-4">
            {selNode ? (
              <Inspector
                node={selNode}
                issues={issues.filter((i) => i.nodeId === selNode.id)}
                onChange={(patch) => store.updateWorkflowNode(wf.id, selNode.id, patch)}
                onRemove={removeNode}
              />
            ) : selEdge ? (
              <EdgeInspector
                edge={selEdge}
                from={nodeById.get(selEdge.from)?.label ?? '?'}
                to={nodeById.get(selEdge.to)?.label ?? '?'}
                onChange={(patch) => store.updateWorkflowEdge(wf.id, selEdge.id, patch)}
                onRemove={() => {
                  store.removeWorkflowEdge(wf.id, selEdge.id);
                  setSelectedEdge(null);
                }}
              />
            ) : (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Inspector</div>
                <p className="mt-3 text-[12.5px] leading-relaxed text-slateink-400">
                  Select a node to edit what it says, what it writes, and what happens when it fails. Select a path to
                  rename the condition that leads down it.
                </p>
                <div className="hairline my-4" />
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Paths</div>
                <div className="mt-3 space-y-1.5">
                  {wf.edges.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        setSelectedEdge(e.id);
                        setSelected(null);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[11.5px] transition-colors',
                        selectedEdge === e.id
                          ? 'border-brand-400/50 text-slate-900'
                          : 'border-slate-900/[0.04] text-slateink-300 hover:border-slate-900/[0.045]'
                      )}
                    >
                      <span className="truncate">
                        {nodeById.get(e.from)?.label} → {nodeById.get(e.to)?.label}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-slateink-400">{e.label || 'default'}</span>
                    </button>
                  ))}
                  {wf.edges.length === 0 && (
                    <p className="text-[11.5px] text-slateink-400">No paths yet. Use ⤳ on a node, then click its target.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {showIssues && (
            <div className="panel p-4">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">
                  Validation · {errors.length ? `${errors.length} blocking` : 'ready to publish'}
                </div>
                <button
                  onClick={() => setShowIssues(false)}
                  className="text-slateink-400 hover:text-slate-900"
                  aria-label="Hide validation panel"
                >
                  <Icons.close size={12} />
                </button>
              </div>
              <div className="mt-3 space-y-2">
                {issues.length === 0 && (
                  <p className="text-[12px] leading-relaxed text-emerald-700">
                    Every node is reachable, every failure has a stated path, and nothing writes a variable that is never
                    read.
                  </p>
                )}
                {issues.map((i, idx) => (
                  <button
                    key={`${i.nodeId}-${idx}`}
                    onClick={() => {
                      if (i.nodeId) {
                        setSelected(i.nodeId);
                        setSelectedEdge(null);
                      }
                    }}
                    className="flex w-full items-start gap-2 rounded-lg border border-slate-900/[0.04] bg-ink-900/40 p-2.5 text-left transition-colors hover:border-slate-900/[0.035]"
                  >
                    {i.severity === 'error' ? (
                      <Icons.close size={12} className="mt-0.5 shrink-0 text-rose-700" />
                    ) : (
                      <Icons.alert size={12} className="mt-0.5 shrink-0 text-amber-800" />
                    )}
                    <span className="text-[11.5px] leading-relaxed text-slateink-200">{i.message}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="panel p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Version history</div>
            <div className="mt-3 space-y-3">
              {[
                { v: wf.version, at: wf.updatedAt, who: 'You', note: 'Current draft' },
                { v: wf.version === '0.1.0' ? '—' : '1.3.0', at: wf.createdAt, who: 'Priya Raghavan', note: 'Template import' },
              ].map((row) => (
                <div key={row.v + row.at} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-brand-700">v{row.v}</div>
                    <div className="text-[11px] text-slateink-400">
                      {row.who} · {row.note}
                    </div>
                  </div>
                  <div className="shrink-0 font-mono text-[10px] text-slateink-400"><Ago at={row.at} /></div>
                </div>
              ))}
            </div>
            <div className="hairline my-4" />
            <p className="text-[11.5px] leading-relaxed text-slateink-400">
              Runs of older versions are kept for 90 days, so a call from last month can always be traced to the graph that
              produced it.
            </p>
          </div>
        </div>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this workflow?">
        <p className="text-[13px] leading-relaxed text-slateink-300">
          {wf.name} will stop running on{' '}
          {store.assistants.find((a) => a.id === wf.assistantId)?.name ?? 'its assistant'}. Calls will fall back to the
          assistant&rsquo;s conversational prompt, which is usually not what you want.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              store.deleteWorkflow(wf.id);
              router.push('/dashboard/workflows');
            }}
          >
            Delete workflow
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------- inspector */

function Inspector({
  node,
  issues,
  onChange,
  onRemove,
}: {
  node: WorkflowNode;
  issues: { severity: 'error' | 'warning'; message: string }[];
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove: () => void;
}) {
  const meta = nodeKind(node.kind);
  const Icon = Icons[ICON_FOR[node.kind]] ?? Icons.sparkles;
  const cfg = (patch: Partial<WorkflowNode['config']>) => onChange({ config: { ...node.config, ...patch } });

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Icon size={14} className={meta.tone} />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">{node.kind}</span>
        </span>
        <button onClick={onRemove} className="text-slateink-400 hover:text-rose-700" aria-label="Delete node">
          <Icons.trash size={13} />
        </button>
      </div>

      <label className="label mt-4" htmlFor="n-label">
        Label
      </label>
      <input id="n-label" className="field text-[12.5px]" value={node.label} onChange={(e) => onChange({ label: e.target.value })} />

      <label className="label mt-3" htmlFor="n-text">
        {node.kind === 'api' ? 'What the call says while this runs' : 'Prompt text'}
      </label>
      <textarea
        id="n-text"
        rows={4}
        className="field text-[12.5px] leading-relaxed"
        value={node.text}
        onChange={(e) => onChange({ text: e.target.value })}
      />

      {node.kind === 'api' && (
        <>
          <label className="label mt-3" htmlFor="n-url">
            URL
          </label>
          <input id="n-url" className="field font-mono text-[11.5px]" value={node.config.url ?? ''} onChange={(e) => cfg({ url: e.target.value })} />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="n-method">
                Method
              </label>
              <select id="n-method" className="field text-[12.5px]" value={node.config.method ?? 'GET'} onChange={(e) => cfg({ method: e.target.value as 'GET' | 'POST' | 'PATCH' })}>
                {['GET', 'POST', 'PATCH'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="n-timeout">
                Timeout (ms)
              </label>
              <input
                id="n-timeout"
                type="number"
                className="field text-[12.5px]"
                value={node.config.timeoutMs ?? 2500}
                onChange={(e) => cfg({ timeoutMs: Number(e.target.value) })}
              />
            </div>
          </div>
          <label className="label mt-3" htmlFor="n-retry">
            Retry
          </label>
          <select id="n-retry" className="field text-[12.5px]" value={node.config.retry ?? 'none'} onChange={(e) => cfg({ retry: e.target.value as 'none' | 'once' | 'twice' })}>
            <option value="none">No retry</option>
            <option value="once">Once</option>
            <option value="twice">Twice</option>
          </select>
        </>
      )}

      {node.kind === 'dtmf' && (
        <div className="mt-3">
          <label className="label" htmlFor="n-digits">
            Expected digits
          </label>
          <input id="n-digits" type="number" className="field text-[12.5px]" value={node.config.digits ?? 8} onChange={(e) => cfg({ digits: Number(e.target.value) })} />
        </div>
      )}

      {node.kind === 'validate' && (
        <div className="mt-3">
          <label className="label" htmlFor="n-pattern">
            Pattern
          </label>
          <input id="n-pattern" className="field font-mono text-[11.5px]" value={node.config.pattern ?? ''} onChange={(e) => cfg({ pattern: e.target.value })} />
        </div>
      )}

      <label className="label mt-3" htmlFor="n-writes">
        Writes variable
      </label>
      <input
        id="n-writes"
        className="field font-mono text-[11.5px]"
        placeholder="memberId"
        value={node.config.writes ?? ''}
        onChange={(e) => cfg({ writes: e.target.value })}
      />

      <label className="label mt-3" htmlFor="n-error">
        If this fails
      </label>
      <textarea
        id="n-error"
        rows={2}
        className="field text-[12.5px] leading-relaxed"
        placeholder="Say what happens instead. Silence is not a policy."
        value={node.config.onError ?? ''}
        onChange={(e) => cfg({ onError: e.target.value })}
      />

      {issues.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {issues.map((i, idx) => (
            <p
              key={idx}
              className={cn('text-[11.5px] leading-relaxed', i.severity === 'error' ? 'text-rose-700' : 'text-amber-800')}
            >
              {i.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function EdgeInspector({
  edge,
  from,
  to,
  onChange,
  onRemove,
}: {
  edge: WorkflowEdge;
  from: string;
  to: string;
  onChange: (patch: Partial<WorkflowEdge>) => void;
  onRemove: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Path</span>
        <button onClick={onRemove} className="text-slateink-400 hover:text-rose-700" aria-label="Delete path">
          <Icons.trash size={13} />
        </button>
      </div>
      <p className="mt-3 text-[12.5px] text-slateink-200">
        {from} → {to}
      </p>
      <label className="label mt-4" htmlFor="e-label">
        Condition label
      </label>
      <input
        id="e-label"
        className="field text-[12.5px]"
        placeholder="default"
        value={edge.label}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <p className="mt-2 text-[11.5px] leading-relaxed text-slateink-400">
        Branch nodes choose a path by label. Leave one path unlabelled as the default so a caller can never fall off the
        graph.
      </p>
    </div>
  );
}
