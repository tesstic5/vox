/**
 * MFA browser probe — enrol and sign in through the real UI.
 *
 * Creates a fresh account over the API, pairs an authenticator through the
 * Security page (reading the secret off the screen and computing the code
 * locally, exactly as an authenticator app would), saves the recovery codes,
 * signs out, and signs back in through the login page's code step.
 *
 *   node scripts/mfa-probe.mjs
 */
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:3000';
const stamp = Date.now();
const email = `mfaprobe.${stamp}@example.com`;
const password = 'probe-password-2026';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secretB32) {
  const clean = secretB32.replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = digest[digest.length - 1] & 0xf;
  const binary = ((digest[o] & 0x7f) << 24) | (digest[o + 1] << 16) | (digest[o + 2] << 8) | digest[o + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const signup = await fetch(`${BASE}/api/auth/signup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, name: 'MFA Probe', orgName: `MFA Probe ${stamp}` }),
});
if (!signup.ok) { console.error('signup failed', signup.status); process.exit(2); }
const cookieHeader = signup.headers.get('set-cookie').split(';')[0];
const [cookieName, cookieValue] = cookieHeader.split('=');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await context.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
// A 401 while signed out (and the favicon) is the app answering honestly,
// not an error — the same exemption the other walks make for their 409s.
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|401/.test(m.text())) errors.push(m.text()); });

/* enrol through the Security page */
await page.goto(`${BASE}/dashboard/settings/security`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Set up/ }).first().click();
await page.getByText('Pair an authenticator, then confirm').waitFor({ timeout: 15000 });
await page.waitForFunction(() => /([A-Z2-7]{4} ){3}[A-Z2-7]{4}/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
const bodyText = await page.locator('body').innerText();
const secretMatch = bodyText.replace(/\s+/g, ' ').match(/([A-Z2-7]{4} ){5,}[A-Z2-7]{2,4}/);
check('enrolment shows a real secret', Boolean(secretMatch), secretMatch ? secretMatch[0].slice(0, 14) + '…' : 'none found');
const secret = secretMatch[0].replace(/\s/g, '');
await page.getByPlaceholder('000000').fill(totp(secret));
await page.getByRole('button', { name: /Enable two-factor/ }).click();
await page.getByText('Recovery codes — save them now').waitFor({ timeout: 15000 });
check('recovery codes are shown after confirming', true);
await page.screenshot({ path: 'screenshots/security-2fa-on.png' });
await page.getByRole('button', { name: /I have saved them/ }).click();
await page.getByText('Two-factor authentication is on').waitFor({ timeout: 15000 });
check('security page reports the factor on', true);

/* sign out, then in again — the code step must appear */
await context.clearCookies();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.locator('input[type="email"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.getByRole('button', { name: /^Sign in/ }).click();
await page.getByText('Password accepted.').waitFor({ timeout: 15000 });
check('login stops at the code step after the password', true);
await page.getByPlaceholder('000000').fill(totp(secret));
await page.getByRole('button', { name: /Verify and sign in/ }).click();
await page.waitForURL(/\/dashboard/, { timeout: 20000 });
check('the right code lands on the dashboard', true, page.url());
await page.screenshot({ path: 'screenshots/mfa-login-done.png' });

check('no page errors throughout', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nMFA PROBE — ALL PASS');
