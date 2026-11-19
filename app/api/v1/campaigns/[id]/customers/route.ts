import { NextResponse, type NextRequest } from 'next/server';
import { fail, IMPORT_BODY_CAP, ok, readJson, requireAuth } from '@/lib/server/api';
import { get, insertMany, newId, nowIso, list, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Campaign audience.
 *
 * Inline up to 10,000 rows; paste a CSV body and it is parsed the same way the
 * dashboard's batch importer parses it. Each row becomes a customer record with
 * a dial state, so progress is resumable rather than a counter.
 */
type Customer = { id: string; campaignId: string; orgId: string; name?: string; phone: string; state: string; attempts: number; createdAt: string };

function parseCsv(text: string) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const phoneIdx = Math.max(0, header.indexOf('phone'));
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return { name: row.name ?? undefined, phone: cells[phoneIdx].trim() };
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const campaign = get<Doc>('campaigns', id);
  if (!campaign || campaign.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No campaign with id ${id}.`, { requestId: ctx.requestId });
  }
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 1000);
  const all = list<Customer>('campaignCustomers', (c) => c.campaignId === id && c.orgId === ctx.orgId);
  return ok(
    {
      object: 'list',
      campaignId: id,
      data: all.slice(0, limit),
      total: all.length,
      has_more: all.length > limit,
      states: all.reduce<Record<string, number>>((acc, c) => {
        acc[c.state] = (acc[c.state] ?? 0) + 1;
        return acc;
      }, {}),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const campaign = get<Doc>('campaigns', id);
  if (!campaign || campaign.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No campaign with id ${id}.`, { requestId: ctx.requestId });
  }

  const contentType = req.headers.get('content-type') ?? '';
  let rows: { name?: string; phone: string }[] = [];
  if (contentType.includes('text/csv')) {
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > IMPORT_BODY_CAP) {
      return fail('PAYLOAD_TOO_LARGE', 'That customer list is too large (limit 5 MB). Split it and import in batches.', { requestId: ctx.requestId });
    }
    rows = parseCsv(raw);
  } else {
    const body = await readJson<{ customers?: { name?: string; phone?: string }[] }>(req);
    if (body instanceof NextResponse) return body;
    rows = (body.customers ?? []).map((c) => ({ name: c.name, phone: String(c.phone ?? '') }));
  }

  const valid = rows.filter((r) => /^\+?\d{7,15}$/.test(r.phone.replace(/[^\d+]/g, '')));
  if (!valid.length) {
    return fail('VALIDATION_ERROR', 'No rows with a usable `phone` column. Send `customers: [{ phone }]` or a CSV with a `phone` header.', {
      param: 'customers',
      requestId: ctx.requestId,
    });
  }
  if (valid.length > 10000) {
    return fail('VALIDATION_ERROR', 'Inline audiences cap at 10,000 rows — split the list and append.', { param: 'customers', requestId: ctx.requestId });
  }

  const inserted = insertMany<Customer>(
    'campaignCustomers',
    valid.map((r) => ({
      id: newId('cust_'),
      campaignId: id,
      orgId: ctx.orgId,
      name: r.name,
      phone: r.phone.replace(/[^\d+]/g, ''),
      state: 'pending',
      attempts: 0,
      createdAt: nowIso(),
    })) as Customer[]
  );

  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'campaign.customers_added', target: id, detail: `${inserted.length} rows` });
  return ok({ campaignId: id, added: inserted.length, rejected: rows.length - valid.length, total: list<Customer>('campaignCustomers', (c) => c.campaignId === id).length }, { requestId: ctx.requestId, status: 201 });
}
