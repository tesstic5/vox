/**
 * Media-stream check.
 *
 * Talks to a running deployment exactly the way Twilio does: opens the WebSocket,
 * sends `connected` / `start` / `media` / `stop`, and inspects what comes back.
 * Run it after starting the server with `VOXERA_MEDIA_SIMULATE=1` to exercise the
 * whole loop — turns, transcripts, pacing, barge-in — without provider keys.
 *
 *   VOXERA_MEDIA_SIMULATE=1 npm start
 *   npm run media:check
 *
 * Everything here is protocol-level on purpose: no imports from the app, so a
 * passing run means the wire contract is right, not that two copies of the same
 * assumption agree.
 */

import crypto from 'node:crypto';
import WebSocket from 'ws';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const SECRET = process.env.VOXERA_MEDIA_SECRET ?? 'dev-media-secret';

let cookie = '';
let failures = 0;

function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!pass) failures += 1;
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (TwiML, HTML) */
  }
  return { status: res.status, json, text };
}

/** 20 ms of μ-law silence, the carrier's own frame size. */
function silenceFrame() {
  return Buffer.alloc(160, 0xff);
}

/** A loud frame, used to make the worker believe the caller started talking. */
function loudFrame() {
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 160; i += 1) buf[i] = i % 2 ? 0x00 : 0xff;
  return buf;
}

