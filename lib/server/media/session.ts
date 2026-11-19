/**
 * A live phone call, as a state machine.
 *
 * Twilio opens a WebSocket and then exchanges JSON frames:
 *
 *   → connected, start, media (base64 8 kHz μ-law), dtmf, stop
 *   ← media (base64 μ-law to play), mark, clear
 *
 * This class owns one call: it decodes inbound audio, runs voice activity so it
 * knows when the caller is talking, streams to a recogniser, runs the agent turn
 * on each final transcript, synthesises the reply, writes audio back into the
 * call in paced 20 ms frames, and handles barge-in by clearing whatever Twilio
 * has buffered and cancelling the synthesis in flight.
 *
 * It has no idea about Next.js or WebSockets — it takes a small transport
 * interface, so it can be driven by the `ws` server, by tests, or by a different
 * carrier's protocol.
 */

import { AudioBuffer, VoiceActivity, providerPcmToUlaw, rms, silenceUlaw, ulawToProviderPcm } from './audio';
import { available as sttAvailable, openDeepgram, type SttSession } from '../providers/stt';
import { available as ttsAvailable, synthesise } from '../providers/tts';
import { assistantConfigFor, telephonyTurn } from '../telephony';
import { endCall, getCall } from '../calls';
import { audit } from '../audit';

export type MediaTransport = {
  /** Sends a JSON frame back over the carrier socket. */
  send: (payload: Record<string, unknown>) => void;
  /** Called when the worker decides the call should end. */
  hangup: (reason: string) => void;
};

export type SessionOptions = {
  callId: string;
  orgId: string;
  transport: MediaTransport;
  /** Carrier stream SID — required by Twilio on every outbound media frame. */
  streamSid?: string;
  /** μ-law frame size in milliseconds (Twilio uses 20). */
  frameMs?: number;
  /** Test/debug hook: injected transcripts instead of a provider socket. */
  transcripts?: AsyncIterable<string>;
};

const FRAME_MS = 20;
/** Silence pushed while the agent is thinking, so the line never sounds dead. */
const THINKING_MS = 300;

/**
 * Limits, because a phone line is a resource someone pays for and a socket that
 * never closes is a leak. Both are overridable per deployment.
 *
 *  - a hard ceiling on call length, so a call the carrier fails to close cannot
 *    run forever (and so nobody is billed past what a plan allows);
 *  - an idle timeout on inbound audio, so a caller who put the phone down mid
 *    call releases the transcriber instead of holding it open.
 */
const MAX_CALL_MS = () => Number(process.env.VOXERA_MAX_CALL_MINUTES ?? 60) * 60_000;
const IDLE_MS = () => Number(process.env.VOXERA_MEDIA_IDLE_SECONDS ?? 45) * 1000;

export class CallSession {
  private callId: string;
  private orgId: string;
  private transport: MediaTransport;
  private streamSid: string;
  private frameMs: number;

  private vad = new VoiceActivity({ frameMs: FRAME_MS });
  private outbound = new AudioBuffer();
  private stt?: SttSession;
  private sttReady = false;
  private closed = false;

  private partial = '';
  private utteranceStart = 0;
  private turnInFlight = false;
  private speaking = false;
  private synthesising = false;
  private abortSynthesis?: AbortController;
  private paceTimer?: NodeJS.Timeout;
  private limitTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private transcripts?: AsyncIterable<string>;

  /** Observable state, written back to the call record as it changes. */
  stats = {
    frames: 0,
    speechFrames: 0,
    utterances: 0,
    bargeIns: 0,
    sttProvider: sttAvailable() ?? null,
    ttsProvider: ttsAvailable() ?? null,
    firstAudioMs: 0,
    errors: [] as string[],
  };

