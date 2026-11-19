import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { actorLabel, accessLogFor } from '@/lib/server/access-log';
import { audit } from '@/lib/server/audit';
import { canReadNotes, noteById, noteDraftConflicts, noteSummary, recordNoteRead, versionHistory } from '@/lib/server/notes';
import { listBy, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One note, with its trail.
 *
 * Reading a note logs a read against the note (the same promise the client record
 * makes). **A refused read is logged too** — as an audit row, `note.read_refused`
 * — because "somebody tried to open a record they may not open" is precisely the
 * event a records system exists to keep, and a refusal nobody records is a
 * refusal nobody can review.
 *
 * The response carries the version trail (what was signed, and when), the note's
 * own access log, and the workspace audit rows about it, so the screen can show
 * one history rather than making somebody assemble it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const note = noteById(ctx.orgId, id);
  if (!note) return fail('NOT_FOUND', `No note with id ${id}.`, { requestId: ctx.requestId });

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const readAllowed = ctx.auth === 'key' || canReadNotes(ctx.user?.role);

  if (!readAllowed) {
    audit({
      orgId: ctx.orgId,
      actor,
      action: 'note.read_refused',
      target: id,
      detail: `${ctx.user?.role ?? 'unknown role'} asked for clinical content`,
      kind: 'access',
    });
    return fail('FORBIDDEN', 'This note is clinical content. Your role cannot open it — ask a practitioner or the practice owner.', {
      requestId: ctx.requestId,
      detail: `note ${id} is a ${note.status} note; ${note.sections.length} section(s)`,
    });
  }

  recordNoteRead({ orgId: ctx.orgId, note, actor, actorName });

  const access = accessLogFor(ctx.orgId, 'note', id, 50).map((e) => ({
    id: e.id,
    action: e.action,
    actor: e.actor,
    actorName: e.actorName,
    detail: e.detail,
    at: String((e as Doc & { at?: string }).at ?? e.createdAt ?? ''),
  }));
  // The workspace trail about this note: created, edited, finalised, amended,
  // archived, refused — in one list, newest first.
  const trail = listBy<Doc>('audit', { orgId: ctx.orgId, target: id }, { limit: 200 }).map((a) => ({
    action: String(a.action),
    actor: String(a.actor),
    detail: String(a.detail ?? ''),
    at: String(a.at ?? a.createdAt ?? ''),
  }));

  return ok(
    {
      note: noteSummary(note, { includeBody: true }),
      versions: versionHistory(ctx.orgId, id),
      conflicts: noteDraftConflicts(ctx.orgId, id),
      access,
      audit: trail,
    },
    { requestId: ctx.requestId }
  );
}
