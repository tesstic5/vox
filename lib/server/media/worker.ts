/**
 * The media worker.
 *
 * Twilio's `<Connect><Stream>` opens a WebSocket to this process and then speaks
 * its own protocol: a `connected` frame, a `start` frame describing the call, a
 * `media` frame every 20 ms carrying base64 8 kHz μ-law, and `mark`/`stop` as
 * things finish. We answer with `media` frames of our own (the agent's voice),
 * plus `clear` for barge-in.
 *
 * That is all this file does: hold the socket, verify the handshake, and hand
 * audio to a `CallSession` — which owns the actual conversation. It is attached
 * to the HTTP server by `server.ts` (see the note there about why the app has a
 * custom entry point).
 *
 * Testing seam: with `VOXERA_MEDIA_SIMULATE=1` the worker feeds the session a
 * scripted set of caller utterances instead of a transcriber socket, so the
 * whole path can be exercised without provider keys. Never set it in production.
 */

import type { IncomingMessage, Server } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { CallSession } from './session';
import { resolveSession } from './config';
import { update, type Doc } from '../db';
import { audit } from '../audit';
import { mediaSecret } from './secret';

export const MEDIA_PATH = '/api/telephony/twilio/media';

/** Set VOXERA_MEDIA_DEBUG=1 to trace every frame the worker sees. */
function debug(...args: unknown[]) {
  if (process.env.VOXERA_MEDIA_DEBUG === '1') console.log('[media]', ...args);
}

/**
 * How many calls may hold a media stream at once. Each live call owns a
 * transcriber socket and a playback buffer, so an unbounded number of sockets is
 * a way to exhaust the process. Overridable per deployment.
 */
const MAX_SESSIONS = () => Number(process.env.VOXERA_MEDIA_MAX_SESSIONS ?? 25);
let activeSessions = 0;

