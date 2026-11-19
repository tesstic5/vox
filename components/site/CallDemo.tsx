'use client';

/**
 * The homepage browser-assistant demo.
 *
 * It creates a short-lived server record, sends recognised or typed text to the
 * same agent pipeline used by dashboard browser tests, streams the text reply,
 * and lets the browser speak it. It is not a carrier phone call and every demo
 * record and action is fictional.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Icons, LogoMark } from '../icons';
import { LiveWave, Meter, Pill } from '../ui';
import { useVoiceCall, voiceSupported, type VoiceEvent } from '@/lib/voice';

const DEMO_AGENTS = [
  { id: 'demo-support', name: 'Customer Support', accent: 'Aria · en-US', match: 'support' },
  { id: 'demo-sales', name: 'Lead Qualification', accent: 'Rachel · en-GB', match: 'booking' },
  { id: 'demo-scheduling', name: 'Appointment Scheduling', accent: 'Marcus · en-AU', match: 'booking' },
];

type Line = { id: string; role: 'assistant' | 'user' | 'system'; text: string; notice?: 'tool' | 'guardrail' };

let seq = 0;
const nextId = () => `l${(seq += 1)}`;

export function CallDemo({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [agent, setAgent] = React.useState(DEMO_AGENTS[0]);
  const [lines, setLines] = React.useState<Line[]>([]);
  const [session, setSession] = React.useState<{ callId: string; token: string; greeting: string } | null>(null);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [typedFallback, setTypedFallback] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sessionRef = React.useRef<{ callId: string; token: string } | null>(null);
  sessionRef.current = session ? { callId: session.callId, token: session.token } : null;
  // Capability is a browser fact the server cannot know. Rendering it during
  // the first paint makes the server's HTML and the client's first render
  // disagree ("This browser cannot…" vs "Real speech recognition…"), and
  // React throws the tree away — hydration error #418 on the homepage.
  // Start from the optimistic copy both sides render, then correct it on
  // mount for the browsers that need the typed fallback.
  const [supported, setSupported] = React.useState(true);
  React.useEffect(() => {
    setSupported(voiceSupported());
  }, []);

  /* ------------------------------------------------------------- session */

  const openSession = React.useCallback(async () => {
    const res = await fetch('/api/public/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.match }),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message ?? 'The demo line is busy — try again in a moment.');
    }
    const next = { callId: json.callId as string, token: json.token as string, greeting: String(json.assistant?.firstMessage ?? '') };
    setSession(next);
    sessionRef.current = { callId: next.callId, token: next.token };
    return next;
  }, [agent.match]);

  /* ------------------------------------------------------------ transport */

  const onTurn = React.useCallback(
    async (text: string, device: { sttMs: number }) => {
      const current = sessionRef.current ?? (await openSession());
      const res = await fetch(`/api/public/demo/${current.callId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${current.token}` },
        body: JSON.stringify({ text, sttMs: device.sttMs }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'The agent did not answer.');
      }
      return res.body;
    },
    [openSession]
  );

  const onEvent = React.useCallback((event: VoiceEvent) => {
    if (event.kind === 'stt.final') setLines((prev) => [...prev, { id: nextId(), role: 'user', text: event.text }]);
    if (event.kind === 'assistant.final') setLines((prev) => [...prev, { id: nextId(), role: 'assistant', text: event.text }]);
    if (event.kind === 'tool')
      setLines((prev) => [...prev, { id: nextId(), role: 'system', text: `${event.name}${event.result ? ` → ok · ${event.ms}ms` : ''}`, notice: 'tool' }]);
    if (event.kind === 'guardrail')
      setLines((prev) => [...prev, { id: nextId(), role: 'system', text: `${event.severity} · ${event.action}`, notice: 'guardrail' }]);
    if (event.kind === 'error') setError(event.message);
  }, []);

  const voice = useVoiceCall({
    enabled: true,
    onTurn,
    onEnd: () => {
      const current = sessionRef.current;
      if (current) {
        void fetch(`/api/public/demo/${current.callId}/turn`, { method: 'DELETE', headers: { authorization: `Bearer ${current.token}` } });
      }
    },
    greeting: session?.greeting,
    voiceHint: undefined,
  });

  // Mirror the voice engine's events into the transcript panel.
  const seen = React.useRef(0);
  React.useEffect(() => {
    const fresh = voice.events.slice(seen.current);
    seen.current = voice.events.length;
    fresh.forEach(onEvent);
  }, [voice.events, onEvent]);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const running = voice.status !== 'idle' && voice.status !== 'unsupported';

  const handleStart = async () => {
    setError(null);
    setLines([]);
    try {
      await openSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the demo line.');
      return;
    }
    if (!supported) {
      setTypedFallback(true);
      return;
    }
    await voice.start();
  };

  const handleHangup = () => {
    voice.stop();
    setSession(null);
    sessionRef.current = null;
    setTypedFallback(false);
  };

  /** Typed transport: same pipeline, no microphone. */
  const sendTyped = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setLines((prev) => [...prev, { id: nextId(), role: 'user', text }]);
    try {
      const body = await onTurn(text, { sttMs: 0 });
      const reader = body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      let spoken = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const name = /^event: (.+)$/m.exec(frame)?.[1]?.trim();
          const raw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!name || !raw) continue;
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (name === 'tool.end')
            setLines((prev) => [...prev, { id: nextId(), role: 'system', text: `${String(data.name)} → ok · ${Number(data.ms)}ms`, notice: 'tool' }]);
          if (name === 'guardrail')
            setLines((prev) => [...prev, { id: nextId(), role: 'system', text: `${String(data.kind)} · ${String(data.action)}`, notice: 'guardrail' }]);
          if (name === 'assistant.delta') spoken += String(data.text ?? '');
          if (name === 'assistant.done') {
            const finalText = String(data.text ?? spoken);
            setLines((prev) => [...prev, { id: nextId(), role: 'assistant', text: finalText }]);
            if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(finalText));
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent did not answer.');
    }
  };

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-3xl border border-slate-900/[0.035] bg-gradient-to-b from-ink-800/95 to-ink-900/95 shadow-panel backdrop-blur',
        className
      )}
    >
      {/* header */}
      <div className="flex items-center gap-3 border-b border-slate-900/[0.04] px-4 py-3.5">
        <LogoMark size={26} />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-slate-900">{agent.name}</div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-brand-700">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" /> browser test · {voice.status}
              </span>
            ) : (
              'ready · web widget'
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {running && voice.metrics.voiceToVoiceMs ? <Pill tone="brand">{voice.metrics.voiceToVoiceMs}ms observed turn</Pill> : null}
        </div>
      </div>

      {/* agent picker */}
      {!running && (
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-4 pt-3.5">
          {DEMO_AGENTS.map((a) => (
            <button
              key={a.id}
              onClick={() => setAgent(a)}
              className={cn(
                'whitespace-nowrap rounded-full border px-3 py-1.5 text-[11.5px] transition-colors',
                agent.id === a.id ? 'border-brand-500/40 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] bg-slate-900/[0.02] text-slateink-400 hover:text-slate-900'
              )}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}

      {/* transcript */}
      <div ref={scrollRef} className={cn('no-scrollbar overflow-y-auto px-4 py-4', compact ? 'h-[190px]' : 'h-[248px]')}>
        {lines.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-brand-500/20 bg-brand-500/[0.07]">
                <Icons.waveform size={24} className="text-brand-700" />
              </div>
              <p className="text-[13.5px] font-medium text-slate-900">Try the browser assistant</p>
              <p className="mx-auto mt-1.5 max-w-[38ch] text-[12.5px] leading-snug text-slateink-400">
                {supported
                  ? 'Your browser recognises speech; the server streams a text reply and fictional tool results. This is not a phone call or real booking.'
                  : 'This browser cannot use speech recognition here — type instead and it can speak the streamed text reply.'}
              </p>
              {error && <p className="mx-auto mt-2 max-w-[34ch] text-[11.5px] text-amber-800">{error}</p>}
              <div className="mt-4 flex items-center justify-center gap-3 font-mono text-[10.5px] text-slateink-400">
                <span>fictional records</span>
                <span className="text-slate-900/15">•</span>
                <span>short-lived demo</span>
                <span className="text-slate-900/15">•</span>
                <span>measured turns</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {lines.map((line) =>
              line.role === 'system' ? (
                <div key={line.id} className="flex justify-center">
                  <span
                    className={cn(
                      'rounded-full border px-3 py-1 font-mono text-[10px]',
                      line.notice === 'guardrail'
                        ? 'border-amber-500/25 bg-amber-500/[0.08] text-amber-800'
                        : 'border-brand-500/25 bg-brand-500/[0.08] text-brand-700'
                    )}
                  >
                    {line.notice === 'tool' ? 'tool · ' : 'guardrail · '}
                    {line.text}
                  </span>
                </div>
              ) : (
                <div key={line.id} className={cn('flex gap-2.5', line.role === 'user' && 'justify-end')}>
                  {line.role === 'assistant' && (
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-brand-500/25 bg-brand-500/10 font-mono text-[9.5px] text-brand-700">
                      AI
                    </span>
                  )}
                  <div
                    className={cn(
                      'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug',
                      line.role === 'assistant' ? 'border border-slate-900/[0.045] bg-ink-850/90 text-slateink-200' : 'bg-white text-black'
                    )}
                  >
                    {line.text}
                  </div>
                </div>
              )
            )}
            {voice.status === 'thinking' && <div className="font-mono text-[11px] text-slateink-400">thinking…</div>}
          </div>
        )}
      </div>

      {/* typed fallback / always-available input */}
      {(typedFallback || (running && voice.metrics.turns > 0)) && !supported && (
        <form onSubmit={sendTyped} className="flex items-center gap-2 border-t border-slate-900/[0.04] px-4 py-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type what the caller says…"
            className="field flex-1"
            aria-label="Caller utterance"
          />
          <button type="submit" className="btn-brand btn-sm">
            <Icons.send size={14} /> Say
          </button>
        </form>
      )}

      {/* controls */}
      <div className="border-t border-slate-900/[0.04] bg-ink-950/40 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {running ? (
              <div className="flex items-center gap-3">
                <LiveWave active={voice.speaking !== null || voice.level > 0.08} bars={compact ? 18 : 26} />
                <span className="hidden truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400 sm:block">
                  {voice.status === 'listening' ? 'listening' : voice.status === 'thinking' ? 'thinking' : voice.speaking === 'agent' ? 'agent speaking' : voice.status}
                </span>
              </div>
            ) : (
              <div className="font-mono text-[10.5px] text-slateink-400">
                {supported ? 'Mic permission will be requested · speech handling depends on your browser' : 'Transcript-only mode in this browser'}
              </div>
            )}
          </div>

          {running ? (
            <>
              <button
                onClick={() => voice.setMuted(!voice.muted)}
                className={cn('btn-ghost h-10 w-10 p-0', voice.muted && 'border-red-500/40 bg-red-500/10 text-red-700')}
                aria-label={voice.muted ? 'Unmute' : 'Mute'}
              >
                {voice.muted ? <Icons.micOff size={17} /> : <Icons.mic size={17} />}
              </button>
              <button onClick={handleHangup} className="btn h-10 gap-2 rounded-full bg-red-500 px-5 text-slate-900 hover:bg-red-400">
                <Icons.phoneOff size={16} />
                End
              </button>
            </>
          ) : (
            <button onClick={() => void handleStart()} className="btn-brand h-10 gap-2 rounded-full px-5">
              <Icons.phone size={16} />
              Start browser test
            </button>
          )}
        </div>
        {running && (
          <div className="mt-3 flex items-center gap-3">
            <Meter level={voice.level} bars={compact ? 22 : 34} className="flex-1" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-slateink-400">
              {voice.metrics.sttMs ? `${voice.metrics.sttMs}ms stt` : 'input'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