  constructor(private options: SessionOptions) {
    this.callId = options.callId;
    this.orgId = options.orgId;
    this.transport = options.transport;
    this.streamSid = options.streamSid ?? '';
    this.frameMs = options.frameMs ?? FRAME_MS;
    this.transcripts = options.transcripts;
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    const call = getCall(this.callId);
    if (!call) {
      this.fail('call record not found');
      return;
    }

    const maxMs = MAX_CALL_MS();
    if (maxMs > 0) {
      this.limitTimer = setTimeout(() => {
        this.record(`Call reached the ${Math.round(maxMs / 60_000)}-minute limit and was ended.`);
        this.transport.hangup('max-duration');
      }, maxMs);
      this.limitTimer.unref?.();
    }

    // Greeting first, so the caller hears a voice as soon as the line connects.
    const config = assistantConfigFor(call.assistantId, this.orgId);
    if (config?.firstMessage) {
      await this.speak(config.firstMessage);
    }

    if (this.transcripts) {
      void this.consumeInjectedTranscripts();
      return;
    }

    if (!sttAvailable()) {
      this.record('No speech-to-text provider configured — audio is being received but not transcribed.');
      // Stay on the line: the caller may still be handled by a human, and the
      // call record should show exactly why nothing was understood.
      return;
    }

    const session = openDeepgram({
      sampleRate: 16000,
      keywords: ['order', 'refund', 'appointment', 'billing', 'human', 'agent'],
      endpointingMs: 300,
      onTranscript: (t) => {
        if (t.final && t.text.trim()) {
          this.partial = '';
          void this.utterance(t.text.trim());
        } else if (t.text.trim()) {
          this.partial = t.text.trim();
          // Interim results go to the dashboard as they arrive.
          this.transport.send({ event: 'transcript.partial', text: this.partial });
        }
      },
      onError: (error) => this.record(`transcriber: ${error}`),
    });
    this.stt = session;
    try {
      await session.ready;
      this.sttReady = true;
    } catch {
      this.record('The transcriber connection failed; the call continues but will not be understood.');
    }
  }

  /** One inbound media frame from the carrier (base64 μ-law, 20 ms). */
  pushAudio(base64: string) {
    if (this.closed) return;
    this.stats.frames += 1;
    this.armIdleTimer();
    const ulaw = Buffer.from(base64, 'base64');
    const providerPcm = ulawToProviderPcm(ulaw);
    const level = rms(providerPcm);
    const activity = this.vad.push(level);

    // Barge-in: the caller talking over the agent cancels playback immediately.
    if (activity.start) {
      this.stats.speechFrames += 1;
      if (this.speaking) {
        this.stats.bargeIns += 1;
        this.interrupt();
        this.record('Caller interrupted the agent — playback cleared.');
      }
    }

    if (this.sttReady && this.stt) this.stt.write(providerPcm);
  }

  /** DTMF from the caller — mapped to intents so keypresses still work. */
  pushDtmf(digit: string) {
    const map: Record<string, string> = { '1': 'Order status', '2': 'Billing', '3': 'Appointment', '0': 'Speak to a human' };
    const phrase = map[digit];
    if (phrase) void this.utterance(phrase);
    else this.record(`Unmapped keypress: ${digit}`);
  }

  /** Carrier said the stream stopped, or the socket died. */
  stop(reason = 'customer-ended-call') {
    if (this.closed) return;
    this.closed = true;
    if (this.paceTimer) clearInterval(this.paceTimer);
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.abortSynthesis?.abort();
    this.stt?.close();
    endCall({ orgId: this.orgId, callId: this.callId, endedReason: reason });
    this.record(`Call ended (${reason}).`);
  }

