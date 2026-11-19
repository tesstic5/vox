import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { aiCredentialsFor, connectAiCredential, publicAiCredential } from '@/lib/server/ai/credentials';
import { deploymentProviders, providerById, type AuthStyle, type WireFormat } from '@/lib/server/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /v1/ai/credentials — the workspace's model keys, masked.
 * POST /v1/ai/credentials — connect (or rotate) one.
 *
 * Nothing here returns a secret: the dashboard shows a hint, a verification
 * result and, when a key is refused, the provider's own words about why.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing provider credentials requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const credentials = aiCredentialsFor(ctx.orgId).map(publicAiCredential);
  return ok(
    {
      object: 'list',
      data: credentials,
      total: credentials.length,
      has_more: false,
      // Deployment-level keys, so an operator can see what runs without BYO keys.
      fromEnvironment: deploymentProviders().filter((p) => p.configured).map((p) => ({ id: p.id, label: p.label, envKey: p.envKey })),
      hint: credentials.length
        ? undefined
        : 'No workspace model key yet. Assistants fall back to the built-in rule engine until one is connected.',
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing provider credentials requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{
    provider?: string;
    apiKey?: string;
    label?: string;
    /** Bring-your-own endpoint: where it lives, how it authenticates. */
    baseUrl?: string;
    wire?: WireFormat;
    authStyle?: AuthStyle;
    headers?: Record<string, string>;
  }>(req);
  if (body instanceof NextResponse) return body;

  const provider = String(body.provider ?? '').trim();
  const apiKey = String(body.apiKey ?? '').trim();
  if (!provider) return fail('VALIDATION_ERROR', 'provider is required.', { param: 'provider', requestId: ctx.requestId });

  const byo = providerById(provider)?.byo === true;
  if (byo) {
    if (!String(body.baseUrl ?? '').trim()) {
      return fail('VALIDATION_ERROR', 'A base URL is required for your own endpoint, e.g. https://ai.yourcompany.com/v1.', {
        param: 'baseUrl',
        requestId: ctx.requestId,
      });
    }
    if (body.authStyle !== 'none' && apiKey.length < 8) {
      return fail('VALIDATION_ERROR', 'That does not look like an API key. Choose auth style "none" if the endpoint needs no key.', {
        param: 'apiKey',
        requestId: ctx.requestId,
      });
    }
  } else if (apiKey.length < 12) {
    return fail('VALIDATION_ERROR', 'That does not look like an API key.', { param: 'apiKey', requestId: ctx.requestId });
  }

  const result = await connectAiCredential({
    orgId: ctx.orgId,
    provider,
    apiKey,
    label: body.label,
    actor: 'dashboard',
    baseUrl: body.baseUrl,
    wire: body.wire,
    authStyle: body.authStyle,
    headers: body.headers,
  });
  if (!result.ok) {
    return fail(result.status === 401 ? 'UNAUTHORIZED' : 'VALIDATION_ERROR', result.error, {
      param: 'apiKey',
      detail: 'provider_rejected_key',
      requestId: ctx.requestId,
    });
  }

  return ok(
    { ...publicAiCredential(result.credential), verification: result.check },
    { requestId: ctx.requestId, status: 201 }
  );
}
