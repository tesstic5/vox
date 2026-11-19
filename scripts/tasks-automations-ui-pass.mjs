#!/usr/bin/env node
/** Browser probe for administrative task and constrained automation screens. */
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
      ...(options.body ? { 'content-type': 'application/json' } : {}),
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

const browser = await chromium.launch({ headless: true });
const errors = [];
function observe(page) {
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`console: ${entry.text()}`); });
  page.on('response', (response) => { if (response.url().startsWith(BASE) && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: owner.name, value: owner.value, url: BASE }]);
  const page = await context.newPage(); observe(page);

  await page.goto(`${BASE}/dashboard/tasks`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Administrative tasks' }).waitFor({ timeout: 30_000 });
  const cookieChoice = page.getByRole('button', { name: 'Decline optional' });
  if (await cookieChoice.isVisible().catch(() => false)) await cookieChoice.click();
  const tasksBody = await page.locator('body').innerText();
  check('task screen states administrative and emergency boundaries', tasksBody.includes('not emergency monitoring') && tasksBody.includes('not turn a task into a signed clinical record'));
  check('task screen links to the real automation engine', await page.getByRole('link', { name: 'Automations', exact: true }).isVisible());

  const taskTitle = `Browser queue task ${stamp}`;
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill(taskTitle);
  await page.getByLabel('Description').fill('Synthetic browser-only administrative task evidence.');
  await page.getByLabel('Priority').selectOption('high');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByText('Task added to the administrative queue.', { exact: true }).waitFor({ timeout: 30_000 });
  const taskRow = page.getByRole('button').filter({ hasText: taskTitle });
  await taskRow.waitFor({ timeout: 30_000 });
  await taskRow.click();
  check('created task is visible with workspace ownership and revision evidence', await page.getByRole('heading', { name: taskTitle }).isVisible() && (await page.locator('body').innerText()).includes('workspace:'));
  await page.getByRole('button', { name: 'completed', exact: true }).click();
  await page.getByText('Task moved to completed.', { exact: true }).waitFor({ timeout: 30_000 });
  check('browser can complete and explicitly reopen a task', await page.getByRole('button', { name: 'open', exact: true }).isVisible());
  await page.getByRole('button', { name: 'open', exact: true }).click();
  await page.getByText('Task moved to open.', { exact: true }).waitFor({ timeout: 30_000 });

  await page.goto(`${BASE}/dashboard/automations`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Administrative automations' }).waitFor({ timeout: 30_000 });
  const automationBody = await page.locator('body').innerText();
  check('automation screen exposes allowlist and prohibited effects', automationBody.includes('arbitrary code is never accepted') && automationBody.includes('cannot diagnose or triage') && automationBody.includes('deny access to care'));

  const ruleName = `Browser due rule ${stamp}`;
  const noticeTitle = `Browser due notice ${stamp}`;
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Rule name').fill(ruleName);
  await page.getByLabel('Trigger').selectOption('task.due');
  await page.getByLabel('Allowed field').selectOption('task.priority');
  await page.getByLabel('Value', { exact: true }).fill('urgent');
  await page.getByLabel('Action').selectOption('internal_notification');
  await page.getByLabel('Notice title').fill(noticeTitle);
  await page.getByLabel('Message').fill('Synthetic browser automation notice.');
  await page.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('button', { name: 'Create paused rule', exact: true }).click();
  await page.getByText('Automation rule created in paused state.', { exact: true }).waitFor({ timeout: 30_000 });
  const ruleRow = page.getByRole('button').filter({ hasText: ruleName });
  await ruleRow.waitFor({ timeout: 30_000 });
  await ruleRow.click();
  await page.getByRole('button', { name: 'Activate v1' }).waitFor({ timeout: 30_000 });
  const pausedDetail = await page.locator('body').innerText();
  check('new browser rule is paused with immutable version-one detail', pausedDetail.includes('paused') && pausedDetail.includes('VERSION 1 ACTIONS'));
  await page.getByLabel('Sample task.priority', { exact: true }).fill('urgent');
  await page.getByRole('button', { name: 'Preview v1', exact: true }).click();
  await page.getByText('Preview matched version 1.', { exact: true }).waitFor({ timeout: 30_000 });
  check('browser preview uses the server evaluator without executing effects', (await page.locator('body').innerText()).includes('No records were written.') && (await page.locator('body').innerText()).includes('create one internal notice'));
  await page.getByRole('button', { name: 'Activate v1' }).click();
  await page.getByText('Version 1 is active for new events.', { exact: true }).waitFor({ timeout: 30_000 });
  check('activation is explicit in the browser', (await page.locator('body').innerText()).includes('active v1'));

  const dueAt = new Date(Date.now() - 120_000).toISOString();
  await api('/api/v1/tasks', owner, { method: 'POST', body: JSON.stringify({ title: `Browser urgent due ${stamp}`, priority: 'urgent', dueAt }) });
  for (let index = 0; index < 4; index += 1) {
    await api('/api/v1/scheduler', owner, { method: 'POST', body: JSON.stringify({ action: 'run', job: 'domain-jobs', force: true }) });
  }
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Administrative automations' }).waitFor({ timeout: 30_000 });
  await page.getByText(noticeTitle, { exact: true }).waitFor({ timeout: 30_000 });
  check('durable browser-triggered event surfaces one internal notice', await page.getByText(noticeTitle, { exact: true }).count() === 1 && (await page.locator('body').innerText()).includes('Synthetic browser automation notice.'));
  const reloadedRule = page.getByRole('button').filter({ hasText: ruleName });
  await reloadedRule.click();
  const detailHeading = page.getByRole('heading', { name: ruleName, exact: true });
  await detailHeading.waitFor({ timeout: 30_000 });
  const detailPanel = detailHeading.locator('xpath=ancestor::section[1]');
  await detailPanel.getByText('internal notice created', { exact: true }).first().waitFor({ timeout: 30_000 });
  const runDetail = await detailPanel.innerText();
  check('rule detail exposes completed durable run evidence', runDetail.includes('attempt 1') && runDetail.includes('internal notice created'));
  let noticeCard = page.getByText(noticeTitle, { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  await noticeCard.getByRole('button', { name: 'Mark read', exact: true }).click();
  await page.getByText('Automation notice marked read.', { exact: true }).waitFor({ timeout: 30_000 });
  noticeCard = page.getByText(noticeTitle, { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  const readButton = noticeCard.getByRole('button', { name: 'Mark read', exact: true });
  await readButton.waitFor({ state: 'hidden', timeout: 30_000 });
  check('browser can persist notice read state', await readButton.count() === 0);
  await noticeCard.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByText('Automation notice dismissed. Its audit evidence is retained.', { exact: true }).waitFor({ timeout: 30_000 });
  const dismissedTitle = page.getByText(noticeTitle, { exact: true });
  await dismissedTitle.waitFor({ state: 'hidden', timeout: 30_000 });
  check('browser dismissal removes the active notice without deleting evidence', await dismissedTitle.count() === 0 && (await page.locator('body').innerText()).includes('audit evidence is retained'));

  await page.goto(`${BASE}/dashboard/workflows`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Visual workflows' }).waitFor({ timeout: 30_000 });
  check('unrelated visual call workflow remains intentionally unavailable', (await page.locator('body').innerText()).includes('intentionally unavailable') && (await page.locator('body').innerText()).includes('not executed by the call runtime'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/dashboard/tasks`, { waitUntil: 'networkidle', timeout: 60_000 });
  const taskWidth = await page.locator('body').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('task queue has no horizontal mobile overflow', taskWidth.scroll <= taskWidth.client + 1, `${taskWidth.scroll}/${taskWidth.client}`);
  await page.goto(`${BASE}/dashboard/automations`, { waitUntil: 'networkidle', timeout: 60_000 });
  const automationWidth = await page.locator('body').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  check('automation screen has no horizontal mobile overflow', automationWidth.scroll <= automationWidth.client + 1, `${automationWidth.scroll}/${automationWidth.client}`);
  check('browser walk has no page exceptions or server 500s', errors.length === 0, errors.join(' | '));
  await context.close();
} finally {
  await browser.close();
}

const failed = checks.filter((row) => !row.ok);
console.log(`\n${checks.length - failed.length} passed / ${failed.length} failed`);
if (failed.length) process.exit(1);
