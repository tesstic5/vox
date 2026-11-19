/**
 * The classes browser pass (A8).
 *
 * A gate that only speaks HTTP proves the rules; it cannot prove that anybody can
 * *see* them. This walks the two screens a person actually uses — the desk's class
 * page and the public booking page's class list — in a real browser, and fails on
 * any console error, any uncaught exception, and any claim on screen that the API
 * does not back.
 *
 * The pass **stages its own class** every time — a service, an instructor linked to
 * it, a session two days out and two people in it — says so in its output, and
 * takes it away again in a `finally`. It never borrows a session the workspace
 * already had: a browser test that marks real demo clients arrived and done is a
 * test editing the thing it is supposed to observe. What a staged run leaves
 * behind is what the product leaves behind when a class is called off — a
 * cancelled session with its cancelled seats — and `scripts/tidy-probe-orgs.ts`
 * sweeps those once the service is gone, by its orphan-session rule.
 *
 *     node scripts/class-ui-pass.mjs          # app up, repo cwd, playwright installed
 *
 * Env: VOXERA_BASE (default http://127.0.0.1:3000), VOXERA_SLUG (northwind-labs),
 * VOXERA_EMAIL / VOXERA_PASSWORD for the desk login.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const SLUG = process.env.VOXERA_SLUG ?? 'northwind-labs';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';

let passes = 0;
const failures = [];
/** The fixture this pass staged, when it had to stage one, so it can sweep it. */
let unstageLater = null;

const check = (label, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return ok;
};

/* ------------------------------------------------------------------ session */

/** The cookie notice sits over the bottom of the page until it is answered. */
async function answerCookieNotice(page) {
  const accept = page.getByRole('button', { name: 'Accept all' });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click().catch(() => {});
    await page.waitForTimeout(150);
  }
}

async function signIn(page) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
}

/** The class the pass will look for, taken from the API so page and payload agree. */
async function fixture(page) {
  /**
   * Always its own class, never the workspace's.
   *
   * This used to borrow any upcoming session it found, which meant a run against
   * the demo marked real demo clients as arrived and done — a browser test that
   * edits the thing it is testing. Staging every time keeps the pass honest and
   * its side effects inside its own `finally`.
   */
  // Stage one: a class service, an instructor who runs it, and a session far
  // enough out to be comfortably in the future and inside the diary's range.
  console.log('      (staging a class of its own for this pass)');
  const stamp = Date.now().toString().slice(-6);
  const name = `Probe Class UI ${stamp}`;
  const site = ((await (await page.request.get(`${BASE}/api/v1/locations`)).json()).data ?? []).find((l) => (l.name ?? '').includes('Northwind East'));
  const instructors = ((await (await page.request.get(`${BASE}/api/v1/providers`)).json()).data ?? []).filter((p) => (p.locationIds ?? []).includes(site.id));
  const instructor = instructors[0];
  const service = await (await page.request.post(`${BASE}/api/v1/services`, { data: { name, durationMinutes: 60, price: 10 } })).json();
  const serviceId = service.id ?? service.service?.id;
  const before = instructor.serviceIds ?? [];
  await page.request.patch(`${BASE}/api/v1/providers/${instructor.id}`, { data: { serviceIds: [...before, serviceId] } });

  let created = null;
  for (const offset of [2, 3, 4, 5, 9, 10, 11]) {
    const date = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const staged = await page.request.post(`${BASE}/api/v1/classes`, {
      data: { action: 'create', serviceId, providerId: instructor.id, locationId: site.id, date, time: '11:00', capacity: 8, notes: 'staged by the UI pass' },
    });
    const body = await staged.json().catch(() => ({}));
    if (staged.ok() && (body.sessions ?? [])[0]) { created = (body.sessions ?? [])[0]; break; }
  }
  if (!created) return { session: null, staged: null };

  /**
   * A second class, small enough to fill, so the queue has something to be for.
   *
   * It is staged through the product's own calls like the first one: two seats
   * taken by two people, which is what makes it full, and what the public page
   * then has to say out loud.
   */
  let full = null;
  for (const offset of [6, 7, 8, 13, 14, 15]) {
    const date = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const staged = await page.request.post(`${BASE}/api/v1/classes`, {
      data: { action: 'create', serviceId, providerId: instructor.id, locationId: site.id, date, time: '15:00', capacity: 2, notes: 'staged by the UI pass — the queue' },
    });
    const body = await staged.json().catch(() => ({}));
    if (staged.ok() && (body.sessions ?? [])[0]) { full = (body.sessions ?? [])[0]; break; }
  }
  if (full) {
    for (const [i, number] of ['+15550190731', '+15550190732'].entries()) {
      await page.request.post(`${BASE}/api/v1/classes/${full.id}`, {
        data: { action: 'add-seat', name: `Probe Class UI Filler ${i + 1}`, number },
      });
    }
    const filled = ((await (await page.request.get(`${BASE}/api/v1/classes`)).json()).sessions ?? []).find((s) => s.id === full.id);
    if (filled) full = filled;
  }
  // Two people in it, so the block on the grid and the roster show a real count.
  for (const [i, number] of ['+15550190721', '+15550190722'].entries()) {
    await page.request.post(`${BASE}/api/public/workspaces/${SLUG}/booking`, {
      data: { sessionId: created.id, name: `Probe Class UI Guest ${i + 1}`, number, consentSms: true },
    });
  }
  const fresh = ((await (await page.request.get(`${BASE}/api/v1/classes`)).json()).sessions ?? []).find((s) => s.id === created.id) ?? created;
  return {
    session: fresh,
    full,
    staged: {
      sessionId: created.id,
      fullSessionId: full?.id,
      serviceId,
      instructorId: instructor.id,
      before,
    },
  };
}

