import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { boardFor, createNote, deleteNote, notesFor, updateNote } from '@/lib/server/board';
import { locationById } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The staff board.
 *
 * `view=today` answers "who is where today" per site: who is on the rota and who
 * is on now, which rooms are in use and free, what still needs a decision
 * (unconfirmed, waiting, no-shows, the wait list), and what is coming next.
 * `view=notes` is the internal board the team writes to each other — staff-only,
 * audited, never part of a client's record.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const view = url.searchParams.get('view') ?? 'today';
  const locationId = url.searchParams.get('locationId') ?? undefined;
  if (locationId && !locationById(ctx.orgId, locationId)) {
    return fail('NOT_FOUND', `No location with id ${locationId}.`, { requestId: ctx.requestId });
  }

  switch (view) {
    case 'today': {
      const board = boardFor(ctx.orgId, { locationId, date: url.searchParams.get('date') ?? undefined });
      return ok(
        {
          ...board,
          notes: notesFor(ctx.orgId, { locationId, includeWorkspace: true }),
        },
        { requestId: ctx.requestId }
      );
    }

    case 'notes':
      return ok({ notes: notesFor(ctx.orgId, { locationId, includeWorkspace: true }) }, { requestId: ctx.requestId });

    default:
      return fail('VALIDATION_ERROR', '`view` must be one of: today, notes.', { param: 'view', requestId: ctx.requestId });
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ action?: string; id?: string; title?: string; body?: string; locationId?: string; pinned?: boolean }>(req);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  switch (body.action) {
    case 'note:create': {
      const result = createNote(ctx.orgId, {
        title: String(body.title ?? ''),
        body: String(body.body ?? ''),
        locationId: body.locationId || undefined,
        pinned: body.pinned,
        author: actor,
        authorName: actorName,
      });
      if (result.error) {
        return fail(result.error === 'not_found' ? 'NOT_FOUND' : 'VALIDATION_ERROR', result.message ?? 'Could not post that note.', {
          requestId: ctx.requestId,
        });
      }
      return ok({ note: result.note }, { requestId: ctx.requestId, status: 201 });
    }

    case 'note:update': {
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = updateNote(ctx.orgId, id, { title: body.title, body: body.body, pinned: body.pinned }, actor);
      if (result.error) {
        return fail(result.error === 'not_found' ? 'NOT_FOUND' : 'VALIDATION_ERROR', result.message ?? 'Could not update that note.', {
          requestId: ctx.requestId,
        });
      }
      return ok({ note: result.note }, { requestId: ctx.requestId });
    }

    case 'note:delete': {
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      if (!deleteNote(ctx.orgId, id, actor)) return fail('NOT_FOUND', 'That note does not exist.', { requestId: ctx.requestId });
      return ok({ id, deleted: true }, { requestId: ctx.requestId });
    }

    default:
      return fail('VALIDATION_ERROR', '`action` must be one of: note:create, note:update, note:delete.', { param: 'action', requestId: ctx.requestId });
  }
}
