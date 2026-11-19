/**
 * Two honesty probes for customer-owned tool endpoints.
 *
 * Both questions are about the same claim — "a tool with an endpoint is really
 * called, and when it cannot be, we say so instead of pretending" — and neither
 * is answerable from the dashboard, so they live here:
 *
 *   --mode=blocked   With the outbound policy in its shipping state, a tool
 *                    pointed at a loopback address must be *reported* as blocked
 *                    by `POST /v1/tools/{id}/test`: `ok:false`, an error naming
 *                    the policy, and no invented response body.
 *
 *   --mode=live      With `VOXERA_ALLOW_PRIVATE_OUTBOUND=1` (local demo only), a
 *                    real call turn that asks for the tool must record
 *                    `source:'endpoint'` on the call — earlier runs only ever
 *                    observed `builtin`, which left the endpoint path unproven
 *                    in a live call.
 *
 * Run against a started app:  npx tsx scripts/endpoint-probe.ts --mode=blocked
 * Everything it creates, it removes. It never touches seeded assistants.
 */

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const ECHO = process.env.VOXERA_ECHO ?? 'http://127.0.0.1:3000/api/webhook-echo';
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=blocked').split('=')[1];

let cookie = '';
let failures: string[] = [];

async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON answer is a result too — never crash on one */
  }
  return { status: res.status, body: body as T };
}

function check(label: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
  if (!pass) failures.push(label);
}

async function login(): Promise<void> {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'jordan@northwind.dev', password: 'demo-password-2026' }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}

async function blockedMode(): Promise<void> {
  await login();
  const stamp = Date.now().toString(36);
  const name = `probe_blocked_${stamp}`;
  const created = await api('/api/v1/tools', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'probe: an endpoint that the outbound policy must refuse',
      method: 'POST',
      endpoint: 'http://127.0.0.1:4020/custom/probe',
    }),
  });
  const toolId = created.body?.id;
  check('a tool can be saved with a private endpoint', created.status === 201 && Boolean(toolId), `status ${created.status}`);

  const tested = await api(`/api/v1/tools/${toolId}/test`, { method: 'POST', body: JSON.stringify({ args: { probe: true } }) });
  const t = tested.body ?? {};
  check('the test answers honestly', t.ok === false && t.status === null, JSON.stringify({ ok: t.ok, status: t.status }).slice(0, 90));
  check(
    'it names the outbound policy as the reason',
    /policy|private|loopback/i.test(String(t.error ?? '')),
    String(t.error ?? '(no error field)').slice(0, 120)
  );
  check('no response body is invented', !String(t.response ?? '').trim(), `response=${JSON.stringify(String(t.response ?? '').slice(0, 40))}`);
  check('the caller is told a live call would fall back', /live call/i.test(String(t.hint ?? '')), String(t.hint ?? '').slice(0, 90));

  const removed = await api(`/api/v1/tools/${toolId}`, { method: 'DELETE' });
  check('the probe tool is removed', removed.status === 200 || removed.status === 204, `status ${removed.status}`);
}

