import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, insert, list, newId, nowIso, orgScope, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { providerForModel } from '@/lib/server/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['assistants:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
  const status = url.searchParams.get('status');

  let items = orgScope<Doc>('assistants', ctx.orgId);
  if (status) items = items.filter((a) => a.status === status);

  return ok(
    {
      object: 'list',
      data: items.slice(0, limit),
      total: items.length,
      has_more: items.length > limit,
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['assistants:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  const name = String(body.name ?? '').trim();
  if (!name) return fail('VALIDATION_ERROR', 'An assistant needs a name.', { param: 'name', requestId: ctx.requestId });
  if (typeof body.firstMessage !== 'string' && typeof body.systemPrompt !== 'string') {
    return fail('VALIDATION_ERROR', 'Provide at least a firstMessage or a systemPrompt.', { param: 'systemPrompt', requestId: ctx.requestId });
  }
  if (body.temperature !== undefined) {
    const t = Number(body.temperature);
    if (Number.isNaN(t) || t < 0 || t > 2) {
      return fail('VALIDATION_ERROR', 'temperature must be between 0 and 2.', {
        param: 'temperature',
        detail: 'Received ' + JSON.stringify(body.temperature),
        requestId: ctx.requestId,
      });
    }
  }
  const toolNames = Array.isArray(body.tools) ? (body.tools as string[]) : [];
  if (toolNames.length) {
    const known = new Set(list<Doc>('tools', (t) => t.orgId === ctx.orgId).map((t) => t.name));
    const missing = toolNames.filter((t) => !known.has(t));
    if (missing.length) {
      return fail('VALIDATION_ERROR', `Unknown tool(s): ${missing.join(', ')}. Create the tool first.`, {
        param: 'tools',
        requestId: ctx.requestId,
      });
    }
  }

  // A client that created the record offline may hand us its id; keep it so
  // ids never change under the dashboard's feet.
  const clientId = typeof body.id === 'string' && /^[a-z]+_[A-Za-z0-9]{6,40}$/.test(body.id) ? body.id : undefined;
  if (clientId && get<Doc>('assistants', clientId)) {
    return fail('CONFLICT', `An assistant with id ${clientId} already exists.`, { param: 'id', requestId: ctx.requestId });
  }

  const assistant = insert<Doc>('assistants', {
    id: clientId ?? `asst_${newId('').slice(1, 13)}`,
    orgId: ctx.orgId,
    name,
    firstMessage: body.firstMessage ?? `Hi, this is ${name}. How can I help?`,
    systemPrompt: body.systemPrompt ?? `You are ${name}, a helpful voice assistant.`,
    model: body.model ?? '',
    // Which provider serves an explicitly selected model. Missing means
    // unconfigured; creation must not silently imply an OpenAI connection.
    provider: body.provider ?? providerForModel(String(body.model ?? ''))?.id,
    voiceId: body.voiceId ?? '',
    temperature: body.temperature ?? 0.4,
    transcriber: body.transcriber ?? '',
    language: body.language ?? 'en-US',
    tools: toolNames,
    knowledge: Array.isArray(body.knowledge) ? body.knowledge : [],
    serverUrl: body.serverUrl ?? '',
    // Publishing is a separate verified action; creation never bypasses it.
    status: 'draft',
    calls: 0,
    minutes: 0,
    containment: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
  } as Doc);

  audit({ orgId: ctx.orgId, actor: ctx.auth === 'key' ? `key:${ctx.key?.name}` : 'dashboard', action: 'assistant.created', target: String(assistant.id), detail: name });
  return ok({ ...assistant }, { requestId: ctx.requestId, status: 201 });
}
