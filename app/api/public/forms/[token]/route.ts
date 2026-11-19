import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateHeaders, rateLimit, readJson, requestId } from '@/lib/server/api';
import { formResponsesFor, formResponseVersion, publicFormForToken, savePublicForm, type FormResponseDoc } from '@/lib/server/forms';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' };

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rid = requestId();
  const limit = rateLimit(`public-form-view:${clientIp(req)}`, 120, 15 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many form requests. Try again later.', { requestId: rid, headers: { ...headers, ...rateHeaders(limit), 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } });
  const { token } = await params;
  try {
    const loaded = publicFormForToken(token);
    if (!loaded?.version) return fail('NOT_FOUND', 'This form link is invalid.', { requestId: rid, headers });
    const assignment = loaded.assignment;
    if (assignment.status === 'revoked') return fail('FORBIDDEN', 'This form link has been revoked. Contact the practice for help.', { requestId: rid, headers });
    if (assignment.status === 'expired') return fail('FORBIDDEN', 'This form link has expired. Contact the practice for a new link.', { requestId: rid, headers });
    const response = formResponsesFor(assignment.orgId, { assignmentId: assignment.id })[0];
    const draft = response ? formResponseVersion(assignment.orgId, response.id) : undefined;
    return ok({
      form: loaded.version.schema,
      assignment: { id: assignment.id, status: assignment.status, expiresAt: assignment.expiresAt },
      response: response ? { status: response.status, respondent: response.respondent, answers: response.status === 'in_progress' ? draft?.answers : undefined } : undefined,
    }, { requestId: rid, headers: { ...headers, ...rateHeaders(limit) } });
  } catch (error) {
    return fail('CONFLICT', error instanceof Error ? error.message : 'The form could not be loaded.', { requestId: rid, headers });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rid = requestId();
  const limit = rateLimit(`public-form-save:${clientIp(req)}`, 30, 15 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many form submissions. Try again later.', { requestId: rid, headers: { ...headers, ...rateHeaders(limit), 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } });
  const { token } = await params;
  const loaded = publicFormForToken(token);
  if (!loaded) return fail('NOT_FOUND', 'This form link is invalid.', { requestId: rid, headers });
  try { requireClinicalWriteMode(loaded.assignment.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Form submissions are disabled.', { requestId: rid, headers }); }
  const body = await readJson<{ answers?: unknown; submit?: boolean; respondent?: FormResponseDoc['respondent'] }>(req, 512 * 1024);
  if (body instanceof NextResponse) return body;
  if (body.respondent && !['self', 'guardian', 'proxy', 'referrer'].includes(body.respondent.relationship)) return fail('VALIDATION_ERROR', 'Respondent relationship is invalid.', { param: 'respondent.relationship', requestId: rid, headers });
  try {
    const saved = savePublicForm({ token, answers: body.answers ?? {}, submit: body.submit === true, respondent: body.respondent, ip: clientIp(req) });
    return ok({
      status: saved.response.status,
      completionMessage: saved.response.status === 'submitted' ? loaded.version?.schema.completionMessage : undefined,
      savedAt: saved.version.createdAt,
    }, { requestId: rid, headers: { ...headers, ...rateHeaders(limit) } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The form could not be saved.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    const conflict = storageConflict || message.includes('already') || message.includes('expired') || message.includes('revoked') || message.includes('changed');
    return fail(
      conflict ? 'CONFLICT' : 'VALIDATION_ERROR',
      storageConflict ? 'This form changed while it was being saved. Reload the link before trying again.' : message,
      { requestId: rid, headers },
    );
  }
}
