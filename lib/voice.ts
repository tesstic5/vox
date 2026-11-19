'use client';

/**
 * The browser half of the voice pipeline.
 *
 *   1. Listen   — `SpeechRecognition` transcribes the caller continuously and
 *                 reports when they stopped speaking.
 *   2. Think    — the transcript goes to the agent over SSE; tools, guardrails
 *                 and the reply stream back as they happen.
 *   3. Speak    — `speechSynthesis` starts on the first chunk (`tts.start`), not
 *                 on the last one, which is what keeps the gap short.
 *
 * The mic level is read from an `AnalyserNode` so the UI can show a real input
 * meter rather than a random animation, and barge-in stops playback the moment
 * the caller starts talking.
 */

import * as React from 'react';

export type VoiceStatus = 'unsupported' | 'idle' | 'requesting' | 'listening' | 'thinking' | 'speaking' | 'error';

export type VoiceEvent =
  | { kind: 'stt.partial'; text: string }
  | { kind: 'stt.final'; text: string; sttMs: number }
  | { kind: 'intent'; intent: string; confidence: number }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; result?: string; ms?: number }
  | { kind: 'guardrail'; note: string; action: string; severity: string }
  | { kind: 'assistant.partial'; text: string }
  | { kind: 'assistant.final'; text: string; latencyMs: number; voiceToVoiceMs?: number }
  | { kind: 'status'; status: VoiceStatus }
  | { kind: 'error'; message: string };

/** Minimal typings for the Web Speech API, which TypeScript does not ship. */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string; confidence: number } };
  };
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function voiceSupported() {
  if (typeof window === 'undefined') return false;
  return Boolean(recognitionCtor()) && 'speechSynthesis' in window;
}

/** Picks the most natural-sounding available system voice. */
export function pickVoice(preferred?: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return undefined;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return undefined;
  if (preferred) {
    const byName = voices.find((v) => v.name.toLowerCase().includes(preferred.toLowerCase()));
    if (byName) return byName;
  }
  const ranked = [
    /Google US English/i,
    /Samantha/i,
    /Aria/i,
    /Jenny/i,
    /Google UK English Female/i,
    /Microsoft Aria/i,
    /Female/i,
  ];
  for (const pattern of ranked) {
    const hit = voices.find((v) => pattern.test(v.name));
    if (hit) return hit;
  }
  return voices.find((v) => v.lang.startsWith('en')) ?? voices[0];
}

export type CallHandle = {
  status: VoiceStatus;
  events: VoiceEvent[];
  transcript: { role: 'user' | 'assistant'; text: string }[];
  level: number;
  /** Live metrics measured on this device. */
  metrics: { voiceToVoiceMs?: number; sttMs?: number; lastLatencyMs?: number; turns: number; bargeIns: number };
  speaking: 'agent' | 'user' | null;
  muted: boolean;
  start: () => Promise<void>;
  stop: () => void;
  setMuted: (muted: boolean) => void;
};

/**
 * Drives one call in the browser.
 *
 * `onTurn` is the transport: it receives the caller's transcript and must return
 * the streaming response to consume. Both the public demo (`/api/public/demo/:id/turn`)
 * and a signed-in test call (`/api/v1/calls/:id/turn/stream`) use this hook —
 * the audio path is identical, only the auth differs.
 */