/** Take a staged fixture away again: cancel the session, unlink and delete the service. */
async function unstage(page, staged) {
  if (!staged) return;
  await page.request.post(`${BASE}/api/v1/classes`, { data: { action: 'cancel', sessionId: staged.sessionId, reason: 'staged by the UI pass' } });
  if (staged.fullSessionId) {
    await page.request.post(`${BASE}/api/v1/classes`, { data: { action: 'cancel', sessionId: staged.fullSessionId, reason: 'staged by the UI pass' } });
  }
  await page.request.patch(`${BASE}/api/v1/providers/${staged.instructorId}`, { data: { serviceIds: staged.before } });
  await page.request.delete(`${BASE}/api/v1/services/${staged.serviceId}`);
  console.log('      (the staged class has been cancelled and swept away)');
}

/* --------------------------------------------------------------------- main */

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const noise = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/favicon/.test(msg.text())) noise.push(msg.text().replace(/\s+/g, ' ').slice(0, 160));
});
page.on('pageerror', (err) => noise.push(`pageerror: ${String(err).slice(0, 160)}`));

try {
  await signIn(page);
  const { session, full, staged } = await fixture(page);
  unstageLater = staged;
  if (!session) {
    console.log('no class could be staged for this pass — check the workspace has a site with a practitioner');
    await browser.close();
    process.exit(1);
  }

  /* --- 1. the desk's class page ------------------------------------------- */
  await page.goto(`${BASE}/dashboard/classes`, { waitUntil: 'networkidle' });
  await answerCookieNotice(page);
  await page.waitForSelector('text=Classes', { timeout: 20000 });
  const listed = await page.locator(`text=${session.serviceName}`).first().isVisible().catch(() => false);
  check('the desk sees the class on its own page', listed, session.serviceName);

  const countText = await page.locator(`text=/${session.seats}\\/${session.capacity}/`).first().textContent().catch(() => '');
  check('with its places counted', /\d+\/\d+/.test(countText ?? ''), (countText ?? '').trim());

  const rowClickable = await page.locator('button', { hasText: session.serviceName }).first().isVisible().catch(() => false);
  check('and a roster to open', rowClickable);

  // the roster modal, from the list
  if (rowClickable) {
    await page.locator('button', { hasText: session.serviceName }).first().click();
    // Wait for the section itself, not just the modal shell: the roster
    // renders after its data lands, so an instant isVisible() check races
    // the fetch and fails intermittently under load (seen in a full-suite
    // run that passed standalone). Waiting is the honest version of the
    // same assertion.
    const rosterHeading = await page
      .waitForSelector('text=Add somebody', { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check('the roster opens with a way to add somebody', rosterHeading);
    const seatsShown = await page.locator('text=/place\\(s\\) left/').first().isVisible().catch(() => false);
    check('and says how many places are left', seatsShown);

    /* the register: two people are booked into the staged class, nobody is here */
    const hereText = async () => (await page.locator('text=/\\d+ of \\d+ here/').first().textContent().catch(() => '')) ?? '';
    const before = (await hereText()).trim();
    check('the roster counts who is here — nobody, before anyone arrives', /^0 of \d+ here/.test(before), before || 'no count on screen');

    const everyone = page.locator('button', { hasText: "Everyone's here" }).first();
    if (await everyone.isVisible().catch(() => false)) {
      await everyone.click();
      await page.waitForFunction(() => /\d+ of \d+ here/.test(document.body.innerText) && !/still to arrive/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    }
    const after = (await hereText()).trim();
    check('one tap says the room has arrived', /\d+ of \d+ here/.test(after) && !/^0 of/.test(after), after || 'no count on screen');

    const done = page.locator('button', { hasText: /^Done$/ }).first();
    if (await done.isVisible().catch(() => false)) {
      await done.click();
      await page.waitForFunction(() => /\\d+ done/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    }
    const marked = (await hereText()).trim();
    check('and a place can be marked done, on the spot', /done/.test(marked), marked || 'no count on screen');

    await page.keyboard.press('Escape').catch(() => {});
  }

  /* --- 2. the diary draws it as one block --------------------------------- */
  const date = session.local.date;
  await page.goto(`${BASE}/dashboard/calendar`, { waitUntil: 'networkidle' });
  await answerCookieNotice(page);
  await page.waitForTimeout(900);
  /**
   * The diary opens on today and the class is days away, so the grid is stepped
   * forward until the day is on screen — the way a person finds it. The calendar
   * takes no date parameter; assuming one would be this driver asserting its own
   * invention rather than the page.
   */
  const forward = page.getByRole('button', { name: /^(Next|Forward|›|>)$/i }).first();
  for (let step = 0; step < 8; step += 1) {
    if ((await page.locator(`div[data-date="${date}"]`).count()) > 0) break;
    if (!(await forward.isVisible().catch(() => false))) break;
    await forward.click();
    await page.waitForTimeout(650);
  }
  check('the day the class is on can be reached on the grid', (await page.locator(`div[data-date="${date}"]`).count()) > 0, date);
  const block = page.locator(`a[href="/dashboard/classes?session=${session.id}"]`).first();
  const blockCount = await page.locator(`a[href="/dashboard/classes?session=${session.id}"]`).count();
  check('the diary draws the class once', blockCount === 1, `${blockCount} block(s)`);
  const badge = (await block.textContent().catch(() => '')) ?? '';
  check('the block says it is a class, with its count', /class/i.test(badge) && /\d+\/\d+/.test(badge), badge.replace(/\s+/g, ' ').trim().slice(0, 60));

  /* --- 3. the public booking page ----------------------------------------- */
  const anon = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const publicPage = await anon.newPage();
  const publicNoise = [];
  publicPage.on('console', (msg) => {
    if (msg.type() === 'error' && !/favicon/.test(msg.text())) publicNoise.push(msg.text().slice(0, 140));
  });
  publicPage.on('pageerror', (err) => publicNoise.push(`pageerror: ${String(err).slice(0, 140)}`));

  await publicPage.goto(`${BASE}/book/${SLUG}`, { waitUntil: 'networkidle' });
  await answerCookieNotice(publicPage);
  await publicPage.waitForSelector('text=What do you need?', { timeout: 20000 });
  const classesHeading = await publicPage.locator('text=Classes you can join').first().isVisible().catch(() => false);
  check('the public page offers classes, not just times', classesHeading);
  /**
   * Scoped to the class section on purpose: this class is *also* in the service
   * list above (it is a bookable service), so a bare text match clicks the wrong
   * card — and then "it did not book" is the driver's fault, not the page's.
   */
  const classSection = publicPage.locator('section', { has: publicPage.getByRole('heading', { name: 'Classes you can join' }) }).first();
  const card = classSection.locator('div', { hasText: session.serviceName }).filter({ hasText: session.local.start }).last();
  check('the fixture class is offered with its time', await card.isVisible().catch(() => false), `${session.serviceName} ${session.local.start}`);
  const placesLeft = (await card.locator('text=/place/').first().textContent().catch(() => '')) ?? '';
  check('with the places left said out loud', /place/.test(placesLeft), placesLeft.trim());

  // and a stranger can actually take one
  if (await card.isVisible().catch(() => false)) {
    await card.getByRole('button', { name: 'Take a place' }).first().click();
    await card.locator('input[placeholder="Your name"]').fill('Probe Class Browser');
    await card.locator('input[placeholder="Mobile number"]').fill('+15550190777');
    await card.getByRole('button', { name: 'Take a place' }).first().click();
    const booked = await publicPage
      .locator('text=/Place booked|You were already in/')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('a stranger can take a place from the page', booked);
    // The receipt must name the class and the time — and a second run of this
    // pass is a normal thing, so "you were already in" is a pass, not a failure.
    const receipt = (await publicPage.locator('text=/Place booked|You were already in/').first().locator('xpath=ancestor::section[1]').textContent().catch(() => '')) ?? '';
    check(
      'and the receipt names the class and the time',
      receipt.includes(session.serviceName) && receipt.includes(session.local.start),
      receipt.replace(/\s+/g, ' ').trim().slice(0, 90),
    );
  }

  /* --- 4. a full class, and the line for a place ------------------------- */

  if (full) {
    // The card for the full class, found by the class's own name and time.
    await publicPage.goto(`${BASE}/book/${SLUG}`, { waitUntil: 'networkidle' });
    await answerCookieNotice(publicPage);
    await publicPage.waitForSelector('text=Classes you can join', { timeout: 20000 });
    const fullSection = publicPage.locator('section', { has: publicPage.getByRole('heading', { name: 'Classes you can join' }) }).first();
    const fullCard = fullSection.locator('div', { hasText: full.serviceName }).filter({ hasText: full.local.start }).last();
    const fullCardText = (await fullCard.textContent().catch(() => '')) ?? '';
    check(
      'a full class is offered as a queue, not hidden',
      /Full — join the wait list/.test(fullCardText),
      fullCardText.replace(/\s+/g, ' ').trim().slice(0, 80),
    );

    if (/Full — join the wait list/.test(fullCardText)) {
      await fullCard.getByRole('button', { name: 'Join the wait list' }).first().click();
      await fullCard.locator('input[placeholder="Your name"]').fill('Probe Class Browser Wait');
      await fullCard.locator('input[placeholder="Mobile number"]').fill('+15550190778');
      await fullCard.getByRole('button', { name: 'Join the wait list' }).first().click();
      const queued = await publicPage
        .locator('text=/You are in line|You were already in line/')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      check('and a stranger can join the line from it', queued);
      const lineText = (await publicPage.locator('text=/You are in line|You were already in line/').first().locator('xpath=ancestor::section[1]').textContent().catch(() => '')) ?? '';
      check(
        'the page says where they are in line, and for which class',
        /first in line|nd in line|rd in line|th in line/.test(lineText) && lineText.includes(full.serviceName),
        lineText.replace(/\s+/g, ' ').trim().slice(0, 100),
      );
    }

    // The desk's own view of the same queue, then a place given back.
    await page.goto(`${BASE}/dashboard/classes`, { waitUntil: 'networkidle' });
    // Both staged classes run the same service, so the name alone opens the wrong
    // roster — the time is what tells them apart on the list.
    await page
      .locator('button')
      .filter({ hasText: full.serviceName })
      .filter({ hasText: full.local.start })
      .first()
      .click();
    await page.waitForSelector('text=Waiting for a place', { timeout: 15000 });
    // The roster is a dialog over the page; the whole of it is the honest read,
    // because the count and the name live in different rows of one panel.
    const queueText = (await page.locator('body').innerText().catch(() => '')) ?? '';
    check(
      'the desk sees who is in line',
      /1 in line/.test(queueText) && /Probe Class Browser Wait/.test(queueText),
      queueText.replace(/\s+/g, ' ').trim().slice(0, 100),
    );

    await page.getByRole('button', { name: 'Give place back' }).first().click();
    const offered = await page
      .locator('text=/offered/')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('a place given back is offered to the person in line', offered);
  }

  check('the desk pages never complained', noise.length === 0, noise.slice(0, 2).join(' | '));
  check('nor did the public page', publicNoise.length === 0, publicNoise.slice(0, 2).join(' | '));

  await page.screenshot({ path: 'screenshots/classes-desk.png', fullPage: false });
  await publicPage.screenshot({ path: 'screenshots/classes-public.png', fullPage: false });
} finally {
  await unstage(page, unstageLater).catch(() => {});
  await browser.close();
}

fs.writeFileSync(
  'screenshots/class-ui-pass.json',
  JSON.stringify({ passes, failures, at: new Date().toISOString() }, null, 2)
);

console.log();
if (failures.length) {
  console.log(`${passes} passed, ${failures.length} FAILED: ${failures.join(' · ')}`);
  process.exit(1);
}
console.log(`${passes} checks passed · screenshots/classes-desk.png · screenshots/classes-public.png`);
console.log('CLASSES WALKED — the desk and the public page both show what the API holds.');
