import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { createApiKey, SUPPORTED_API_KEY_SCOPES, type ApiKeyDoc } from '@/lib/server/auth';
import { list } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing API keys requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const keys = list<ApiKeyDoc>('apiKeys', (k) => k.orgId === ctx.orgId).map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    last4: k.last4,
    scopes: k.scopes,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt ?? null,
    revokedAt: k.revokedAt ?? null,
  }));
  return ok(listBody(keys), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing API keys requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const unverified = requireVerifiedEmail(ctx);
  if (unverified) return unverified;
  const body = await readJson<{ name?: string; scopes?: string[] }>(req);
  if (body instanceof NextResponse) return body;
  const name = String(body.name ?? '').trim();
  if (!name) return fail('VALIDATION_ERROR', 'Give the key a name so future-you knows what it is for.', { param: 'name', requestId: ctx.requestId });
  if (name.length > 120) return fail('VALIDATION_ERROR', 'Key names are limited to 120 characters.', { param: 'name', requestId: ctx.requestId });

  const requestedScopes: unknown = body.scopes ?? ['*'];
  if (!Array.isArray(requestedScopes) || !requestedScopes.length || requestedScopes.length > SUPPORTED_API_KEY_SCOPES.length) {
    return fail('VALIDATION_ERROR', 'Choose one or more supported API-key scopes.', {
      param: 'scopes',
      detail: SUPPORTED_API_KEY_SCOPES.join(', '),
      requestId: ctx.requestId,
    });
  }
  const allowed = new Set<string>(SUPPORTED_API_KEY_SCOPES);
  const scopes = [...new Set(requestedScopes.map((scope) => String(scope).trim()))];
  const invalid = scopes.filter((scope) => !allowed.has(scope));
  if (invalid.length || (scopes.includes('*') && scopes.length > 1)) {
    return fail('VALIDATION_ERROR', invalid.length ? `Unsupported scope: ${invalid.join(', ')}.` : 'The wildcard scope must be used alone.', {
      param: 'scopes',
      detail: SUPPORTED_API_KEY_SCOPES.join(', '),
      requestId: ctx.requestId,
    });
  }

  const { key, plaintext } = createApiKey(ctx.orgId, name, ctx.userId, scopes);
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'key.created', target: key.id, detail: name });

  // The secret is returned exactly once — only its hash is stored.
  return ok(
    {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      last4: key.last4,
      scopes: key.scopes,
      createdAt: key.createdAt,
      secret: plaintext,
      warning: 'Store this now — it cannot be retrieved again.',
    },
    { requestId: ctx.requestId, status: 201 }
  );
}
