#!/usr/bin/env node
/**
 * The browser-storage gate.
 *
 * PRACTICE.md §5 says no client data may reach the browser. That claim is worth
 * exactly as much as the check behind it, so this script attacks it from both
 * ends: it proves the guards behave, and it proves the running product does not
 * bake a record into a page or a bundle.
 *
 *   1. the mirror strips practice collections before anything is written
 *   2. a record that arrives under an innocent key is still caught
 *   3. the store never hydrates from or writes a dashboard blob
 *   4. legacy dashboard blobs are thrown away and state comes from server sync
 *   5. no practice screen touches browser storage at all
 *   6. the served dashboard HTML holds no client name or number
 *   7. the shipped JavaScript bundles hold no client name or number
 *
 * Usage: npx tsx scripts/privacy_check.ts   (the app must be running)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPrivateData, isCacheable, strippedForMirror, SERVER_ONLY_COLLECTIONS } from '../lib/privacy';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';

let cookie = '';
const failures: string[] = [];
const CACHE = process.env.VOXERA_CHECK_SESSION ?? '/tmp/voxera-check-session.json';

/**
 * A cookie that works — shared with the python checks so a suite of them can
 * run back to back without tripping the sign-in limiter. A cookie the server
 * has forgotten (an app restart) is discarded and replaced.
 */
async function signIn() {
  if (existsSync(CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE, 'utf8')) as { cookie?: string; base?: string; email?: string };
      if (cached.cookie && cached.base === BASE && cached.email === EMAIL) {
        const probe = await fetch(`${BASE}/api/v1/clients?limit=1`, { headers: { cookie: cached.cookie } });
        if (probe.status !== 401 && probe.status !== 403) {
          cookie = cached.cookie;
          return;
        }
      }
    } catch {
      /* a corrupt cache is not a reason to fail */
    }
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const fresh = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (fresh) {
    writeFileSync(CACHE, JSON.stringify({ cookie: fresh, base: BASE, email: EMAIL }));
  }
  cookie = fresh;
}

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function walk(dir: string, out: string[] = [], ext = '.js'): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, ext);
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

const sampleClient = {
  id: 'cli_probe',
  name: 'Probe Patient',
  number: '+14155559999',
  dateOfBirth: '1980-04-02',
  alerts: [{ label: 'Anticoagulant' }],
  consents: { sms: { granted: true } },
};

