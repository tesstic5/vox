#!/usr/bin/env node
/** Browser walk for native forms, referral triage and correspondence. */

import { createRequire } from 'node:module';
const tools = process.env.VOXERA_BROWSER_TOOLS ?? '/tmp/voxera-browser-tools';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const stamp = Date.now().toString(36);
const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const body = await response.json().catch(() => ({}));
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0].split('=');
  if (!response.ok || pair.length < 2) throw new Error(`login failed: ${response.status} ${body?.error?.message ?? ''}`);
  return { name: pair[0], value: pair.slice(1).join('='), header: `${pair[0]}=${pair.slice(1).join('=')}` };
}
async function api(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { cookie: cookie.header, ...(options.headers ?? {}) } });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${body?.error?.message ?? text.slice(0, 120)}`);
  return body;
}

const owner = await login();
await api('/api/v1/clinical/migrations', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'RUN PHASE 1 DATA MIGRATIONS' }) });
await api('/api/v1/clinical/readiness', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'synthetic_test' }) });
const client = await api('/api/v1/clients', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Browser Patient ${stamp}`, number: `+447711${String(Date.now()).slice(-6)}`, email: `browser-${stamp}@example.test` }) });
const formCreated = await api('/api/v1/forms/templates', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Browser intake ${stamp}`, category: 'intake', schema: { version: 1, title: 'Browser intake check', description: 'A synthetic browser verification form.', emergencyNotice: 'Do not use this form for emergencies.', fields: [
  { id: 'preferred_name', key: 'preferred_name', label: 'Preferred browser name', type: 'text', required: true },
  { id: 'has_detail', key: 'has_detail', label: 'Do you need to add detail?', type: 'yes_no', required: true },
  { id: 'detail', key: 'detail', label: 'Additional detail', type: 'long_text', required: true, condition: { op: 'equals', field: 'has_detail', value: true } },
  { id: 'confirm', key: 'confirm', label: 'I confirm this synthetic response', type: 'acknowledgement', required: true },
] } }) });
const formTemplate = await api(`/api/v1/forms/templates/${formCreated.template.id}`, owner, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'publish', expectedRevision: formCreated.template.revision }) });
const assignment = await api('/api/v1/forms/assignments', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ templateId: formTemplate.id, clientId: client.id, send: false }) });
const referralCreated = await api('/api/v1/referrals', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ patient: { name: `Browser Referral ${stamp}`, email: `ref-${stamp}@example.test` }, referrer: { name: 'Browser Case Manager', email: `referrer-${stamp}@example.test`, organisation: 'Browser Referrals' }, reason: 'Synthetic browser triage check', priority: 'urgent' }) });
const letterTemplateCreated = await api('/api/v1/letters/templates', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Browser letter ${stamp}`, subject: 'Browser letter for {{patient.name}}', body: 'Dear {{recipient.name}},\n\nSynthetic browser letter.\n\n{{author.name}}', footer: '{{practice.name}}', requiresApproval: true }) });
const letterTemplate = await api(`/api/v1/letters/templates/${letterTemplateCreated.template.id}`, owner, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'publish', expectedRevision: letterTemplateCreated.template.revision }) });
const letterCreated = await api('/api/v1/letters', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ templateId: letterTemplate.id, clientId: client.id, recipient: { name: `Browser Recipient ${stamp}`, email: `letter-${stamp}@example.test` } }) });
const correctionSourceCreated = await api('/api/v1/letters', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ templateId: letterTemplate.id, clientId: client.id, recipient: { name: `Correction Recipient ${stamp}`, email: `correction-${stamp}@example.test` } }) });
const correctionAwaiting = await api(`/api/v1/letters/${correctionSourceCreated.letter.id}`, owner, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ action: 'submit', expectedRevision: correctionSourceCreated.letter.revision }) });
const correctionApproved = await api(`/api/v1/letters/${correctionSourceCreated.letter.id}`, owner, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ action: 'approve', expectedRevision: correctionAwaiting.revision }) });
const correctionSource = await api(`/api/v1/letters/${correctionSourceCreated.letter.id}`, owner, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ action: 'finalise', expectedRevision: correctionApproved.revision }) });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: owner.name, value: owner.value, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`console: ${entry.text()}`); });
  page.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  await page.goto(`${BASE}/dashboard/forms`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Forms' }).waitFor({ timeout: 30_000 });
  const cookieChoice = page.getByRole('button', { name: 'Decline optional' });
  if (await cookieChoice.isVisible().catch(() => false)) await cookieChoice.click();
  const templateTab = page.locator('[role="tab"]').filter({ hasText: 'Templates' });
  const assignmentTab = page.locator('[role="tab"]').filter({ hasText: 'Assignments' });
  const responseTab = page.locator('[role="tab"]').filter({ hasText: 'Responses' });
  check('forms dashboard renders the native workflow', await page.getByRole('heading', { name: 'Forms' }).isVisible() && await templateTab.isVisible());
  check('forms navigation exposes templates, assignments and responses', await assignmentTab.isVisible() && await responseTab.isVisible());
  await assignmentTab.click();
  const assignedRow = page.locator('article').filter({ hasText: formCreated.template.name });
  check('assigned secure form appears without a bearer token', await assignedRow.isVisible() && !(await page.locator('body').innerText()).includes(assignment.publicUrl.split('/').at(-1)));

  await page.goto(`${BASE}/dashboard/referrals`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('referral inbox renders queue controls', await page.getByRole('heading', { name: 'Referral inbox' }).isVisible() && await page.getByLabel('Search').isVisible() && await page.getByLabel('Status').isVisible());
  await page.getByText(referralCreated.referral.patient.name, { exact: true }).click();
  const referralDetail = page.locator('section.panel').last();
  await referralDetail.getByRole('heading', { name: referralCreated.referral.patient.name }).waitFor();
  check('referral detail shows reason, priority and decision history', await referralDetail.getByText('Synthetic browser triage check', { exact: true }).isVisible() && await referralDetail.getByText('Decision history').isVisible() && await referralDetail.getByText('urgent', { exact: true }).isVisible());
  check('triage actions are available to the owner', await referralDetail.getByRole('button', { name: 'triaged', exact: true }).isVisible() && await referralDetail.getByRole('button', { name: 'accepted', exact: true }).isVisible());
  await referralDetail.getByRole('button', { name: 'triaged', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Referral moved to triaged' }).waitFor({ timeout: 30_000 });
  await referralDetail.getByRole('button', { name: 'accepted', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Referral moved to accepted' }).waitFor({ timeout: 30_000 });
  const notifyPanel = referralDetail.getByText('Notify referrer', { exact: true }).locator('..');
  check('accepted referral exposes a fixed recorded referrer destination', await notifyPanel.getByText(`referrer-${stamp}@example.test`, { exact: false }).isVisible() && await notifyPanel.getByRole('button', { name: 'Queue referrer notification' }).isVisible());
  await notifyPanel.getByLabel('Subject').fill('Browser referral update');
  await notifyPanel.getByLabel('Message').fill('The browser referral has been accepted for administrative follow-up.');
  await notifyPanel.getByRole('button', { name: 'Queue referrer notification' }).click();
  await page.getByRole('status').filter({ hasText: 'Referrer notification queued' }).waitFor({ timeout: 30_000 });
  await referralDetail.getByText('Browser referral update', { exact: true }).waitFor({ timeout: 30_000 });
  await referralDetail.getByText('queued', { exact: true }).waitFor({ timeout: 30_000 });
  check('referrer notification appears with durable queued evidence', await referralDetail.getByText('Browser referral update', { exact: true }).isVisible() && await referralDetail.getByText('queued', { exact: true }).isVisible());

  await page.goto(`${BASE}/dashboard/letters`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('letters dashboard renders queue and template workflow', await page.getByRole('heading', { name: 'Letters' }).isVisible() && await page.getByRole('tab', { name: /Templates/ }).isVisible());
  await page.getByText(letterCreated.letter.snapshot.recipient.name, { exact: true }).click();
  check('letter detail exposes editable snapshot content and approval action', await page.getByLabel('Subject').inputValue() === letterCreated.version.subject && await page.getByRole('button', { name: 'Submit for approval' }).isVisible());
  check('letter screen explains snapshot integrity rather than claiming delivery', (await page.locator('body').innerText()).includes('point-in-time data snapshot') || (await page.locator('body').innerText()).includes('source data into a snapshot'));
  await page.getByText(correctionSource.snapshot.recipient.name, { exact: true }).click();
  const letterDetail = page.locator('section.panel').last();
  await letterDetail.getByText('Create a correction', { exact: true }).waitFor({ timeout: 30_000 });
  check('finalised letter exposes immutable evidence and an explicit correction workflow', await letterDetail.getByText('Immutable artifact evidence', { exact: true }).isVisible() && await letterDetail.getByRole('button', { name: 'Create linked correction draft' }).isVisible());
  await letterDetail.getByPlaceholder('Why is a correction required?').fill('Browser correction required for factual administrative accuracy.');
  await letterDetail.getByRole('button', { name: 'Create linked correction draft' }).click();
  await page.getByRole('status').filter({ hasText: 'Linked correction draft created' }).waitFor({ timeout: 30_000 });
  await letterDetail.getByText('Correction chain', { exact: true }).waitFor({ timeout: 30_000 });
  check('linked correction opens as an editable draft with its source chain visible', await letterDetail.getByText('Correction chain', { exact: true }).isVisible() && await letterDetail.getByText(correctionSource.id, { exact: false }).isVisible() && await letterDetail.getByLabel('Subject').isEditable());
  await page.locator('button').filter({ hasText: correctionSource.id }).click();
  await letterDetail.getByText('Superseded by linked correction', { exact: true }).waitFor({ timeout: 30_000 });
  check('superseded source remains visibly linked and downloadable', await letterDetail.getByText('Superseded by linked correction', { exact: true }).isVisible() && await letterDetail.getByRole('link', { name: 'PDF' }).isVisible());

  const publicPage = await context.newPage();
  await publicPage.setViewportSize({ width: 390, height: 844 });
  const publicErrors = [];
  publicPage.on('pageerror', (error) => publicErrors.push(error.message));
  publicPage.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) publicErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const publicResponse = await publicPage.goto(assignment.publicUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await publicPage.getByRole('heading', { name: 'Browser intake check' }).waitFor({ timeout: 30_000 });
  check('public form uses no-store and privacy-preserving referrer controls', publicResponse?.headers()['cache-control']?.includes('no-store') && ['no-referrer', 'strict-origin-when-cross-origin'].includes(publicResponse?.headers()['referrer-policy'] ?? ''), `${publicResponse?.headers()['cache-control']} · ${publicResponse?.headers()['referrer-policy']}`);
  check('public form is usable on a mobile viewport', await publicPage.getByRole('heading', { name: 'Browser intake check' }).isVisible() && await publicPage.getByLabel('Preferred browser name').isVisible());
  await publicPage.getByLabel('Preferred browser name').fill('Browser Answer');
  await publicPage.getByText('Yes', { exact: true }).click();
  check('conditional question appears when its rule matches', await publicPage.getByLabel('Additional detail').isVisible());
  await publicPage.getByText('No', { exact: true }).click();
  check('conditional question disappears and cannot be submitted hidden', !(await publicPage.getByLabel('Additional detail').isVisible().catch(() => false)));
  await publicPage.getByText('I acknowledge this statement').click();
  const bodyWidth = await publicPage.locator('body').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('public form has no horizontal mobile overflow', bodyWidth.scroll <= bodyWidth.client + 1, `${bodyWidth.scroll}/${bodyWidth.client}`);
  await publicPage.getByRole('button', { name: 'Submit securely' }).click();
  await publicPage.getByRole('heading', { name: 'Form received' }).waitFor({ timeout: 30_000 });
  check('public form completes with a clear receipt state', await publicPage.getByRole('heading', { name: 'Form received' }).isVisible());
  check('browser walk has no page exceptions or server 500s', errors.length === 0 && publicErrors.length === 0, [...errors, ...publicErrors].join(' | '));
  await context.close();
} finally {
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
console.log(`\n${checks.length - failed.length} passed / ${failed.length} failed`);
if (failed.length) process.exit(1);
