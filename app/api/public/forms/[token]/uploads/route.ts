import { type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateHeaders, rateLimit, requestId } from '@/lib/server/api';
import { formResponseForAssignment, publicFormForToken, savePublicForm } from '@/lib/server/forms';
import { completeDocumentUpload, createDocumentUploadToken, DOCUMENT_MIME_TYPES } from '@/lib/server/clinical-documents';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const responseHeaders = { 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' };
const PUBLIC_MAX_BYTES = 10 * 1024 * 1024;

async function limitedBytes(req: NextRequest, maxBytes: number) {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        chunk.fill(0);
        for (const buffered of chunks) buffered.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new Error('UPLOAD_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    for (const buffered of chunks) buffered.fill(0);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rid = requestId();
  const limit = rateLimit(`public-form-upload:${clientIp(req)}`, 20, 60 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many upload attempts. Try again later.', { requestId: rid, headers: { ...responseHeaders, ...rateHeaders(limit), 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } });
  const { token } = await params;
  const loaded = publicFormForToken(token);
  if (!loaded?.version) return fail('NOT_FOUND', 'This form link is invalid.', { requestId: rid, headers: responseHeaders });
  if (['submitted', 'revoked', 'expired'].includes(loaded.assignment.status)) return fail('CONFLICT', `This form is ${loaded.assignment.status}.`, { requestId: rid, headers: responseHeaders });
  try { requireClinicalWriteMode(loaded.assignment.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Uploads are disabled.', { requestId: rid, headers: responseHeaders }); }
  const fieldKey = String(req.headers.get('x-voxera-form-field') ?? '').trim();
  const field = loaded.version.schema.fields.find((item) => item.key === fieldKey && item.type === 'file');
  if (!field) return fail('VALIDATION_ERROR', 'The upload field is invalid.', { param: 'x-voxera-form-field', requestId: rid, headers: responseHeaders });
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > PUBLIC_MAX_BYTES) return fail('PAYLOAD_TOO_LARGE', 'The file exceeds the 10 MB public-form limit.', { requestId: rid, headers: responseHeaders });
  const mimeType = String(req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType)) return fail('VALIDATION_ERROR', 'This file type is not supported.', { param: 'content-type', requestId: rid, headers: responseHeaders });
  let originalName = String(req.headers.get('x-voxera-file-name') ?? 'form-upload');
  try { originalName = decodeURIComponent(originalName).replace(/[\r\n]/g, '').slice(0, 240); }
  catch { return fail('VALIDATION_ERROR', 'The file name is invalid.', { requestId: rid, headers: responseHeaders }); }
  let bytes: Buffer;
  try { bytes = await limitedBytes(req, PUBLIC_MAX_BYTES); }
  catch (error) { return fail(error instanceof Error && error.message === 'UPLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR', error instanceof Error && error.message === 'UPLOAD_TOO_LARGE' ? 'The file exceeds the 10 MB public-form limit.' : 'Could not read the uploaded file.', { requestId: rid, headers: responseHeaders }); }
  if (!bytes.length) {
    bytes.fill(0);
    return fail('VALIDATION_ERROR', 'The file is empty.', { requestId: rid, headers: responseHeaders });
  }
  try {
    let response = formResponseForAssignment(loaded.assignment.orgId, loaded.assignment.id);
    if (!response) {
      try {
        response = savePublicForm({ token, answers: {}, submit: false, ip: clientIp(req) }).response;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const raced = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
        if (!raced) throw error;
        response = formResponseForAssignment(loaded.assignment.orgId, loaded.assignment.id);
        if (!response) throw error;
      }
    }
    const capability = createDocumentUploadToken({
      orgId: loaded.assignment.orgId, ownerType: 'form_response', ownerId: response.id, patientId: response.clientId,
      title: `${field.label} — ${originalName}`, category: 'form_attachment', allowedMimeTypes: [mimeType], maxBytes: PUBLIC_MAX_BYTES,
      actor: 'public-form',
    });
    const completed = await completeDocumentUpload({ token: capability.token, bytes, mimeType, originalName, actor: 'public-form' });
    bytes.fill(0);
    return ok({ documentId: completed.document.id, name: originalName, scanStatus: completed.document.currentScanStatus, note: 'The upload is quarantined until malware scanning reports it clean.' }, { requestId: rid, status: 201, headers: { ...responseHeaders, ...rateHeaders(limit) } });
  } catch (error) {
    bytes.fill(0);
    const message = error instanceof Error ? error.message : 'The file could not be uploaded.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(
      message.includes('exceed') ? 'PAYLOAD_TOO_LARGE' : storageConflict || message.includes('already') || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR',
      storageConflict ? 'This form changed while the file was being attached. Reload the form before trying again.' : message,
      { requestId: rid, headers: responseHeaders },
    );
  }
}