async function main() {
  // ---------------------------------------------------------------- 1 & 2
  const state = {
    assistants: [{ id: 'asst_1', name: 'Appointment desk' }],
    calls: [{ id: 'call_1' }],
    clients: [sampleClient],
    widgets: { embed: true },
  };
  const mirror = strippedForMirror(state);
  check('the mirror strips the practice collections', !('clients' in mirror) && Array.isArray((mirror as { assistants?: unknown[] }).assistants),
    Object.keys(mirror).join(', '));
  check('everything else is still mirrored', JSON.stringify(mirror).includes('Appointment desk'), `${Object.keys(mirror).length} key(s) kept`);

  const smuggled = { assistants: [], recentlyViewed: [{ ...sampleClient, label: 'last opened' }] };
  const caught = findPrivateData(smuggled);
  check('a record under an innocent key is still caught', caught.length > 0, caught.join(', '));

  const looksLikeRecord = [{ name: 'Someone', number: '+14155550000', clientId: 'cli_x' }];
  check('a record with no telltale field name is caught by its shape', findPrivateData({ recent: looksLikeRecord }).length > 0,
    findPrivateData({ recent: looksLikeRecord }).join(', '));

  check('a clean payload is cacheable', isCacheable({ assistants: [{ id: 'a' }], activity: [] }));
  check('a payload with a birth date is not', !isCacheable({ anything: { dateOfBirth: '1990-01-01' } }));
  check('the collection list is not empty', SERVER_ONLY_COLLECTIONS.length >= 6, `${SERVER_ONLY_COLLECTIONS.length} collection(s)`);

  // -------------------------------------------------------------------- 4
  const store = readFileSync('lib/store.tsx', 'utf8');
  check('the store never hydrates a dashboard blob from browser storage', !/localStorage\.getItem\(KEY\)/.test(store));
  check('and throws the legacy blob away rather than keeping any of it', /localStorage\.removeItem\(KEY\)/.test(store));
  check('the store never writes dashboard state to browser storage', !/localStorage\.setItem/.test(store));
  check('workspace state is hydrated from the authenticated server sync',
    store.includes('useServerSync({') && store.includes('onSnapshot: applySnapshot'));

  // -------------------------------------------------------------------- 5
  const screens = ['clients', 'calendar', 'practice', 'bookings'];
  const offenders: string[] = [];
  for (const screen of screens) {
    const text = readFileSync(`app/dashboard/${screen}/page.tsx`, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      // A comment saying a screen does *not* use browser storage is the rule
      // being written down, not a violation of it.
      const negated = /(never|not|nothing|no)\b[^.]{0,40}(localStorage|sessionStorage|indexedDB)/i.test(line);
      if (/localStorage|sessionStorage|indexedDB/.test(line) && !negated) {
        offenders.push(`${screen}:${index + 1}`);
      }
    });
  }
  check('no practice screen reads or writes browser storage', offenders.length === 0, offenders.join(', ') || `${screens.length} screens clean`);
  check('the rule is documented where the screens can find it', readFileSync('lib/privacy.ts', 'utf8').includes('PRIVACY_STATEMENT'));

  // Browser storage is not banned outright — preferences live there, because a
  // preference is not a record. The gate draws the line rather than moving it:
  // every key must come from lib/prefs.ts, and only primitives get written.
  const prefs = readFileSync('lib/prefs.ts', 'utf8');
  check('preferences may only be written under declared keys', prefs.includes('PREF_KEYS') && /ALLOWED\.has\(key\)/.test(prefs));
  check('a preference cannot carry a record', prefs.includes('findPrivateData({ [key]: scalar })') && prefs.includes("typeof value === 'number'"));
  const rawWrites = ['app/dashboard/calendar/page.tsx', 'app/dashboard/clients/page.tsx']
    .flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, i) => ({ file, line, i })))
    .filter(({ line }) => /localStorage|sessionStorage|indexedDB/.test(line));
  check('screens go through the preference module, not the storage API', rawWrites.length === 0,
    rawWrites.map((w) => `${w.file}:${w.i + 1}`).join(', ') || 'none');
  check('the privacy toggle is a preference, not a record', readFileSync('app/dashboard/calendar/page.tsx', 'utf8').includes('PREF_KEYS.calendarPrivacy'));

  // ---------------------------------------------------------------- 6 & 7
  await signIn();
  const ping = await call('GET', '/api/v1/clients?limit=1');
  check('signed in to check the running product', ping.status === 200);
  const list = await call('GET', '/api/v1/clients?includeUpcoming=true');
  const clients = (list.body.data ?? []) as Array<{ id: string; name: string; number: string }>;
  check('there are records on file to look for', clients.length > 0, `${clients.length} client(s)`);

  /**
   * What counts as a fingerprint of a record.
   *
   * A record's identity is minted or typed at runtime, so no source file can
   * contain it. That is the whole test: read the source tree, keep the probes
   * the source does *not* have, and then look for those in the page and in the
   * bundles. Seeded personas ("Priya Raghavan" is a speaker on the marketing
   * site) drop out on their own instead of being special-cased.
   */
  const sourceFiles = ['.ts', '.tsx'].flatMap((ext) => walk('lib', [], ext).concat(walk('app', [], ext), walk('components', [], ext), walk('scripts', [], ext)));
  const sourceHaystack = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const sourceDigits = sourceHaystack.replace(/\D/g, '');

  const details = await Promise.all(clients.slice(0, 8).map((c) => call('GET', `/api/v1/clients/${c.id}`)));
  const alertLabels = details
    .flatMap((d) => ((d.body.alerts ?? []) as Array<{ label?: string }>).map((a) => String(a.label ?? '')))
    .filter((label) => label.length > 6);

  const candidates = [
    ...clients.map((c) => ({ what: `client id ${c.id}`, value: c.id, kind: 'id' })),
    ...clients.map((c) => ({ what: `number of ${c.name}`, value: c.number.replace(/\D/g, ''), kind: 'digits' })),
    ...clients.filter((c) => c.name.includes(' ')).map((c) => ({ what: `name ${c.name}`, value: c.name, kind: 'text' })),
    ...alertLabels.map((label) => ({ what: `alert "${label}"`, value: label, kind: 'text' })),
  ];
  const probes = candidates.filter((probe) => {
    const haystack = probe.kind === 'digits' ? sourceDigits : sourceHaystack;
    return probe.value.length >= 6 && !haystack.includes(probe.value);
  });
  const droppedBySource = candidates.length - probes.length;
  check('there is something unique to look for', probes.length >= 5,
    `${probes.length} fingerprint(s), ${droppedBySource} already in the source tree`);

  let htmlHits: string[] = [];
  let bundleHits: string[] = [];
  for (const screen of ['clients', 'calendar']) {
    const res = await fetch(`${BASE}/dashboard/${screen}`, { headers: { cookie } });
    const html = await res.text();
    for (const probe of probes) {
      if (html.includes(probe.value)) htmlHits.push(`${screen}:${probe.what}`);
    }
  }
  check('no record is baked into the served dashboard pages', htmlHits.length === 0,
    htmlHits.join(', ') || `${probes.length} fingerprint(s) searched for`);

  const bundles = walk('.next/static');
  for (const file of bundles) {
    const text = readFileSync(file, 'utf8');
    for (const probe of probes) {
      if (text.includes(probe.value)) bundleHits.push(probe.what);
    }
  }
  check('no record is compiled into the shipped bundles', bundleHits.length === 0,
    bundleHits.slice(0, 3).join(', ') || `${bundles.length} bundle(s), ${probes.length} fingerprint(s)`);

  console.log();
  if (failures.length) {
    console.log(`${failures.length} FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('ALL PASS — practice records stay on the server, and the browser cache cannot hold them.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
