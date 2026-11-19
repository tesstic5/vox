import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { canWorkLeads, leadStats, listLeads } from '@/lib/server/leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/leads — the sales inbox.
 *
 * Leads are platform-level (the marketing form sells Voxera, not a
 * practice), so this is not org-scoped like the rest of /api/v1: it is
 * gated by `canWorkLeads` — explicitly allowlisted operator emails only.
 * An empty allowlist denies access. An API key cannot read it: a key belongs
 * to a workspace, and these are not the workspace's to see.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !canWorkLeads(ctx.user)) {
    return fail('FORBIDDEN', 'The sales inbox is for the team that answers the form.', { requestId: ctx.requestId });
  }
  const status = new URL(req.url).searchParams.get('status') ?? undefined;
  const leads = listLeads(status);
  return ok({ object: 'list', data: leads, total: leads.length, stats: leadStats() }, { requestId: ctx.requestId });
}