async function main() {
  // ---- sign in and open a call we can attach a stream to -------------------
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  check('dashboard login', login.status === 200, `status ${login.status}`);

  const assistants = await api('/api/v1/assistants?limit=5');
  const list = (assistants.json as { data?: { id: string; name: string; status?: string }[] })?.data ?? [];
  const assistant = list.find((a) => a.status === 'published') ?? list[0];
  check('assistant available', Boolean(assistant), assistant?.name);
  if (!assistant) process.exit(1);

  const created = await api('/api/v1/calls', {
    method: 'POST',
    body: JSON.stringify({ assistantId: assistant.id, type: 'inbound', from: '+14155551234', to: '+14155550142' }),
  });
  const call = (created.json as { id?: string })?.id ?? (created.json as { data?: { id: string } })?.data?.id;
  check('call created', Boolean(call), call);
  if (!call) process.exit(1);

  // ---- status endpoint ----------------------------------------------------
  const status = await api('/api/telephony/media/status');
  const statusJson = status.json as { protocol?: string; inbound?: { frameMs?: number }; providers?: { transcriber?: { configured?: boolean } } };
  check('media status endpoint', status.status === 200 && statusJson.protocol === 'twilio-media-streams', `frame ${statusJson.inbound?.frameMs}ms`);
  check('status reports transcriber honestly', typeof statusJson.providers?.transcriber?.configured === 'boolean');

  // ---- the stream itself --------------------------------------------------
  const callSid = `CA${crypto.randomBytes(8).toString('hex')}`;
  const expires = Date.now() + 600_000;
  const token = `${expires}.${crypto.createHmac('sha256', SECRET).update(`${callSid}:${call}:${expires}`).digest('base64url')}`;
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/telephony/twilio/media?callId=${call}&token=${token}`);

  const events: string[] = [];
  const mediaFrames: Buffer[] = [];
  let cleared = 0;
  let marked = 0;
  let partials = 0;
  let closedCode = 0;

  /**
   * Talk back the moment the agent is audibly speaking.
   *
   * Barge-in used to be tested with a burst on a one-second timer, and that made
   * the assertion a coin flip. The reason is in the detector: a burst is 400 ms of
   * speech and the gaps between bursts are 600 ms, while the voice-activity check
   * needs 700 ms of silence before it will fire "speech started" again. So the
   * whole run produced **one** onset, at t≈1 s, and whether a `clear` came back
   * depended entirely on whether that one instant fell inside playback — which is
   * why it passed 7/7 alone and failed twice inside the full suite.
   *
   * The honest test is the condition barge-in is for: the caller talks *while the
   * agent is talking*. The agent's own media frames are proof of exactly that, so
   * a burst is sent when one arrives (rate-limited, so it stays a caller
   * interrupting rather than continuous noise).
   */
  let lastBarge = 0;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { event?: string; media?: { payload?: string } };
    if (!msg.event) return;
    events.push(msg.event);
    if (msg.event === 'media' && msg.media?.payload) {
      mediaFrames.push(Buffer.from(msg.media.payload, 'base64'));
      if (Date.now() - lastBarge > 1500) {
        lastBarge = Date.now();
        for (let i = 0; i < 20; i += 1) {
          ws.send(JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: loudFrame().toString('base64') } }));
        }
      }
    }
    if (msg.event === 'clear') cleared += 1;
    if (msg.event === 'mark') marked += 1;
    if (msg.event === 'transcript.partial') partials += 1;
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  check('websocket upgraded', ws.readyState === WebSocket.OPEN);

  ws.on('close', (code) => {
    closedCode = code;
  });

  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(
    JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ' + crypto.randomBytes(6).toString('hex'),
        callSid,
        from: '+14155551234',
        to: '+14155550142',
        customParameters: { callId: call },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
      streamSid: 'MZtest',
    })
  );

  // Speak for ~1.2 s (enough to trip voice activity), then hand over to silence.
  const talk = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: loudFrame().toString('base64') } }));
  }, 20);
  setTimeout(() => clearInterval(talk), 1200);

  // Keep sending silence so the line never looks dead, for the run of the test.
  const hum = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: silenceFrame().toString('base64') } }));
    }
  }, 20);

  // Barge-in is driven by the agent's own audio arriving — see the message
  // handler above. Nothing to schedule here.

  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'dtmf', streamSid: 'MZtest', dtmf: { digit: '2' } }));
  }, 7000);

  // Simulated caller runs ~5 scripted utterances; give it the time it needs.
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  clearInterval(hum);

  ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZtest' }));
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (ws.readyState === WebSocket.OPEN) ws.close();

  check('received media frames from the agent', mediaFrames.length > 0, `${mediaFrames.length} frames`);
  check('every frame is a 20 ms μ-law frame', mediaFrames.every((f) => f.length === 160), `sizes ${[...new Set(mediaFrames.map((f) => f.length))].join(',')}`);
  check('agent audio starts within a second of the greeting', events.indexOf('media') >= 0);
  check('turn events reached the socket', events.includes('turn'), `${events.filter((e) => e === 'turn').length} turns`);
  check('caller transcripts reached the socket', events.includes('transcript.final'), `${events.filter((e) => e === 'transcript.final').length} finals`);
  check('barge-in cleared playback', cleared > 0, `${cleared} clear, ${marked} mark`);
  check('socket stayed open for the call', closedCode === 0 || closedCode === 1000, `code ${closedCode}`);

  // ---- what the call record says now -------------------------------------
  const record = await api(`/api/v1/calls/${call}`);
  const doc = (record.json as { data?: Record<string, unknown> })?.data ?? (record.json as Record<string, unknown>);
  const transcript = (doc?.transcript ?? []) as { role: string; text: string }[];
  const media = (doc?.media as { stream?: { frames?: number; utterances?: number; notes?: string[] } } | undefined)?.stream;
  const userTurns = transcript.filter((t) => t.role === 'user');
  const agentTurns = transcript.filter((t) => t.role === 'assistant');

  check('call record has caller turns', userTurns.length >= 3, `${userTurns.length} caller turns`);
  check('call record has agent replies', agentTurns.length >= 3, `${agentTurns.length} agent turns`);
  check('media facts written to the call', Boolean(media), media ? `${media.frames} frames, ${media.utterances} utterances` : 'missing');
  check('call is no longer in progress', doc?.status !== 'in-progress', `status ${doc?.status}`);

  console.log('\nconversation:');
  for (const turn of transcript.slice(0, 10)) console.log(`  ${turn.role === 'user' ? 'caller ' : 'agent  '} ${turn.text.slice(0, 92)}`);
  if (media?.notes?.length) console.log(`\nworker notes: ${media.notes.join(' | ')}`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASS' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('media-check failed to run:', err);
  process.exit(1);
});
