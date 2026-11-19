#!/usr/bin/env node
/** Browser acceptance walk for body-chart administration, drawing and signing. */

import { createRequire } from 'node:module';
const tools = process.env.VOXERA_BROWSER_TOOLS ?? '/tmp/voxera-browser-tools';
const require = createRequire(`${tools}/package.json`);
const { chromium } = require('playwright');

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3301';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const DESK_EMAIL = process.env.VOXERA_DESK_EMAIL ?? 'desk@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const stamp = Date.now().toString(36);
const chartTitle = `Browser body source ${stamp}`;
const noteTitle = `Browser body-chart note ${stamp}`;
const checks = [];

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function login(email = EMAIL) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await response.json().catch(() => ({}));
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0].split('=');
  if (!response.ok || pair.length < 2) throw new Error(`login failed: ${response.status} ${body?.error?.message ?? ''}`);
  return { name: pair[0], value: pair.slice(1).join('='), header: `${pair[0]}=${pair.slice(1).join('=')}` };
}

async function apiResponse(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { cookie: cookie.header, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { response, body, text };
}

async function api(path, cookie, options = {}) {
  const result = await apiResponse(path, cookie, options);
  if (!result.response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${result.response.status} ${result.body?.error?.message ?? result.text.slice(0, 160)}`);
  return result.body;
}

async function dismissCookies(page) {
  const button = page.getByRole('button', { name: 'Decline optional' });
  try {
    await button.waitFor({ state: 'visible', timeout: 3_000 });
    await button.click();
    await page.getByRole('region', { name: 'Cookie preferences' }).waitFor({ state: 'hidden', timeout: 5_000 });
  } catch {
    // The preference was already stored or this page has no banner.
  }
}

async function waitForCleanDocument(cookie, title, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const documents = await api('/api/v1/documents?ownerType=workspace', cookie);
    const found = (documents.data ?? []).find((row) => row.title === title);
    if (found?.currentScanStatus === 'clean' && found.currentVersionId) return found;
    if (found?.currentScanStatus === 'infected' || found?.currentScanStatus === 'failed') throw new Error(`uploaded browser chart failed scanning: ${found.currentScanStatus}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for scanner-clean document ${title}`);
}

const owner = await login();
await api('/api/v1/clinical/migrations', owner, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirmation: 'RUN PHASE 1 DATA MIGRATIONS' }),
});
await api('/api/v1/clinical/readiness', owner, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'synthetic_test' }),
});
const clients = await api('/api/v1/clients?limit=5', owner);
const client = (clients.data ?? [])[0];
if (!client?.id) throw new Error('browser fixture does not contain a client');

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addCookies([{ name: owner.name, value: owner.value, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`console: ${entry.text()}`); });
  page.on('response', (response) => {
    if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto(`${BASE}/dashboard/clinical/templates`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Body-chart template library' }).waitFor({ timeout: 30_000 });
  await dismissCookies(page);
  check('administrator library explains encrypted scanner-clean pinned sources', (await page.getByRole('heading', { name: 'Body-chart template library' }).locator('..').innerText()).includes('scanner-clean images'));
  await page.getByLabel('Template title').last().fill(chartTitle);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100c9fe92ef0000000049454e44ae426082', 'hex');
  await page.getByLabel('PNG or JPEG').setInputFiles({ name: `browser-${stamp}.png`, mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Encrypt & upload' }).click();
  await page.getByRole('status').filter({ hasText: 'Image encrypted and uploaded' }).waitFor({ timeout: 30_000 });
  check('administrator upload uses encrypted quarantine workflow', await page.getByRole('status').filter({ hasText: 'unavailable as a template until malware scanning reports clean' }).isVisible());
  const cleanDocument = await waitForCleanDocument(owner, chartTitle);
  check('uploaded workspace image reaches clean scan state before publication', cleanDocument.ownerType === 'workspace' && cleanDocument.currentScanStatus === 'clean' && Boolean(cleanDocument.currentVersionId));

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Body-chart template library' }).waitFor({ timeout: 30_000 });
  await dismissCookies(page);
  await page.getByLabel('Template title').last().fill(chartTitle);
  await page.getByLabel('Workspace image').selectOption({ label: chartTitle });
  await page.getByRole('button', { name: 'Publish immutable source' }).click();
  await page.getByRole('status').filter({ hasText: 'Published template created' }).waitFor({ timeout: 30_000 });
  const card = page.locator('article').filter({ hasText: chartTitle }).last();
  await card.waitFor({ timeout: 30_000 });
  const previewLoaded = await card.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0);
  check('administrator publishes and previews the exact scanner-clean image', await card.getByText('published', { exact: true }).isVisible() && previewLoaded);
  await card.getByRole('button', { name: 'Retire' }).click();
  await page.getByRole('status').filter({ hasText: 'Template retired' }).waitFor({ timeout: 30_000 });
  check('administrator can retire without deleting pinned source evidence', await card.getByText('retired', { exact: true }).isVisible());
  await card.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('status').filter({ hasText: 'Template published' }).waitFor({ timeout: 30_000 });
  check('retired template can be explicitly republished', await card.getByText('published', { exact: true }).isVisible());

  const chartTemplates = await api('/api/v1/body-chart-templates', owner);
  const chartTemplate = (chartTemplates.data ?? []).find((row) => row.title === chartTitle);
  if (!chartTemplate) throw new Error('published browser chart template was not returned by the API');
  const noteTemplateBody = await api('/api/v1/note-templates', owner, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'create', name: `Browser body record ${stamp}`, state: 'published',
      sections: [
        { id: 'record', label: 'Browser clinical record', kind: 'long_text', required: true },
        { id: 'body_map', label: 'Browser body map', kind: 'body_chart', required: true },
      ],
    }),
  });
  const opened = await api('/api/v1/notes', owner, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', clientId: client.id, templateId: noteTemplateBody.template.id, title: noteTitle }),
  });
  const filledSections = opened.note.sections.map((section) => ({
    ...section, body: section.id === 'record' ? 'Synthetic clinician-authored browser assessment.' : '',
  }));
  const savedBody = await api('/api/v1/notes', owner, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'update', id: opened.note.id, expectedRevision: opened.note.revision, sections: filledSections }),
  });
  check('browser fixture note retains required body-chart section', savedBody.incomplete?.includes('Browser body map'));

  await page.goto(`${BASE}/dashboard/clients?client=${encodeURIComponent(client.id)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('dialog').waitFor({ timeout: 30_000 });
  await dismissCookies(page);
  await page.getByRole('tab', { name: /Notes|Treatment notes|Job notes/ }).click();
  const row = page.locator('li').filter({ hasText: noteTitle });
  await row.getByRole('button', { name: 'Open' }).click();
  let editor = page.getByRole('dialog').last();
  await editor.locator('[data-body-chart-slot="body_map"]').waitFor({ timeout: 30_000 });
  await editor.getByLabel('Body-chart template').selectOption({ label: chartTitle });
  await editor.getByRole('button', { name: 'Add chart' }).click();
  await page.getByText('Body chart added. Its source-image version is now pinned to this annotation.').waitFor({ timeout: 30_000 });
  let canvas = editor.getByRole('application', { name: 'Body chart. Choose a tool, then point or draw on the image.' });
  await canvas.waitFor({ timeout: 30_000 });
  check('clinician opens a pinned image-backed drawing canvas', await editor.getByRole('img', { name: 'Body-chart template for clinician annotation' }).isVisible() && await canvas.isVisible());

  await canvas.click({ position: { x: 80, y: 80 } });
  const toolbar = editor.getByRole('toolbar', { name: 'Body-chart annotation tools' });
  await toolbar.getByLabel('Tool').selectOption('stroke');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('body-chart canvas has no browser geometry');
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .55, { steps: 8 });
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .7, { steps: 8 });
  await page.mouse.up();
  await toolbar.getByLabel('Tool').selectOption('label');
  await toolbar.getByLabel('Label text').fill('Browser tender area');
  await canvas.click({ position: { x: Math.max(2, box.width * .6), y: Math.max(2, box.height * .4) } });
  const marks = editor.getByRole('list', { name: 'Body-chart marks' });
  check('point, freehand and label tools create three clinician marks', await marks.locator('li').count() === 3 && (await marks.innerText()).includes('Browser tender area'));
  await editor.getByRole('button', { name: 'Save chart' }).click();
  await page.getByText('Body-chart draft saved at a new aggregate revision.').waitFor({ timeout: 30_000 });
  check('chart save advances aggregate revision and clears dirty state', await editor.getByRole('button', { name: 'Save chart' }).isDisabled());

  const chartBefore = await api(`/api/v1/notes/${opened.note.id}/body-charts`, owner);
  const noteBefore = await api(`/api/v1/notes/${opened.note.id}`, owner);
  const annotationBefore = chartBefore.data[0];
  const currentNote = noteBefore.note;
  const serverMarks = [...annotationBefore.marks, { id: 'server_current', type: 'point', x: .4, y: .6, color: '#059669', size: 8 }];
  await api(`/api/v1/notes/${opened.note.id}/body-charts`, owner, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'update', annotationId: annotationBefore.id, expectedRevision: annotationBefore.revision,
      expectedNoteRevision: currentNote.revision, marks: serverMarks,
    }),
  });
  const stale = await apiResponse(`/api/v1/notes/${opened.note.id}/body-charts`, owner, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'update', annotationId: annotationBefore.id, expectedRevision: annotationBefore.revision,
      expectedNoteRevision: currentNote.revision,
      marks: [{ id: 'browser_preserved', type: 'point', x: .9, y: .1, color: '#111111', size: 8 }],
    }),
  });
  check('browser scenario preserves a stale concurrent annotation set', stale.response.status === 409 && String(stale.body?.error?.message ?? '').includes('Both annotation sets'));

  await editor.locator('button').filter({ hasText: /^Close$/ }).click();
  await row.getByRole('button', { name: 'Open' }).click();
  editor = page.getByRole('dialog').last();
  await editor.getByText('Concurrent annotations need reconciliation').waitFor({ timeout: 30_000 });
  check('UI explains that concurrent marks were not merged automatically', (await editor.innerText()).includes('Nothing is merged or selected automatically'));
  await editor.getByRole('button', { name: 'Keep current set' }).click();
  await page.getByText('Concurrent body-chart annotations reconciled explicitly.').waitFor({ timeout: 30_000 });
  check('clinician explicitly reconciles the preserved set', !(await editor.getByText('Concurrent annotations need reconciliation').isVisible().catch(() => false)));

  const sign = editor.getByRole('button', { name: 'Sign & finalise' });
  check('required chart makes reviewed note eligible for explicit signing', await sign.isEnabled());
  page.once('dialog', (dialog) => dialog.accept());
  await sign.click();
  await editor.getByText('Signed evidence', { exact: true }).waitFor({ timeout: 30_000 });
  const readOnlyCanvas = editor.getByRole('application', { name: 'Read-only signed body-chart annotations.' });
  await readOnlyCanvas.waitFor({ timeout: 30_000 });
  check('signed chart is visibly read-only with no drawing toolbar', await readOnlyCanvas.isVisible() && await editor.getByRole('toolbar', { name: 'Body-chart annotation tools' }).count() === 0 && await editor.getByText('Signed charts are read-only', { exact: false }).isVisible());
  const history = editor.locator('details').filter({ hasText: 'Immutable body-chart history' });
  await history.locator('summary').click();
  const historyText = await history.innerText();
  check('signed history displays verified snapshot, signer and SHA-256', historyText.includes('verified') && historyText.includes('Jordan Reyes') && /[a-f0-9]{64}/.test(historyText));
  check('signed history exposes structured and safe overlay downloads', await history.getByRole('link', { name: 'Structured export' }).isVisible() && await history.getByRole('link', { name: 'Overlay SVG' }).isVisible());

  const signedDetail = await api(`/api/v1/notes/${opened.note.id}`, owner);
  const signedCharts = await api(`/api/v1/notes/${opened.note.id}/body-charts`, owner);
  const evidenceHash = signedDetail.versions?.[0]?.bodyCharts?.[0]?.contentHash;
  check('browser-finalised note and chart share one verified evidence hash', signedDetail.note.status === 'final' && signedCharts.versions?.length === 1 && signedCharts.versions[0].integrity === 'verified' && evidenceHash === signedCharts.versions[0].contentHash);

  await page.setViewportSize({ width: 390, height: 844 });
  const editorWidth = await editor.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('signed body-chart record remains usable at mobile width', editorWidth.scroll <= editorWidth.client + 2 && await readOnlyCanvas.isVisible(), `${editorWidth.scroll}/${editorWidth.client}`);
  check('clinician browser walk has no page exceptions or HTTP 5xx', errors.length === 0, errors.join(' | '));

  const desk = await login(DESK_EMAIL);
  const deskContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await deskContext.addCookies([{ name: desk.name, value: desk.value, domain: '127.0.0.1', path: '/' }]);
  const deskPage = await deskContext.newPage();
  const deskErrors = [];
  deskPage.on('pageerror', (error) => deskErrors.push(error.message));
  deskPage.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) deskErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await deskPage.goto(`${BASE}/dashboard/clients?client=${encodeURIComponent(client.id)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await deskPage.getByRole('dialog').waitFor({ timeout: 30_000 });
  await dismissCookies(deskPage);
  await deskPage.getByRole('tab', { name: /Notes|Treatment notes|Job notes/ }).click();
  const restrictedRow = deskPage.locator('li').filter({ hasText: 'Clinical note' }).filter({ hasText: 'signed v1' }).first();
  await restrictedRow.getByRole('button', { name: 'Restricted' }).waitFor({ timeout: 30_000 });
  check('reception browser sees only administrative note status', await restrictedRow.isVisible() && !(await deskPage.locator('body').innerText()).includes(noteTitle));
  await restrictedRow.getByRole('button', { name: 'Restricted' }).click();
  await deskPage.getByText('This note is clinical content. Your role cannot open it.').waitFor({ timeout: 30_000 });
  check('reception cannot open chart content in the browser', await deskPage.getByRole('application').count() === 0 && !(await deskPage.locator('body').innerText()).includes('Browser tender area'));
  check('reception browser walk has no page exceptions or HTTP 5xx', deskErrors.length === 0, deskErrors.join(' | '));
  await deskContext.close();
  await context.close();
} finally {
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
if (failed.length) {
  console.error(`\n${failed.length} body-chart UI checks failed: ${failed.map((row) => row.label).join('; ')}`);
  process.exit(1);
}
console.log(`\nPhase 4 body-chart UI pass: ${checks.length}/${checks.length}`);
