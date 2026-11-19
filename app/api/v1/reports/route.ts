import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { audit } from '@/lib/server/audit';
import { locationsFor } from '@/lib/server/practice';
import {
  attendanceReport,
  attributionReport,
  costsReport,
  exportReport,
  rangeFrom,
  recallReport,
  reportsOverview,
  revenueReport,
  utilisationReport,
  type ReportKind,
} from '@/lib/server/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VIEWS = ['overview', 'revenue', 'utilisation', 'attendance', 'costs', 'attribution', 'recalls', 'export'] as const;
const KINDS: ReportKind[] = ['revenue', 'utilisation', 'attendance', 'costs', 'attribution', 'recalls'];

/**
 * Practice reports — one window, every view.
 *
 * `view=overview` is the screen's single fetch: the headlines plus the sections
 * behind them, all cut to the same from/to. The per-view forms exist because an
 * API caller should not have to download six sections to ask one question, and
 * `view=export` returns a spreadsheet of whichever report was asked for.
 *
 * The window is resolved in the practice's timezone (`rangeFrom`), so "this
 * month" means the practice's month — the same rule the diary and the money
 * screen already follow.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(req.url);
  const view = (url.searchParams.get('view') ?? 'overview') as (typeof VIEWS)[number];
  if (!VIEWS.includes(view)) {
    return fail('VALIDATION_ERROR', `\`view\` must be one of: ${VIEWS.join(', ')}.`, { param: 'view', requestId: ctx.requestId });
  }

  // The practice's own clock, the same source the messaging rules and the
  // no-show report use — a day is the day the diary is written in.
  const timezone = url.searchParams.get('timezone') ?? locationsFor(ctx.orgId)[0]?.timezone ?? 'UTC';
  const range = rangeFrom({
    preset: url.searchParams.get('preset'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    days: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : undefined,
    timezone,
  });

  if (view === 'export') {
    const kind = (url.searchParams.get('kind') ?? 'revenue') as ReportKind;
    if (!KINDS.includes(kind)) {
      return fail('VALIDATION_ERROR', `\`kind\` must be one of: ${KINDS.join(', ')}.`, { param: 'kind', requestId: ctx.requestId });
    }
    const file = exportReport(ctx.orgId, range, kind);
    // Leaving with the numbers is an event worth a row: the per-record access log
    // is for patient records, and a report is an aggregate — so this goes to the
    // workspace audit trail instead, where a practice would look for it.
    const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    audit({
      orgId: ctx.orgId,
      actor,
      action: 'report.exported',
      target: kind,
      detail: `${range.from} → ${range.to} — ${file.rows} row(s), ${file.filename}`,
    });
    return new NextResponse(file.csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${file.filename}"`,
        'x-report-rows': String(file.rows),
        'x-report-range': `${range.from}_${range.to}`,
      },
    });
  }

  // `days` on a per-view call is the shortcut a dashboard tile uses; everything
  // else goes through the same resolver as the overview, so no two screens can
  // disagree about what "the last 90 days" was.
  //
  // These two are read *before* the overview branch on purpose. They used to be
  // parsed below it, so `?view=overview&recallDays=30` — the exact call the
  // recalls tab makes — quietly ignored the window it was asked for, and the tab
  // reported the practice's own number back to the person who had just overridden
  // it. A parameter that works on one view and not the one that shows it is a bug.
  const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
  const interval = url.searchParams.get('recallDays') ? Number(url.searchParams.get('recallDays')) : undefined;

  const include = url.searchParams.get('include') ?? undefined;
  if (view === 'overview') {
    return ok(reportsOverview(ctx.orgId, range, { include, intervalDays: interval, limit }), { requestId: ctx.requestId });
  }

  const payload =
    view === 'revenue'
      ? revenueReport(ctx.orgId, range)
      : view === 'utilisation'
        ? utilisationReport(ctx.orgId, range)
        : view === 'attendance'
          ? attendanceReport(ctx.orgId, range)
          : view === 'costs'
            ? costsReport(ctx.orgId, range)
            : view === 'attribution'
              ? attributionReport(ctx.orgId, range)
              : recallReport(ctx.orgId, range, { intervalDays: interval, limit });

  return ok(payload, { requestId: ctx.requestId });
}
