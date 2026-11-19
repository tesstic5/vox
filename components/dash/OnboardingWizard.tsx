'use client';

/**
 * The setup wizard.
 *
 * Four steps from a brand-new account to a call that happened, and every step is
 * the real thing: the agent begins as a draft for review, the number is bought on
 * the account this workspace actually buys from, and the first call is either a live
 * browser conversation or a dial to the client's own phone.
 *
 * The state it renders is derived server-side from the workspace's collections
 * (see `lib/server/onboarding.ts`), so this screen cannot claim a step is done
 * when the assistant or number does not exist — refresh it and it still agrees
 * with the rest of the product.
 */

import * as React from 'react';
import Link from 'next/link';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, Pill, Progress, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { CallWidget } from '@/components/dash/CallWidget';

type Step = {
  id: string;
  title: string;
  why: string;
  done: boolean;
  detail: string;
  cta: string;
};

type State = {
  steps: Step[];
  done: number;
  total: number;
  percent: number;
  complete: boolean;
  useCase?: string;
  assistantId?: string;
  numberId?: string;
  firstCallId?: string;
  preloaded?: boolean;
  demo?: { assistants: number; numbers: number; calls: number; note: string };
  workspace: { assistants: number; published: number; numbers: number; assigned: number; calls: number; answered: number };
  telephony: {
    mode: 'workspace' | 'managed' | 'none';
    canBuy: boolean;
    managed: boolean;
    hint: string;
    areaCodes: { code: string; label: string; country: string }[];
  };
  profile: {
    configured: boolean;
    type: 'contractor' | 'dental' | 'physiotherapy' | 'other';
    typeLabel: string;
    modules: string[];
    country?: string;
    timezone?: string;
    currency?: string;
  };
  operations: { locations: number; services: number; providers: number; rotas: number; ready: boolean };
  useCases: { id: string; label: string; desc: string; tools: number }[];
};

type Assistant = { id: string; name: string; status?: string; model?: string; tools?: string[] };
type Available = { number: string; locality?: string; region?: string; price?: string };

