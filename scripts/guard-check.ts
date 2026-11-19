/**
 * Server-side guard checks: the outbound URL policy, metering, retention and the
 * media secret. These are the fixes that do not show up in an HTTP response, so
 * they are asserted directly against the modules.
 *
 * Runs against the real data file, so it only touches documents it creates and
 * restores anything it changes. Safe to run while the app is up.
 *
 *   npx tsx scripts/guard-check.ts
 */

import http from 'node:http';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  // The dev opt-out must not be inherited from the shell for the blocking tests.
  const optOut = process.env.VOXERA_ALLOW_PRIVATE_OUTBOUND;
  delete process.env.VOXERA_ALLOW_PRIVATE_OUTBOUND;

  const net = await import('../lib/server/net');
  const { mediaSecret, mediaSigningAvailable } = await import('../lib/server/media/secret');
  const { mintMediaToken } = await import('../lib/server/telephony');
  const { meterMinutes } = await import('../lib/server/metering');
  const { sweep } = await import('../lib/server/maintenance');
  const db = await import('../lib/server/db');

  console.log('— outbound URL policy ——————————————————————————');
  const blocked: [string, string][] = [
    ['http://127.0.0.1:3000/api/auth/me', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.1.2.3/hook', 'private range'],
    ['http://192.168.0.10/hook', 'home range'],
    ['http://172.16.4.4/hook', 'private range'],
    ['http://[::1]:3000/hook', 'IPv6 loopback'],
    ['http://[fd00::1]/hook', 'IPv6 unique local'],
    ['http://localhost:4010/hook', 'localhost name'],
    ['http://metadata.google.internal/computeMetadata', 'internal TLD'],
    ['ftp://example.com/hook', 'non-http protocol'],
    ['http://user:pass@example.com/hook', 'credentials in URL'],
    ['not a url', 'not a URL'],
  ];
  for (const [url, why] of blocked) {
    const verdict = await net.guardUrl(url);
    check(`blocks ${why}`, verdict.policy === 'blocked', `${url} → ${verdict.reason ?? 'allowed'}`);
  }

  let publicResolves = true;
  try {
    await import('node:dns/promises').then((dns) => dns.lookup('example.com'));
  } catch {
    publicResolves = false;
  }
  if (publicResolves) {
    const verdict = await net.guardUrl('https://example.com/webhook');
    check('allows a public host', verdict.policy === 'allowed', verdict.reason ?? '');
  } else {
    console.log('SKIP  public host check — no DNS in this sandbox');
  }

  // A redirect is where a URL check usually leaks: public in, private out.
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:9/private' });
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const port = (redirector.address() as { port: number }).port;
  let redirectBlocked = false;
  let redirectReason = '';
  try {
    await net.safeFetch(`http://127.0.0.1:${port}/go`, { method: 'GET' });
  } catch (err) {
    redirectBlocked = err instanceof Error;
    redirectReason = err instanceof Error ? err.message : String(err);
  }
  redirector.close();
  check('refuses a private target before it is even dialled', redirectBlocked, redirectReason.slice(0, 80));

  // With the documented opt-out, a self-hosted demo may reach loopback again.
  process.env.VOXERA_ALLOW_PRIVATE_OUTBOUND = '1';
  const optedOut = await net.guardUrl('http://127.0.0.1:3000/api/webhook-echo');
  check('opt-out allows loopback for a local demo', optedOut.policy === 'allowed', optedOut.reason ?? '');
  delete process.env.VOXERA_ALLOW_PRIVATE_OUTBOUND;
  if (optOut) process.env.VOXERA_ALLOW_PRIVATE_OUTBOUND = optOut;

  console.log('\n— media secret ————————————————————————————————');
  const restoreSecret = process.env.VOXERA_MEDIA_SECRET;
  const restoreNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  delete process.env.VOXERA_MEDIA_SECRET;
  check('no secret in production means no signing', mediaSecret() === null && !mediaSigningAvailable());
  check('no token is minted without a secret', mintMediaToken('call_x', 'CA_x') === '');
  process.env.VOXERA_MEDIA_SECRET = 'check-secret';
  const token = mintMediaToken('call_x', 'CA_x');
  check('a secret mints a verifiable token', token.includes('.') && token.length > 20, token.slice(0, 24) + '…');
  if (restoreSecret) process.env.VOXERA_MEDIA_SECRET = restoreSecret;
  else delete process.env.VOXERA_MEDIA_SECRET;
  if (restoreNodeEnv) (process.env as Record<string, string | undefined>).NODE_ENV = restoreNodeEnv;

  console.log('\n— metering ————————————————————————————————————');
  // Pick an organisation that still has a balance, so the assertion is about a
  // real decrement rather than 0 → 0.
  const org =
    db.list<{ id: string; name?: string; balanceMinutes?: number; minutesUsed?: number }>('orgs', (o) => (o.balanceMinutes ?? 0) > 1)[0] ??
    db.list<{ id: string; name?: string; balanceMinutes?: number; minutesUsed?: number }>('orgs')[0];
  if (org) {
    const before = { balance: org.balanceMinutes ?? 0, used: org.minutesUsed ?? 0 };
    meterMinutes(org.id, 2.5);
    const after = db.get<{ id: string; balanceMinutes?: number; minutesUsed?: number }>('orgs', org.id)!;
    check(
      'a call decrements the organisation balance',
      Math.abs((after.balanceMinutes ?? 0) - Math.max(0, before.balance - 2.5)) < 0.001,
      `${before.balance} → ${after.balanceMinutes}`
    );
    check('usage accumulates alongside it', (after.minutesUsed ?? 0) > before.used, `${before.used} → ${after.minutesUsed}`);
    db.update('orgs', org.id, { balanceMinutes: before.balance, minutesUsed: before.used });
    console.log(`      restored ${org.name ?? org.id} to balance ${before.balance} / used ${before.used}`);
  } else {
    check('an organisation exists to meter', false, 'no orgs in the store');
  }

  console.log('\n— retention ———————————————————————————————————');
  const DAY = 86_400_000;
  const stale = db.insert<{ id: string }>('sessions', {
    id: 'ses_guardcheck_stale',
    userId: 'usr_check',
    orgId: 'org_check',
    tokenHash: 'x',
    createdAt: new Date(Date.now() - 40 * DAY).toISOString(),
    expiresAt: new Date(Date.now() - 31 * DAY).toISOString(),
    userAgent: 'guard-check',
    ip: '127.0.0.1',
  } as never) as { id: string };
  const fresh = db.insert<{ id: string }>('sessions', {
    id: 'ses_guardcheck_fresh',
    userId: 'usr_check',
    orgId: 'org_check',
    tokenHash: 'y',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    userAgent: 'guard-check',
    ip: '127.0.0.1',
  } as never);
  const result = sweep();
  check('expired sessions are swept', !db.get('sessions', stale.id), JSON.stringify(result.removed));
  check('live sessions are kept', Boolean(db.get('sessions', fresh.id)));
  db.remove('sessions', fresh.id);
  db.flushNow();

  console.log();
  console.log(failures ? `GUARD CHECK: ${failures} failure(s)` : 'GUARD CHECK: ALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('guard-check failed to run', err);
  process.exit(1);
});
