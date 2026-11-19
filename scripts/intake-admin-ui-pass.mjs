#!/usr/bin/env node
/** Browser verification for contacts, relationships, custom fields and form mappings. */
import { createRequire } from 'node:module';
const tools = process.env.VOXERA_BROWSER_TOOLS ?? '/tmp/voxera-browser-tools';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const stamp = Date.now().toString(36);
const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
async function login(email = 'jordan@northwind.dev') {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo-password-2026' }) });
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
const patient = await api('/api/v1/clients', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ name: `Intake UI Patient ${stamp}`, number: `+447712${String(Date.now()).slice(-6)}`, email: `intake-ui-${stamp}@example.test`, address: '1 Legacy UI Road, Oldtown' }) });
const contact = await api('/api/v1/contacts', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ kind: 'person', name: `Intake UI Contact ${stamp}`, email: `contact-${stamp}@example.test`, phone: '+447700930001', address: '2 Legacy UI Road, Oldtown', payer: true }) });
const definition = await api('/api/v1/custom-fields', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType: 'client', key: `preferred_language_${stamp}`, label: `Preferred language ${stamp}`, valueType: 'text', sensitivity: 'administrative' }) });
const contactDefinition = await api('/api/v1/custom-fields', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType: 'contact', key: `contact_channel_${stamp}`, label: `Contact channel ${stamp}`, valueType: 'text', sensitivity: 'administrative' }) });
const referralDefinition = await api('/api/v1/custom-fields', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetType: 'referral', key: `referral_source_${stamp}`, label: `Referral source ${stamp}`, valueType: 'text', sensitivity: 'administrative' }) });
const referralCreated = await api('/api/v1/referrals', owner, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' }, body: JSON.stringify({ patient: { name: `Referral UI Patient ${stamp}`, address: '3 Legacy UI Road, Oldtown' }, reason: 'Synthetic UI value entry and address review', priority: 'routine' }) });
const referral = referralCreated.referral;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: owner.name, value: owner.value, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`console: ${entry.text()}`); });
  page.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  await page.goto(`${BASE}/dashboard/intake`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Intake administration' }).waitFor({ timeout: 30_000 });
  const cookieChoice = page.getByRole('button', { name: 'Decline optional' });
  if (await cookieChoice.isVisible().catch(() => false)) await cookieChoice.click();
  check('intake administration renders as a real dashboard workflow', await page.getByRole('heading', { name: 'Intake administration' }).isVisible() && await page.getByRole('tab', { name: /Contact directory/ }).isVisible());
  check('reusable contact appears in the directory', await page.getByText(contact.name, { exact: true }).isVisible());
  const directoryRow = page.locator('article').filter({ hasText: contact.name });
  await directoryRow.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('heading', { name: `Manage ${contact.name}` }).waitFor({ timeout: 30_000 });
  const contactField = page.getByLabel(contactDefinition.label);
  await contactField.fill('Email first');
  await contactField.locator('xpath=..').getByRole('button', { name: 'Save' }).click();
  await page.getByText(`${contactDefinition.label} saved for ${contact.name}.`, { exact: true }).waitFor({ timeout: 30_000 });
  const contactValues = await api(`/api/v1/contacts/${contact.id}/custom-fields`, owner);
  const savedContactValue = contactValues.data.find((row) => row.definition.id === contactDefinition.id)?.value;
  check('contact directory exposes practical typed value entry', savedContactValue?.value === 'Email first' && savedContactValue?.verificationStatus === 'verified');
  await page.getByLabel('Address line 1').fill('2 UI Road');
  await page.getByLabel('City or locality').fill('Leeds');
  await page.getByLabel('Postcode').fill('LS1 1AA');
  await page.getByRole('button', { name: 'Review and save address' }).click();
  await page.getByText(`Structured address reviewed for ${contact.name}; legacy text remains preserved.`, { exact: true }).waitFor({ timeout: 30_000 });
  const reviewedContact = await api(`/api/v1/contacts/${contact.id}`, owner);
  check('contact UI explicitly reviews structure without discarding legacy text', reviewedContact.structuredAddress?.reviewStatus === 'reviewed' && reviewedContact.structuredAddress?.legacyText === '2 Legacy UI Road, Oldtown');
  await page.getByRole('tab', { name: /Custom fields/ }).click();
  check('typed field catalogue is available', await page.getByText(definition.label, { exact: true }).isVisible() && await page.getByText(`custom:${definition.key}`, { exact: false }).isVisible());

  await page.goto(`${BASE}/dashboard/clients/${patient.id}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: patient.name }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Contacts & fields/ }).click();
  check('patient record exposes associated contacts and custom fields', await page.getByRole('heading', { name: 'Associated contacts' }).isVisible() && await page.getByRole('heading', { name: 'Custom fields' }).isVisible());
  await page.locator('section[aria-labelledby="relationships-title"] select').first().selectOption(contact.id);
  await page.getByRole('button', { name: 'Link contact' }).click();
  const relationshipRow = page.locator('article').filter({ hasText: contact.name });
  await relationshipRow.waitFor({ timeout: 30_000 });
  check('staff can link a directory contact from the patient record', await relationshipRow.isVisible() && await relationshipRow.getByText('not verified', { exact: true }).isVisible());

  const fieldPanel = page.locator('div').filter({ has: page.getByLabel(definition.label) }).last();
  await page.getByLabel(definition.label).fill('English');
  await fieldPanel.getByRole('button', { name: 'Save' }).click();
  await page.getByText(`${definition.label} saved with a verified staff source.`, { exact: true }).waitFor({ timeout: 30_000 });
  const values = await api(`/api/v1/clients/${patient.id}/custom-fields`, owner);
  const saved = values.data.find((row) => row.definition.id === definition.id)?.value;
  check('custom field saves a verified staff-sourced value', saved?.value === 'English' && saved?.source === 'staff' && saved?.verificationStatus === 'verified');
  await page.getByLabel('Address line 1').fill('1 UI Road');
  await page.getByLabel('City or locality').fill('York');
  await page.getByLabel('Postcode').fill('YO1 1AA');
  await page.getByRole('button', { name: 'Review and save address' }).click();
  await page.getByText('Structured address reviewed. The original legacy text remains preserved.', { exact: true }).waitFor({ timeout: 30_000 });
  const reviewedPatient = await api(`/api/v1/clients/${patient.id}`, owner);
  check('patient UI provides explicit structured-address review', reviewedPatient.structuredAddress?.reviewStatus === 'reviewed' && reviewedPatient.structuredAddress?.legacyText === '1 Legacy UI Road, Oldtown');

  await page.goto(`${BASE}/dashboard/referrals`, { waitUntil: 'networkidle', timeout: 60_000 });
  const referralRow = page.locator('button').filter({ hasText: referral.patient.name }).first();
  await referralRow.click();
  await page.getByRole('heading', { name: referral.patient.name }).waitFor({ timeout: 30_000 });
  const referralField = page.getByLabel(referralDefinition.label);
  await referralField.fill('Community');
  await referralField.locator('xpath=..').getByRole('button', { name: 'Save' }).click();
  await page.getByText(`${referralDefinition.label} saved with verified staff evidence.`, { exact: true }).waitFor({ timeout: 30_000 });
  const referralValues = await api(`/api/v1/referrals/${referral.id}/custom-fields`, owner);
  check('referral detail exposes practical typed value entry', referralValues.data.find((row) => row.definition.id === referralDefinition.id)?.value?.value === 'Community');
  await page.getByLabel('Address line 1').fill('3 UI Road');
  await page.getByLabel('City or locality').fill('Sheffield');
  await page.getByLabel('Postcode').fill('S1 1AA');
  await page.getByRole('button', { name: 'Review and save address' }).click();
  await page.getByText('Referral address reviewed; the source text remains preserved.', { exact: true }).waitFor({ timeout: 30_000 });
  const reviewedReferral = await api(`/api/v1/referrals/${referral.id}`, owner);
  check('referral UI preserves legacy address evidence through review', reviewedReferral.referral.patient.structuredAddress?.legacyText === '3 Legacy UI Road, Oldtown' && reviewedReferral.referral.patient.structuredAddress?.reviewStatus === 'reviewed');

  await page.goto(`${BASE}/dashboard/forms`,  { waitUntil: 'networkidle', timeout: 60_000 });
  const mapping = page.getByLabel('Reviewable patient update').first();
  await mapping.waitFor({ timeout: 30_000 });
  const mappingOption = mapping.locator(`option[value="custom:${definition.key}"]`);
  await mappingOption.waitFor({ state: 'attached', timeout: 30_000 });
  check('form builder offers compatible custom-field mappings', await mappingOption.count() === 1);
  check('builder explains that mapped answers require review', (await page.locator('body').innerText()).includes('Submissions only create a suggestion; staff must accept it.'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/dashboard/clients/${patient.id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { name: patient.name }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Contacts & fields/ }).click();
  const width = await page.locator('body').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('patient administration has no horizontal mobile overflow', width.scroll <= width.client + 1, `${width.scroll}/${width.client}`);
  check('browser walk has no page exceptions or server 500s', errors.length === 0, errors.join(' | '));
  await context.close();
} finally {
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
console.log(`\n${checks.length - failed.length} passed / ${failed.length} failed`);
if (failed.length) process.exit(1);
