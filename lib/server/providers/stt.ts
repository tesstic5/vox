/**
 * Speech-to-text providers.
 *
 * A live call needs a *streaming* recogniser: audio goes up, partial and final
 * transcripts come back, and the turn is triggered on the final. Deepgram's
 * streaming API is wired here because it accepts raw PCM16 with no container;
 * OpenAI and Groq can transcribe explicitly buffered utterances through the
 * separate batch helper, but they are not presented as live-stream fallbacks.
 *
 * With a Deepgram key: live streaming transcription. Without one: `available()`
 * is false and the worker says so on the call record rather than inventing text.
 */

import WebSocket from 'ws';

export type SttProvider = 'deepgram' | 'openai' | 'groq';

export type SttTranscript = {
  text: string;
  final: boolean;
  confidence?: number;
  /** Milliseconds of audio the provider has consumed — used for endpointing. */
  durationMs?: number;
};

export type SttSession = {
  provider: SttProvider;
  /** Push 16 kHz PCM16. */
  write: (pcm: Int16Array) => void;
  /** Flush and close (end of call). */
  close: () => void;
  /** Resolves when the socket is ready to accept audio. */
  ready: Promise<void>;
};

export function available() {
  // MediaSession opens a bidirectional Deepgram socket. Batch transcription
  // keys must not make that streaming readiness check pass.
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram' as const;
  return undefined;
}

export function describe() {
  const provider = available();
  if (!provider) {
    return {
      configured: false as const,
      provider: null,
      detail:
        'No live speech-to-text stream is configured. Set DEEPGRAM_API_KEY to transcribe carrier audio. OpenAI and Groq batch transcription keys do not make the live stream ready. Until then the worker records the boundary instead of guessing at words.',
    };
  }
  return { configured: true as const, provider, detail: `${provider} streaming transcription is active.` };
}

type DeepgramOptions = {
  sampleRate?: number;
  language?: string;
  /** Keywords bias recognition — order numbers, product names, your vocabulary. */
  keywords?: string[];
  /** How long a pause ends an utterance. Shorter = snappier, more interruptions. */
  endpointingMs?: number;
  onTranscript: (t: SttTranscript) => void;
  onError?: (error: string) => void;
};

/**
 * Deepgram streaming session.
 *
 * `encoding=linear16` because we hand it PCM we already decoded from μ-law, and
 * `interim_results=true` so the UI (and the endpointing decision) can see what
 * the caller is saying as they say it.
 */
export function openDeepgram(options: DeepgramOptions): SttSession {
  const sampleRate = options.sampleRate ?? 16000;
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    model: 'nova-3',
    language: options.language ?? 'en-US',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: String(options.endpointingMs ?? 300),
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  options.keywords?.slice(0, 40).forEach((k) => params.append('keywords', `${k}:1`));

  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
    headers: { authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  let resolveReady: () => void = () => undefined;
  let rejectReady: (e: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let closed = false;

  socket.on('open', () => resolveReady());
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        duration?: number;
        channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
      };
      if (msg.type === 'UtteranceEnd') {
        options.onTranscript({ text: '', final: true });
        return;
      }
      const alternative = msg.channel?.alternatives?.[0];
      const text = alternative?.transcript ?? '';
      if (!text) return;
      options.onTranscript({
        text,
        final: Boolean(msg.is_final || msg.speech_final),
        confidence: alternative?.confidence,
        durationMs: msg.duration ? msg.duration * 1000 : undefined,
      });
    } catch {
      /* ignore malformed frames */
    }
  });
  socket.on('error', (err) => {
    options.onError?.(err.message);
    rejectReady(err instanceof Error ? err : new Error('deepgram socket error'));
  });
  socket.on('close', () => {
    closed = true;
  });

  return {
    provider: 'deepgram',
    ready,
    write: (pcm) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      socket.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    },
    close: () => {
      try {
        socket.send(JSON.stringify({ type: 'CloseStream' }));
        socket.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Batch transcription of one utterance — for providers without a practical
 * streaming socket, or for reprocessing a recording. WAV-wrapped PCM16.
 */
function wav(pcm: Int16Array, sampleRate: number) {
  const header = Buffer.alloc(44);
  const dataLength = pcm.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export async function transcribeUtterance(input: {
  pcm: Int16Array;
  sampleRate?: number;
  provider?: SttProvider;
  language?: string;
  prompt?: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const sampleRate = input.sampleRate ?? 16000;
  const provider = input.provider ?? available();
  if (!provider) return { ok: false, error: 'no speech-to-text provider configured' };

  try {
    if (provider === 'openai' || provider === 'groq') {
      const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY;
      const endpoint =
        provider === 'openai' ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://api.groq.com/openai/v1/audio/transcriptions';
      const form = new FormData();
      const bytes = wav(input.pcm, sampleRate);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'utterance.wav');
      form.append('model', provider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-large-v3-turbo');
      if (input.language) form.append('language', input.language.split('-')[0]);
      if (input.prompt) form.append('prompt', input.prompt.slice(0, 900));
      const res = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(20_000) });
      const json = (await res.json()) as { text?: string; error?: { message?: string } };
      if (!res.ok) return { ok: false, error: json.error?.message ?? `transcription failed (${res.status})` };
      return { ok: true, text: (json.text ?? '').trim() };
    }

    // Deepgram's pre-recorded endpoint, for a single buffered utterance.
    const params = new URLSearchParams({ model: 'nova-3', language: input.language ?? 'en-US', smart_format: 'true', punctuate: 'true' });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: { authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'content-type': 'audio/wav' },
      body: new Uint8Array(wav(input.pcm, sampleRate)),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
      err_msg?: string;
    };
    if (!res.ok) return { ok: false, error: json.err_msg ?? `transcription failed (${res.status})` };
    return { ok: true, text: (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'transcription failed' };
  }
}