async function liveMode(): Promise<void> {
  await login();
  const stamp = Date.now().toString(36);

  // The seeded workspace already has a `lookup_order` tool, pointed at a host
  // that does not resolve (`api.northwind.dev`) — which is why earlier runs only
  // ever saw `builtin`. Repointing that one tool at a real, local endpoint for
  // the length of the probe is the honest test: same tool, same runtime, same
  // call path a customer's own URL would take.
  const listed = await api('/api/v1/tools');
  const tools: any[] = listed.body?.data ?? [];
  const target = tools.find((t) => t.name === 'lookup_order');
  check('the workspace has an order tool to point somewhere', Boolean(target), `tools=${tools.length}`);
  if (!target) return;
  const original = { endpoint: target.endpoint, method: target.method ?? 'POST', headers: target.headers };

  const repointed = await api(`/api/v1/tools/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ endpoint: ECHO, method: 'POST' }),
  });
  check('it can be pointed at our own endpoint', repointed.body?.endpoint === ECHO, String(repointed.body?.endpoint ?? '').slice(0, 80));

  // This mode calls a *loopback* endpoint, so it only means anything where the
  // outbound policy allows that (a local demo, `VOXERA_ALLOW_PRIVATE_OUTBOUND=1`).
  // On a locked-down deployment the honest outcome is a fallback to the built-in
  // executor, so say that plainly instead of reporting two failures.
  const canary = await api<{ status: number | null; error?: string }>(`/api/v1/tools/${target.id}/test`, {
    method: 'POST',
    body: JSON.stringify({ args: {} }),
  });
  const blocked = canary.body?.status === null && /policy/i.test(String(canary.body?.error ?? ''));
  if (blocked) {
    await api(`/api/v1/tools/${target.id}`, { method: 'PATCH', body: JSON.stringify({ endpoint: original.endpoint, method: original.method }) });
    // Never leave the demo workspace pointing at a probe URL: read it back.
    const restoredNow = await api<{ endpoint?: string; data?: { endpoint?: string } }>(`/api/v1/tools/${target.id}`);
    const putBack = restoredNow.body?.data ?? restoredNow.body;
    if (putBack?.endpoint !== original.endpoint) {
      console.error(`FAIL  the order tool was left pointing at ${putBack?.endpoint ?? '(unknown)'} — restore it before continuing`);
      process.exit(1);
    }
    console.log('SKIP  this deployment forbids private outbound calls (`VOXERA_ALLOW_PRIVATE_OUTBOUND` is unset).');
    console.log('      The built-in executor answers instead — run this probe against a local demo to see the endpoint path.');
    console.log('\nLIVE-ENDPOINT PROBE: SKIPPED (locked-down deployment)');
    process.exit(0);
  }
  // In an allowed local test deployment, keep the endpoint in place through the
  // call below. It is restored after the call, not before it.

  const assistant = await api('/api/v1/assistants', {
    method: 'POST',
    body: JSON.stringify({
      name: `ZZ probe endpoint ${stamp}`,
      firstMessage: 'Thanks for calling — how can I help?',
      systemPrompt: 'You are a support agent. When a caller asks about an order, look it up with the tool you were given.',
      model: 'claude-haiku-4.5',
      provider: 'anthropic',
      tools: ['lookup_order'],
      // A call can only be placed against a published assistant, so the probe
      // publishes its own — and removes it at the end.
      status: 'published',
    }),
  });
  const assistantId = assistant.body?.id;
  check('a probe assistant can use it', assistant.status === 201 && Boolean(assistantId), `status ${assistant.status}`);
  const published = await api(`/api/v1/assistants/${assistantId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ message: 'endpoint probe' }),
  });
  check('the verified owner explicitly publishes the probe assistant', published.status === 200 && published.body?.status === 'published', `status ${published.status}`);

  const call = await api('/api/v1/calls', {
    method: 'POST',
    body: JSON.stringify({ assistantId, type: 'web', customer: { number: '+14155559123' } }),
  });
  const callId = call.body?.id;
  check('a call starts', Boolean(callId), `status ${call.status}`);

  const turn = await api(`/api/v1/calls/${callId}/turn`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Can you check on my order please?' }),
  });
  check('the turn was answered', turn.status === 200 && Boolean(turn.body?.turn?.reply), String(turn.body?.turn?.reply ?? '').slice(0, 80));

  const final = await api(`/api/v1/calls/${callId}`);
  const doc = final.body?.data ?? final.body ?? {};
  const calls: any[] = doc.toolCalls ?? [];
  const named = calls.filter((c) => String(c.name) === 'lookup_order');
  check('the tool ran inside the call', named.length > 0, `toolCalls=${JSON.stringify(calls.map((c) => `${c.name}:${c.source}`)).slice(0, 140)}`);
  check(
    'the call records it as the endpoint that answered',
    named.some((c) => c.source === 'endpoint'),
    `sources=${named.map((c) => c.source).join(',') || 'none'}`
  );
  check(
    'the endpoint result is stored, not just the fact it ran',
    named.some((c) => /received/.test(JSON.stringify(c.result ?? ''))),
    JSON.stringify(named[0]?.result ?? null).slice(0, 120)
  );

  // Put the demo workspace back exactly as it was.
  const restored = await api(`/api/v1/tools/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ endpoint: original.endpoint, method: original.method }),
  });
  check('the order tool is pointed back at the seeded endpoint', restored.body?.endpoint === original.endpoint, String(restored.body?.endpoint ?? '').slice(0, 70));

  const removed = await api(`/api/v1/assistants/${assistantId}`, { method: 'DELETE' });
  check('the probe assistant is removed', removed.status === 200 || removed.status === 204, `status ${removed.status}`);
}

async function main(): Promise<void> {
  console.log(`endpoint probe — mode=${MODE} against ${BASE}`);
  if (MODE === 'blocked') await blockedMode();
  else if (MODE === 'live') await liveMode();
  else throw new Error(`unknown mode ${MODE}`);
  console.log();
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log(MODE === 'blocked' ? 'BLOCKED-ENDPOINT PROBE: ALL PASS' : 'LIVE-ENDPOINT PROBE: ALL PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