export function OnboardingWizard({ initial, emailVerified }: { initial: State | null; emailVerified?: boolean }) {
  const toast = useToast();
  const [state, setState] = React.useState<State | null>(initial);
  const [stepIndex, setStepIndex] = React.useState(0);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [callOpen, setCallOpen] = React.useState(false);

  // step 1 — the agent
  const [useCase, setUseCase] = React.useState(initial?.useCase ?? initial?.useCases?.[0]?.id ?? 'inbound-support');
  const [business, setBusiness] = React.useState('');
  const [agentName, setAgentName] = React.useState('');
  const [reviewed, setReviewed] = React.useState(false);
  // step 2 — the number
  const [areaCode, setAreaCode] = React.useState('415');
  const [available, setAvailable] = React.useState<Available[]>([]);
  const [numberHint, setNumberHint] = React.useState('');
  const [chosen, setChosen] = React.useState('');
  // step 3 — the call
  const [phone, setPhone] = React.useState('');
  const [assistants, setAssistants] = React.useState<Assistant[]>([]);

  const load = React.useCallback(async () => {
    try {
      const [next, list] = await Promise.all([
        request<State>('GET', '/api/v1/onboarding'),
        request<{ data: Assistant[] }>('GET', '/api/v1/assistants?limit=50'),
      ]);
      setState(next);
      setAssistants(list.data ?? []);
      setUseCase(next.useCase ?? next.useCases[0]?.id ?? 'inbound-support');
      const firstOpen = next.steps.findIndex((s) => !s.done);
      setStepIndex(firstOpen === -1 ? next.steps.length - 1 : firstOpen);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Sign in to continue.');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Something went wrong.';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy('');
    }
  };

  const createAssistant = () =>
    run('assistant', async () => {
      const res = await request<{ assistant: Assistant; toolsCreated: number; note: string }>('POST', '/api/v1/onboarding/assistant', {
        useCase,
        business: business || undefined,
        name: agentName || undefined,
      });
      setState((s) => (s ? { ...s, ...(res as unknown as State) } : s));
      setReviewed(false);
      toast(`${res.assistant.name} is a draft. Review it before publishing.`);
      await load();
    });

  const searchNumbers = () =>
    run('search', async () => {
      const res = await request<{ available: Available[]; hint: string; areaCodeLabel?: string }>(
        'GET',
        `/api/v1/onboarding/numbers?areaCode=${encodeURIComponent(areaCode)}`
      );
      setAvailable(res.available);
      setNumberHint(res.hint);
      setChosen(res.available[0]?.number ?? '');
      if (!res.available.length) toast(res.hint, 'error');
    });

  const buyNumber = () =>
    run('buy', async () => {
      const res = await request<{ number: { id: string; number: string }; note: string; boughtOn: string; reused: boolean }>(
        'POST',
        '/api/v1/onboarding/numbers/buy',
        { number: chosen || available[0]?.number, label: 'Main line', country: 'US' }
      );
      toast(`${res.number.number} is live — ${res.note}`);
      setAvailable([]);
      await load();
    });

  const testBrowser = () =>
    run('browser', async () => {
      await request('POST', '/api/v1/onboarding/first-call', { mode: 'browser' });
      setCallOpen(true);
      toast('Test call ready — the panel is open, start talking.');
      await load();
    });

  const testPhone = () =>
    run('phone', async () => {
      const res = await request<{ call: { id: string }; carrierSid?: string; note: string }>('POST', '/api/v1/onboarding/first-call', {
        mode: 'phone',
        to: phone,
      });
      toast(`Dialling ${phone}… ${res.carrierSid ? `(${res.carrierSid})` : ''}`);
      await load();
    });

  if (error === 'Sign in to continue.') {
    return (
      <>
        <PageHeader title="Set up your workspace" desc="A guided checklist based on this workspace’s business profile and enabled modules." />
        <div className="panel p-6">
          <p className="text-[13px] text-slate-900">Sign in to set up this workspace.</p>
          <p className="mt-1.5 text-[12.5px] text-slateink-400">Setup is per workspace — the agent and number you create belong to it.</p>
          <div className="mt-4">
            <Link href="/login?next=/dashboard/onboarding" className="text-[13px] text-brand-700 hover:text-brand-700">
              Sign in →
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (!state) {
    return (
      <>
        <PageHeader title="Set up your workspace" desc="Loading what this workspace already has…" />
        <div className="panel animate-pulse p-6">
          <div className="h-3 w-40 rounded bg-slate-900/[0.06]" />
          <div className="mt-3 h-3 w-64 rounded bg-slate-900/[0.06]" />
        </div>
      </>
    );
  }

  /**
   * Publishing a draft the wizard already created.
   *
   * The account that made it was unverified, which is why it is a draft; the code
   * has usually been entered by the time somebody presses this.
   */
  async function publishAgent() {
    if (!agent) return;
    setBusy('publish');
    setError('');
    try {
      await request('POST', `/api/v1/assistants/${agent.id}/publish`, { message: 'Published from setup' });
      toast(`${agent.name} is live.`);
      await load();
    } catch (err) {
      const text = err instanceof ApiError ? err.message : 'Publishing failed.';
      setError(text);
      toast(text, 'error');
    } finally {
      setBusy('');
    }
  }

  const step = state.steps[stepIndex];
  const agent = assistants.find((a) => a.id === state.assistantId) ?? assistants[0];

  return (
    <>
      <PageHeader
        title="Set up your workspace"
        desc={`A ${state.profile.typeLabel.toLowerCase()} checklist built from saved workspace state — no step completes from a UI flag.`}
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Setup' }]}
        actions={
          <>
            <Button variant="quiet" size="sm" onClick={() => void load()}>
              <Icons.refresh size={13} /> Re-check
            </Button>
            <Link href="/docs" className="text-[12.5px] text-brand-700 hover:text-brand-700">
              Quickstart docs →
            </Link>
          </>
        }
      />

      {emailVerified === false && (
        <div className="panel mb-4 border-amber-400/25 p-4">
          <div className="flex items-start gap-3">
            <Icons.alert size={15} className="mt-0.5 shrink-0 text-amber-800" />
            <div className="flex-1">
              <div className="text-[13.5px] font-medium text-slate-900">Verify your email before publishing or buying a number</div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slateink-300">
                Creating an agent works now. Publishing it and buying a number are refused until a six-digit code is
                accepted — a live number nobody can administer is worse than no number. The code goes to the address you
                signed up with.
              </p>
            </div>
            <a href="/verify-email" className="btn-brand shrink-0 px-4 py-2 text-[12.5px] no-underline">
              Verify email
            </a>
          </div>
        </div>
      )}

      {state.demo && (
        <div className="panel border-brand-500/20 p-4">
          <div className="flex items-start gap-3">
            <Icons.sparkles size={15} className="mt-0.5 shrink-0 text-brand-700" />
            <p className="text-[12.5px] leading-relaxed text-slateink-300">
              <span className="text-slate-900">This is an explicitly pre-loaded demo workspace</span> — {state.demo.assistants} demonstration assistant
              {state.demo.assistants === 1 ? '' : 's'}, {state.demo.numbers} placeholder number{state.demo.numbers === 1 ? '' : 's'} and{' '}
              {state.demo.calls} generated call record{state.demo.calls === 1 ? '' : 's'}. They are labelled demonstration data and never count
              as your setup; production-mode signups start empty.
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-semibold text-slate-900">
              {state.done} of {state.total} done
            </div>
            <div className="mt-1.5 text-[12.5px] text-slateink-400">
              {state.complete
                ? 'Every enabled setup step is backed by a workspace record. Review the checklist again whenever you change modules.'
                : 'Only relevant enabled modules appear here, and every completion is derived from saved workspace records.'}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Pill tone={state.complete ? 'brand' : 'info'}>{state.percent}%</Pill>
            <div className="w-40">
              <Progress value={state.percent} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)] xl:items-start">
        <div className="panel p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Checklist</div>
          <div className="mt-3 space-y-1">
            {state.steps.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setStepIndex(i)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  i === stepIndex ? 'border-brand-400/50 bg-brand-500/[0.06]' : 'border-transparent hover:bg-slate-900/[0.03]'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                    s.done ? 'border-brand-400/50 bg-brand-500/25 text-brand-700' : 'border-slate-900/[0.09] text-transparent'
                  )}
                >
                  <Icons.check size={10} />
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[12.5px]', s.done ? 'text-slateink-400 line-through' : 'text-slate-900')}>{s.title}</span>
                  <span className="mt-0.5 block text-[11px] text-slateink-400">{s.detail}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 border-t border-slate-900/[0.04] pt-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">This workspace</div>
            <dl className="mt-2.5 space-y-1.5 text-[12px]">
              {[
                ['Profile', state.profile.typeLabel],
                ['Team & rota', `${state.operations.providers} people · ${state.operations.rotas} rotas`],
                ...(state.profile.modules.includes('assistants') ? [['Assistants', `${state.workspace.assistants} (${state.workspace.published} published)`]] : []),
                ...(state.profile.modules.includes('communications') ? [
                  ['Numbers', `${state.workspace.numbers} (${state.workspace.assigned} assigned)`],
                  ['Calls', String(state.workspace.calls)],
                  ['Telephony', state.telephony.mode === 'none' ? 'not connected' : state.telephony.managed ? 'managed by Voxera' : 'your own carrier'],
                ] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-2">
                  <dt className="text-slateink-400">{label}</dt>
                  <dd className="font-mono text-[11.5px] text-slateink-200">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="space-y-4">
          <div className="panel p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand-700">
                  Step {stepIndex + 1} of {state.total}
                </div>
                <h2 className="mt-2 text-[17px] font-semibold text-slate-900">{step.title}</h2>
                <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-slateink-300">{step.why}</p>
              </div>
              {step.done && <Pill tone="brand">done</Pill>}
            </div>

            {error && error !== 'Sign in to continue.' && (
              <div className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-[12.5px] text-rose-700">{error}</div>
            )}

            {step.id === 'business_profile' && (
              <div className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-900/[0.045] p-4"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Business type</div><div className="mt-2 text-[13px] font-medium">{state.profile.typeLabel}</div></div>
                  <div className="rounded-xl border border-slate-900/[0.045] p-4"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Local rules</div><div className="mt-2 text-[12px] text-slateink-300">{[state.profile.country, state.profile.timezone, state.profile.currency].filter(Boolean).join(' · ') || 'Not confirmed'}</div></div>
                  <div className="rounded-xl border border-slate-900/[0.045] p-4"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Enabled modules</div><div className="mt-2 text-[13px] font-medium">{state.profile.modules.length}</div></div>
                </div>
                <p className="text-[12.5px] leading-relaxed text-slateink-400">Changing type later recommends language and modules; it does not rewrite historical records or custom templates.</p>
                <Link href="/dashboard/business" className="btn-brand btn-sm inline-flex">Review business profile</Link>
              </div>
            )}

            {step.id === 'operations' && (
              <div className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    ['Locations', state.operations.locations],
                    ['Services', state.operations.services],
                    [state.profile.type === 'contractor' ? 'Technicians' : 'Team members', state.operations.providers],
                    ['Rotas', state.operations.rotas],
                  ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-slate-900/[0.045] p-4"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></div>)}
                </div>
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-[12.5px] leading-relaxed text-slateink-300">
                  Add your own records. Setup does not invent people, prices, locations or opening hours. A field-service address stays on the customer job; a dispatch location supplies the technician’s timezone and rota.
                </div>
                <Link href="/dashboard/practice" className="btn-brand btn-sm inline-flex">Configure services and team</Link>
              </div>
            )}

            {/* ------------------------------------------------ assistant */}
            {step.id === 'assistant' && (
              <div className="mt-5 space-y-5">
                <div className="grid gap-2 sm:grid-cols-3">
                  {state.useCases.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => setUseCase(u.id)}
                      className={cn(
                        'rounded-xl border px-3.5 py-3 text-left transition-colors',
                        useCase === u.id ? 'border-brand-400/50 bg-brand-500/[0.07]' : 'border-slate-900/[0.045] bg-ink-900/40 hover:border-slate-900/[0.09]'
                      )}
                    >
                      <div className="text-[12.5px] text-slate-900">{u.label}</div>
                      <div className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">{u.desc}</div>
                      <div className="mt-2 font-mono text-[10px] text-slateink-400">{u.tools} tools attached</div>
                    </button>
                  ))}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] text-slateink-400">Your business name (the agent says it out loud)</span>
                    <input className="field" placeholder="Northwind Labs" value={business} onChange={(e) => setBusiness(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] text-slateink-400">Agent name (optional)</span>
                    <input className="field" placeholder="Booking desk" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
                  </label>
                </div>

                {agent && agent.status === 'draft' && (
                  <div className="space-y-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.05] p-4">
                    <p className="text-[12.5px] text-slateink-300">
                      Review the instructions, tools and business details before the assistant handles calls. It starts without sample prices or policies.
                    </p>
                    <Link href={`/dashboard/assistants/${agent.id}`} className="text-[12.5px] font-medium text-brand-700 hover:underline">
                      Review this assistant →
                    </Link>
                    <label className="flex items-start gap-2 text-[12px] text-slateink-300">
                      <input type="checkbox" className="mt-0.5" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                      I have reviewed this assistant and am ready to publish it.
                    </label>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="brand" onClick={() => void createAssistant()} disabled={busy === 'assistant'} className={cn(agent && agent.status === 'draft' && 'hidden')}>
                    {busy === 'assistant' ? 'Creating…' : step.done ? 'Create another' : 'Create my assistant'}
                  </Button>
                  {agent && agent.status === 'draft' && (
                    <Button variant="brand" onClick={() => void publishAgent()} disabled={busy === 'publish' || !reviewed || emailVerified === false}>
                      {busy === 'publish' ? 'Publishing…' : 'Publish this assistant'}
                    </Button>
                  )}
                  <span className="text-[12px] text-slateink-400">
                    {agent && agent.status === 'draft'
                      ? emailVerified === false ? 'Verify your email before publishing.' : 'Publishing is a separate step after review.'
                      : 'Created as a draft; you decide when to publish.'}
                  </span>
                </div>

                {agent && (
                  <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] text-slate-900">{agent.name}</span>
                      <Pill tone="brand">{agent.status ?? 'published'}</Pill>
                      <span className="font-mono text-[11px] text-slateink-400">{agent.tools?.length ?? 0} tools · {agent.model}</span>
                    </div>
                    <p className="mt-1.5 text-[12px] text-slateink-400">
                      Edit the prompt, voice, or knowledge in{' '}
                      <Link href="/dashboard/assistants" className="text-brand-700 hover:text-brand-700">
                        Assistants
                      </Link>
                      .
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ---------------------------------------------------- step 2 */}
            {step.id === 'number' && (
              <div className="mt-5 space-y-5">
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-4 py-3 text-[12.5px] text-slateink-300">
                  {state.telephony.hint}
                </div>

                {!state.telephony.canBuy ? (
                  <div className="flex flex-wrap gap-2">
                    <Link href="/dashboard/carriers">
                      <Button variant="brand" size="sm">Connect a carrier</Button>
                    </Link>
                    <Link href="/docs">
                      <Button variant="ghost" size="sm">Read the telephony guide</Button>
                    </Link>
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="mb-2 text-[12px] text-slateink-400">Pick the area code your customers will recognise</div>
                      <div className="flex flex-wrap gap-2">
                        {state.telephony.areaCodes.map((a) => (
                          <button
                            key={a.code}
                            onClick={() => setAreaCode(a.code)}
                            className={cn(
                              'rounded-lg border px-3 py-1.5 text-left transition-colors',
                              areaCode === a.code ? 'border-brand-400/50 bg-brand-500/[0.08]' : 'border-slate-900/[0.045] hover:border-slate-900/[0.09]'
                            )}
                          >
                            <span className="font-mono text-[12px] text-slate-900">{a.code}</span>
                            <span className="ml-2 text-[11.5px] text-slateink-400">{a.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <Button variant="ghost" size="sm" onClick={() => void searchNumbers()} disabled={busy === 'search'}>
                        {busy === 'search' ? 'Checking inventory…' : 'Search available numbers'}
                      </Button>
                      {numberHint && <span className="text-[12px] text-slateink-400">{numberHint}</span>}
                    </div>

                    {available.length > 0 && (
                      <div className="space-y-2">
                        {available.map((n) => (
                          <button
                            key={n.number}
                            onClick={() => setChosen(n.number)}
                            className={cn(
                              'flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                              chosen === n.number ? 'border-brand-400/50 bg-brand-500/[0.07]' : 'border-slate-900/[0.045] hover:border-slate-900/[0.09]'
                            )}
                          >
                            <span>
                              <span className="block font-mono text-[13px] text-slate-900">{n.number}</span>
                              <span className="block text-[11.5px] text-slateink-400">
                                {[n.locality, n.region].filter(Boolean).join(', ') || 'Local number'}
                              </span>
                            </span>
                            <Pill tone={chosen === n.number ? 'brand' : 'default'}>{chosen === n.number ? 'selected' : 'choose'}</Pill>
                          </button>
                        ))}
                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          <Button variant="brand" size="sm" onClick={() => void buyNumber()} disabled={busy === 'buy' || !chosen}>
                            {busy === 'buy' ? 'Buying…' : `Buy ${chosen} and point it at ${agent?.name ?? 'my agent'}`}
                          </Button>
                          <span className="text-[11.5px] text-slateink-400">
                            Voice webhooks are configured in the same step — the number answers with your agent the moment it is yours.
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ---------------------------------------------------- step 3 */}
            {step.id === 'first_call' && (
              <div className="mt-5 space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/40 p-4">
                    <div className="text-[13px] text-slate-900">Talk to it here</div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">
                      A live call over your microphone, against the same runtime a phone call uses. Interrupt it — that is the point of the test.
                    </p>
                    <Button variant="brand" size="sm" className="mt-3" onClick={() => void testBrowser()} disabled={busy === 'browser'}>
                      {busy === 'browser' ? 'Opening…' : callOpen ? 'Open the call panel again' : 'Start a browser call'}
                    </Button>
                  </div>
                  <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/40 p-4">
                    <div className="text-[13px] text-slate-900">Call your own phone</div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">
                      The honest test: it rings, you answer, and you hear what a customer hears — including the pauses.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        className="field w-40 font-mono text-[12px]"
                        placeholder="+14155550123"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void testPhone()}
                        disabled={busy === 'phone' || !/^\+\d{7,15}$/.test(phone.replace(/[^\d+]/g, ''))}
                      >
                        {busy === 'phone' ? 'Dialling…' : 'Ring me'}
                      </Button>
                    </div>
                    {state.telephony.mode === 'none' && (
                      <p className="mt-2 text-[11.5px] text-amber-800">No telephony account connected, so only the browser call works right now.</p>
                    )}
                  </div>
                </div>

                {state.firstCallId && (
                  <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-4 py-3">
                    <div className="font-mono text-[11px] text-slateink-400">{state.firstCallId}</div>
                    <p className="mt-1 text-[12.5px] text-slateink-200">
                      Your first call is on record — open it in{' '}
                      <Link href={`/dashboard/calls/${state.firstCallId}`} className="text-brand-700 hover:text-brand-700">
                        call logs
                      </Link>{' '}
                      to read the transcript and see the cost.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ---------------------------------------------------- step 4 */}
            {step.id === 'connect' && (
              <div className="mt-5 space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/40 p-4">
                    <div className="text-[13px] text-slate-900">Get outcomes out</div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">
                      Subscribe an endpoint to <span className="font-mono text-brand-700">booking.*</span> and{' '}
                      <span className="font-mono text-brand-700">call.ended</span> — every confirmation, move and cancellation lands in your system, signed.
                    </p>
                    <Link href="/dashboard/webhooks">
                      <Button variant="brand" size="sm" className="mt-3">Add a webhook</Button>
                    </Link>
                  </div>
                  <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/40 p-4">
                    <div className="text-[13px] text-slate-900">Push your diary in</div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">
                      Send the appointments you want confirmed to the sync endpoint; your system stays authoritative and we keep a mirror we can call from.
                    </p>
                    <Link href="/dashboard/bookings">
                      <Button variant="ghost" size="sm" className="mt-3">Open Bookings → Integration</Button>
                    </Link>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/60 p-4">
                  <div className="font-mono text-[11px] text-slateink-400">curl</div>
                  <pre className="mt-2 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-slateink-200">
{`curl -X POST https://api.voxera.ai/v1/bookings/sync \\
  -H "authorization: Bearer $VOXERA_API_KEY" \\
  -d '{"mode":"full","bookings":[{"externalId":"A-1",
       "customer":{"name":"Amara Osei","number":"+14155550177"},
       "startsAt":"2026-09-26T21:00:00Z"}]}'`}
                  </pre>
                  <Link href="/dashboard/api-keys" className="mt-3 inline-block text-[12.5px] text-brand-700 hover:text-brand-700">
                    Create an API key →
                  </Link>
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-900/[0.04] pt-5">
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStepIndex((i) => Math.max(0, i - 1))} disabled={stepIndex === 0}>
                  Back
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStepIndex((i) => Math.min(state.total - 1, i + 1))}
                  disabled={stepIndex === state.total - 1}
                >
                  Next step
                </Button>
              </div>
              <div className="flex items-center gap-3">
                {step.done ? (
                  <span className="text-[12px] text-slateink-400">Done — move on whenever you are ready.</span>
                ) : (
                  <span className="text-[12px] text-slateink-400">Nothing happens until you press the button.</span>
                )}
                <Link href="/dashboard">
                  <Button variant="quiet" size="sm">Skip to dashboard</Button>
                </Link>
              </div>
            </div>
          </div>

          <div className="panel p-5">
            <h3 className="text-[13.5px] font-semibold text-slate-900">What you get with all four done</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[
                ['A number that answers', 'Callers reach the agent, campaigns dial out from it, and every call is transcribed and metered.'],
                ['An agent that can act', 'Tools are attached, so it books, moves, cancels, texts confirmations and escalates — not just talks.'],
                ['A record of everything', 'Transcripts, tool calls, cost per call, and the reason each call ended.'],
                ['A loop back to your system', 'Outcomes leave by webhook or by poll; your diary stays the source of truth.'],
              ].map(([title, body]) => (
                <div key={title} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-4 py-3">
                  <div className="text-[12.5px] text-slate-900">{title}</div>
                  <div className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">{body}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <CallWidget open={callOpen} onClose={() => setCallOpen(false)} />
    </>
  );
}
