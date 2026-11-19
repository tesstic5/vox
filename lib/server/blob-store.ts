/** Encrypted-byte object storage adapters. Object keys are opaque and tenant-neutral. */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataPath } from './paths';
import { configuredBlobBackend } from './document-config';

export type BlobHead = { bytes: number; etag?: string; lastModified?: string };

export interface BlobStore {
  readonly backend: 'filesystem' | 's3';
  put(key: string, bytes: Buffer): Promise<BlobHead>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<BlobHead | undefined>;
  delete(key: string): Promise<void>;
}

function safeObjectKey(key: string): string {
  if (!/^[a-zA-Z0-9/_-]{1,400}$/.test(key) || key.includes('..') || key.startsWith('/')) throw new Error('invalid object key');
  return key;
}

class FilesystemBlobStore implements BlobStore {
  readonly backend = 'filesystem' as const;
  private readonly root = path.resolve(process.env.VOXERA_BLOB_ROOT?.trim() || dataPath('clinical-blobs'));

  private file(key: string) {
    const file = path.resolve(this.root, safeObjectKey(key));
    if (!file.startsWith(`${this.root}${path.sep}`)) throw new Error('object path escaped blob root');
    return file;
  }

  async put(key: string, bytes: Buffer): Promise<BlobHead> {
    const target = this.file(key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, target);
    return { bytes: bytes.length, etag: crypto.createHash('sha256').update(bytes).digest('hex') };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.file(key));
  }

  async head(key: string): Promise<BlobHead | undefined> {
    try {
      const stat = await fs.stat(this.file(key));
      return { bytes: stat.size, lastModified: stat.mtime.toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256(value: Buffer | string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

class S3BlobStore implements BlobStore {
  readonly backend = 's3' as const;
  private endpoint = new URL(String(process.env.VOXERA_S3_ENDPOINT ?? ''));
  private bucket = String(process.env.VOXERA_S3_BUCKET ?? '').trim();
  private region = String(process.env.VOXERA_S3_REGION ?? 'auto').trim() || 'auto';
  private accessKey = String(process.env.VOXERA_S3_ACCESS_KEY_ID ?? '').trim();
  private secretKey = String(process.env.VOXERA_S3_SECRET_ACCESS_KEY ?? '').trim();

  constructor() {
    if (!this.bucket || !this.accessKey || !this.secretKey || !['http:', 'https:'].includes(this.endpoint.protocol)) {
      throw new Error('S3 blob storage requires endpoint, bucket, access key and secret key');
    }
    if (process.env.NODE_ENV === 'production' && this.endpoint.protocol !== 'https:') throw new Error('production S3 endpoint must use HTTPS');
  }

  private objectUrl(key: string) {
    const encoded = safeObjectKey(key).split('/').map(awsEncode).join('/');
    const prefix = this.endpoint.pathname.replace(/\/$/, '');
    const url = new URL(this.endpoint.origin);
    url.pathname = `${prefix}/${awsEncode(this.bucket)}/${encoded}`.replace(/\/+/g, '/');
    return url;
  }

  private async request(method: string, key: string, body?: Buffer): Promise<Response> {
    const url = this.objectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? Buffer.alloc(0));
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const dateKey = hmac(`AWS4${this.secretKey}`, date);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign).toString('hex');
    const headers = {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
  }

  private ensure(response: Response, action: string) {
    if (response.ok) return;
    throw new Error(`S3 ${action} failed with HTTP ${response.status}`);
  }

  async put(key: string, bytes: Buffer): Promise<BlobHead> {
    const response = await this.request('PUT', key, bytes);
    this.ensure(response, 'put');
    return { bytes: bytes.length, etag: response.headers.get('etag')?.replaceAll('"', '') || undefined };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.request('GET', key);
    this.ensure(response, 'get');
    return Buffer.from(await response.arrayBuffer());
  }

  async head(key: string): Promise<BlobHead | undefined> {
    const response = await this.request('HEAD', key);
    if (response.status === 404) return undefined;
    this.ensure(response, 'head');
    return {
      bytes: Number(response.headers.get('content-length') ?? 0),
      etag: response.headers.get('etag')?.replaceAll('"', '') || undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', key);
    if (response.status !== 404) this.ensure(response, 'delete');
  }
}

let cached: { signature: string; store: BlobStore } | undefined;

export function blobStore(): BlobStore {
  const backend = configuredBlobBackend();
  const signature = backend === 's3'
    ? [backend, process.env.VOXERA_S3_ENDPOINT, process.env.VOXERA_S3_BUCKET, process.env.VOXERA_S3_ACCESS_KEY_ID].join('|')
    : [backend, process.env.VOXERA_BLOB_ROOT, process.env.VOXERA_DATA_DIR].join('|');
  if (cached?.signature === signature) return cached.store;
  const store: BlobStore = backend === 's3' ? new S3BlobStore() : new FilesystemBlobStore();
  cached = { signature, store };
  return store;
}
