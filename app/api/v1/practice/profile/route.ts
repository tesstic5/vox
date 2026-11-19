import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { practiceProfile, setPracticeProfile, type PracticeProfile } from '@/lib/server/practice';
import { TERM_PACK_IDS, describeTermPack, termsFor, type TermPackId } from '@/lib/terms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The practice profile: vocabulary, booking policy, and the term pack the whole
 * interface reads. One setting changes "patient" to "customer" everywhere,
 * rather than a rename per vertical in the database.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const profile = practiceProfile(ctx.orgId);
  return ok(
    {
      profile,
      terms: termsFor(profile.termPack),
      packs: TERM_PACK_IDS.map((id) => ({ id, describes: describeTermPack(id) })),
    },
    { requestId: ctx.requestId }
  );
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<Partial<PracticeProfile>>(req);
  if (body instanceof NextResponse) return body;

  const patch: Partial<PracticeProfile> = {};
  if (body.termPack !== undefined) {
    if (!TERM_PACK_IDS.includes(body.termPack as TermPackId)) {
      return fail('VALIDATION_ERROR', `\`termPack\` must be one of: ${TERM_PACK_IDS.join(', ')}.`, { param: 'termPack', requestId: ctx.requestId });
    }
    patch.termPack = body.termPack;
  }
  for (const key of ['slotStepMinutes', 'minNoticeMinutes', 'maxAdvanceDays', 'recallDays'] as const) {
    if (body[key] !== undefined) {
      const value = Number(body[key]);
      if (!Number.isFinite(value) || value < 0) {
        return fail('VALIDATION_ERROR', `\`${key}\` must be zero or more.`, { param: key, requestId: ctx.requestId });
      }
      patch[key] = value;
    }
  }
  if (patch.slotStepMinutes !== undefined && patch.slotStepMinutes < 5) {
    return fail('VALIDATION_ERROR', '`slotStepMinutes` below 5 would offer an unusable grid.', { param: 'slotStepMinutes', requestId: ctx.requestId });
  }
  // The practice's window is the fallback every service inherits, so it has to be
  // a real number: zero would recall everybody the day after they were seen.
  if (patch.recallDays !== undefined && (patch.recallDays < 1 || patch.recallDays > 3650)) {
    return fail('VALIDATION_ERROR', '`recallDays` must be between 1 and 3650 — it is the fallback window for every service.', {
      param: 'recallDays',
      requestId: ctx.requestId,
    });
  }
  const profile = setPracticeProfile(ctx.orgId, patch, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  return ok({ profile, terms: termsFor(profile.termPack) }, { requestId: ctx.requestId });
}
