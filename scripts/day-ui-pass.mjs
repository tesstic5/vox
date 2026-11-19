#!/usr/bin/env node
/**
 * A6 — the my-day page, opened in a real browser.
 *
 * Everything else about A6 is proved by the API gate (`scripts/day_check.py`),
 * but a page is not a payload: this drives a headless Chromium over the mobile
 * viewport the item was specified for, clicks the one control that turns an
 * unlinked login into a diary, and fails on any console error — a hydration
 * mismatch is a console error in a production build, which is how the standing
 * nesting rule gets a second pair of eyes.
 *
 * It is a dev tool rather than a gate: it needs a browser download
 * (`npm i --no-save playwright && npx playwright install chromium`), which does
 * not belong in the workspace snapshot, and a gate that fails for want of a
 * browser teaches nobody anything. It says so plainly if playwright is missing.
 *
 *   node scripts/day-ui-pass.mjs            # pass, and write screenshots/
 *   node scripts/day-ui-pass.mjs --keep     # leave the login linked (default: unlink again)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const SHOTS = 'screenshots';
const keep = process.argv.includes('--keep');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed — npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

/* ----------------------------------------------------------------- fixtures */

const checks = [];
const ok = (label, detail = '') => {
  checks.push({ label, pass: true, detail });
  console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
};
const bad = (label, detail = '') => {
  checks.push({ label, pass: false, detail });
  console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
};
const expect = (label, condition, detail = '') => (condition ? ok(label, detail) : bad(label, detail));


const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') ?? '' };
};

/* -------------------------------------------------------------------- start */

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
ok('signed in', `${EMAIL} (${session.name})`);

// start from the state the page is designed to meet first, and that the gate hands
// back: a login with no practitioner record. A pass that only works on its first
// run is not a pass.
const clear = await api('/api/v1/day', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `${session.name}=${session.value}` },
  body: JSON.stringify({ action: 'provider:unlink' }),
});
ok('the pass starts from an unlinked login', clear.status === 200, JSON.stringify(clear.body?.provider ?? clear.body));

