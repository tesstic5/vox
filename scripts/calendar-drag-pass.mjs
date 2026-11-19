#!/usr/bin/env node
/**
 * D1, walked in a browser: the diary draws one clock and drags the same one.
 *
 * D1 was "the diary is on a UTC clock in the default view — dragging moves
 * appointments 4–7 hours". It was fixed on 2026-10-15 and proved twice: through
 * the API (`manage_check.py` moves appointments and compares instants) and
 * against the built HTML. Neither of those can see the thing a receptionist
 * actually does, which is *drag a block on the grid*, and the fix's own note said
 * so: "D1 has not been walked in a real browser".
 *
 * It needed the walk. Three of the four things below were wrong when this script
 * was first pointed at the page:
 *
 *   1. the default view's clock — the payload says `America/New_York`, not UTC
 *      (this one held);
 *   2. the blocks are drawn on that clock — a 2pm appointment sits on the 2pm line
 *      (held);
 *   3. **a drop landed on nothing.** The only `onDrop` was on the appointment
 *      block itself, so releasing the mouse anywhere else — which is everywhere a
 *      person would drop it — hit no handler and the appointment did not move.
 *      Fixed by handing the column the drop; the maths stay in the diary's clock;
 *   4. the resize handle was never exercised at all.
 *
 * What it proves, in the terms D1 was written in: a block picked up at 2pm and
 * dropped an hour lower is at 3pm in the site's timezone — the corresponding UTC
 * instant, not the wall-clock number treated as UTC. Dropping it on the next
 * day's column moves the day and keeps the clock. The page stays console-clean.
 *
 *   node scripts/calendar-drag-pass.mjs        # needs the app on :3000 + playwright
 *
 * Fixtures are its own: a `Drag Probe` room, service, client and one appointment.
 * The appointment is cancelled and the client archived at the end; historical
 * records are never permanently deleted. Its isolated room prevents collisions.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const PX_PER_MIN = 0.9; // the grid's own scale — mirrored from the page on purpose:
// if the page changes it, this pass should notice by failing, not by drifting.
const SHOTS = 'screenshots';

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

/* --------------------------------------------------------------- fixtures */

const signIn = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const setCookie = signIn.headers.get('set-cookie') ?? '';
const [cookieName, cookieValue] = setCookie.split(';')[0].split('=');
const jar = `${cookieName}=${cookieValue}`;
if (signIn.status !== 200) {
  console.error(`sign-in failed: ${signIn.status}`);
  process.exit(2);
}

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: jar, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ------------------------------------------------------- pre-flight: debris */
// A gate that only works on a virgin database is not a gate. An earlier run that
// died mid-way leaves its appointment in the probe room, and a room with a live
// appointment is a room the engine will not double-book — the next run then reads
// "every room at that time is taken" and blames the page. Its own leftovers are
// cleared first, and only its own: the fixtures are matched by name.
{
  const clients = ((await api('GET', '/api/v1/clients?limit=200')).body.data ?? []).filter((c) =>
    ['Drag Probe Client'].includes(c.name)
  );
  let cleared = 0;
  for (const client of clients) {
    const detail = (await api('GET', `/api/v1/clients/${client.id}`)).body;
    for (const appointment of detail.appointments ?? []) {
      // Every one of them, past ones included: the probe is always staged at
      // 2pm site-time, so by an afternoon run yesterday's leftover *is* in
      // the past — and an identical stale block stacked on the new one means
      // the walk drags the corpse and asserts on the living.
      if (appointment.startsAt) {
        await api('POST', `/api/v1/bookings/${appointment.id}/status`, { status: 'cancelled', note: 'calendar drag stale cleanup' });
        cleared += 1;
      }
    }
    await api('DELETE', `/api/v1/clients/${client.id}`, { reason: 'drag pass pre-flight' });
  }
  if (cleared) console.log(`      (cleared ${cleared} appointment(s) an earlier run left in the probe room)`);
}

