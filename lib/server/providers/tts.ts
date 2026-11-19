/**
 * Text-to-speech providers.
 *
 * The voice path has one hard requirement: audio must start before the sentence
 * is finished, in the carrier's format (8 kHz μ-law), so it can be written
 * straight into the media stream. ElevenLabs will emit μ-law directly; OpenAI
 * returns raw PCM at 24 kHz, which we resample.
 *
 * Without a key, `available()` is false and the worker tells the caller it could
 * not speak — it never silently drops audio.
 */

import { pcm16ToUlaw, resample, silenceUlaw } from '../media/audio';

export type TtsProvider = 'elevenlabs' | 'openai' | 'cartesia';

export type TtsChunk = { audio: Uint8Array; final: boolean };

export function available() {
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs' as const;
  if (process.env.OPENAI_API_KEY) return 'openai' as const;
  if (process.env.CARTESIA_API_KEY) return 'cartesia' as const;
  return undefined;
}

export function describe() {
  const provider = available();
  if (!provider) {
    return {
      configured: false as const,
      provider: null,
      detail:
        'No text-to-speech provider is configured, so the media worker can hear but not speak. Set ELEVENLABS_API_KEY, CARTESIA_API_KEY, or OPENAI_API_KEY. (Twilio’s own <Say> still works on the TwiML path.)',
    };
  }
  return { configured: true as const, provider, detail: `${provider} is synthesising audio for the media stream.` };
}

/** Rough duration of speech at a natural pace, for pacing audio into the call. */
export function estimateMs(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(400, Math.round((words / 165) * 60_000) + 220);
}

type SynthesiseInput = {
  text: string;
  voiceId?: string;
  /** BCP-47. */
  language?: string;
  onChunk: (chunk: TtsChunk) => void;
  signal?: AbortSignal;
};

/**
 * Speaks `text` and pushes μ-law frames as they arrive.
 *
 * Every provider here is asked to stream, and the first chunk is emitted as soon
 * as it exists — that is what makes time-to-first-audio tens of milliseconds
 * rather than seconds.
 */
export async function synthesise(input: SynthesiseInput): Promise<{ ok: true; provider: TtsProvider; firstChunkMs: number } | { ok: false; error: string }> {
  const provider = available();
  if (!provider) return { ok: false, error: 'no text-to-speech provider configured' };
  const started = Date.now();
  let first = 0;

  const emit = (audio: Uint8Array, final = false) => {
    if (!first && audio.length) first = Date.now() - started;
    input.onChunk({ audio, final });
  };

  try {
    if (provider === 'elevenlabs') {
      const voiceId = input.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`, {
        method: 'POST',
        headers: { 'xi-api-key': String(process.env.ELEVENLABS_API_KEY), 'content-type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          model_id: 'eleven_flash_v2_5',
          language_code: input.language?.split('-')[0],
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
          optimize_streaming_latency: 3,
        }),
        signal: input.signal ?? AbortSignal.timeout(45_000),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `elevenlabs returned ${res.status} ${detail.slice(0, 200)}` };
      }
      // Already μ-law 8 kHz: usable as carrier frames without conversion.
      await pump(res.body, (bytes) => emit(bytes));
      emit(silenceUlaw(60), true);
      return { ok: true, provider, firstChunkMs: first };
    }

    if (provider === 'cartesia') {
      const res = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'x-api-key': String(process.env.CARTESIA_API_KEY),
          'cartesia-version': '2024-06-10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model_id: process.env.CARTESIA_MODEL ?? 'sonic-2',
          transcript: input.text,
          voice: { mode: 'id', id: input.voiceId ?? process.env.CARTESIA_VOICE_ID ?? 'a0e99841-438c-4a64-b679-ae501e7d6091' },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 8000 },
        }),
        signal: input.signal ?? AbortSignal.timeout(45_000),
      });
      if (!res.ok || !res.body) return { ok: false, error: `cartesia returned ${res.status}` };
      await pump(res.body, (bytes) => {
        // raw little-endian PCM16 at 8 kHz
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
        emit(pcm16ToUlaw(pcm));
      });
      emit(silenceUlaw(60), true);
      return { ok: true, provider, firstChunkMs: first };
    }

    // OpenAI: PCM16 at 24 kHz, resampled down to the carrier's 8 kHz μ-law.
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
        voice: input.voiceId ?? process.env.OPENAI_TTS_VOICE ?? 'alloy',
        input: input.text,
        response_format: 'pcm',
        speed: 1.03,
      }),
      signal: input.signal ?? AbortSignal.timeout(45_000),
    });
    if (!res.ok || !res.body) return { ok: false, error: `openai tts returned ${res.status}` };
    await pump(res.body, (bytes, carry) => {
      const even = bytes.byteLength - (bytes.byteLength % 2);
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
      const downsampled = resample(pcm, 24000, 8000);
      emit(pcm16ToUlaw(downsampled));
      void carry;
    });
    emit(silenceUlaw(60), true);
    return { ok: true, provider, firstChunkMs: first };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: true, provider, firstChunkMs: first };
    return { ok: false, error: err instanceof Error ? err.message : 'synthesis failed' };
  }
}

/** Reads a byte stream and hands chunks over as they arrive. */
async function pump(body: ReadableStream<Uint8Array>, onChunk: (bytes: Uint8Array, carry?: Uint8Array) => void) {
  const reader = body.getReader();
  let carry = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    // Keep even lengths so 16-bit samples never split across chunks.
    const combined = new Uint8Array(carry.length + value.length);
    combined.set(carry, 0);
    combined.set(value, carry.length);
    const even = combined.length - (combined.length % 2);
    onChunk(combined.subarray(0, even), combined.subarray(even));
    carry = combined.subarray(even);
  }
  if (carry.length) onChunk(carry);
}
