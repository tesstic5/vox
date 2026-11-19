/**
 * TOTP unit probe — the RFC 6238 test vectors, run against the real module.
 *
 * The RFC publishes eight-digit codes for the ASCII seed "12345678901234567890"
 * (SHA-1). Voxera displays six digits, so the expected values below are the
 * RFC codes modulo 10^6. If the HMAC, counter encoding, or dynamic truncation
 * drifts, these fail before any authenticator app ever disagrees with us.
 *
 *   npx tsx scripts/totp-vectors.ts
 */
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../lib/server/totp';

const seed = Buffer.from('12345678901234567890', 'ascii');
const vectors: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

let failed = 0;
for (const [seconds, expected] of vectors) {
  const got = totpCode(seed, seconds * 1000);
  const ok = got === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  T=${seconds}s → ${got} (RFC ${expected})`);
}

const roundtrip = base32Decode(base32Encode(seed)).equals(seed);
console.log(`${roundtrip ? 'PASS' : 'FAIL'}  base32 round-trips the seed`);
if (!roundtrip) failed += 1;

const now = Date.now();
const accepts = verifyTotp(seed, totpCode(seed, now), now) && verifyTotp(seed, totpCode(seed, now - 30_000), now);
const rejects = !verifyTotp(seed, '000000', now) && !verifyTotp(seed, '12345', now) && !verifyTotp(seed, totpCode(seed, now - 120_000), now);
console.log(`${accepts ? 'PASS' : 'FAIL'}  current and previous step accepted`);
console.log(`${rejects ? 'PASS' : 'FAIL'}  wrong, short and two-steps-old codes refused`);
if (!accepts || !rejects) failed += 1;

if (failed) {
  console.error(`\n${failed} vector(s) failed`);
  process.exit(1);
}
console.log('\nALL PASS — TOTP matches RFC 6238');
