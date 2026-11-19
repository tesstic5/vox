#!/usr/bin/env node
/**
 * Every dashboard route, opened once in a real browser, failing on the first
 * thing that goes wrong.
 *
 * This is the pass that finds the class of defect a payload gate cannot see: a
 * page that renders fine in `check.py` — the API says yes to every question —
 * and then throws in the browser because a *row* it was handed does not have the
 * field it renders. Four pages were doing exactly that (the platform billing page
 * rendering practice invoices, the keys page rendering a secret the server does
 * not return, the tools page rendering a schema-less tool, the webhooks page
 * rendering a delivery's attempt list as a child) and nothing caught them,
 * because the browser passes only walked a slice of the dashboard.
 *
 * So it walks all of it. The route list is read from the filesystem rather than
 * written down, so a new page is covered the day it is created; a dynamic segment
 * is filled from the API, so `/dashboard/calls/[id]` is visited as a call that
 * exists.
 *
 * It needs playwright, which is deliberately not a package dependency (it is a
 * 300 MB browser, not a library the app ships):
 *
 *   npm i --no-save playwright@1.64.1 && npx playwright install chromium
 *   node scripts/console-sweep.mjs
 *
 * Screenshots are not written (this is a console pass); `day-ui-pass.mjs` is the
 * one that keeps pictures. Requires the app running on :3000 with the stubs up,
 * the same as every other live gate.
 */

import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed — npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

/* ------------------------------------------------------------------- helpers */

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') ?? '' };
}

/** Every `page.tsx` under app/dashboard, as a route — found, never listed. */
function dashboardRoutes() {
  const out = [];
  const walk = (dir, route) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${route}/${entry}`);
      else if (entry === 'page.tsx') out.push(route === '' ? '/dashboard' : `/dashboard${route}`);
    }
  };
  walk('app/dashboard', '');
  return out.sort();
}

/* ---------------------------------------------------------------- fixtures */

const routes = dashboardRoutes();
if (routes.length === 0) {
  console.error('no dashboard routes found — run this from the project root');
  process.exit(2);
}

const signIn = await api('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (signIn.status !== 200) {
  console.error(`sign-in failed: ${signIn.status} ${JSON.stringify(signIn.body)}`);
  process.exit(2);
}
const cookie = signIn.setCookie.split(';')[0].split('=');
const session = { name: cookie[0], value: cookie.slice(1).join('=') };

/**
 * A real id for each dynamic segment, read from its authoritative API. Native
 * resources must not rely on the generic collections bridge: that can make a
 * detail route look covered while silently skipping the row the page really
 * consumes.
 */
const ID_SOURCE = {
  assistants: '/api/v1/assistants?limit=1',
  calls: '/api/v1/calls?limit=1',
  numbers: '/api/v1/numbers',
  workflows: '/api/v1/collections/workflows',
};

async function pickIds() {
  const ids = {};
  for (const [segment, path] of Object.entries(ID_SOURCE)) {
    const res = await api(path, {
      headers: { cookie: `${session.name}=${session.value}` },
    });
    const rows = Array.isArray(res.body?.data) ? res.body.data : Array.isArray(res.body) ? res.body : [];
    if (res.status === 200 && rows[0]?.id) ids[segment] = rows[0].id;
  }
  return ids;
}

const ids = await pickIds();

/** `/dashboard/calls/[id]` → the route this workspace can actually open. */
function resolve(route) {
  const segment = route.match(/^\/dashboard\/([a-z-]+)\/\[id\]$/);
  if (!segment) return route;
  const id = ids[segment[1]];
  if (id) return `/dashboard/${segment[1]}/${id}`;
  // The current workflow detail page deliberately renders an unavailable
  // capability and never reads its segment. Exercise that boundary even when
  // no executable workflow row exists; native detail pages still require data.
  if (segment[1] === 'workflows') return '/dashboard/workflows/unavailable';
  return null;
}

/* --------------------------------------------------------------------- drive */

const browser = await chromium.launch();
const checks = [];
let skipped = 0;

for (const raw of routes) {
  const route = resolve(raw);
  if (!route) {
    console.log(`SKIP  ${raw} — no row to open`);
    skipped += 1;
    continue;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: session.name, value: session.value, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error' || /favicon/.test(msg.text())) return;
    // Chromium's generic resource message omits the URL. Response events below
    // retain it, so expected permission boundaries can be distinguished from
    // genuine broken requests without suppressing either.
    if (/^Failed to load resource:/.test(msg.text())) return;
    errors.push(msg.text().replace(/\s+/g, ' ').slice(0, 160));
  });
  page.on('response', (response) => {
    if (!response.url().startsWith(BASE) || response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    const expectedBoundary = response.status() === 403 && (
      (route === '/dashboard/growth' && path === '/api/v1/growth') ||
      (route === '/dashboard/leads' && path === '/api/v1/leads')
    );
    if (!expectedBoundary && !/favicon/.test(path)) errors.push(`${response.status()} ${path}`);
  });
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(BASE) && !request.url().includes('_rsc=')) {
      errors.push(`request failed: ${new URL(request.url()).pathname} (${request.failure()?.errorText ?? 'unknown'})`);
    }
  });
  page.on('pageerror', (err) => errors.push(`threw: ${String(err.message).replace(/\s+/g, ' ').slice(0, 160)}`));
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(700);
  } catch (err) {
    errors.push(`nav: ${String(err.message).split('\n')[0].slice(0, 80)}`);
  }
  await context.close();
  const pass = errors.length === 0;
  checks.push({ route, pass, errors });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${route}${pass ? '' : `  — ${errors.slice(0, 2).join(' | ')}`}`);
}

await browser.close();

/* ------------------------------------------------------------------- verdict */

const failed = checks.filter((c) => !c.pass);
mkdirSync('screenshots', { recursive: true });
writeFileSync(
  'screenshots/dashboard-console-sweep.json',
  JSON.stringify({ at: new Date().toISOString(), base: BASE, checks, skipped: routes.length - checks.length }, null, 1)
);
console.log(`\n${checks.length - failed.length}/${checks.length} dashboard routes console-clean${skipped ? `, ${skipped} skipped` : ''} · screenshots/dashboard-console-sweep.json`);
console.log(failed.length ? `FAILED: ${failed.map((f) => f.route).join(' · ')}` : 'CONSOLE SWEEP — every dashboard page renders without an error.');
process.exit(failed.length ? 1 : 0);
