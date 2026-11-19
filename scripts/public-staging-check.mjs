#!/usr/bin/env node
/**
 * Public Dokploy/Traefik acceptance probe.
 *
 * Required:
 *   VOXERA_STAGING_URL=https://staging.example.com
 *   VOXERA_ACCEPTANCE_EMAIL=<synthetic staging owner>
 *   VOXERA_ACCEPTANCE_PASSWORD=<its password>
 *
 * This checks the network boundary the loopback suites cannot: valid public TLS,
 * HTTP→HTTPS, production headers, PostgreSQL readiness, private metrics,
 * unauthenticated dashboard redirect, cross-origin refusal, Secure/HttpOnly
 * session cookies, and that attacker-prepended X-Forwarded-For values do not
 * evade the public login limiter. Run it against synthetic staging only. The
 * limiter check is deliberately last and consumes that source IP's one-minute
 * login budget.
 */

import tls from 'node:tls';
import { mkdirSync, writeFileSync } from 'node:fs';

const rawBase = process.env.VOXERA_STAGING_URL ?? '';
const email = process.env.VOXERA_ACCEPTANCE_EMAIL ?? '';
const password = process.env.VOXERA_ACCEPTANCE_PASSWORD ?? '';
const artifact = process.env.VOXERA_STAGING_ARTIFACT ?? 'screenshots/public-staging-check.json';
const checks = [];
let failures = 0;

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function baseUrl() {
  try {
    const value = new URL(rawBase);
    if (value.protocol !== 'https:' || value.pathname !== '/' || value.search || value.hash || value.username || value.password) return null;
    return value;
  } catch {
    return null;
  }
}

async function request(url, options = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...options });
}

function certificate(hostname, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ hostname, port, servername: hostname, rejectUnauthorized: true });
    socket.setTimeout(20_000);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const result = {
        authorized: socket.authorized,
        subject: cert.subject?.CN,
        issuer: cert.issuer?.CN,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        fingerprint256: cert.fingerprint256,
      };
      socket.end();
      resolve(result);
    });
    socket.once('timeout', () => socket.destroy(new Error('TLS timeout')));
    socket.once('error', reject);
  });
}