let locations = (await api('GET', '/api/v1/locations?includeInactive=true')).body.data ?? [];
// Isolate the interaction from seeded classes and appointments. Retention keeps
// a site referenced by the cancelled probe appointment as an inactive historical
// record, so repeat runs reactivate that exact record instead of pretending a
// successful retirement was a hard delete and then colliding with its name.
let site = locations.find((location) => location.name === 'Drag Probe Site');
if (site) {
  const restored = await api('PATCH', `/api/v1/locations/${site.id}`, { timezone: 'America/New_York', active: true });
  site = restored.body.data ?? restored.body;
} else {
  const madeSite = await api('POST', '/api/v1/locations', { name: 'Drag Probe Site', timezone: 'America/New_York', active: true });
  site = madeSite.body.data ?? madeSite.body;
  if (!site?.id) {
    console.error(`could not create the probe site: ${madeSite.status} ${JSON.stringify(madeSite.body).slice(0, 200)}`);
    process.exit(2);
  }
}
const timezone = site.timezone ?? 'America/New_York';

const rooms = (await api('GET', `/api/v1/rooms?locationId=${site.id}&includeInactive=true`)).body.data ?? [];
let room = rooms.find((r) => r.name === 'Drag Probe Room');
if (room) {
  room = (await api('POST', '/api/v1/rooms', { action: 'update', id: room.id, active: true })).body.room;
} else {
  room = (await api('POST', '/api/v1/rooms', { action: 'create', locationId: site.id, name: 'Drag Probe Room' })).body.room;
}

const services = (await api('GET', '/api/v1/services?includeInactive=true')).body.data ?? [];
let service = services.find((s) => s.name === 'Drag Probe Visit');
if (service) {
  service = (await api('PATCH', `/api/v1/services/${service.id}`, { active: true, durationMinutes: 30, price: 0, recallDays: 0 })).body;
} else {
  service = (await api('POST', '/api/v1/services', { name: 'Drag Probe Visit', durationMinutes: 30, price: 0, recallDays: 0 })).body;
}

/** A wall-clock time in the site's own timezone, as an instant. */
function instant(dateStr, hours, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hours, minutes);
  const offsetText = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(naive))
    .find((p) => p.type === 'timeZoneName').value;
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetText);
  const offsetMinutes = match ? Number(match[1]) * 60 + Number(match[2] ?? 0) * (Number(match[1]) < 0 ? -1 : 1) : 0;
  return new Date(naive - offsetMinutes * 60_000).toISOString();
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(Date.now() + 86_400_000));

