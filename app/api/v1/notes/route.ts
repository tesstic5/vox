import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import {
  canReadNotes,
  canWriteNotes,
  noteTemplatesFor,
  notesFor,
  noteSummary,
  notesTerm,
  noteById,
  redactNote,
  seedNoteTemplatesForOrg,
  versionHistory,
} from '@/lib/server/notes';
import { clientById } from '@/lib/server/clients';
import { serviceById, termsForOrg } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Notes — what the practice writes down.
 *
 * Two doors, deliberately different:
 *
 *   - **The list** answers "does this person have a note, and is it signed?" —
 *     which is the reception desk's actual question when they are chasing a
 *     signature. It answers it for every role.
 *   - **The content** answers "what was said about their treatment?" — which is a
 *     practitioner's question. A receptionist or a viewer gets the row with
 *     `restricted: true` and a reason, not a redacted document that pretends to
 *     be complete.
 *
 * A refused read is recorded in the workspace audit trail (`note.read_refused`),
 * because "somebody tried to open a record they may not open" is exactly the
 * event a records system should keep.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const readAllowed = ctx.auth === 'key' || canReadNotes(ctx.user?.role);

  // Opening the notes screen tops the workspace up with templates, the same way
  // the message library tops itself up on read.
  const seeded = seedNoteTemplatesForOrg(ctx.orgId);
  const terms = termsForOrg(ctx.orgId);

  if (url.searchParams.get('view') === 'templates') {
    const templates = noteTemplatesFor(ctx.orgId, { includeInactive: url.searchParams.get('include') === 'inactive' }).map((t) => ({
      id: t.id,
      name: t.name,
      serviceId: t.serviceId ?? null,
      serviceName: t.serviceId ? serviceById(ctx.orgId, t.serviceId)?.name ?? null : null,
      sections: t.sections,
      active: t.active,
    }));
    return ok(
      {
        templates,
        seededNow: seeded.seeded,
        vocabulary: {
          note: terms.note.one,
          notePlural: terms.note.many,
          client: terms.client.one,
        },
      },
      { requestId: ctx.requestId }
    );
  }

  const clientId = url.searchParams.get('clientId') ?? undefined;
  const bookingId = url.searchParams.get('bookingId') ?? undefined;
  const status = url.searchParams.get('status') as 'draft' | 'final' | 'archived' | null;
  const includeArchived = url.searchParams.get('include') === 'archived' || status === 'archived';

  const rows = notesFor(ctx.orgId, {
    clientId,
    bookingId,
    status: status ?? undefined,
    includeArchived,
  }).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));

  const data = rows.map((n) => {
    const base = noteSummary(n, { includeBody: false });
    if (!readAllowed) return redactNote(n);
    return {
      ...base,
      // The list carries enough body to identify the note without carrying the
      // whole record: first line, and who signed it.
      preview: String(n.body ?? '').split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 140),
      signedBy: n.signerName,
    };
  });

  const drafts = rows.filter((n) => n.status === 'draft').length;
  const finals = rows.filter((n) => n.status === 'final').length;
  const unsigned = rows.filter((n) => n.status === 'draft' && n.draftedBy === 'agent').length;

  return ok(
    listBody(data, {
      restricted: !readAllowed,
      ...(readAllowed
        ? {}
        : { restrictedReason: 'Notes are clinical content. Your role can see that they exist and whether they are signed, not what they say.' }),
      stats: {
        total: rows.length,
        drafts,
        finalised: finals,
        archived: rows.filter((n) => n.status === 'archived').length,
        awaitingSignature: unsigned,
        incomplete: rows.filter((n) => n.status === 'draft' && (n.sections ?? []).some((s) => s.required && !String(s.body ?? '').trim())).length,
      },
      seededNow: seeded.seeded,
      vocabulary: { note: terms.note.one, notePlural: terms.note.many },
      actor: { actor, actorName },
    }),
    { requestId: ctx.requestId }
  );
}

