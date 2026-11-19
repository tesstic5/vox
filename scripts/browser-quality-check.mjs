#!/usr/bin/env node
/**
 * Browser quality audit: accessibility, request behaviour, local navigation
 * latency and resource weight on the product's representative user journeys.
 *
 * This complements the interaction walks. It opens public, authentication,
 * owner, desk, practice, money, communications and field-service routes in a
 * production build, then records what the browser actually did. It fails on:
 *
 *   - WCAG 2 A/AA violations reported by axe-core;
 *   - failed same-origin requests or 4xx/5xx responses;
 *   - repeated API reads (the same method/path more than twice on one load);
 *   - more than 180 requests, 2 MiB transferred, 900 KiB JS or 200 KiB CSS;
 *   - a warm local load above 4 seconds.
 *
 * The limits are intentionally generous guardrails, not claims about Internet
 * Core Web Vitals: this is a loopback production-server audit. Raw observations
 * are written to screenshots/browser-quality-check.json.
 */

import { chromium } from 'playwright';
import axe from 'axe-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const SLUG = process.env.VOXERA_SLUG ?? 'northwind-labs';
const MOBILE = process.argv.includes('--mobile');
const ARTIFACT = `screenshots/browser-quality-check${MOBILE ? '.mobile' : '.desktop'}.json`;

const ROUTES = [
  '/',
  '/pricing',
  '/signup',
  `/book/${SLUG}`,
  '/dashboard',
  '/dashboard/calendar',
  '/dashboard/my-day',
  '/dashboard/classes',
  '/dashboard/clients',
  '/dashboard/messaging',
  '/dashboard/money',
  '/dashboard/reports',
  '/dashboard/enquiries',
  '/dashboard/estimates',
  '/dashboard/jobs',
  '/dashboard/dispatch',
  '/dashboard/business',
  '/dashboard/settings/security',
];

const LIMITS = {
  requests: 180,
  transferBytes: 2 * 1024 * 1024,
  scriptBytes: 900 * 1024,
  cssBytes: 200 * 1024,
  loadMs: 4000,
};

function cleanPath(url) {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => key !== 't' && !key.startsWith('_rsc'))
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  const query = new URLSearchParams(params).toString();
  return `${parsed.pathname}${query ? `?${query}` : ''}`;
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0].split('=');
  if (!pair[0] || pair.length < 2) throw new Error('login returned no session cookie');
  return { name: pair[0], value: pair.slice(1).join('=') };
}

const session = await login();
const browser = await chromium.launch();
const results = [];

