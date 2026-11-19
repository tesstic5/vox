import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { createSquad, normalizeMembers, squadsFor, type SquadDoc } from '@/lib/server/squads';
import { get, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Squads — an ordered set of assistants a call can hand off between.
 *
 * `members` are assistant ids in handoff order, so the first member answers and
 * a transfer moves the call down the list. The dashboard's squads page reads the
 * same collection this API writes.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const squads = squadsFor(ctx.orgId).map((s) => ({
    ...s,
    members: s.members.map((member) => {
      const assistant = get<Doc & { name?: string }>('assistants', member.assistantId);
      return {
        ...member,
        name: assistant?.orgId === ctx.orgId ? String(assistant?.name ?? 'Unknown') : 'Missing',
      };
    }),
  }));
  return ok(listBody(squads), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<Partial<SquadDoc>>(req);
  if (body instanceof NextResponse) return body;

  const name = String(body.name ?? '').trim();
  if (name.length < 2) return fail('VALIDATION_ERROR', '`name` is required.', { param: 'name', requestId: ctx.requestId });

  const members = normalizeMembers(body.members);
  for (const member of members) {
    const assistant = get<Doc>('assistants', member.assistantId);
    if (!assistant || assistant.orgId !== ctx.orgId) {
      return fail('VALIDATION_ERROR', `Unknown assistant in members: ${member.assistantId}.`, { param: 'members', requestId: ctx.requestId });
    }
  }
  if (new Set(members.map((m) => m.assistantId)).size !== members.length) {
    return fail('VALIDATION_ERROR', 'The same assistant cannot appear twice in a squad — handoffs are ordered, so a repeat is a loop.', {
      param: 'members',
      requestId: ctx.requestId,
    });
  }
  const squad = createSquad(ctx.orgId, { name, members, brief: body.brief });
  return ok(squad, { requestId: ctx.requestId, status: 201 });
}
