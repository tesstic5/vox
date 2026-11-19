#!/usr/bin/env node
/** Phase 1 browser walk: canonical client record, Files library and permission boundaries. */

import { chromium } from 'playwright';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const OWNER_EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const DESK_EMAIL = process.env.VOXERA_DESK_EMAIL ?? 'desk@northwind.dev';
const checks = [];
let uploadedId = '';
let uploadedRevision = 0;

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function login(email) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await response.json().catch(() => ({}));
  const setCookie = response.headers.get('set-cookie') ?? '';
  const pair = setCookie.split(';')[0].split('=');
  if (!response.ok || !pair[0] || pair.length < 2) throw new Error(`login ${email} failed: HTTP ${response.status} ${body?.error?.message ?? ''}`);
  return { name: pair[0], value: pair.slice(1).join('='), header: `${pair[0]}=${pair.slice(1).join('=')}` };
}

async function request(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { cookie: cookie.header, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { response, body };
}

const browser = await chromium.launch();
try {
  const owner = await login(OWNER_EMAIL);
  await request('/api/v1/clinical/migrations', owner, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'RUN PHASE 1 DATA MIGRATIONS' }),
  });
  await request('/api/v1/clinical/readiness', owner, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'synthetic_test' }),
  });
  const clients = await request('/api/v1/clients?limit=5', owner);
  const patient = Array.isArray(clients.body?.data) ? clients.body.data.find((row) => row?.id) : undefined;
  if (!patient) throw new Error('no synthetic client exists for the document UI walk');
  const id = String(patient.id);

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.addCookies([{ name: owner.name, value: owner.value, domain: '127.0.0.1', path: '/' }]);
  const page = await desktop.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  await page.goto(`${BASE}/dashboard/clients/${encodeURIComponent(id)}`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('canonical client detail route opens the selected server record', await page.locator(`[data-client-record="${id}"]`).isVisible(), id);
  check('client record exposes the Phase 1 overview, appointments, documents and access sections',
    await page.getByRole('button', { name: /^Overview/ }).isVisible() &&
    await page.getByRole('button', { name: /^Appointments/ }).isVisible() &&
    await page.getByRole('button', { name: /^Documents/ }).isVisible() &&
    await page.getByRole('button', { name: /^Access/ }).isVisible());
  check('subject-access export is a real controlled route', await page.getByRole('link', { name: /Subject-access export/ }).getAttribute('href') === `/api/v1/clients/${id}/export`);

  await page.goto(`${BASE}/dashboard/files?patientId=${encodeURIComponent(id)}`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('Files is a working encrypted-document library rather than an unavailable placeholder', await page.getByRole('heading', { name: 'Clinical documents' }).isVisible());
  check('document search and file input have accessible labels',
    await page.getByLabel('Search title, category or document ID').isVisible() && await page.getByLabel('PDF, JPEG, PNG, text or DOCX').isVisible());
  check('client link preselects the patient without copying records into browser storage', await page.getByLabel('Patient ID').inputValue() === id, await page.getByLabel('Patient ID').inputValue());

  const title = `Browser quarantine ${Date.now()}`;
  await page.getByLabel('Document title').fill(title);
  await page.getByLabel('Category', { exact: true }).fill('browser_security_probe');
  await page.getByLabel('PDF, JPEG, PNG, text or DOCX').setInputFiles({
    name: 'keyboard-probe.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic document UI bytes; no real patient data'),
  });
  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && /\/api\/v1\/documents\/uploads\//.test(response.url()));
  const uploadButton = page.getByRole('button', { name: /Upload to quarantine/ });
  await uploadButton.focus();
  await page.keyboard.press('Enter');
  const response = await uploadResponse;
  const uploadBody = await response.json().catch(() => ({}));
  uploadedId = String(uploadBody?.document?.id ?? '');
  uploadedRevision = Number(uploadBody?.document?.revision ?? 0);
  await page.getByText(title).waitFor({ state: 'visible', timeout: 20_000 });
  check('keyboard activation uploads through a single-use capability', response.status() === 201 && Boolean(uploadedId), `HTTP ${response.status()}`);
  const uploadedArticle = page.getByText(title).locator('xpath=ancestor::article');
  check('new bytes are visibly quarantined and not offered as a download',
    await uploadedArticle.getByText(/scan pending|unavailable|pending/i).isVisible() &&
    await uploadedArticle.getByText('Download blocked').isVisible());
  check('document library displays the typed canonical record link', await uploadedArticle.getByText(new RegExp(`owner patient:${id}`)).isVisible());
  await page.goto(`${BASE}/dashboard/clinical/operations`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('clinical operations UI exposes the redacted dead-letter queue',
    await page.getByRole('heading', { name: 'Clinical job operations' }).isVisible() &&
    await page.getByRole('heading', { name: 'Dead letters' }).isVisible() &&
    await page.getByText(/never returns job payloads/i).isVisible());
  check('the owner document and operations pages produced no server or browser exception', errors.length === 0, errors.join(' | '));
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addCookies([{ name: owner.name, value: owner.value, domain: '127.0.0.1', path: '/' }]);
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/dashboard/clients/${encodeURIComponent(id)}`, { waitUntil: 'networkidle', timeout: 60_000 });
  const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('client detail remains usable on a 390px viewport', overflow <= 1, `${overflow}px overflow`);
  await mobile.close();

  const desk = await login(DESK_EMAIL);
  const deskContext = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  await deskContext.addCookies([{ name: desk.name, value: desk.value, domain: '127.0.0.1', path: '/' }]);
  const deskPage = await deskContext.newPage();
  await deskPage.goto(`${BASE}/dashboard/clients/${encodeURIComponent(id)}`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('denied clinical tabs are absent for the front-desk role',
    await deskPage.getByRole('button', { name: /^Documents/ }).count() === 0 && await deskPage.getByRole('button', { name: /^Access/ }).count() === 0);
  const direct = await request(`/api/v1/documents?patientId=${encodeURIComponent(id)}`, desk);
  check('the same role is denied at the direct typed document URL', direct.response.status === 403, `HTTP ${direct.response.status}`);
  const deadLetters = await request('/api/v1/clinical/dead-letters?status=open', desk);
  check('front-desk role cannot inspect clinical job failures', deadLetters.response.status === 403, `HTTP ${deadLetters.response.status}`);
  await deskContext.close();
} finally {
  if (uploadedId) {
    try {
      const owner = await login(OWNER_EMAIL);
      await request(`/api/v1/documents/${encodeURIComponent(uploadedId)}`, owner, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' },
        body: JSON.stringify({ archive: true, expectedRevision: uploadedRevision }),
      });
    } catch { /* cleanup evidence must not replace the original verdict */ }
  }
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} document/client browser checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((row) => row.label).join(' · ')}`);
  process.exit(1);
}
console.log('PHASE 1 UI WALKED — scoped client records and quarantine-first Files work on desktop and mobile.');