/** Constant-time compare of the token we minted when the call was answered. */
function tokenValid(input: { callId: string; callSid: string; token: string }) {
  // No secret, no trust: without one this deployment cannot verify any handshake,
  // so it accepts none (see `secret.ts` for why there is no default in production).
  const secret = mediaSecret();
  if (!secret) return false;
  const [expires, signature] = input.token.split('.');
  if (!expires || !signature) return false;
  if (Number(expires) < Date.now()) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${input.callSid}:${input.callId}:${expires}`)
    .digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Scripted caller for the simulate mode, timed so the pacing loop is exercised. */
async function* scriptedCaller(signal: { aborted: boolean }): AsyncGenerator<string> {
  const lines = [
    'Hi, I need to check on my order please.',
    'It was supposed to arrive on Tuesday and it has not shown up.',
    'Yes please, that is the right order.',
    'Can you book me an appointment for Thursday at 2pm instead?',
    'No that is everything, thanks for your help.',
  ];
  for (const line of lines) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (signal.aborted) return;
    yield line;
  }
}

function attach(socket: WebSocket, handshake: URL, release: () => void) {
  let session: CallSession | undefined;
  let streamSid = '';
  let started = false;
  const closed = { aborted: false };
  let mediaFrames = 0;
  let flushTimer: NodeJS.Timeout | undefined;

  const send = (payload: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  socket.on('message', (raw) => {
    let frame: {
      event?: string;
      streamSid?: string;
      media?: { payload?: string };
      dtmf?: { digit?: string };
      start?: {
        callSid?: string;
        streamSid?: string;
        from?: string;
        to?: string;
        customParameters?: Record<string, string>;
        mediaFormat?: { encoding?: string; sampleRate?: number };
      };
      stop?: { callSid?: string };
    };
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (frame.event === 'connected') {
      // Twilio is ready. Nothing to send until `start` arrives.
      return;
    }

    if (frame.event === 'start' && !started) {
      started = true;
      streamSid = frame.start?.streamSid ?? frame.streamSid ?? '';
      const callSid = frame.start?.callSid ?? '';
      const custom = frame.start?.customParameters ?? {};
      // Twilio puts the handshake token in customParameters; a direct client
      // may put it in the query string. Both are supported.
      const token = custom.token ?? handshake.searchParams.get('token') ?? '';

      const callId = custom.callId ?? '';
      debug('start frame', { callSid, to: frame.start?.to, from: frame.start?.from, streamSid, callId, hasToken: Boolean(token) });
      if (callId && !tokenValid({ callId, callSid, token })) {
        audit({ orgId: 'platform', actor: 'media', action: 'call.media_rejected', target: callId, detail: `bad handshake token for ${callSid}` });
        socket.close(1008, 'invalid stream token');
        return;
      }

      const resolved = resolveSession({
        callSid,
        to: frame.start?.to ?? '',
        from: frame.start?.from ?? '',
        streamSid,
        customParameters: custom,
      });
      debug('resolved', resolved);
      if (!resolved || !resolved.callId) {
        send({ event: 'error', message: 'no call found for this stream' });
        socket.close(1008, 'unknown call');
        return;
      }

      session = new CallSession({
        callId: resolved.callId,
        orgId: resolved.orgId,
        streamSid,
        transport: {
          send,
          // Ending the call before closing the socket means the call record keeps
          // the reason the worker decided on (max duration, capacity, idle) rather
          // than the generic 'socket-closed' the close handler would write.
          hangup: (reason) => {
            session?.stop(reason);
            send({ event: 'hangup', reason });
            socket.close(1000, reason);
          },
        },
        transcripts: process.env.VOXERA_MEDIA_SIMULATE === '1' ? scriptedCaller(closed) : undefined,
      });

      void session.start();
      // Persist worker state while the call runs, so the dashboard shows a live
      // call rather than one that only becomes real when it hangs up.
      flushTimer = setInterval(() => {
        if (!session) return;
        update<Doc>('calls', resolved.callId, {
          media: {
            stream: {
              provider: 'twilio',
              simulated: process.env.VOXERA_MEDIA_SIMULATE === '1',
              frames: session.stats.frames,
              utterances: session.stats.utterances,
              bargeIns: session.stats.bargeIns,
              transcriber: session.stats.sttProvider,
              voice: session.stats.ttsProvider,
              notes: session.stats.errors.slice(-5),
              updatedAt: new Date().toISOString(),
            },
          },
        });
      }, 4000);
      return;
    }

    if (frame.event === 'media' && session && frame.media?.payload) {
      if (mediaFrames++ === 0) debug('first media frame', frame.media.payload.length, 'bytes');
      session.pushAudio(frame.media.payload);
      return;
    }

    if (frame.event === 'dtmf' && session && frame.dtmf?.digit) {
      session.pushDtmf(frame.dtmf.digit);
      return;
    }

    if (frame.event === 'stop') {
      closed.aborted = true;
      session?.stop('customer-ended-call');
      session = undefined;
      if (flushTimer) clearInterval(flushTimer);
    }
  });

  socket.on('close', () => {
    closed.aborted = true;
    if (flushTimer) clearInterval(flushTimer);
    session?.stop('socket-closed');
    session = undefined;
    release();
  });

  socket.on('error', () => {
    closed.aborted = true;
  });
}

/**
 * Attaches the worker to an HTTP server.
 *
 * Anything that is not the media path is left completely alone, so Next's own
 * upgrade handling (and the dev HMR socket) keeps working.
 */
export function attachMediaWorker(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== MEDIA_PATH) return;

    // Capacity is a property of the deployment, not of the call: refuse the
    // upgrade outright rather than accepting audio we cannot process.
    if (activeSessions >= MAX_SESSIONS()) {
      audit({ orgId: 'platform', actor: 'media', action: 'call.media_rejected', detail: `at capacity (${activeSessions}/${MAX_SESSIONS()})` });
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    activeSessions += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
    };

    // A carrier sends the handshake token in the query string; Twilio itself also
    // passes stream parameters here, both are accepted and checked in `start`.
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Server-side `ws` sockets have no `url` of their own, so the handshake URL
      // travels with the connection. `release` is called when the socket closes,
      // whichever way it ends, so the capacity count cannot drift.
      attach(ws, url, release);
    });
  });

  return wss;
}
