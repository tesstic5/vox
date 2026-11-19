/**
 * Audio primitives for the media-stream path.
 *
 * Twilio sends and expects 8 kHz mono G.711 μ-law. Providers speak 16 kHz PCM.
 * Everything in between — decode, resample, level detection — lives here, with
 * no dependencies, because this code runs once per 20 ms frame per call.
 */

/** μ-law → linear PCM16 table (256 entries, built once). */
const ULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i += 1) {
  const u = ~i & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = ((mantissa << 3) + 0x84) << exponent;
  ULAW_DECODE[i] = Math.max(-32768, Math.min(32767, sign * (magnitude - 0x84)));
}

export function ulawToPcm16(ulaw: Uint8Array): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i += 1) out[i] = ULAW_DECODE[ulaw[i]];
  return out;
}

function search(val: number, table: Int16Array) {
  let lo = 0;
  let hi = 255;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < val) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo > 255 ? 255 : lo;
}

/** PCM16 → μ-law, the inverse of the table above (used for every outbound frame). */
export function pcm16ToUlaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    let sample = pcm[i];
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 0x84;
    const exponent = search(sample, ULAW_DECODE);
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/**
 * Linear resampling.
 *
 * Good enough for speech at these rates: the alternative is a polyphase filter
 * and a dependency, and the providers' own models tolerate the difference.
 */
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const length = Math.floor(input.length * ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Twilio frames are 8 kHz μ-law; providers want 16 kHz PCM16. */
export function ulawToProviderPcm(ulaw: Uint8Array) {
  return resample(ulawToPcm16(ulaw), 8000, 16000);
}

/** Provider PCM16 (16 kHz) back to a Twilio frame (8 kHz μ-law). */
export function providerPcmToUlaw(pcm: Int16Array, rate = 16000) {
  return pcm16ToUlaw(resample(pcm, rate, 8000));
}

/** Root-mean-square level of a frame, 0–1. Used for barge-in and silence. */
export function rms(pcm: Int16Array) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}

/** Silence a caller cannot hear, in the carrier's own format. */
export function silenceUlaw(ms: number) {
  return pcm16ToUlaw(new Int16Array(Math.round((ms / 1000) * 8000)));
}

/**
 * Voice activity: a frame is speech if it is above the noise floor for long
 * enough, which is what stops a cough from interrupting the agent mid-sentence.
 */
export class VoiceActivity {
  private noiseFloor = 0.006;
  private speechFrames = 0;
  private silenceFrames = 0;
  private speaking = false;

  constructor(private opts: { threshold?: number; speechMs?: number; silenceMs?: number; frameMs?: number } = {}) {}

  /** Returns true when the caller started or stopped speaking on this frame. */
  push(level: number): { start?: boolean; end?: boolean; speaking: boolean } {
    const threshold = this.opts.threshold ?? this.noiseFloor * 2.2;
    const frameMs = this.opts.frameMs ?? 20;
    const speechNeeded = Math.ceil((this.opts.speechMs ?? 120) / frameMs);
    const silenceNeeded = Math.ceil((this.opts.silenceMs ?? 700) / frameMs);

    if (level < this.noiseFloor) {
      // Track the room, not the talker: a slow follower avoids adapting to speech.
      this.noiseFloor = this.noiseFloor * 0.995 + level * 0.005;
    }

    const voiced = level > Math.max(threshold, 0.012);
    if (voiced) {
      this.speechFrames += 1;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
      this.speechFrames = 0;
    }

    if (!this.speaking && this.speechFrames >= speechNeeded) {
      this.speaking = true;
      return { start: true, speaking: true };
    }
    if (this.speaking && this.silenceFrames >= silenceNeeded) {
      this.speaking = false;
      return { end: true, speaking: false };
    }
    return { speaking: this.speaking };
  }

  get active() {
    return this.speaking;
  }
}

/**
 * A queue of audio frames with mark support.
 *
 * Twilio plays what it is sent, so the worker has to pace output itself; it also
 * has to be able to flush instantly when the caller interrupts.
 */
/**
 * Outbound audio queue.
 *
 * Providers hand over arbitrary chunk sizes; the carrier wants exactly 20 ms of
 * μ-law (160 bytes) per frame, written at real time. This buffers bytes and
 * hands out whole frames, so the pacing loop can simply ask for one frame every
 * 20 ms and let the queue absorb network jitter. `flush()` is barge-in: throw
 * away everything not yet played.
 */
export class AudioBuffer {
  private queue = new Uint8Array(0);
  private flushing = false;

  constructor(private frameBytes = 160) {}

  push(bytes: Uint8Array) {
    if (this.flushing || !bytes.length) return;
    const next = new Uint8Array(this.queue.length + bytes.length);
    next.set(this.queue, 0);
    next.set(bytes, this.queue.length);
    this.queue = next;
  }

  /** Up to `maxFrames` whole frames, oldest first. */
  drain(maxFrames = 1): Uint8Array[] {
    const frames: Uint8Array[] = [];
    while (frames.length < maxFrames && this.queue.length >= this.frameBytes) {
      frames.push(this.queue.subarray(0, this.frameBytes));
      this.queue = this.queue.subarray(this.frameBytes);
    }
    return frames;
  }

  /** Barge-in: drop queued audio and ignore anything pushed until `resume()`. */
  flush() {
    this.flushing = true;
    this.queue = new Uint8Array(0);
  }

  resume() {
    this.flushing = false;
  }

  /** Bytes waiting to play (a working measure of "how far ahead" we are). */
  get pending() {
    return this.queue.length;
  }
}
