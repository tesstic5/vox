import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { createOnboardingAssistant, onboardingState, onboardingUseCases } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/onboarding/assistant — create the agent from a use case.
 *
 * Always creates a draft. The business must review the assistant and publish
 * deliberately; email verification is also required before publishing.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['assistants:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Setup requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ useCase?: string; business?: string; name?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.useCase) return fail('VALIDATION_ERROR', 'Pick one of the use cases first.', { param: 'useCase', requestId: ctx.requestId });
  const available = onboardingUseCases(ctx.orgId);
  if (!available.some((useCase) => useCase.id === body.useCase)) {
    return fail('VALIDATION_ERROR', 'That use case is not available for this workspace’s enabled modules.', {
      param: 'useCase',
      detail: `Available: ${available.map((useCase) => useCase.id).join(', ') || 'none'}`,
      requestId: ctx.requestId,
    });
  }

  const result = createOnboardingAssistant({
    orgId: ctx.orgId,
    useCase: body.useCase,
    business: body.business,
    name: body.name,
    publish: false,
  });
  return ok(
    {
      assistant: result.assistant,
      useCase: result.useCase,
      toolsCreated: result.toolsCreated,
      published: result.published,
      note: 'Created as a draft. Review its instructions and your business details, verify your email if needed, then publish when ready.',
      onboarding: onboardingState(ctx.orgId),
    },
    { requestId: ctx.requestId, status: 201 }
  );
}
