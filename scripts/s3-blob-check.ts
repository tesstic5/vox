import crypto from 'node:crypto';
import http from 'node:http';
import { blobStore } from '../lib/server/blob-store';

let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  console.log(`PASS ${label}`);
}
function hash(value: Buffer | string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer | string, value: string) { return crypto.createHmac('sha256', key).update(value).digest(); }

async function main() {
  const accessKey = 'R2_TEST_ACCESS';
  const secret = 'r2-test-secret-value';
  const region = 'auto';
  const objects = new Map<string, Buffer>();
  const signed: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const amzDate = String(req.headers['x-amz-date'] ?? '');
        const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
        const authorization = String(req.headers.authorization ?? '');
        if (payloadHash !== hash(body)) throw new Error('payload hash mismatch');
        const date = amzDate.slice(0, 8);
        const canonicalHeaders = `host:${req.headers.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const canonicalRequest = [req.method, req.url, '', canonicalHeaders, 'host;x-amz-content-sha256;x-amz-date', payloadHash].join('\n');
        const scope = `${date}/${region}/s3/aws4_request`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hash(canonicalRequest)}`;
        const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
        const expected = hmac(signingKey, stringToSign).toString('hex');
        if (!authorization.includes(`Credential=${accessKey}/${scope}`) || !authorization.endsWith(`Signature=${expected}`)) {
          throw new Error(`signature mismatch: ${authorization}`);
        }
        signed.push(`${req.method} ${req.url}`);
        const key = String(req.url);
        if (req.method === 'PUT') {
          objects.set(key, body);
          res.writeHead(200, { etag: `"${hash(body)}"` }).end();
        } else if (req.method === 'GET') {
          const value = objects.get(key);
          if (!value) res.writeHead(404).end(); else res.writeHead(200, { 'content-length': value.length }).end(value);
        } else if (req.method === 'HEAD') {
          const value = objects.get(key);
          if (!value) res.writeHead(404).end(); else res.writeHead(200, { 'content-length': value.length, etag: `"${hash(value)}"` }).end();
        } else if (req.method === 'DELETE') {
          const existed = objects.delete(key);
          res.writeHead(existed ? 204 : 404).end();
        } else res.writeHead(405).end();
      } catch (error) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  process.env.VOXERA_BLOB_BACKEND = 's3';
  process.env.VOXERA_S3_ENDPOINT = `http://127.0.0.1:${address.port}/r2-prefix`;
  process.env.VOXERA_S3_BUCKET = 'clinical-test';
  process.env.VOXERA_S3_REGION = region;
  process.env.VOXERA_S3_ACCESS_KEY_ID = accessKey;
  process.env.VOXERA_S3_SECRET_ACCESS_KEY = secret;
  const store = blobStore();
  const key = 'v1/opaque-folder/object_123';
  const bytes = Buffer.from('encrypted-ciphertext-fixture');
  const put = await store.put(key, bytes);
  check('S3 adapter accepts independently verified SigV4 PUT', put.bytes === bytes.length && put.etag === hash(bytes));
  const head = await store.head(key);
  check('S3 adapter signs HEAD and parses object metadata', head?.bytes === bytes.length && head.etag === hash(bytes));
  const downloaded = await store.get(key);
  check('S3 adapter signs GET and returns exact ciphertext', downloaded.equals(bytes));
  await store.delete(key);
  check('S3 adapter signs DELETE', (await store.head(key)) === undefined);
  check('R2-style endpoint prefix and path-style bucket are canonicalised identically', signed.every((line) => line.includes('/r2-prefix/clinical-test/v1/opaque-folder/object_123')), signed);
  check('all S3 operations were SigV4 authenticated', signed.length === 5, signed);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  console.log(`\nS3/R2 blob interoperability: ${checks}/${checks} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