  /**
   * Restarts the idle countdown. Only meaningful for real audio: a simulated
   * session has no frames by design and must not be reaped for silence.
   */
  private armIdleTimer() {
    if (this.transcripts) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = IDLE_MS();
    if (idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.record(`No audio for ${Math.round(idleMs / 1000)}s — ending the call rather than holding the line open.`);
      this.transport.hangup('no-audio');
    }, idleMs);
    this.idleTimer.unref?.();
  }

  /* ------------------------------------------------------------------ turns */

  /**
   * A completed caller utterance.
   *
   * The turn runs the same runtime the browser path uses, so tools, guardrails,
   * knowledge and metering behave identically; only the transport differs.
   */
  private async utterance(text: string) {
    if (this.closed) return;
    const call = getCall(this.callId);
    if (!call || call.status !== 'in-progress') return;
    this.stats.utterances += 1;
    this.transport.send({ event: 'transcript.final', text });

    // Callers on a phone cannot barge in on a tool call, so the reply waits for
    // the tools to finish and then speaks the whole answer.
    this.turnInFlight = true;
    const started = Date.now();
    try {
      const turn = await telephonyTurn({ call, orgId: this.orgId, text });
      if (!turn) {
        this.record('Assistant no longer exists for this call.');
        this.transport.hangup('assistant_missing');
        return;
      }
      this.transport.send({
        event: 'turn',
        intent: turn.result.intent,
        tools: turn.result.toolCalls.map((t) => ({ name: t.name, ms: t.ms })),
        guardrail: turn.result.guardrail?.kind,
        // Set when a squad member took the call over — the carrier's dashboard
        // and our call record show the same thing.
        handoff: turn.handoff ? { to: turn.handoff.toName, brief: turn.handoff.brief } : undefined,
        latencyMs: Date.now() - started,
      });

      if (turn.forwarded) {
        await this.speak(turn.result.reply);
        this.transport.send({ event: 'forward', to: '+14155550100' });
        return;
      }
      await this.speak(turn.result.reply);
      if (turn.result.intent === 'goodbye') {
        this.transport.hangup('assistant-ended-call');
      }
    } catch (err) {
      this.record(err instanceof Error ? err.message : 'turn failed');
    } finally {
      this.turnInFlight = false;
    }
  }

  private async consumeInjectedTranscripts() {
    if (!this.transcripts) return;
    for await (const text of this.transcripts) {
      await this.utterance(text);
    }
  }

  /* ------------------------------------------------------------------ audio */

  /**
   * Synthesises a reply and writes it into the call.
   *
   * Frames are paced at real time (20 ms of audio every 20 ms) because Twilio
   * plays what it receives; pushing a whole sentence at once makes the carrier
   * jitter-buffer it and adds latency to everything that follows.
   */
  private async speak(text: string) {
    if (this.closed) return;

    if (!ttsAvailable()) {
      this.record('Cannot speak: no text-to-speech provider configured.');
      // Keep the line warm rather than dead, and treat it as the agent talking so
      // barge-in still works — but do not pad out the full length of the reply,
      // because nothing is actually being said.
      this.speaking = true;
      this.outbound.push(silenceUlaw(Math.min(1_200, Math.max(400, text.length * 8))));
      this.startPacing();
      return;
    }

    this.speaking = true;
    this.synthesising = true;
    this.abortSynthesis = new AbortController();
    // Voice selection is deployment-level in this build. Do not forward a
    // legacy assistant alias to whichever provider happens to be configured.
    const result = await synthesise({
      text,
      onChunk: ({ audio }) => {
        if (this.aborted) return;
        this.outbound.push(audio);
        if (!this.stats.firstAudioMs) this.stats.firstAudioMs = Date.now();
      },
      signal: this.abortSynthesis.signal,
    });

    this.synthesising = false;
    if (!result.ok) this.record(`speech: ${result.error}`);
    this.startPacing();
  }

  private get aborted() {
    return this.abortSynthesis?.signal.aborted ?? false;
  }

  /**
   * Writes buffered audio into the call at real time: one 20 ms frame every
   * 20 ms, catching up if the queue is running more than ~200 ms ahead.
   */
  private startPacing() {
    if (this.paceTimer) return;
    // A short silence pad before speech gives the carrier something to settle
    // into, which is what stops the first syllable getting clipped.
    this.outbound.push(silenceUlaw(80));

    this.paceTimer = setInterval(() => {
      if (this.closed) return;
      const backlog = this.outbound.pending;
      const frames = this.outbound.drain(backlog > 1600 ? 3 : 1);
      for (const frame of frames) {
        this.transport.send({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: Buffer.from(frame).toString('base64') },
        });
      }
      if (!frames.length && !this.synthesising && !this.turnInFlight) {
        this.speaking = false;
        clearInterval(this.paceTimer);
        this.paceTimer = undefined;
        this.transport.send({ event: 'mark', name: `reply-${Date.now()}` });
      }
    }, this.frameMs);
  }

  /** Barge-in: drop what has not played and cancel the synthesis in flight. */
  private interrupt() {
    this.abortSynthesis?.abort();
    this.synthesising = false;
    this.outbound.flush();
    this.outbound.resume();
    if (this.paceTimer) {
      clearInterval(this.paceTimer);
      this.paceTimer = undefined;
    }
    this.speaking = false;
    // Twilio holds buffered audio; `clear` discards it so the agent stops talking.
    this.transport.send({ event: 'clear', streamSid: this.streamSid });
  }

  /* --------------------------------------------------------------- reporting */

  /** Writes notable session events onto the call record, where they belong. */
  private record(note: string) {
    if (this.stats.errors.length > 60) return;
    this.stats.errors.push(note);
    audit({ orgId: this.orgId, actor: 'media', action: 'call.media_note', target: this.callId, detail: note });
  }

  private fail(error: string) {
    this.record(error);
    this.transport.hangup('error');
  }

  /** Snapshot for the call record / dashboard. */
  summary() {
    return {
      ...this.stats,
      streaming: Boolean(this.stt),
      transcripts: this.stats.utterances,
      notes: this.stats.errors.slice(-8),
    };
  }
}