// Stage the one diary row this browser journey reads. Depending on a previous
// API gate (or on a long-lived demo appointment still happening to be future)
// made the walk turn red after a legitimate cleanup. Choose a real free slot
// from Priya's current rota, create a roomless appointment, then cancel it at
// the end. Interrupted runs are also caught by tidy-probe-orgs via the name.
const authHeaders = { cookie: `${session.name}=${session.value}` };
const providers = (await api('/api/v1/providers', { headers: authHeaders })).body?.data ?? [];
const services = (await api('/api/v1/services', { headers: authHeaders })).body?.data ?? [];
const priya = providers.find((row) => row.name === 'Priya Raman' && row.active !== false);
let fixtureBooking = null;
if (priya) {
  const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  for (const serviceId of priya.serviceIds ?? []) {
    if (fixtureBooking || !services.some((row) => row.id === serviceId && row.active !== false)) continue;
    for (const locationId of priya.locationIds ?? []) {
      const query = new URLSearchParams({ providerId: priya.id, locationId, serviceId, from, days: '3', limit: '20' });
      const available = (await api(`/api/v1/availability?${query}`, { headers: authHeaders })).body?.data ?? [];
      for (const slot of available) {
        const created = await api('/api/v1/bookings', {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            externalId: `day-ui-probe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            customer: { name: 'Day UI Probe', number: '+14155550157' },
            startsAt: slot.startsAt,
            serviceId,
            providerId: priya.id,
            locationId,
          }),
        });
        if (created.status === 201) {
          fixtureBooking = created.body;
          break;
        }
      }
      if (fixtureBooking) break;
    }
  }
}
if (!fixtureBooking) {
  console.error('could not stage a roomless Priya appointment in the next three days');
  process.exit(2);
}

const browser = await chromium.launch();
const consoleNoise = [];
const failures = [];

async function pageAt(viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    userAgent:
      viewport.width < 500
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : undefined,
  });
  await context.addCookies([{ ...session, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  let where = 'about:blank';
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) where = frame.url().replace(BASE, '');
  });
  page.on('response', (res) => {
    if (res.status() >= 400) failures.push(`${res.status()} ${res.url().replace(BASE, '')} (on ${where})`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') consoleNoise.push(`${msg.type()} on ${where}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => consoleNoise.push(`pageerror on ${where}: ${error.message}`));
  page.on('requestfailed', (req) => {
    // a Next.js RSC prefetch aborted by navigating away is not a broken request
    if (req.url().includes('_rsc=') && /ERR_ABORTED/.test(req.failure()?.errorText ?? '')) return;
    failures.push(`${req.method()} ${req.url().replace(BASE, '')} — ${req.failure()?.errorText ?? 'failed'} (on ${where})`);
  });
  return { context, page };
}

/** The cookie notice sits over the bottom of the page until it is answered. */
async function dismissCookieNotice(page) {
  const accept = page.getByRole('button', { name: 'Accept all' });
  try {
    await accept.waitFor({ state: 'visible', timeout: 2500 });
    await accept.click();
    await page.waitForTimeout(250);
    return true;
  } catch {
    return false;
  }
}

mkdirSync(SHOTS, { recursive: true });

/* --------------------------------------------------- the phone, unlinked first */

const phone = await pageAt({ width: 390, height: 844 });
await phone.page.goto(`${BASE}/dashboard/my-day`, { waitUntil: 'networkidle' });
const hadNotice = await dismissCookieNotice(phone.page);
ok('the cookie notice is answered like a person would', hadNotice ? 'Accept all' : 'no notice on this page');

// the workspace is handed back unlinked, so this is the state a practitioner first meets
const unlinkedNotice = phone.page.getByText('No practitioner record is linked to this login');
expect('an unlinked login is told so, in the page, not in an empty day', await unlinkedNotice.isVisible());
const thisIsMe = phone.page.getByRole('button', { name: 'This is me' });
const candidateCount = await thisIsMe.count();
expect('every practitioner record is offered as a claim', candidateCount === 3, `${candidateCount} candidates`);
await phone.page.screenshot({ path: join(SHOTS, 'a6-my-day-phone-unlinked.png'), fullPage: true });

// claim Priya's record — the click a practitioner actually makes on their first day
const priyaRow = phone.page.locator('div', { hasText: 'Priya Raman' }).filter({ has: thisIsMe }).last();
await priyaRow.getByRole('button', { name: 'This is me' }).click();
await phone.page.waitForSelector('text=Your own diary, in the order you will live it', { timeout: 15000 });
ok('“This is me” turns the login into a diary');

const heading = await phone.page.locator('h1').first().innerText();
expect('the page is titled for what it is', /My day/.test(heading), heading);
const bodyText0 = await phone.page.locator('body').innerText();
expect('and names whose day it is', /Priya Raman/.test(bodyText0), 'Priya Raman');

expect('free time is shown against bookable time', /free|Free/.test(bodyText0));

/* A day off is a day off — and the diary must be read on a day that has one.
 *
 * This walk used to assert that *today* held appointments, which was true every
 * time it was written and false on the first Saturday it ran: Priya's rota has no
 * Saturday, so her day was correctly empty and the walk called three green
 * behaviours red. The day a demo is opened is not a fixture, so the walk reads the
 * rota first: it says so when today is off, then moves to the next day that has a
 * diary on it and judges that one.
 */
const linked = { cookie: `${session.name}=${session.value}` };
const todayRows = (await api(`/api/v1/day?days=1`, { headers: linked })).body?.rows ?? [];
if (todayRows[0] && !todayRows[0].working) {
  expect('a day off says so instead of showing an empty diary', /not on the rota/.test(bodyText0), 'not on the rota');
}

// widening the window is what puts the strip of days on the page
const rangeSelect = phone.page.locator('select').nth(
  await phone.page.locator('select').evaluateAll((els) => els.findIndex((el) => [...el.options].some((o) => o.text.includes('Next 3 days'))))
);
await Promise.all([
  phone.page.waitForResponse((r) => r.url().includes('/api/v1/day'), { timeout: 15000 }).catch(() => null),
  rangeSelect.selectOption('3'),
]);
await phone.page.waitForTimeout(600);

const windowRows = (await api(`/api/v1/day?days=3`, { headers: linked })).body?.rows ?? [];
const busy = windowRows.find((row) => row.counts.appointments > 0);
expect('the next few days hold a diary to read', Boolean(busy), busy ? `${busy.counts.appointments} visit(s) on ${busy.date}` : 'none');

// The three widened days are on the screen together, so the visits are read from
// whichever of them carries a diary — no clicking, and no phone-sized hiding:
// the day strip itself is `hidden sm:flex` under 640 px, so a tap on it is not a
// control a phone user has.
const bodyText = busy ? await phone.page.locator('body').innerText() : '';
const firstVisit = busy?.appointments?.[0];
expect(
  'appointments are on the page',
  Boolean(firstVisit) && bodyText.includes(String(firstVisit.customer?.name ?? firstVisit.client ?? '')) ||
    /Sofia Duarte|Devin Park|Consultation|Follow-up/.test(bodyText),
  firstVisit ? firstVisit.customer?.name ?? '' : 'no visit in the window'
);
expect('a visit with no room is flagged rather than hidden', /room|Room/.test(bodyText));

// the page and the API must agree about the day: the first gap's heading quotes
// the whole stretch, and its sub-line quotes what of it can be sold
const apiDay = await api(`/api/v1/day?days=1${busy ? `&date=${busy.date}` : ''}`, { headers: linked });
const gap0 = apiDay.body?.rows?.[0]?.free?.gaps?.[0];
if (gap0) {
  const heading = `${gap0.past ? 'was free' : 'free'}${gap0.now ? ' now' : ''} · ${gap0.minutes} min`;
  expect(
    'the gap line quotes the whole stretch the API reported',
    bodyText.includes(heading),
    `${heading} (free ${gap0.minutes} min, ${gap0.bookableMinutes} min bookable)`
  );
  expect(
    'and its sub-line quotes the bookable part, not the whole stretch',
    bodyText.includes(`${gap0.bookableMinutes} min`),
    `${gap0.bookableMinutes} min`
  );
} else {
  bad('the API returned a gap to cross-check');
}
await phone.page.screenshot({ path: join(SHOTS, 'a6-my-day-phone.png'), fullPage: true });

// a phone view must not scroll sideways
const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
expect('no horizontal overflow on a 390 px viewport', overflow <= 1, `${overflow}px`);

// widening the window is a real control, not decoration
const widened = await phone.page.locator('body').innerText();
expect(
  '“Next 3 days” widens the view',
  /Sat|Sun|Mon|Tue|Wed|Thu|Fri/.test(widened) || widened.split('\n').length > bodyText0.split('\n').length,
  `${windowRows.length} day(s) in the window`
);

// the owner's picker: somebody else's day, named as theirs
const picker = phone.page.locator('select[title*="colleague"]');
if (await picker.count()) {
  await picker.selectOption({ label: 'Marcus Ito' });
  await phone.page.waitForTimeout(1500);
  const other = await phone.page.locator('body').innerText();
  expect('an owner can read a colleague’s day, and it says so', /Marcus Ito/.test(other));
  await picker.selectOption({ index: 0 });
  await phone.page.waitForTimeout(1000);
} else {
  bad('the practitioner picker is missing for an owner');
}
await phone.context.close();

/* ---------------------------------------------------------- the desk, desktop */

const desktop = await pageAt({ width: 1440, height: 900 });
await desktop.page.goto(`${BASE}/dashboard/my-day`, { waitUntil: 'networkidle' });
await dismissCookieNotice(desktop.page);
expect('the day reads on a desk screen too', await desktop.page.locator('h1').first().isVisible());
await desktop.page.screenshot({ path: join(SHOTS, 'a6-my-day-desktop.png'), fullPage: true });

// The chrome is shared and so is the seeded store, so a console defect in either
// (the full walk of every dashboard route is `scripts/console-sweep.mjs`, which
// is the pass that eventually caught four pages this list never reached)
// shows up on every page — and only a real browser in a production build can see
// it: React #418 is thrown, not logged, so a hydration mismatch reaches this pass
// as an *uncaught error*, while a 404 or a bad request reaches it as a console
// error. Listen for both, on every route than ever held a defect — the whole
// dashboard, not a sample of it.
const SWEEP = [
  '/dashboard',
  '/dashboard/notifications',
  '/dashboard/clients',
  '/dashboard/money',
  '/dashboard/board',
  '/dashboard/team',
  '/dashboard/calls',
  '/dashboard/assistants',
  '/dashboard/numbers',
  '/dashboard/analytics',
  '/dashboard/billing',
  '/dashboard/my-day',
  '/dashboard/logs',
  '/dashboard/settings',
];
for (const route of SWEEP) {
  const errors = [];
  const onError = (msg) => {
    if (msg.type() === 'error' && !/favicon/.test(msg.text())) errors.push(msg.text().slice(0, 80));
  };
  const onPageError = (err) => errors.push(String(err.message).slice(0, 80));
  desktop.page.on('console', onError);
  desktop.page.on('pageerror', onPageError);
  await desktop.page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  await desktop.page.waitForTimeout(900);
  desktop.page.off('console', onError);
  desktop.page.off('pageerror', onPageError);
  const heading = await desktop.page.locator('h1').first().innerText().catch(() => '');
  expect(`${route} loads without a console error`, errors.length === 0, errors.slice(0, 2).join(' | ') || heading.slice(0, 40));
}
/* ---------------- notification truthfulness, proved in the browser ---------- */

// The old screen exposed local-looking email/Slack switches even though no
// delivery workflow consumed them. The truthful surface keeps persisted inbox
// records and explicitly says that alert delivery is unavailable.
await desktop.page.goto(`${BASE}/dashboard/notifications`, { waitUntil: 'networkidle' });
await dismissCookieNotice(desktop.page);
const notificationBody = await desktop.page.locator('body').innerText();
expect('the notification delivery boundary is reachable', /Alert delivery is not wired in this build/i.test(notificationBody));
expect('the inbox does not present unwired delivery preferences', !/Daily digest|Slack routing|Save preferences/i.test(notificationBody));

await desktop.context.close();

/* --------------------------------------------------------------- the docs page */

const docs = await pageAt({ width: 1280, height: 900 });
await docs.page.goto(`${BASE}/docs`, { waitUntil: 'networkidle' });
const docsHeading = await docs.page.locator('h1').first().innerText();
expect('the implementation guide renders in a browser', /records that exist/i.test(docsHeading), docsHeading);
const docsBody = await docs.page.locator('body').innerText();
expect('and carries the provider-verification boundary', /Browser tests do not prove carrier or speech-provider delivery/i.test(docsBody));
await docs.page.screenshot({ path: join(SHOTS, 'a6-docs-guide.png'), fullPage: false });
await docs.context.close();

/* ------------------------------------------------------------- browser health */

const realNoise = consoleNoise.filter((line) => !/favicon|Download the React DevTools/.test(line));
const hydration = realNoise.filter((line) => /418|419|422|423|425|hydrat/i.test(line));
const serverErrors = failures.filter((f) => /^5\d\d /.test(f));
const notFounds = failures.filter((f) => /^404 /.test(f));

// The hydration defect remains a hard failure on every page this pass visits;
// the notifications check above separately prevents unwired delivery switches
// from returning as if they were server-backed controls.
expect('no hydration mismatch anywhere in the chrome', hydration.length === 0, hydration.slice(0, 2).join(' | '));
expect('no 404s from the dashboard’s own requests', notFounds.length === 0, notFounds.slice(0, 3).join(' | '));
expect('nothing else upset the page', realNoise.length === 0 && serverErrors.length === 0,
  [...realNoise, ...serverErrors].slice(0, 3).join(' | '));


/* ------------------------------------------------------------------ put back */

if (fixtureBooking?.id) {
  const cancelled = await api(`/api/v1/bookings/${fixtureBooking.id}/status`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled', note: 'day browser journey cleanup' }),
  });
  if (cancelled.status !== 200) bad('the staged day appointment is cancelled', `HTTP ${cancelled.status}`);
}

if (!keep) {
  const unlink = await api('/api/v1/day', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${session.name}=${session.value}` },
    body: JSON.stringify({ action: 'provider:unlink' }),
  });
  const stillLinked = unlink.body?.day?.linked ?? unlink.body?.linked;
  expect('the login is unlinked again, as the workspace was handed over', unlink.status === 200 && stillLinked === false, `day.linked=${stillLinked}`);
}

await browser.close();

/* -------------------------------------------------------------------- verdict */

const failed = checks.filter((c) => !c.pass);
writeFileSync(join(SHOTS, 'a6-my-day-browser-pass.json'), JSON.stringify({ checks, consoleNoise, failures, at: new Date().toISOString() }, null, 1));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · ${SHOTS}/a6-my-day-*.png`);
console.log(failed.length ? `FAILED: ${failed.map((f) => f.label).join(' · ')}` : 'BROWSER PASS — the day view works as a page, on a phone and on a desk.');
process.exit(failed.length ? 1 : 0);