/**
 * Writes.
 *
 * `create` opens a draft from a template; `update` edits one (drafts only —
 * a signed note is amended, never edited); `finalise` signs it; `amend` reopens
 * it at the next version with a reason; `archive`/`restore` are the soft-delete
 * pair; `attach`/`detach` record paperwork against it.
 *
 * The role check happens once, here: a role that may not read clinical content
 * may not write it either. The *state* checks (a final note is not edited) happen
 * in the module, so every door honours them.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<Record<string, unknown> & { action?: string; id?: string }>(req);
  if (body instanceof NextResponse) return body;

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const role = ctx.user?.role;
  const writeAllowed = ctx.auth === 'key' || canWriteNotes(role);
  if (!writeAllowed) {
    return fail('FORBIDDEN', 'Notes are clinical content. This account can see that a note exists; writing one needs a practitioner or the practice owner.', {
      requestId: ctx.requestId,
    });
  }

  const action = String(body.action ?? 'create');
  const notes = await import('@/lib/server/notes');

  if (action === 'create') {
    const clientId = String(body.clientId ?? '');
    if (!clientId || !clientById(ctx.orgId, clientId)) {
      return fail('VALIDATION_ERROR', 'A note belongs to a client. Send `clientId`.', { param: 'clientId', requestId: ctx.requestId });
    }
    const created = notes.createNote({
      orgId: ctx.orgId,
      clientId,
      bookingId: body.bookingId ? String(body.bookingId) : undefined,
      serviceId: body.serviceId ? String(body.serviceId) : undefined,
      providerId: body.providerId ? String(body.providerId) : undefined,
      templateId: body.templateId ? String(body.templateId) : undefined,
      title: body.title ? String(body.title) : undefined,
      sections: Array.isArray(body.sections) ? (body.sections as never) : undefined,
      body: body.body ? String(body.body) : undefined,
      draftedBy: body.draftedBy === 'agent' ? 'agent' : 'staff',
      actor,
      actorName,
    });
    if (!created.ok) return fail(created.code === 'VALIDATION_ERROR' ? 'VALIDATION_ERROR' : 'NOT_FOUND', created.error, { requestId: ctx.requestId });
    return ok({ note: noteSummary(created.note, { includeBody: true }), incomplete: notes.incompleteSections(created.note) }, { status: 201, requestId: ctx.requestId });
  }

  const id = String(body.id ?? '');
  if (!id) return fail('VALIDATION_ERROR', 'Send the note `id` for this action.', { param: 'id', requestId: ctx.requestId });
  const note = noteById(ctx.orgId, id);
  if (!note) return fail('NOT_FOUND', `No note with id ${id}.`, { requestId: ctx.requestId });

  if (action === 'update') {
    const updated = notes.updateNote({
      orgId: ctx.orgId,
      id,
      expectedRevision: Number(body.expectedRevision),
      patch: {
        title: body.title ? String(body.title) : undefined,
        sections: Array.isArray(body.sections) ? (body.sections as never) : undefined,
        body: body.body !== undefined ? String(body.body) : undefined,
      },
      actor,
      actorName,
    });
    if (!updated.ok) {
      const code = updated.code === 'FINALISED' || updated.code === 'CONFLICT' ? 'CONFLICT' : updated.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR';
      return fail(code, updated.error, { requestId: ctx.requestId, detail: updated.conflictId });
    }
    return ok({ note: noteSummary(updated.note, { includeBody: true }), incomplete: notes.incompleteSections(updated.note) }, { requestId: ctx.requestId });
  }

  if (action === 'finalise') {
    if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Finalising a clinical note requires an authenticated staff session; API keys may only create and update unsigned drafts.', { requestId: ctx.requestId });
    const signed = notes.finaliseNote({
      orgId: ctx.orgId,
      id,
      expectedRevision: Number(body.expectedRevision),
      signerId: ctx.userId,
      signerName: body.signerName ? String(body.signerName) : ctx.user?.name ?? actorName ?? ctx.user?.email,
      actor,
    });
    if (!signed.ok) {
      const code = signed.code === 'INCOMPLETE' || signed.code === 'VALIDATION_ERROR' ? 'VALIDATION_ERROR' : signed.code === 'FINALISED' || signed.code === 'CONFLICT' ? 'CONFLICT' : 'NOT_FOUND';
      return fail(code, signed.error, { requestId: ctx.requestId, detail: signed.missing?.join(', ') });
    }
    return ok({ note: noteSummary(signed.note, { includeBody: true }), versions: versionHistory(ctx.orgId, id) }, { requestId: ctx.requestId });
  }

  if (action === 'amend') {
    if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Amending signed clinical evidence requires an authenticated staff session.', { requestId: ctx.requestId });
    const amended = notes.amendNote({ orgId: ctx.orgId, id, expectedRevision: Number(body.expectedRevision), reason: String(body.reason ?? ''), actor, actorName });
    if (!amended.ok) {
      const code = amended.code === 'NOT_FOUND' ? 'NOT_FOUND' : amended.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR';
      return fail(code, amended.error, { requestId: ctx.requestId });
    }
    return ok({ note: noteSummary(amended.note, { includeBody: true }), versions: versionHistory(ctx.orgId, id) }, { requestId: ctx.requestId });
  }

  if (action === 'resolve_conflict') {
    if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Reconciling clinical text requires an authenticated staff session.', { requestId: ctx.requestId });
    const resolved = notes.resolveNoteDraftConflict({
      orgId: ctx.orgId,
      noteId: id,
      conflictId: String(body.conflictId ?? ''),
      resolution: body.resolution === 'use_conflict' ? 'use_conflict' : 'keep_current',
      expectedRevision: Number(body.expectedRevision),
      actor,
      actorName,
    });
    if (!resolved.ok) {
      const code = resolved.code === 'NOT_FOUND' ? 'NOT_FOUND' : resolved.code === 'CONFLICT' || resolved.code === 'FINALISED' ? 'CONFLICT' : 'VALIDATION_ERROR';
      return fail(code, resolved.error, { requestId: ctx.requestId });
    }
    return ok({ note: noteSummary(resolved.note, { includeBody: true }), conflicts: notes.noteDraftConflicts(ctx.orgId, id) }, { requestId: ctx.requestId });
  }

  if (action === 'archive' || action === 'restore') {
    const done = action === 'archive'
      ? notes.archiveNote({ orgId: ctx.orgId, id, reason: body.reason ? String(body.reason) : undefined, actor, actorName })
      : notes.restoreNote({ orgId: ctx.orgId, id, actor, actorName });
    if (!done.ok) return fail(done.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR', done.error, { requestId: ctx.requestId });
    return ok({ note: noteSummary(done.note, { includeBody: true }) }, { requestId: ctx.requestId });
  }

  if (action === 'attach') {
    const attached = notes.attachToNote({
      orgId: ctx.orgId,
      id,
      name: String(body.name ?? ''),
      bytes: Number(body.bytes ?? 0),
      contentType: body.contentType ? String(body.contentType) : undefined,
      sha256: body.sha256 ? String(body.sha256) : undefined,
      actor,
      actorName,
    });
    if (!attached.ok) return fail(attached.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR', attached.error, { requestId: ctx.requestId });
    return ok({ note: noteSummary(attached.note, { includeBody: true }) }, { requestId: ctx.requestId });
  }

  if (action === 'detach') {
    const detached = notes.detachFromNote({ orgId: ctx.orgId, id, attachmentId: String(body.attachmentId ?? ''), actor, actorName });
    if (!detached.ok) return fail(detached.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR', detached.error, { requestId: ctx.requestId });
    return ok({ note: noteSummary(detached.note, { includeBody: true }) }, { requestId: ctx.requestId });
  }

  return fail('VALIDATION_ERROR', `Unknown action \`${action}\`. Use create, update, finalise, amend, archive, restore, attach or detach.`, {
    param: 'action',
    requestId: ctx.requestId,
  });
}
