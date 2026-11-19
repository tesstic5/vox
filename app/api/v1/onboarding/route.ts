import { NextResponse, type NextRequest } from 'next/server';
import { ok, readJson, requireAuth } from '@/lib/server/api';
import { onboardingState, patchOnboarding } from '@/lib/server/onboarding';
import { practiceSetup } from '@/lib/server/practice-setup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/onboarding — the wizard's state, plus the practice's own checklist.
 *
 * Everything in the response is derived from the workspace's own collections, so
 * this is also the honest answer to "is this account set up?" for a support
 * engineer looking at a ticket. `practice` answers the other half of the
 * question — has this clinic been set up to run a day — and is what the
 * dashboard's practice card and the calendar's empty state read.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  return ok({ ...onboardingState(ctx.orgId), practice: practiceSetup(ctx.orgId) }, { requestId: ctx.requestId });
}

/** PATCH /v1/onboarding — dismiss the wizard, or record a choice. */
export async function PATCH(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ dismissed?: boolean; completed?: boolean; useCase?: string }>(req);
  if (body instanceof NextResponse) return body;
  patchOnboarding(ctx.orgId, {
    ...(typeof body.dismissed === 'boolean' ? { dismissed: body.dismissed } : {}),
    ...(body.completed ? { completedAt: new Date().toISOString() } : {}),
    ...(body.useCase ? { useCase: body.useCase } : {}),
  });
  return ok(onboardingState(ctx.orgId), { requestId: ctx.requestId });
}
