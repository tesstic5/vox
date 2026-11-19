/**
 * Secret storage.
 *
 * Two things in the platform hold credentials that must never come back out of
 * an API read: carrier accounts (telephony) and AI provider keys (models). Both
 * are encrypted with AES-256-GCM here, and both are handed to callers already
 * masked.
 *
 * The key comes from `VOXERA_SECRET_KEY` when the deployment sets one — which is
 * what you want in production, because it survives redeploys — otherwise a key
 * file is generated in `data/` so secrets are never written in clear.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths';

const KEY_FILE = () => dataPath('.voxera-key');

let cachedKey: Buffer | undefined;

function secretKey(): Buffer {
  const fromEnv = process.env.VOXERA_SECRET_KEY;
  if (fromEnv) {
    // Any length is acceptable: hash it to exactly 32 bytes.
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  if (cachedKey) return cachedKey;
  try {
    const file = KEY_FILE();
    if (fs.existsSync(file)) {
      /**
       * Tighten an inherited key file.
       *
       * The file is written 0600, but one that arrived with a volume restore, a
       * `cp -a`, or an older build can be world-readable — and this is the key
       * that decrypts every stored carrier and provider credential. Fixing the
       * mode on read costs one syscall and closes a hole that would otherwise
       * survive forever on a deployed box.
       */
      try {
        if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      } catch {
        /* read-only mount: nothing to do, and the key still loads */
      }
      cachedKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
      return cachedKey;
    }
    const generated = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated.toString('hex'), { mode: 0o600 });
    cachedKey = generated;
    return cachedKey;
  } catch (error) {
    /**
     * Read-only filesystem and no `VOXERA_SECRET_KEY`.
     *
     * The old fallback derived the key from the literal `'voxera-ephemeral'`, so
     * every deployment in that state shared one publicly known encryption key —
     * worse than losing the credentials, because it did not look like losing them.
     * Outside development the key is now random per process: stored credentials
     * become unreadable after a restart (and must be re-entered), which is loud,
     * immediate, and fixable by setting the env var the docs already ask for.
     */
    console.error(
      '[secrets] no VOXERA_SECRET_KEY and the key file is not writable — ' +
        (process.env.NODE_ENV === 'production'
          ? 'using a per-process key; stored carrier and model credentials will not survive a restart'
          : 'using an ephemeral key'),
      error instanceof Error ? error.message : error
    );
    cachedKey =
      process.env.NODE_ENV === 'production'
        ? crypto.randomBytes(32)
        : crypto.createHash('sha256').update('voxera-ephemeral').digest();
    return cachedKey;
  }
}

export type Sealed = { encrypted: string; iv: string; authTag: string };

export function sealSecret(plaintext: string): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function openSecret(doc: Sealed): string | undefined {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(doc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(doc.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(doc.encrypted, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** `sk-ant-…4f2a` → `sk-a••••4f2a`. What a dashboard may show. */
export function maskSecret(secret: string) {
  if (secret.length <= 10) return '••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
