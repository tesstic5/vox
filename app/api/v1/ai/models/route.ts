import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { aiReadiness, aiCredentialFor, endpointModels } from '@/lib/server/ai/credentials';
import { DEFAULT_MODEL } from '@/lib/server/ai/providers';
import { MODELS } from '@/lib/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/ai/models — what this workspace can run, and what each model costs.
 *
 * One catalogue for everybody: the same list the marketing site prices from, with
 * `ready` resolved against this workspace's key (or the deployment's) and the
 * engine the turn will actually use when neither is present.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;

  const providers = aiReadiness(ctx.orgId);
  const ready = new Set(providers.filter((p) => p.ready).map((p) => p.id));

  // The bring-your-own endpoint's model list is whatever the endpoint says it is,
  // so it is asked (and the answer cached on the credential) rather than assumed.
  const url = new URL(req.url);
  const customDoc = aiCredentialFor(ctx.orgId, 'custom');
  const live = customDoc?.baseUrl && url.searchParams.get('probe') !== '0' ? await endpointModels(ctx.orgId) : undefined;

  return ok(
    {
      object: 'list',
      // The list here is `models` rather than `data` (it is a catalogue, not a
      // collection), but the envelope keys still mean what they mean elsewhere.
      total: MODELS.length,
      has_more: false,
      engine: ready.size ? 'model' : 'rules',
      note: ready.size
        ? `${[...ready].join(', ')} ${ready.size === 1 ? 'is' : 'are'} configured — assistants on those providers answer with a real model.`
        : 'No model key is configured, so every assistant answers with the built-in rule engine. Connect a key to change that.',
      providers,
      custom: customDoc?.baseUrl
        ? {
            baseUrl: customDoc.baseUrl,
            wire: customDoc.wire ?? 'openai',
            authStyle: customDoc.authStyle ?? 'bearer',
            verified: live?.verified ?? customDoc.verified,
            models: live?.models ?? customDoc.models ?? [],
            error: live?.error,
            note: customDoc.note,
          }
        : null,
      models: MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        context: m.context,
        latency: m.latency,
        inputCost: 0,
        outputCost: 0,
        pricingAvailable: false,
        ready: ready.has(m.provider),
        isDefaultForProvider: DEFAULT_MODEL[m.provider] === m.id,
      })),
    },
    { requestId: ctx.requestId }
  );
}
