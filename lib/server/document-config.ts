import crypto from 'node:crypto';

export function documentMasterKey(): Buffer {
  const raw = process.env.VOXERA_DOCUMENT_MASTER_KEY?.trim() ?? '';
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      key = Buffer.alloc(0);
    }
  }
  if (key.length !== 32) throw new Error('VOXERA_DOCUMENT_MASTER_KEY must be exactly 32 bytes (64 hex characters or base64)');
  return key;
}

export function documentMasterKeyConfigured(): boolean {
  try {
    documentMasterKey();
    return true;
  } catch {
    return false;
  }
}

export type BlobBackend = 'filesystem' | 's3';

export function configuredBlobBackend(): BlobBackend {
  return process.env.VOXERA_BLOB_BACKEND?.trim().toLowerCase() === 's3' ? 's3' : 'filesystem';
}

export function s3BlobConfigurationComplete(): boolean {
  return Boolean(
    process.env.VOXERA_S3_ENDPOINT?.trim() &&
    process.env.VOXERA_S3_BUCKET?.trim() &&
    process.env.VOXERA_S3_ACCESS_KEY_ID?.trim() &&
    process.env.VOXERA_S3_SECRET_ACCESS_KEY?.trim(),
  );
}

export function malwareScannerConfigured(): boolean {
  return Boolean(process.env.VOXERA_MALWARE_SCAN_COMMAND?.trim());
}

export function documentConfigurationFingerprint(): string {
  const safe = {
    backend: configuredBlobBackend(),
    endpoint: process.env.VOXERA_S3_ENDPOINT ? new URL(process.env.VOXERA_S3_ENDPOINT).host : undefined,
    bucket: process.env.VOXERA_S3_BUCKET,
    keyConfigured: documentMasterKeyConfigured(),
    scannerConfigured: malwareScannerConfigured(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}
