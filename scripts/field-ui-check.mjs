#!/usr/bin/env node
/**
 * Focused real-browser gate for the contractor workspace.
 *
 * Covers all four field-service routes at desktop and narrow mobile widths,
 * then exercises the two creation dialogs without writing data. It fails on
 * runtime/hydration/network errors, page overflow, unnamed controls, duplicate
 * IDs, undersized interactive targets, broken field navigation, missing focus
 * indication, or a dialog that does not trap/restore keyboard focus.
 *
 * Requires a production server and Playwright:
 *   VOXERA_BASE=http://127.0.0.1:3000 node scripts/field-ui-check.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const ROUTES = [
  ['/dashboard/enquiries', 'Contractor enquiries'],
  ['/dashboard/estimates', 'Estimates'],
  ['/dashboard/jobs', 'Jobs'],
  ['/dashboard/dispatch', 'Dispatch'],
];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed — npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

const signIn = await api('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (signIn.response.status !== 200) {
  console.error(`sign-in failed: ${signIn.response.status} ${JSON.stringify(signIn.body)}`);
  process.exit(2);
}
const cookieParts = (signIn.response.headers.get('set-cookie') ?? '').split(';')[0].split('=');
const session = { name: cookieParts[0], value: cookieParts.slice(1).join('=') };
if (!session.name || !session.value) {
  console.error('sign-in did not return a session cookie');
  process.exit(2);
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 220);
}

async function auditDom(page, expectedHeading) {
  return page.evaluate((heading) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nameOf = (element) => {
      const aria = element.getAttribute('aria-label');
      if (aria?.trim()) return aria.trim();
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (value) return value;
      }
      if ('labels' in element && element.labels?.length) {
        const value = [...element.labels].map((label) => label.textContent ?? '').join(' ').trim();
        if (value) return value;
      }
      const text = element.textContent?.trim();
      if (text) return text;
      const title = element.getAttribute('title');
      if (title?.trim()) return title.trim();
      const placeholder = element.getAttribute('placeholder');
      return placeholder?.trim() ?? '';
    };

    const issues = [];
    const h1s = [...document.querySelectorAll('main h1')].filter(visible);
    if (h1s.length !== 1) issues.push(`expected one visible h1, found ${h1s.length}`);
    else if (h1s[0].textContent?.trim() !== heading) issues.push(`h1 was "${h1s[0].textContent?.trim()}"`);
    if (!document.querySelector('main')) issues.push('main landmark missing');
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      issues.push(`page overflow ${document.documentElement.scrollWidth}px > ${document.documentElement.clientWidth}px`);
    }

    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id).filter(Boolean);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length) issues.push(`duplicate ids: ${duplicates.slice(0, 5).join(', ')}`);

    const controls = [...document.querySelectorAll('main a[href], main button, main input:not([type="hidden"]), main select, main textarea')].filter(visible);
    const unnamed = controls.filter((element) => !nameOf(element)).map((element) => element.outerHTML.slice(0, 100));
    if (unnamed.length) issues.push(`${unnamed.length} unnamed controls: ${unnamed.slice(0, 3).join(' | ')}`);

    const smallTargets = controls.filter((element) => {
      if (element.matches('input, select, textarea')) return false;
      // WCAG 2.5.8 exempts links constrained by a line of text. Breadcrumb
      // links are inline prose navigation; buttons and standalone links are not.
      if (element.matches('a') && element.closest('nav[aria-label="Breadcrumb"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width < 24 || rect.height < 24;
    }).map((element) => `${nameOf(element)} (${Math.round(element.getBoundingClientRect().width)}×${Math.round(element.getBoundingClientRect().height)})`);
    if (smallTargets.length) issues.push(`targets below 24px: ${smallTargets.slice(0, 5).join(', ')}`);

    const imagesWithoutAlt = [...document.querySelectorAll('main img')].filter((image) => !image.hasAttribute('alt'));
    if (imagesWithoutAlt.length) issues.push(`${imagesWithoutAlt.length} images have no alt attribute`);

    const fieldNav = document.querySelector('nav[aria-label="Field service"]');
    if (!fieldNav) issues.push('field-service navigation landmark missing');
    else if (fieldNav.querySelectorAll('a').length !== 4) issues.push('field-service navigation does not have four links');

    return { issues, controls: controls.length, width: document.documentElement.clientWidth };
  }, expectedHeading);
}

async function keyboardNavCheck(page) {
  const links = page.locator('nav[aria-label="Field service"] a');
  if (await links.count() !== 4) return ['field navigation link count changed'];
  await links.first().focus();
  await page.keyboard.press('Tab');
  const state = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const style = getComputedStyle(active);
    return {
      text: active.textContent?.trim() ?? '',
      focusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  const issues = [];
  if (state?.text !== 'Estimates') issues.push(`Tab from first field link reached "${state?.text ?? 'nothing'}"`);
  if (!state?.focusVisible) issues.push('keyboard focus did not match :focus-visible');
  const hasOutline = state && state.outlineStyle !== 'none' && Number.parseFloat(state.outlineWidth) >= 2;
  const hasShadow = state && state.boxShadow !== 'none';
  if (!hasOutline && !hasShadow) issues.push('keyboard focus has no visible outline or ring');
  return issues;
}

async function dialogCheck(page, openerName, dialogName) {
  const issues = [];
  const opener = page.getByRole('button', { name: openerName }).first();
  if (!(await opener.isVisible())) return [`${openerName} opener is not visible`];
  await opener.click();
  const dialog = page.getByRole('dialog', { name: dialogName });
  try {
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    // Modal focus moves on a zero-delay timer after the committed render.
    await page.waitForTimeout(50);
  } catch {
    return [`${dialogName} dialog did not open`];
  }

  const state = await dialog.evaluate((element) => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = [...element.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible);
    const unnamed = controls.filter((control) => {
      if (control.getAttribute('aria-label')?.trim()) return false;
      const ids = control.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
      if (ids.some((id) => document.getElementById(id)?.textContent?.trim())) return false;
      return !('labels' in control) || !control.labels?.length;
    });
    return {
      described: Boolean(element.getAttribute('aria-describedby')),
      formControls: controls.length,
      unnamed: unnamed.length,
      activeName: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '',
    };
  });
  if (!state.described) issues.push('dialog description is not programmatically associated');
  if (!state.formControls) issues.push('dialog has no form controls');
  if (state.unnamed) issues.push(`${state.unnamed} dialog form controls have no accessible name`);
  if (state.activeName !== 'Close') issues.push(`initial dialog focus was "${compact(state.activeName)}", not Close`);

  const focusables = dialog.locator('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  const count = await focusables.count();
  if (count > 1) {
    await focusables.last().focus();
    await page.keyboard.press('Tab');
    if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) issues.push('Tab escaped the dialog from its last control');
    await focusables.first().focus();
    await page.keyboard.press('Shift+Tab');
    if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) issues.push('Shift+Tab escaped the dialog from its first control');
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  if (await dialog.isVisible().catch(() => false)) issues.push('Escape did not close the dialog');
  const restored = await opener.evaluate((element) => document.activeElement === element);
  if (!restored) issues.push('dialog did not restore focus to its opener');
  return issues;
}

const browser = await chromium.launch();
const checks = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  await context.addCookies([{ name: session.name, value: session.value, domain: '127.0.0.1', path: '/' }]);

  for (const [route, heading] of ROUTES) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !/favicon/.test(message.text())) errors.push(`console: ${compact(message.text())}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${compact(error.message)}`));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'failed';
      // Next cancels speculative RSC link prefetches once their cache entry is
      // no longer needed. That is deliberate browser work, not a page failure.
      if (reason === 'net::ERR_ABORTED' && request.url().includes('_rsc=')) return;
      errors.push(`request: ${request.url()} — ${reason}`);
    });

    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(500);
      const consent = page.getByRole('button', { name: 'Decline optional' });
      if (await consent.isVisible().catch(() => false)) await consent.click();

      const dom = await auditDom(page, heading);
      errors.push(...dom.issues);
      errors.push(...await keyboardNavCheck(page));
      if (route === '/dashboard/enquiries') errors.push(...await dialogCheck(page, 'New enquiry', 'New contractor enquiry'));
      if (route === '/dashboard/jobs') errors.push(...await dialogCheck(page, 'New direct job', 'New direct job'));
    } catch (error) {
      errors.push(`runner: ${compact(error instanceof Error ? error.message : error)}`);
    }

    const unique = [...new Set(errors)];
    checks.push({ viewport: viewport.name, route, pass: unique.length === 0, errors: unique });
    console.log(`${unique.length ? 'FAIL' : 'PASS'}  ${viewport.name.padEnd(7)} ${route}${unique.length ? ` — ${unique.slice(0, 2).join(' | ')}` : ''}`);
    await page.close();
  }
  await context.close();
}

await browser.close();
const failed = checks.filter((check) => !check.pass);
mkdirSync('screenshots', { recursive: true });
writeFileSync('screenshots/field-ui-check.json', JSON.stringify({ at: new Date().toISOString(), base: BASE, checks }, null, 2));
console.log(`\n${checks.length - failed.length}/${checks.length} contractor viewport checks passed · screenshots/field-ui-check.json`);
console.log(failed.length ? `FAILED: ${failed.map((check) => `${check.viewport}:${check.route}`).join(' · ')}` : 'FIELD UI — desktop, mobile, accessibility, keyboard and hydration checks are clean.');
process.exit(failed.length ? 1 : 0);
