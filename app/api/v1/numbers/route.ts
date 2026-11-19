import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { insert, list, newId, nowIso, orgScope, update, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COUNTRY_CODES: Record<string, string> = { US: '+1', CA: '+1', GB: '+44', DE: '+49', AU: '+61', IN: '+91', PK: '+92' };

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['numbers:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const numbers = orgScope<Doc>('numbers', ctx.orgId);
  return ok(listBody(numbers), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['numbers:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const unverified = requireVerifiedEmail(ctx);
  if (unverified) return unverified;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ id?: string; areaCode?: string; country?: string; label?: string; assistantId?: string }>(req);
  if (body instanceof NextResponse) return body;

  const areaCode = String(body.areaCode ?? '').replace(/\D/g, '').slice(0, 4);
  if (areaCode.length < 3) {
    return fail('VALIDATION_ERROR', 'Provide an area code of at least 3 digits.', { param: 'areaCode', requestId: ctx.requestId });
  }
  const country = (body.country ?? 'US').toUpperCase();
  if (!COUNTRY_CODES[country]) return fail('VALIDATION_ERROR', `Numbers are not available in ${country} yet.`, { param: 'country', requestId: ctx.requestId });

  if (body.assistantId) {
    const assistant = list<Doc>('assistants', (a) => a.id === body.assistantId && a.orgId === ctx.orgId)[0];
    if (!assistant) return fail('VALIDATION_ERROR', `No assistant with id ${body.assistantId}.`, { param: 'assistantId', requestId: ctx.requestId });
  }

  const clientId = typeof body.id === 'string' && /^[a-z]+_[A-Za-z0-9]{6,40}$/.test(body.id) ? body.id : undefined;
  const number = insert<Doc>('numbers', {
    id: clientId ?? `num_${newId('').slice(1, 11)}`,
    orgId: ctx.orgId,
    // Deliberately not E.164: this is a workspace routing record, never carrier
    // inventory and never something a person could mistake for a dialable line.
    number: `sandbox:${country}:${areaCode}:${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`,
    label: body.label ?? 'Sandbox line',
    provider: 'sandbox',
    assistantId: body.assistantId ?? null,
    country,
    areaCode,
    status: 'sandbox',
    monthlyCost: 0,
    inboundCalls30d: 0,
    sandbox: true,
    createdAt: nowIso(),
  } as Doc);

  audit({ orgId: ctx.orgId, actor: ctx.auth === 'key' ? `key:${ctx.key?.name}` : 'dashboard', action: 'number.sandbox_created', target: String(number.id), detail: String(number.number) });
  return ok(number, { requestId: ctx.requestId, status: 201 });
}