export function useVoiceCall(options: {
  enabled: boolean;
  /** Resolves the stream for one caller turn. */
  onTurn?: (text: string, device: { sttMs: number }) => Promise<ReadableStream<Uint8Array> | null>;
  /** Called with device-side measurements after the agent finishes speaking. */
  onTelemetry?: (metrics: { voiceToVoiceMs: number; sttMs: number; bargeIns: number }) => void;
  /** Called with the transcript when the caller hangs up. */
  onEnd?: () => void;
  voiceHint?: string;
  greeting?: string;
}): CallHandle {
  const { enabled, onTurn, onTelemetry, onEnd, voiceHint, greeting } = options;

  const [status, setStatus] = React.useState<VoiceStatus>('idle');
  const [events, setEvents] = React.useState<VoiceEvent[]>([]);
  const [transcript, setTranscript] = React.useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [level, setLevel] = React.useState(0);
  const [speaking, setSpeaking] = React.useState<'agent' | 'user' | null>(null);
  const [muted, setMutedState] = React.useState(false);
  const [metrics, setMetrics] = React.useState<CallHandle['metrics']>({ turns: 0, bargeIns: 0 });

  const recognition = React.useRef<SpeechRecognitionLike | null>(null);
  const stream = React.useRef<MediaStream | null>(null);
  const analyser = React.useRef<AnalyserNode | null>(null);
  const audioCtx = React.useRef<AudioContext | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const running = React.useRef(false);
  const mutedRef = React.useRef(false);
  const busy = React.useRef(false);
  const speechEndedAt = React.useRef(0);
  const endedAtRef = React.useRef(0);
  const sttStartedAt = React.useRef(0);
  const lastSttMs = React.useRef(0);
  const bargeInsRef = React.useRef(0);
  const metricsRef = React.useRef<CallHandle['metrics']>({ turns: 0, bargeIns: 0 });
  const mutedBeforeSpeak = React.useRef(false);

  const push = React.useCallback((event: VoiceEvent) => {
    setEvents((prev) => [...prev.slice(-200), event]);
  }, []);

  const setStatusBoth = React.useCallback(
    (next: VoiceStatus) => {
      setStatus(next);
      push({ kind: 'status', status: next });
    },
    [push]
  );

  /* ------------------------------------------------------------ microphone */

  const startMeter = React.useCallback(async () => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = media;
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      audioCtx.current = ctx;
      const source = ctx.createMediaStreamSource(media);
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      source.connect(node);
      analyser.current = node;
      const buf = new Uint8Array(node.frequencyBinCount);
      const tick = () => {
        if (!analyser.current) return;
        analyser.current.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i];
        setLevel(Math.min(1, sum / buf.length / 90));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return true;
    } catch {
      // Recognition can still work without a meter on some browsers.
      return false;
    }
  }, []);

  const stopMeter = React.useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    analyser.current = null;
    setLevel(0);
  }, []);

  /* --------------------------------------------------------------- speaking */

  const speak = React.useCallback(
    (text: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(voiceHint);
      if (voice) utterance.voice = voice;
      utterance.rate = 1.03;
      utterance.pitch = 1;
      // Duck self-listening while the agent talks so it does not transcribe itself.
      if (!mutedRef.current) {
        mutedBeforeSpeak.current = false;
        recognition.current?.stop();
      }
      utterance.onstart = () => {
        setSpeaking('agent');
        // Voice-to-voice: the caller's last word to the agent's first audio.
        if (speechEndedAt.current) {
          const v2v = Date.now() - speechEndedAt.current;
          endedAtRef.current = v2v;
          metricsRef.current = { ...metricsRef.current, voiceToVoiceMs: v2v, sttMs: lastSttMs.current };
          setMetrics(metricsRef.current);
          push({ kind: 'status', status: 'speaking' });
        }
      };
      utterance.onend = () => {
        setSpeaking(null);
        if (!running.current) return;
        setStatusBoth('listening');
        try {
          recognition.current?.start();
        } catch {
          /* already started */
        }
      };
      setStatusBoth('speaking');
      window.speechSynthesis.speak(utterance);
    },
    [push, setStatusBoth, voiceHint]
  );

  const stopSpeaking = React.useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(null);
  }, []);

  /* ---------------------------------------------------------------- turns */

  const runTurn = React.useCallback(
    async (text: string) => {
      if (busy.current || !running.current) return;
      busy.current = true;
      const sttMs = lastSttMs.current;
      setStatusBoth('thinking');
      setTranscript((prev) => [...prev, { role: 'user', text }]);
      push({ kind: 'stt.final', text, sttMs });
      metricsRef.current = { ...metricsRef.current, turns: metricsRef.current.turns + 1, sttMs };
      setMetrics(metricsRef.current);

      let spoken = '';
      try {
        const body = await onTurn?.(text, { sttMs });
        if (!body) throw new Error('No transport for this call.');
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let started = false;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const eventLine = /^event: (.+)$/m.exec(frame);
            const dataLine = /^data: (.+)$/m.exec(frame);
            if (!eventLine || !dataLine) continue;
            const name = eventLine[1].trim();
            const data = JSON.parse(dataLine[1]) as Record<string, unknown>;
            switch (name) {
              case 'intent':
                push({ kind: 'intent', intent: String(data.intent), confidence: Number(data.confidence ?? 0) });
                break;
              case 'tool.start':
                push({ kind: 'tool', name: String(data.name), args: (data.args as Record<string, unknown>) ?? {} });
                break;
              case 'tool.end':
                push({ kind: 'tool', name: String(data.name), args: {}, result: String(data.result ?? ''), ms: Number(data.ms ?? 0) });
                break;
              case 'guardrail':
                push({ kind: 'guardrail', note: String(data.note ?? ''), action: String(data.action ?? ''), severity: String(data.kind ?? '') });
                break;
              case 'tts.start':
                if (!started) {
                  started = true;
                }
                break;
              case 'assistant.delta':
                spoken += String(data.text ?? '');
                push({ kind: 'assistant.partial', text: spoken });
                // Speak on the first chunk rather than the last.
                if (!started) {
                  started = true;
                  speak(spoken.trim());
                } else if (spoken.trim().length > 0 && !window.speechSynthesis.speaking) {
                  speak(spoken.trim());
                }
                break;
              case 'assistant.done': {
                const finalText = String(data.text ?? spoken).trim();
                spoken = finalText;
                setTranscript((prev) => [...prev, { role: 'assistant', text: finalText }]);
                push({
                  kind: 'assistant.final',
                  text: finalText,
                  latencyMs: Number(data.latencyMs ?? 0),
                  voiceToVoiceMs: endedAtRef.current || undefined,
                });
                metricsRef.current = { ...metricsRef.current, lastLatencyMs: Number(data.latencyMs ?? 0) };
                setMetrics(metricsRef.current);
                onTelemetry?.({
                  voiceToVoiceMs: endedAtRef.current,
                  sttMs: lastSttMs.current,
                  bargeIns: bargeInsRef.current,
                });
                break;
              }
              case 'error':
                push({ kind: 'error', message: String(data.message ?? 'Turn failed') });
                break;
              default:
                break;
            }
          }
        }
      } catch (err) {
        push({ kind: 'error', message: err instanceof Error ? err.message : 'The agent did not answer.' });
      } finally {
        busy.current = false;
      }
    },
    [onTelemetry, onTurn, push, setStatusBoth, speak]
  );

  /* ------------------------------------------------------------- lifecycle */

  const stop = React.useCallback(() => {
    running.current = false;
    busy.current = false;
    mutedRef.current = true;
    stopSpeaking();
    try {
      recognition.current?.abort();
    } catch {
      /* noop */
    }
    recognition.current = null;
    stopMeter();
    setStatusBoth('idle');
    setSpeaking(null);
    onEnd?.();
  }, [onEnd, setStatusBoth, stopMeter, stopSpeaking]);

  const start = React.useCallback(async () => {
    const Ctor = recognitionCtor();
    if (!enabled || !Ctor || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setStatusBoth('unsupported');
      return;
    }
    if (running.current) return;
    running.current = true;
    mutedRef.current = false;
    setMutedState(false);
    bargeInsRef.current = 0;
    metricsRef.current = { turns: 0, bargeIns: 0 };
    setMetrics(metricsRef.current);
    setStatusBoth('requesting');

    if (greeting) {
      setTranscript([{ role: 'assistant', text: greeting }]);
      push({ kind: 'assistant.final', text: greeting, latencyMs: 0 });
    }

    const mic = await startMeter();
    if (!mic) push({ kind: 'error', message: 'Microphone blocked — the agent can still answer if you type.' });

    const rec = new Ctor();
    recognition.current = rec;
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onspeechstart = () => {
      setSpeaking('user');
      // Barge-in: stop the agent the moment the caller talks over it.
      if (window.speechSynthesis.speaking) {
        bargeInsRef.current += 1;
        metricsRef.current = { ...metricsRef.current, bargeIns: bargeInsRef.current };
        setMetrics(metricsRef.current);
        stopSpeaking();
      }
    };

    rec.onspeechend = () => {
      setSpeaking(null);
      speechEndedAt.current = Date.now();
    };

    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) final += text;
        else interim += text;
      }
      if (interim) push({ kind: 'stt.partial', text: interim.trim() });
      if (final.trim()) {
        lastSttMs.current = sttStartedAt.current ? Date.now() - sttStartedAt.current : 0;
        void runTurn(final.trim());
      } else if (interim && !sttStartedAt.current) {
        sttStartedAt.current = Date.now();
      }
    };

    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        push({ kind: 'error', message: 'Microphone permission was denied. Allow it and start the call again.' });
        stop();
        return;
      }
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        push({ kind: 'error', message: `Transcriber: ${event.error}` });
      }
    };

    rec.onend = () => {
      // Chrome ends the session after silence; restart it while the call is live.
      if (!running.current || busy.current || window.speechSynthesis.speaking) return;
      try {
        rec.start();
      } catch {
        /* already running */
      }
    };

    try {
      rec.start();
      setStatusBoth('listening');
      if (greeting) speak(greeting);
    } catch {
      push({ kind: 'error', message: 'Could not start the transcriber.' });
      setStatusBoth('error');
    }
  }, [enabled, greeting, push, runTurn, setStatusBoth, speak, stop, stopMeter, stopSpeaking]);

  const setMuted = React.useCallback(
    (next: boolean) => {
      mutedRef.current = next;
      setMutedState(next);
      if (next) {
        try {
          recognition.current?.stop();
        } catch {
          /* noop */
        }
      } else if (running.current) {
        try {
          recognition.current?.start();
        } catch {
          /* noop */
        }
      }
    },
    []
  );

  React.useEffect(() => () => {
    running.current = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    try {
      recognition.current?.abort();
    } catch {
      /* noop */
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    audioCtx.current?.close().catch(() => undefined);
  }, []);

  return { status, events, transcript, level, metrics, speaking, muted, start, stop, setMuted };
}
