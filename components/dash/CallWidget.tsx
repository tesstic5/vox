'use client';

/**
 * Browser assistant test.
 *
 * Opens a `web` call record on the server and sends typed or browser-transcribed
 * turns through the assistant runtime over SSE. Browser speech recognition and
 * speech synthesis are device capabilities, not evidence that carrier audio,
 * codecs, DTMF or a configured speech provider work. The stored source remains
 * `dashboard`/`web` so this test is distinguishable from a phone call.
 */

import * as React from 'react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';
import { LiveWave, Meter, Modal, Pill, useToast } from '../ui';
import { useVoiceCall, voiceSupported, type VoiceEvent } from '@/lib/voice';

type Line =
  | { kind: 'assistant' | 'user'; text: string }
  | { kind: 'tool'; name: string; args?: Record<string, unknown>; result?: string; ms?: number }
  | { kind: 'guardrail'; note: string; action: string }
  | { kind: 'intent'; intent: string; confidence: number };

export function CallWidget({ open, onClose, initialAssistantId }: { open: boolean; onClose: () => void; initialAssistantId?: string }) {
  const store = useStore();
  const toast = useToast();
  const [assistantId, setAssistantId] = React.useState<string>(initialAssistantId ?? '');
  const [logId, setLogId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>([]);
  const [voiceMode, setVoiceMode] = React.useState(true);
  const [micState, setMicState] = React.useState<'unknown' | 'ok' | 'denied'>('unknown');
  const [callId, setCallId] = React.useState<string | null>(null);
  const transcriptRef = React.useRef<HTMLDivElement>(null);

  const assistants = store.assistants;
  const assistant = assistants.find((a) => a.id === assistantId) ?? assistants[0] ?? null;
  const live = store.connection.status === 'live';
  // Same hydration rule as the homepage demo: a browser capability cannot be
  // read during first render without the server and client disagreeing.
  const [supported, setSupported] = React.useState(true);
  React.useEffect(() => {
    setSupported(voiceSupported());
  }, []);
  React.useEffect(() => {
    if (open && initialAssistantId) setAssistantId(initialAssistantId);
  }, [open, initialAssistantId]);

  /* ------------------------------------------------------------- transport */

  const openCall = React.useCallback(async () => {
    if (!assistant) throw new Error('Create an assistant first.');
    const call = await store.serverWrites.createCall({
      assistantId: assistant.id,
      from: 'Web widget',
      to: assistant.name,
      type: 'web',
      source: 'dashboard',
    });
    setCallId(call.id);
    return call.id;
  }, [assistant, store.serverWrites]);

  const callIdRef = React.useRef<string | null>(null);
  callIdRef.current = callId;

  const onTurn = React.useCallback(
    async (text: string, device: { sttMs: number }) => {
      const id = callIdRef.current ?? (await openCall());
      callIdRef.current = id;
      const res = await fetch(`/api/v1/calls/${id}/turn/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text, sttMs: device.sttMs, chunkDelayMs: 24 }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'The agent did not answer.');
      }
      return res.body;
    },
    [openCall]
  );

  const onTelemetry = React.useCallback(
    (metrics: { voiceToVoiceMs: number; sttMs: number; bargeIns: number }) => {
      const id = callIdRef.current;
      if (!id || !metrics.voiceToVoiceMs) return;
      void fetch(`/api/v1/calls/${id}/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(metrics),
      });
    },
    []
  );

  const onVoiceEvent = React.useCallback((event: VoiceEvent) => {
    switch (event.kind) {
      case 'stt.final':
        setLines((prev) => [...prev, { kind: 'user', text: event.text }]);
        break;
      case 'intent':
        setLines((prev) => [...prev, { kind: 'intent', intent: event.intent, confidence: event.confidence }]);
        break;
      case 'tool':
        setLines((prev) => {
          const next = [...prev];
          const idx = next.findIndex((l) => l.kind === 'tool' && l.name === event.name && !l.result);
          const entry: Line = { kind: 'tool', name: event.name, args: event.args, result: event.result, ms: event.ms };
          if (idx >= 0) next[idx] = entry;
          else next.push(entry);
          return next;
        });
        break;
      case 'guardrail':
        setLines((prev) => [...prev, { kind: 'guardrail', note: event.note, action: event.action }]);
        break;
      case 'assistant.final':
        setLines((prev) => [...prev, { kind: 'assistant', text: event.text }]);
        break;
      default:
        break;
    }
  }, []);

  const onVoiceEnd = React.useCallback(async () => {
    const id = callIdRef.current;
    if (!id) return;
    try {
      await store.serverWrites.end(id, 'customer-ended-call');
      setLogId(id);
      toast('Call ended — transcript, tools and cost are in your call log.');
      store.refreshFromServer();
    } catch {
      toast('Call ended, but the log did not update.');
    } finally {
      callIdRef.current = null;
      setCallId(null);
    }
  }, [store, toast]);

  const voice = useVoiceCall({
    enabled: live && voiceMode && open,
    onTurn,
    onTelemetry,
    onEnd: onVoiceEnd,
    voiceHint: assistant?.voiceId,
    greeting: assistant?.firstMessage,
  });

  /* ------------------------------------------------------------ typed path */

  const sendTyped = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setLines((prev) => [...prev, { kind: 'user', text }]);
    try {
      const id = callIdRef.current ?? (await openCall());
      callIdRef.current = id;
      setCallId(id);
      const res = await fetch(`/api/v1/calls/${id}/turn/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text, chunkDelayMs: 18 }),
      });
      if (!res.ok || !res.body) throw new Error('turn failed');
      const reader = res.body.getReader();
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
          const dataRaw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!name || !dataRaw) continue;
          const data = JSON.parse(dataRaw) as Record<string, unknown>;
          if (name === 'intent') setLines((prev) => [...prev, { kind: 'intent', intent: String(data.intent), confidence: Number(data.confidence ?? 0) }]);
          if (name === 'tool.end') setLines((prev) => [...prev, { kind: 'tool', name: String(data.name), result: String(data.result), ms: Number(data.ms) }]);
          if (name === 'guardrail') setLines((prev) => [...prev, { kind: 'guardrail', note: String(data.note), action: String(data.action) }]);
          if (name === 'assistant.delta') {
            spoken += String(data.text ?? '');
          }
          if (name === 'assistant.done') {
            setLines((prev) => [...prev, { kind: 'assistant', text: String(data.text ?? spoken) }]);
          }
        }
      }
      if (voiceMode && supported) window.speechSynthesis?.speak(new SpeechSynthesisUtterance(spoken));
    } catch {
      toast('That turn did not go through — check the connection badge in the header.');
    }
  };

  const hangUp = async () => {
    if (voice.status !== 'idle') voice.stop();
    await onVoiceEnd();
    setLines([]);
  };

  React.useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [lines]);

  const running = voice.status !== 'idle' && voice.status !== 'unsupported';
  const speaking = voice.speaking;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (running) void hangUp();
        onClose();
      }}
      title="Test call"
      desc={
        assistant
          ? `${assistant.name} · ${assistant.model} · ${voiceMode && supported ? 'microphone + speech synthesis' : 'typed'}`
          : 'No assistant selected'
      }
      width="max-w-4xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          {assistants.length > 1 && !running && (
            <select value={assistant?.id ?? ''} onChange={(e) => setAssistantId(e.target.value)} className="field max-w-[220px]">
              {assistants.map((a) => (
                <option key={a.id} value={a.id} className="bg-ink-900">
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <label className={cn('flex items-center gap-2 text-[12px]', supported ? 'text-slateink-300' : 'text-slateink-500')}>
            <input
              type="checkbox"
              checked={voiceMode}
              disabled={!supported}
              onChange={(e) => setVoiceMode(e.target.checked)}
            />
            Voice mode {supported ? '(mic + speaker)' : '(unsupported in this browser)'}
          </label>
          <span className="font-mono text-[10.5px] text-slateink-400">
            {running
              ? `${voice.status} · ${voice.metrics.voiceToVoiceMs ? `${voice.metrics.voiceToVoiceMs}ms voice-to-voice · ` : ''}${
                  voice.metrics.sttMs ? `${voice.metrics.sttMs}ms stt · ` : ''
                }${voice.metrics.turns} turns`
              : live
                ? 'Real call · metered · saved to your log'
                : 'No session — sign in to place calls'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <>
                <button
                  onClick={() => voice.setMuted(!voice.muted)}
                  className={cn('btn-ghost btn-sm', voice.muted && 'border-red-500/40 bg-red-500/10 text-red-700')}
                >
                  {voice.muted ? <Icons.micOff size={14} /> : <Icons.mic size={14} />}
                  {voice.muted ? 'Muted' : 'Mute'}
                </button>
                <button onClick={() => void hangUp()} className="btn-sm rounded-full bg-red-500 px-4 py-2 text-slate-900 hover:bg-red-400">
                  <Icons.phoneOff size={14} /> End call
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setLines([]);
                  setLogId(null);
                  if (!live) {
                    toast('Sign in to place a real call — the agent runs server-side.');
                    return;
                  }
                  if (voiceMode && supported) {
                    void voice.start().then(() => {
                      // Start the call record immediately so the greeting is logged.
                      void openCall().catch(() => undefined);
                    });
                  } else {
                    void openCall()
                      .then(() => toast('Call open — type what the caller says below.'))
                      .catch(() => toast('Could not open the call.'));
                  }
                }}
                className="btn-brand btn-sm"
              >
                <Icons.phone size={14} /> Start call
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div>
          <div ref={transcriptRef} className="no-scrollbar h-[330px] overflow-y-auto rounded-xl border border-slate-900/[0.045] bg-ink-950/60 p-4">
            {lines.length === 0 ? (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-brand-500/20 bg-brand-500/[0.07]">
                    <Icons.waveform size={22} className="text-brand-700" />
                  </span>
                  <p className="text-[13.5px] font-medium text-slate-900">Talk to {assistant?.name ?? 'your agent'}</p>
                  <p className="mx-auto mt-1.5 max-w-[40ch] text-[12px] leading-snug text-slateink-400">
                    {supported && voiceMode
                      ? 'Your browser transcribes you, the agent answers over a stream, and its reply is spoken as it arrives — tolerating interruptions like a real call.'
                      : 'Type what the caller says; the agent answers through the same pipeline, tools included.'}
                  </p>
                  {micState === 'denied' && (
                    <p className="mx-auto mt-2 max-w-[40ch] text-[11.5px] text-amber-800">
                      Microphone is blocked for this site. Allow it in the browser, or use typed mode below.
                    </p>
                  )}
                  {logId && (
                    <a href={`/dashboard/calls/${logId}`} className="mt-4 inline-flex text-[12px] text-brand-700 hover:underline">
                      View the saved call →
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {lines.map((line, i) => {
                  if (line.kind === 'tool') {
                    return (
                      <div key={i} className="flex justify-center">
                        <span className="rounded-full border border-brand-500/25 bg-brand-500/[0.08] px-3 py-1 font-mono text-[10px] text-brand-700">
                          tool · {line.name}
                          {line.args && Object.keys(line.args).length ? `(${JSON.stringify(line.args)})` : ''}
                          {line.result ? ` → ${line.result.slice(0, 90)} · ${line.ms}ms` : ' …'}
                        </span>
                      </div>
                    );
                  }
                  if (line.kind === 'guardrail') {
                    return (
                      <div key={i} className="flex justify-center">
                        <span className="rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-3 py-1 font-mono text-[10px] text-amber-800">
                          guardrail · {line.action} — {line.note}
                        </span>
                      </div>
                    );
                  }
                  if (line.kind === 'intent') {
                    return (
                      <div key={i} className="flex justify-center">
                        <span className="font-mono text-[10px] text-slateink-500">
                          intent · {line.intent} · {Math.round(line.confidence * 100)}%
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className={cn('flex gap-2.5', line.kind === 'user' && 'justify-end')}>
                      {line.kind === 'assistant' && (
                        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-brand-500/25 bg-brand-500/10 font-mono text-[9.5px] text-brand-700">
                          AI
                        </span>
                      )}
                      <div
                        className={cn(
                          'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug',
                          line.kind === 'assistant' ? 'border border-slate-900/[0.045] bg-ink-850/90 text-slateink-200' : 'bg-white text-black'
                        )}
                      >
                        {line.text}
                      </div>
                    </div>
                  );
                })}
                {voice.status === 'thinking' && <div className="font-mono text-[11px] text-slateink-400">thinking…</div>}
              </div>
            )}
          </div>

          <form onSubmit={sendTyped} className="mt-3 flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!live}
              placeholder={live ? 'Type what the caller says (works alongside the mic)…' : 'Sign in to place calls'}
              className="field flex-1"
              aria-label="Caller utterance"
            />
            <button type="submit" disabled={!live || !draft.trim()} className="btn-brand btn-sm">
              <Icons.send size={14} /> Say
            </button>
          </form>

          <div className="mt-3 rounded-xl border border-slate-900/[0.045] bg-ink-900/60 px-4 py-3">
            <div className="flex items-center gap-3">
              <LiveWave active={speaking !== null || voice.level > 0.08} bars={22} />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">
                {voice.status === 'listening' ? 'listening' : voice.status === 'thinking' ? 'thinking' : speaking === 'agent' ? 'agent speaking' : voice.status}
              </span>
              {running && <Meter level={voice.level} bars={20} className="ml-auto" />}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/60 p-4">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-slateink-400">Voice path</div>
            <div className="mt-3 space-y-2">
              {[
                ['Transcriber', 'browser speech API'],
                ['Model', assistant?.model ?? '—'],
                ['Voice', `${assistant?.voiceId ?? '—'} (system)`],
                ['Tools', `${assistant?.tools.length ?? 0} enabled`],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-2">
                  <span className="text-[11px] text-slateink-400">{k}</span>
                  <span className="truncate text-right font-mono text-[10.5px] text-slate-900">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/60 p-4">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-slateink-400">Measured live</div>
            <div className="mt-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slateink-400">Browser round trip</span>
                {voice.metrics.voiceToVoiceMs ? <Pill tone="brand">{voice.metrics.voiceToVoiceMs}ms</Pill> : <span className="font-mono text-[11px] text-slateink-400">—</span>}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slateink-400">Transcriber</span>
                <span className="font-mono text-[11px] text-slate-900">{voice.metrics.sttMs ? `${voice.metrics.sttMs}ms` : '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slateink-400">Agent turn</span>
                <span className="font-mono text-[11px] text-slate-900">{voice.metrics.lastLatencyMs ? `${voice.metrics.lastLatencyMs}ms` : '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slateink-400">Turns · barged-in</span>
                <span className="font-mono text-[11px] text-slate-900">
                  {voice.metrics.turns} · {voice.metrics.bargeIns}
                </span>
              </div>

            </div>
          </div>

          <p className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3 text-[11px] leading-relaxed text-slateink-400">
            {live ? (
              <>
                Transcription happens in the browser; the reply streams from{' '}
                <span className="font-mono text-slateink-300">/api/v1/calls/{'{id}'}/turn/stream</span> and starts playing on the first chunk, not the
                last. Interrupt the agent — it yields.
              </>
            ) : (
              <>Sign in to open a web test against the assistant runtime.</>
            )}
          </p>
        </div>
      </div>
    </Modal>
  );
}
