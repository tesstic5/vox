#!/usr/bin/env node
/** Browser probe for public referral submission and authenticated administrative review. */
import { createRequire } from 'node:module';
const tools = process.env.VOXERA_BROWSER_TOOLS ?? '/tmp/voxera-browser-tools';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');

const BASE = (process.env.VOXERA_BASE ?? 'http://127.0.0.1:3201').replace(/\/$/, '');
const stamp = Date.now().toString(36);
const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function message(body) { return body?.error?.message ?? String(body).slice(0, 200); }

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'jordan@northwind.dev', password: 'demo-password-2026' }) });
  const body = await response.json().catch(() => ({}));
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0].split('=');
  if (!response.ok || pair.length < 2) throw new Error(`login failed: ${response.status} ${message(body)}`);
  return { name: pair[0], value: pair.slice(1).join('='), header: `${pair[0]}=${pair.slice(1).join('=')}` };
}
async function api(path, cookie, options = {}) {
  const method = options.method ?? 'GET';
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : { 'x-voxera-synthetic-data': '1' }),
      ...(cookie ? { cookie: cookie.header } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${message(body)}`);
  return body;
}

const owner = await login();
await api('/api/v1/clinical/migrations', owner, { method: 'POST', body: JSON.stringify({ confirmation: 'RUN PHASE 1 DATA MIGRATIONS' }) });
await api('/api/v1/clinical/readiness', owner, { method: 'POST', body: JSON.stringify({ mode: 'synthetic_test' }) });
const title = `Synthetic browser referral ${stamp}`;
const patientName = `Synthetic Browser Patient ${stamp}`;
const patientEmail = `browser-referral-${stamp}@example.test`;
const reason = `<img src=x onerror="window.__voxeraXss=1"> Synthetic browser-only shoulder evidence ${stamp}`;
const slug = `browser-referral-${stamp}`;
const schema = {
  version: 1, title, description: 'Synthetic browser evidence for the public referral workflow.',
  fields: [
    { id: 'patient_name', key: 'patient_name', label: 'Patient name', type: 'text', required: true },
    { id: 'date_of_birth', key: 'date_of_birth', label: 'Date of birth', type: 'date', required: true },
    { id: 'patient_email', key: 'patient_email', label: 'Patient email', type: 'text', required: true },
    { id: 'reason', key: 'reason', label: 'Reason for referral', type: 'long_text', required: true },
    { id: 'consent', key: 'consent', label: 'Permission confirmed', type: 'acknowledgement', required: true },
    { id: 'attachment', key: 'attachment', label: 'Supporting attachment', type: 'file' },
  ],
};
const created = await api('/api/v1/forms/templates', owner, { method: 'POST', body: JSON.stringify({ name: title, category: 'referral', schema }) });
const template = created.template;
await api(`/api/v1/forms/templates/${template.id}`, owner, { method: 'PATCH', body: JSON.stringify({ action: 'publish', expectedRevision: template.revision }) });
const configured = await api('/api/v1/referral-forms', owner, { method: 'POST', body: JSON.stringify({
  name: `Browser website referral ${stamp}`, slug, templateId: template.id,
  mapping: { patientName: 'patient_name', dateOfBirth: 'date_of_birth', email: 'patient_email', reason: 'reason', consent: 'consent' },
  routing: { priority: 'soon' }, active: true,
  privacyNotice: 'Synthetic browser information is used only to verify the isolated referral workflow; never enter real-person information.',
  emergencyNotice: 'This synthetic browser form is not monitored continuously and must never be used for urgent or emergency concerns.',
  completionMessage: 'The synthetic browser referral has been received for administrative review.',
}) });

const browser = await chromium.launch({ headless: true });
const errors = [];
function observe(page) {
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`console: ${entry.text()}`); });
  page.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
}
try {
  const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await publicContext.newPage(); observe(page);
  const navigation = await page.goto(`${BASE}/refer/${slug}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: title }).waitFor({ timeout: 30_000 });
  const publicCookieChoice = page.getByRole('button', { name: 'Decline optional' });
  if (await publicCookieChoice.isVisible().catch(() => false)) await publicCookieChoice.click();
  const headers = navigation?.headers() ?? {};
  check('public page carries no-store, no-referrer and noindex controls', headers['cache-control']?.includes('no-store') && headers['referrer-policy'] === 'no-referrer' && headers['x-robots-tag']?.includes('noindex'), `${headers['cache-control']} · ${headers['referrer-policy']} · ${headers['x-robots-tag']}`);
  check('public introduction prominently prohibits real-person test data', await page.getByText('Test form — no real person information', { exact: true }).isVisible() && (await page.locator('body').innerText()).includes('Do not enter information about a real patient'));
  check('public introduction explains emergency and administrative limits', (await page.locator('body').innerText()).includes('not monitored continuously') && (await page.locator('body').innerText()).includes('does not confirm care or urgency'));
  await page.getByRole('button', { name: 'Start secure referral' }).click();
  await page.getByLabel('Patient name').waitFor({ timeout: 30_000 });
  check('public draft stays on the non-bearer slug URL and shows an expiry', page.url() === `${BASE}/refer/${slug}` && (await page.locator('body').innerText()).includes('Draft expires'));
  await page.getByLabel('Patient name').fill(patientName);
  await page.getByLabel('Date of birth').fill('1990-05-06');
  await page.getByLabel('Patient email').fill(patientEmail);
  await page.getByLabel('Reason for referral').fill(reason);
  await page.locator('#referral-consent').check();
  await page.locator('#referral-attachment').setInputFiles({ name: 'browser-evidence.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic browser evidence\n%%EOF\n') });
  await page.getByText('1 secure file attached', { exact: true }).waitFor({ timeout: 30_000 });
  check('browser upload reports secure quarantine attachment state', await page.getByText('1 secure file attached', { exact: true }).isVisible() && (await page.locator('body').innerText()).includes('held in quarantine'));
  const width = await page.locator('body').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('public referral has no horizontal mobile overflow', width.scroll <= width.client + 1, `${width.scroll}/${width.client}`);
  await page.locator('button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Referral received' }).waitFor({ timeout: 30_000 });
  check('public completion is explicit and non-clinical', (await page.locator('body').innerText()).includes('Reference ending') && (await page.locator('body').innerText()).includes('does not mean the referral has been accepted or clinically triaged'));
  check('one-time draft token is removed from browser storage after submit', await page.evaluate((key) => sessionStorage.getItem(key) === null, `voxera:public-referral:${slug}`));
  await publicContext.close();

  const listed = await api(`/api/v1/referrals?q=${encodeURIComponent(patientEmail)}&limit=100`, owner);
  const exact = (listed.data ?? []).filter((row) => row.patient?.email === patientEmail);
  const referralId = exact[0]?.id;
  check('browser submission appears once in the staff queue', exact.length === 1 && exact[0].source === 'secure_form' && exact[0].priority === 'soon', `matches=${exact.length}`);

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await adminContext.addCookies([{ name: owner.name, value: owner.value, url: BASE }]);
  const admin = await adminContext.newPage(); observe(admin);
  await admin.goto(`${BASE}/dashboard/referral-forms`, { waitUntil: 'networkidle', timeout: 60_000 });
  await admin.getByRole('heading', { name: 'Public referral forms' }).waitFor({ timeout: 30_000 });
  const cookieChoice = admin.getByRole('button', { name: 'Decline optional' });
  if (await cookieChoice.isVisible().catch(() => false)) await cookieChoice.click();
  const configuredCard = admin.locator('article').filter({ hasText: configured.name });
  check('administration lists the immutable active public address', await configuredCard.isVisible() && (await configuredCard.innerText()).includes(`/refer/${slug}`) && (await configuredCard.innerText()).includes('public'));
  check('administration states clinical and bearer-token limitations', (await admin.locator('body').innerText()).includes('does not diagnose') && (await admin.locator('body').innerText()).includes('Bearer draft tokens are hashed and never listed'));

  await admin.goto(`${BASE}/dashboard/referrals`, { waitUntil: 'networkidle', timeout: 60_000 });
  await admin.getByRole('heading', { name: 'Referral inbox' }).waitFor({ timeout: 30_000 });
  await admin.getByLabel('Search').fill(patientEmail);
  const queueRow = admin.getByRole('button').filter({ hasText: patientName });
  await queueRow.waitFor({ timeout: 30_000 });
  await queueRow.click();
  await admin.getByRole('heading', { name: patientName, exact: true }).waitFor({ timeout: 30_000 });
  check('staff detail shows verified original submission evidence', await admin.getByText('Original public submission', { exact: true }).isVisible() && await admin.getByText('verified evidence', { exact: true }).isVisible());
  const inertText = admin.getByText(reason, { exact: true });
  check('submitted markup remains inert text in the administrative review', await inertText.count() >= 2 && await inertText.first().isVisible() && await admin.locator('img[src="x"]').count() === 0 && await admin.evaluate(() => window.__voxeraXss !== 1));
  check('quarantined attachment is visible but not downloadable', await admin.getByText('Supporting attachment — browser-evidence.pdf', { exact: true }).isVisible() && await admin.getByText('Quarantined', { exact: true }).isVisible());

  await admin.getByRole('button', { name: 'accepted', exact: true }).click();
  await admin.getByText('Referral moved to accepted.', { exact: true }).waitFor({ timeout: 30_000 });
  await admin.getByRole('button', { name: 'Convert', exact: true }).click();
  await admin.getByText('Referral converted to a patient record with its decision trail preserved.', { exact: true }).waitFor({ timeout: 30_000 });
  const converted = await api(`/api/v1/referrals/${referralId}`, owner);
  check('staff UI accepts and converts while preserving verified evidence', converted.referral?.status === 'converted' && Boolean(converted.referral?.convertedClientId) && converted.publicSubmission?.evidence?.verified === true);

  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(`${BASE}/dashboard/referrals`, { waitUntil: 'networkidle', timeout: 60_000 });
  const adminWidth = await admin.locator('body').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('referral administration has no horizontal mobile overflow', adminWidth.scroll <= adminWidth.client + 1, `${adminWidth.scroll}/${adminWidth.client}`);
  check('browser walk has no page exceptions or server 500s', errors.length === 0, errors.join(' | '));
  await adminContext.close();
} finally {
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
console.log(`\n${checks.length - failed.length} passed / ${failed.length} failed`);
if (failed.length) process.exit(1);
