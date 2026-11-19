import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireDeskRole, requirePermission } from '@/lib/server/api';
import { clientById, setConsent, type ConsentChannel } from '@/lib/server/clients';
import { actorLabel, recordView } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANNELS: ConsentChannel[] = ['sms', 'email', 'recording'];

/**
 * Consent is a request/answer, not a checkbox that quietly disappears: every
 * change records who said what, when, and where they said it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id }) ?? requireDeskRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ channel?: string; granted?: boolean; source?: string; note?: string }>(req);
  if (body instanceof NextResponse) return body;

  const channel = body.channel as ConsentChannel;
  if (!CHANNELS.includes(channel)) {
    return fail('VALIDATION_ERROR', `\`channel\` must be one of: ${CHANNELS.join(', ')}.`, { param: 'channel', requestId: ctx.requestId });
  }
  if (typeof body.granted !== 'boolean') {
    return fail('VALIDATION_ERROR', '`granted` must be true or false.', { param: 'granted', requestId: ctx.requestId });
  }
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const client = setConsent(ctx.orgId, id, channel, body.granted, {
    source: body.source ?? (ctx.auth === 'key' ? 'api' : 'staff'),
    note: body.note,
    actor,
    actorName,
  });
  if (!client) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  return ok({ id: client.id, consents: client.consents }, { requestId: ctx.requestId });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: id });
  if (denied) return denied;
  const client = clientById(ctx.orgId, id);
  if (!client) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordView({ orgId: ctx.orgId, resource: 'client', resourceId: id, actor, actorName });
  return ok({ id: client.id, consents: client.consents }, { requestId: ctx.requestId });
}
