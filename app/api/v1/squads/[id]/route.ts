import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { normalizeMembers, removeSquad, squadById, updateSquad, type SquadDoc } from '@/lib/server/squads';
import { get, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const squad = squadById(ctx.orgId, id);
  if (!squad) return fail('NOT_FOUND', `No squad with id ${id}.`, { requestId: ctx.requestId });
  return ok(squad, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  if (!squadById(ctx.orgId, id)) return fail('NOT_FOUND', `No squad with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<Partial<SquadDoc>>(req);
  if (body instanceof NextResponse) return body;
  const patch: Partial<SquadDoc> = {};
  if ('name' in body) patch.name = String(body.name);
  if ('brief' in body) patch.brief = String(body.brief);
  if ('members' in body) {
    const members = normalizeMembers(body.members);
    for (const member of members) {
      const assistant = get<Doc>('assistants', member.assistantId);
      if (!assistant || assistant.orgId !== ctx.orgId) {
        return fail('VALIDATION_ERROR', `Unknown assistant in members: ${member.assistantId}.`, { param: 'members', requestId: ctx.requestId });
      }
    }
    if (new Set(members.map((m) => m.assistantId)).size !== members.length) {
      return fail('VALIDATION_ERROR', 'The same assistant cannot appear twice in a squad.', { param: 'members', requestId: ctx.requestId });
    }
    patch.members = members;
  }
  const updated = updateSquad(ctx.orgId, id, patch);
  return ok(updated, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  if (!squadById(ctx.orgId, id)) return fail('NOT_FOUND', `No squad with id ${id}.`, { requestId: ctx.requestId });
  removeSquad(ctx.orgId, id);
  return ok({ id, deleted: true }, { requestId: ctx.requestId });
}