for (const route of ROUTES) {
  const context = await browser.newContext({
    viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  await context.addCookies([{ ...session, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const failedRequests = [];
  const badResponses = [];
  const sameOrigin = new Map();

  page.on('request', (request) => {
    if (!request.url().startsWith(BASE)) return;
    const key = `${request.method()} ${cleanPath(request.url())}`;
    sameOrigin.set(key, (sameOrigin.get(key) ?? 0) + 1);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'failed';
    if (reason === 'net::ERR_ABORTED' && request.url().includes('_rsc=')) return;
    failedRequests.push(`${request.method()} ${cleanPath(request.url())}: ${reason}`);
  });
  page.on('response', (response) => {
    if (response.url().startsWith(BASE) && response.status() >= 400) {
      badResponses.push(`${response.status()} ${cleanPath(response.url())}`);
    }
  });

  const started = performance.now();
  let navigationError = '';
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(300);
  } catch (error) {
    navigationError = String(error instanceof Error ? error.message : error).split('\n')[0];
  }
  const wallMs = Math.round(performance.now() - started);

  const consent = page.getByRole('button', { name: /^(Accept all|Decline optional)$/ }).first();
  if (await consent.isVisible().catch(() => false)) await consent.click().catch(() => {});

  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    initiatorType: entry.initiatorType,
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    duration: entry.duration || 0,
  })));
  const bytesOf = (predicate) => resources.filter(predicate).reduce((sum, item) => sum + (item.transferSize || item.encodedBodySize || 0), 0);
  const transferBytes = bytesOf(() => true);
  const scriptBytes = bytesOf((item) => item.initiatorType === 'script' || /\.js(?:\?|$)/.test(item.name));
  const cssBytes = bytesOf((item) => item.initiatorType === 'link' && /\.css(?:\?|$)/.test(item.name));

  let axeResults = { violations: [], incomplete: [] };
  if (!navigationError) {
    await page.addScriptTag({ content: axe.source });
    axeResults = await page.evaluate(async () => globalThis.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations', 'incomplete'],
    }));
  }

  const duplicates = [...sameOrigin.entries()]
    .filter(([key, count]) => count > 2 && key.includes('/api/'))
    .map(([key, count]) => `${key} ×${count}`);
  const serious = axeResults.violations.filter((item) => ['serious', 'critical'].includes(item.impact));
  const allViolations = axeResults.violations.map((item) => ({
    id: item.id,
    impact: item.impact,
    help: item.help,
    nodes: item.nodes.length,
    targets: item.nodes.slice(0, 5).map((node) => node.target.join(' ')),
  }));

  const issues = [];
  if (navigationError) issues.push(`navigation: ${navigationError}`);
  if (failedRequests.length) issues.push(`${failedRequests.length} failed request(s)`);
  if (badResponses.length) issues.push(`${badResponses.length} HTTP error response(s)`);
  if (serious.length) issues.push(`${serious.length} serious/critical axe violation(s)`);
  if (allViolations.length) issues.push(`${allViolations.length} WCAG A/AA axe violation(s)`);
  if (duplicates.length) issues.push(`${duplicates.length} repeated API read(s)`);
  if (resources.length > LIMITS.requests) issues.push(`${resources.length} resources > ${LIMITS.requests}`);
  if (transferBytes > LIMITS.transferBytes) issues.push(`${Math.round(transferBytes / 1024)} KiB transfer > ${Math.round(LIMITS.transferBytes / 1024)} KiB`);
  if (scriptBytes > LIMITS.scriptBytes) issues.push(`${Math.round(scriptBytes / 1024)} KiB JS > ${Math.round(LIMITS.scriptBytes / 1024)} KiB`);
  if (cssBytes > LIMITS.cssBytes) issues.push(`${Math.round(cssBytes / 1024)} KiB CSS > ${Math.round(LIMITS.cssBytes / 1024)} KiB`);
  if (wallMs > LIMITS.loadMs) issues.push(`${wallMs} ms load > ${LIMITS.loadMs} ms`);

  const result = {
    route,
    viewport: MOBILE ? 'mobile' : 'desktop',
    pass: issues.length === 0,
    issues,
    wallMs,
    resources: resources.length,
    transferBytes,
    scriptBytes,
    cssBytes,
    failedRequests,
    badResponses,
    duplicateApiRequests: duplicates,
    violations: allViolations,
    incompleteAxeChecks: axeResults.incomplete.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
  };
  results.push(result);
  console.log(
    `${result.pass ? 'PASS' : 'FAIL'}  ${route.padEnd(30)} ${wallMs} ms · ${resources.length} req · ${Math.round(transferBytes / 1024)} KiB · ${allViolations.length} axe${issues.length ? ` — ${issues.join('; ')}` : ''}`
  );
  await context.close();
}

await browser.close();
mkdirSync('screenshots', { recursive: true });
writeFileSync(ARTIFACT, JSON.stringify({ at: new Date().toISOString(), base: BASE, limits: LIMITS, results }, null, 2));
const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} browser quality routes passed · ${ARTIFACT}`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((item) => item.route).join(' · ')}`);
  process.exit(1);
}
console.log('BROWSER QUALITY — WCAG A/AA, requests, local latency and resource weight are within guardrails.');
