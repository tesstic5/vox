#!/usr/bin/env node
/** Browser acceptance walk for versioned templates and explicit note signing. */

import { createRequire } from 'node:module';
const tools = process.env.VOXERA_BROWSER_TOOLS ?? '/tmp/voxera-browser-tools';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3301';
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
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${body?.error?.message ?? String(text).slice(0, 120)}`);
  return body;
}

const owner = await login();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: owner.name, value: owner.value, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`console: ${entry.text()}`); });
  page.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  await page.goto(`${BASE}/dashboard/clinical/templates`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Clinical note templates' }).waitFor({ timeout: 30_000 });
  const cookieChoice = page.getByRole('button', { name: 'Decline optional' });
  if (await cookieChoice.isVisible().catch(() => false)) await cookieChoice.click();
  check('template designer renders clinical safety boundary', await page.getByText('Synthetic/test records only', { exact: false }).first().isVisible());
  check('template designer states immutable-version behaviour', (await page.locator('body').innerText()).includes('Every save creates a new immutable version'));

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Template name').fill(`Browser clinical template ${stamp}`);
  await page.getByLabel('Stable id').fill('browser_record');
  await page.getByLabel('Heading').fill('Browser clinical record');
  await page.getByLabel('Prompt').fill('Clinician-authored synthetic browser text');
  await page.getByRole('button', { name: 'Create version 1' }).click();
  await page.getByText('Versioned note template created.', { exact: false }).waitFor({ timeout: 30_000 });
  check('staff can create immutable template version 1 in the UI', await page.getByText(`Browser clinical template ${stamp}`, { exact: true }).first().isVisible());
  const versionOne = page.locator('article').filter({ hasText: 'Initial template' }).first();
  check('version history identifies immutable version 1', await versionOne.getByText('v1', { exact: true }).isVisible() && await versionOne.isVisible());

  await page.getByRole('button', { name: /Add section/ }).click();
  const stableIds = page.getByLabel('Stable id');
  await stableIds.nth(1).fill('browser_review');
  const headings = page.getByLabel('Heading');
  await headings.nth(1).fill('Browser review');
  await page.getByLabel('Why this version is changing').fill('Add a clinician review section');
  await page.getByRole('button', { name: 'Create version 2' }).click();
  await page.getByRole('status').filter({ hasText: 'Earlier versions were not changed' }).waitFor({ timeout: 30_000 });
  const versionTwo = page.locator('article').filter({ hasText: 'Add a clinician review section' }).first();
  check('UI revision creates version 2 instead of editing version 1', await versionTwo.getByText('v2', { exact: true }).isVisible() && await versionTwo.isVisible());

  const clients = await api('/api/v1/clients?limit=5', owner);
  const client = (clients.data ?? [])[0];
  const templates = await api('/api/v1/note-templates', owner);
  const template = (templates.data ?? []).find((row) => row.name === `Browser clinical template ${stamp}`);
  const noteSections = (template.sections ?? []).map((section) => ({ id: section.id, label: section.label, required: section.required, hint: section.prompt, body: `Synthetic browser text for ${section.label}` }));
  const opened = await api('/api/v1/notes', owner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', clientId: client.id, templateId: template.id, title: `Browser signing note ${stamp}`, sections: noteSections }) });

  await page.goto(`${BASE}/dashboard/clients?client=${encodeURIComponent(client.id)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { name: /Clients|Customers|Patients/ }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.getByRole('dialog').waitFor({ timeout: 30_000 });
  await page.getByRole('tab', { name: /Notes|Treatment notes|Job notes/ }).click();
  const row = page.locator('li').filter({ hasText: `Browser signing note ${stamp}` });
  await row.getByRole('button', { name: 'Open' }).click();
  const editor = page.getByRole('dialog').last();
  await editor.getByRole('button', { name: 'Sign & finalise' }).waitFor({ timeout: 30_000 });
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Sign & finalise' }).click();
  await editor.getByText('Signed evidence', { exact: true }).waitFor({ timeout: 30_000 });
  check('note UI requires explicit confirmation and displays signed evidence', await editor.getByText('Signed evidence', { exact: true }).isVisible());
  const editorText = await editor.innerText();
  check('signed UI shows signer, time and full SHA-256 hash', editorText.includes('SHA-256') && /[a-f0-9]{64}/.test(editorText) && editorText.includes('Jordan Reyes'));
  check('note UI shows template version, note version and revision', editorText.includes('template v2') && editorText.includes('note v1') && editorText.includes('revision'));
  const detail = await api(`/api/v1/notes/${opened.note.id}`, owner);
  check('browser-finalised note has one verified immutable snapshot', detail.note.status === 'final' && detail.versions?.length === 1 && detail.versions[0].integrity === 'verified');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/dashboard/clinical/templates`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Clinical note templates' }).waitFor({ timeout: 30_000 });
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  check('template designer remains usable at mobile width', dimensions.content <= dimensions.viewport + 2, `${dimensions.content}/${dimensions.viewport}`);
  check('mobile designer keeps named controls accessible', await page.getByRole('button', { name: 'New', exact: true }).isVisible() && await page.getByText('Synthetic/test records only', { exact: false }).first().isVisible());
  check('browser walk produced no page errors or HTTP 5xx responses', errors.length === 0, errors.join('; '));

  await context.close();
} finally {
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
if (failed.length) {
  console.error(`\n${failed.length} clinical UI checks failed: ${failed.map((row) => row.label).join('; ')}`);
  process.exit(1);
}
console.log(`\nPhase 4 clinical UI pass: ${checks.length}/${checks.length}`);