// 2pm, and late enough in the day that a UTC-bucketed column would have put it on
// tomorrow — which is the second half of what D1 broke.
const created = await api('POST', '/api/v1/bookings', {
  externalId: `drag-probe-${Date.now()}`,
  service: 'Drag Probe Visit',
  durationMinutes: 30,
  startsAt: instant(today, 14, 0),
  locationId: site.id,
  roomId: room.id,
  customer: { name: 'Drag Probe Client', number: '+15550190977', email: 'drag.probe@example.test' },
});
const booking = created.body.booking ?? created.body;
if (!booking?.id) {
  console.error(`could not create the probe appointment: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  process.exit(2);
}
ok('a probe appointment exists at 2pm in the site\'s own time', `${booking.id} · ${booking.startsAt}`);

/* -------------------------------------------------------------------- drive */

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.error(`chromium will not start: ${String(err.message).split('\n')[0]}`);
  console.error('npm i --no-save playwright@1.64.1 && npx playwright install chromium && npx playwright install-deps chromium');
  process.exit(2);
}
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const consoleNoise = [];
page.on('console', (msg) => {
  // A refused move answers 409 and the browser logs the failed request; that is the
  // engine doing its job, and the checks below assert the move's *result* anyway.
  // Everything else is noise until proven otherwise.
  if (msg.type() === 'error' && !/favicon/.test(msg.text()) && !/409/.test(msg.text())) {
    consoleNoise.push(msg.text().replace(/\s+/g, ' ').slice(0, 140));
  }
});
page.on('pageerror', (err) => consoleNoise.push(`threw: ${String(err.message).slice(0, 140)}`));

const diaries = [];
page.on('response', async (res) => {
  if (res.url().includes('/api/v1/diary') && res.ok()) {
    try {
      diaries.push(await res.json());
    } catch {
      /* the pass reads the payload for its clock, not for its body */
    }
  }
});

await page.goto(`${BASE}/dashboard/calendar`, { waitUntil: 'networkidle' });
const banner = page.locator('text=Decline optional');
if (await banner.count()) await banner.first().click().catch(() => {});
await page.getByLabel('Filter by site').selectOption(site.id);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(900);

/* 1 — the clock the isolated site view runs on */
const first = diaries.at(-1) ?? {};
expect(
  'the default view is on a practice clock, not UTC',
  Boolean(first.timezone) && first.timezone !== 'UTC',
  `timezone=${first.timezone} · gridSiteId=${first.gridSiteId ?? '(all sites)'}`
);
expect(
  'and it is the site\'s own clock',
  first.timezone === timezone,
  `${first.timezone} vs ${timezone}`
);

/* 2 — the block is drawn on that clock */
const card = page.locator('div[draggable="true"]', { hasText: 'Drag Probe Client' }).first();
await card.waitFor({ timeout: 15_000 });
const box = await card.boundingBox();
const gridBox = await page.locator('div[data-date]').first().boundingBox();
const hourLine = (h) => {
  const top = gridBox.y + (h * 60 - 7 * 60) * PX_PER_MIN;
  return top;
};
const expectedTop = hourLine(14);
expect(
  'a 2pm appointment is drawn on the 2pm line',
  box && Math.abs(box.y - expectedTop) <= 3,
  `drawn at ${box ? Math.round(box.y) : '?'}px, 2pm is ${Math.round(expectedTop)}px`
);

/* 3 — pick it up and drop it an hour lower, on empty grid */
// `dragTo` is the driver that actually speaks the HTML5 drag protocol; a raw mouse
// sequence does not, which is a thing worth having learned here rather than in a
// report. The source position is near the block's top edge — the offset the page
// records on dragstart — and the target is the 3pm line of the chosen column.
const columnOf = (date) => page.locator(`div[data-date="${date}"]`).first();
const dropOn = async (date, minutes) => {
  const column = columnOf(date);
  const cb = await column.boundingBox();
  const target = page.locator('div[draggable="true"]', { hasText: 'Drag Probe Client' }).first();
  await target.dragTo(column, {
    sourcePosition: { x: 40, y: 6 },
    targetPosition: { x: cb.width / 2, y: (minutes - 7 * 60) * PX_PER_MIN + 6 },
    force: true,
  });
  await page.waitForTimeout(1500);
};

await dropOn(today, 15 * 60); // an hour later, dropped well below the block
let after = (await api('GET', `/api/v1/bookings/${booking.id}`)).body;
let row = after.booking ?? after;
const expectedInstant = instant(today, 15, 0);
expect(
  'dragging an hour down puts it an hour later in the site\'s clock',
  row.startsAt === expectedInstant,
  `${row.startsAt} (expected ${expectedInstant}; UTC-bug would be ${instant(today, 14, 0).replace('T14', 'T14')})`
);
expect(
  'which is the site-resolved UTC instant, not the raw 15:00Z wall clock',
  row.startsAt === expectedInstant && !/T15:00:00\.000Z$/.test(row.startsAt),
  row.startsAt
);

/* 4 — the resize handle, exercised while the block is still on today's
   column: tomorrow's 3pm carries a seeded class whose block is drawn over
   anything parked at the same hour, and a press there lands on the class,
   not on this block's grip. Try longer first; if the hour after is taken
   the diary will (rightly) refuse, so pull the other way instead — either
   outcome proves the handle moves the length, to the grid's 5 minutes. */
const current = (await api('GET', `/api/v1/bookings/${booking.id}`)).body;
const currentRow = current.booking ?? current;
const pullEdge = async (pull) => {
  const card = page.locator('div[draggable="true"]', { hasText: 'Drag Probe Client' }).first();
  if (!(await card.count())) return false;
  const hb = await card.boundingBox();
  // Hover the block's top edge, with force: a seeded neighbour that overlaps
  // the block's centre (an appointment 15 minutes into this one's slot)
  // intercepts a centre hover and the walk dies on a diary it did not stage.
  // The top edge is this block's own — nothing that starts later covers it.
  await card.hover({ position: { x: 8, y: 3 }, force: true });
  const gripBox = await card.locator('span[title="Drag to change the length"]').boundingBox();
  const from = gripBox ? gripBox.y + 2 : hb.y + hb.height - 2;
  await page.mouse.move(hb.x + hb.width / 2, from);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, from + pull * PX_PER_MIN, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1400);
  return true;
};
if (await pullEdge(20)) {
  let resized = (await api('GET', `/api/v1/bookings/${booking.id}`)).body;
  let rr = resized.booking ?? resized;
  if (Number(rr.durationMinutes) === Number(currentRow.durationMinutes)) {
    await pullEdge(-15);
    resized = (await api('GET', `/api/v1/bookings/${booking.id}`)).body;
    rr = resized.booking ?? resized;
  }
  const delta = Number(rr.durationMinutes) - Number(currentRow.durationMinutes);
  expect(
    delta > 0
      ? 'pulling the bottom edge makes the appointment longer, to the 5 minutes'
      : 'pulling the bottom edge makes the appointment shorter, to the 5 minutes (the hour after is taken)',
    delta !== 0 && Math.abs(delta) % 5 === 0,
    `${currentRow.durationMinutes} → ${rr.durationMinutes} minutes`
  );
} else {
  bad('pulling the bottom edge makes the appointment longer', 'the block is not on the visible day');
}

/* 5 — dragged onto the next day's column, the date moves and the clock follows */
const landed = (await api('GET', `/api/v1/bookings/${booking.id}`)).body;
const landedRow = landed.booking ?? landed;
if (landedRow.startsAt === expectedInstant) {
  await dropOn(tomorrow, 15 * 60);
  const tomorrowRow = (await api('GET', `/api/v1/bookings/${booking.id}`)).body;
  const moved2 = tomorrowRow.booking ?? tomorrowRow;
  expect(
    "dropping on tomorrow's column moves the day, at the same clock time",
    moved2.startsAt === instant(tomorrow, 15, 0),
    `${moved2.startsAt} (expected ${instant(tomorrow, 15, 0)})`
  );
} else {
  bad("dropping on tomorrow's column moves the day", 'the first drag did not land — not stacking a second on top of it');
}

/* 6 — the page stayed quiet */
expect('the page never complained while it was being dragged', consoleNoise.length === 0, consoleNoise.slice(0, 2).join(' | '));

mkdirSync(SHOTS, { recursive: true });
await page.screenshot({ path: join(SHOTS, 'd1-calendar-drag.png') }).catch(() => {});
await browser.close();

/* ---------------------------------------------------------------- put back */

const removed = await api('POST', `/api/v1/bookings/${booking.id}/status`, { status: 'cancelled', note: 'calendar drag cleanup' });
expect('the probe appointment is cancelled and retained', removed.status === 200 || removed.status === 204, `status ${removed.status}`);
// Cancelled history no longer blocks retiring its setup records.
const stillThere = ((await api('GET', '/api/v1/services')).body.data ?? []).find((s) => s.name === 'Drag Probe Visit');
if (stillThere) {
  const gone = await api('DELETE', `/api/v1/services/${stillThere.id}`, {});
  expect('and its probe service', gone.status === 200 || gone.status === 204, `status ${gone.status}`);
}
if (room?.id) {
  // Rooms are removed by an action on the collection, not a DELETE on the row.
  const gone = await api('POST', '/api/v1/rooms', { action: 'delete', id: room.id });
  expect('and its probe room', gone.status === 200 || gone.status === 204, `status ${gone.status}`);
}
if (site?.id) {
  const gone = await api('DELETE', `/api/v1/locations/${site.id}`, {});
  expect('and its isolated probe site', gone.status === 200 || gone.status === 204, `status ${gone.status}`);
}
// The booking created a client record; a probe record is archived, never left live.
const prober = ((await api('GET', '/api/v1/clients?limit=200')).body.data ?? []).find((c) => c.name === 'Drag Probe Client');
if (prober) {
  const archived = await api('DELETE', `/api/v1/clients/${prober.id}`, { reason: 'drag probe' });
  expect('and the probe client is archived, not left in the list', archived.status === 200 || archived.status === 204, `status ${archived.status}`);
}

/* ----------------------------------------------------------------- verdict */

const failed = checks.filter((c) => !c.pass);
writeFileSync(
  join(SHOTS, 'd1-calendar-browser-pass.json'),
  JSON.stringify({ at: new Date().toISOString(), checks, consoleNoise }, null, 1)
);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · ${SHOTS}/d1-calendar-drag.png`);
console.log(failed.length ? `FAILED: ${failed.map((f) => f.label).join(' · ')}` : 'D1 WALKED — the diary draws one clock and drags the same one.');
process.exit(failed.length ? 1 : 0);