const parsed = baseUrl();
check('a public HTTPS origin was supplied', Boolean(parsed), rawBase || 'VOXERA_STAGING_URL is missing');
if (!parsed) {
  mkdirSync(artifact.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(artifact, JSON.stringify({ at: new Date().toISOString(), base: rawBase || null, checks, passed: 0, failed: failures }, null, 2));
  process.exitCode = 1;
} else {
  let tlsEvidence = null;
  try {
    tlsEvidence = await certificate(parsed.hostname, Number(parsed.port || 443));
    const expires = Date.parse(tlsEvidence.validTo ?? '');
    check('TLS validates for the public hostname', tlsEvidence.authorized === true, `${tlsEvidence.subject ?? 'unknown'} · ${tlsEvidence.issuer ?? 'unknown'}`);
    check('the certificate is not near expiry', Number.isFinite(expires) && expires - Date.now() > 14 * 86_400_000, tlsEvidence.validTo ?? 'no validity');
  } catch (error) {
    check('TLS validates for the public hostname', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const insecure = new URL(parsed);
    insecure.protocol = 'http:';
    insecure.port = '';
    const response = await request(insecure);
    const location = response.headers.get('location') ?? '';
    check('plain HTTP redirects to HTTPS', [301, 302, 307, 308].includes(response.status) && location.startsWith('https://'), `${response.status} ${location}`.trim());
  } catch (error) {
    check('plain HTTP redirects to HTTPS', false, error instanceof Error ? error.message : String(error));
  }

  let root;
  try {
    root = await request(parsed);
    check('the public application answers', root.status === 200, `HTTP ${root.status}`);
    const expectedHeaders = {
      'content-security-policy': (value) => value.includes("default-src 'self'") && value.includes("frame-ancestors 'self'") && !value.includes('e2b.app'),
      'strict-transport-security': (value) => /max-age=\d+/.test(value),
      'x-content-type-options': (value) => value.toLowerCase() === 'nosniff',
      'referrer-policy': (value) => value.includes('strict-origin'),
      'permissions-policy': (value) => value.includes('camera=()') && value.includes('payment=()'),
    };
    for (const [header, valid] of Object.entries(expectedHeaders)) {
      const value = root.headers.get(header) ?? '';
      check(`${header} is production-safe`, valid(value), value.slice(0, 180) || 'missing');
    }
  } catch (error) {
    check('the public application answers', false, error instanceof Error ? error.message : String(error));
  }

  let healthBody = null;
  try {
    const response = await request(new URL('/api/health', parsed));
    healthBody = await response.json().catch(() => null);
    check('public readiness answers 200', response.status === 200, `HTTP ${response.status}`);
    check('readiness is PostgreSQL readable and writable', healthBody?.status === 'ok' && healthBody?.store?.driver === 'postgres' && healthBody?.store?.readable === true && healthBody?.store?.writable === true, JSON.stringify(healthBody?.store ?? healthBody).slice(0, 220));
    check('the deployed build has an immutable build id', typeof healthBody?.build === 'string' && healthBody.build.length >= 8, String(healthBody?.build ?? 'missing'));
  } catch (error) {
    check('public readiness answers 200', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await request(new URL('/api/metrics', parsed));
    check('aggregate metrics are not public', [401, 403, 404].includes(response.status), `HTTP ${response.status}`);
  } catch (error) {
    check('aggregate metrics are not public', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await request(new URL('/dashboard', parsed));
    const location = response.headers.get('location') ?? '';
    check('an unauthenticated dashboard request redirects to login', [302, 303, 307, 308].includes(response.status) && location.includes('/login'), `${response.status} ${location}`.trim());
  } catch (error) {
    check('an unauthenticated dashboard request redirects to login', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await request(new URL('/api/auth/login', parsed), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://forged-origin.invalid' },
      body: JSON.stringify({ email: 'origin-probe@invalid.example', password: 'not-a-password' }),
    });
    check('a forged browser origin is refused', response.status === 403, `HTTP ${response.status}`);
  } catch (error) {
    check('a forged browser origin is refused', false, error instanceof Error ? error.message : String(error));
  }

  if (!email || !password) {
    check('synthetic staging credentials were supplied for cookie acceptance', false, 'set VOXERA_ACCEPTANCE_EMAIL and VOXERA_ACCEPTANCE_PASSWORD outside source control');
  } else {
    try {
      const response = await request(new URL('/api/auth/login', parsed), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: parsed.origin },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));
      const setCookie = response.headers.get('set-cookie') ?? '';
      check('the synthetic staging owner signs in without bypasses', response.status === 200 && body?.data?.mfaRequired !== true, body?.data?.mfaRequired ? 'MFA challenge returned; use a dedicated non-MFA synthetic acceptance user' : `HTTP ${response.status}`);
      check('the session cookie is Secure', /(?:^|;)\s*Secure(?:;|$)/i.test(setCookie), setCookie ? 'cookie attributes inspected' : 'no session cookie');
      check('the session cookie is HttpOnly', /(?:^|;)\s*HttpOnly(?:;|$)/i.test(setCookie), setCookie ? 'cookie attributes inspected' : 'no session cookie');
      check('the session cookie has SameSite protection', /(?:^|;)\s*SameSite=(?:Lax|Strict)(?:;|$)/i.test(setCookie), setCookie ? 'cookie attributes inspected' : 'no session cookie');
      const cookie = setCookie.split(';')[0];
      if (cookie.includes('=')) {
        const me = await request(new URL('/api/auth/me', parsed), { headers: { cookie } });
        check('the issued session is accepted on the same HTTPS origin', me.status === 200, `HTTP ${me.status}`);
      } else {
        check('the issued session is accepted on the same HTTPS origin', false, 'no cookie pair');
      }
    } catch (error) {
      check('the synthetic staging owner signs in without bypasses', false, error instanceof Error ? error.message : String(error));
    }
  }

  // Last: this intentionally consumes the caller's login budget for one minute.
  try {
    const statuses = [];
    const probeEmail = `xff-probe-${Date.now()}@invalid.example`;
    for (let index = 1; index <= 12; index += 1) {
      const response = await request(new URL('/api/auth/login', parsed), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: parsed.origin,
          'x-forwarded-for': `198.51.100.${index}`,
        },
        body: JSON.stringify({ email: probeEmail, password: 'not-a-password' }),
      });
      statuses.push(response.status);
    }
    check('attacker-prepended X-Forwarded-For values cannot evade the public limiter', statuses.includes(429), statuses.join(', '));
  } catch (error) {
    check('attacker-prepended X-Forwarded-For values cannot evade the public limiter', false, error instanceof Error ? error.message : String(error));
  }

  mkdirSync(artifact.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(artifact, JSON.stringify({
    at: new Date().toISOString(),
    base: parsed.origin,
    tls: tlsEvidence,
    health: healthBody ? { status: healthBody.status, build: healthBody.build, store: healthBody.store, checks: healthBody.checks } : null,
    checks,
    passed: checks.length - failures,
    failed: failures,
  }, null, 2));
  console.log(`\n${checks.length - failures}/${checks.length} public staging checks passed · ${artifact}`);
  if (failures) process.exitCode = 1;
}
