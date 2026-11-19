import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { list, type Doc } from '@/lib/server/db';
import { callsForDay } from '@/lib/server/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v1/usage — metered usage straight off the call records. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const days = Math.min(Number(url.searchParams.get('days') ?? 30) || 30, 365);

  const calls = callsForDay(ctx.orgId, days).filter((c) => c.status === 'ended');
  const events = list<Doc>('usageEvents', (e) => e.orgId === ctx.orgId);

  const daily = new Map<string, { date: string; calls: number; minutes: number; cost: number }>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.set(date, { date, calls: 0, minutes: 0, cost: 0 });
  }
  for (const call of calls) {
    const date = call.startedAt.slice(0, 10);
    const row = daily.get(date) ?? { date, calls: 0, minutes: 0, cost: 0 };
    row.calls += 1;
    row.minutes += call.durationSeconds / 60;
    row.cost += call.cost.total;
    daily.set(date, row);
  }

  const totals = calls.reduce(
    (acc, c) => {
      acc.minutes += c.durationSeconds / 60;
      acc.platform += c.cost.platform;
      acc.stt += c.cost.stt;
      acc.tts += c.cost.tts;
      acc.llm += c.cost.llm;
      acc.telephony += c.cost.telephony;
      acc.total += c.cost.total;
      return acc;
    },
    { minutes: 0, platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 }
  );

  return ok(
    {
      window_days: days,
      calls: calls.length,
      usage_events: events.length,
      minutes: Number(totals.minutes.toFixed(2)),
      cost: {
        platform_usd: Number(totals.platform.toFixed(4)),
        stt_usd: Number(totals.stt.toFixed(4)),
        tts_usd: Number(totals.tts.toFixed(4)),
        llm_usd: Number(totals.llm.toFixed(4)),
        telephony_usd: Number(totals.telephony.toFixed(4)),
        total_usd: Number(totals.total.toFixed(4)),
      },
      daily: [...daily.values()].map((d) => ({
        ...d,
        minutes: Number(d.minutes.toFixed(2)),
        cost: Number(d.cost.toFixed(4)),
      })),
    },
    { requestId: ctx.requestId }
  );
}
