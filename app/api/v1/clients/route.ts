import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_BODY_CAP, fail, IMPORT_BODY_CAP, listBody, ok, readJson, requireApiKeyScopes, requireAuth, requireDeskRole, requirePermission } from '@/lib/server/api';
import { clientStats, clientStatsFor, clientStatus, clientsFor, createClient, ensureClientForBooking, findClientByNumber, normaliseNumber } from '@/lib/server/clients';
import { bookingsFor } from '@/lib/server/bookings';
import { providerById } from '@/lib/server/practice';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { practiceProfile, termsForOrg } from '@/lib/server/practice';
import { clientsCsv, importClients, importTemplateCsv } from '@/lib/server/import-export';
import { resolveExactIdentity } from '@/lib/server/patient-identity';
import { patientAlertsFor, redactPatientAlerts } from '@/lib/server/patient-alerts';
import { permissionDecision, shadowPermissionDecision } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Clients — the people the practice books.
 *
 * Server-first by design: this is the one collection the dashboard never mirrors
 * into `localStorage` (see `lib/privacy.ts` and PRACTICE.md §5). A records-keeping
 * system that leaves a patient list in browser storage is not one.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read');
  if (denied) return denied;
  const url = new URL(req.url);

  // The export is its own answer, not a page of the list: a bookkeeper wants
  // one file, and the front desk wants twenty rows at a time.
  if (url.searchParams.get('view') === 'export') {
    const keyDenied = requireApiKeyScopes(ctx, ['clients:export']);
    if (keyDenied) return keyDenied;
    const exportDenied = requirePermission(ctx, 'clients.export');
    if (exportDenied) return exportDenied;
    const { csv, rows: count } = clientsCsv(ctx.orgId, (client) =>
      ctx.auth !== 'session' || !ctx.user
        ? true
        : shadowPermissionDecision(ctx.user, 'clients.export', { area: 'clients', patientId: client.id }).allowed);
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: '*', action: 'export', actor, actorName, detail: `${count} client(s)` });
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="clients_${new Date().toISOString().slice(0, 10)}.csv"`,
        'x-client-rows': String(count),
        'x-request-id': ctx.requestId,
      },
    });
  }

  const candidateRows = clientsFor(ctx.orgId, {
    includeArchived: url.searchParams.get('includeArchived') === 'true',
    query: url.searchParams.get('q') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    // Alert filtering happens only after permission-aware redaction below; doing
    // it against legacy flags would reveal that a restricted clinical alert exists.
  });
  const rows = ctx.auth === 'session' && ctx.user
    ? candidateRows.filter((client) => shadowPermissionDecision(ctx.user!, 'clients.read', { area: 'clients', patientId: client.id }).allowed)
    : candidateRows;
  // The front desk's question is "who is coming in?" Clinical alert text is a
  // separate permission; reception gets administrative notices only.
  const keyMayReadClinicalAlerts = ctx.auth === 'key'
    && Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes('clinical:read'));
  const visible = (client: (typeof rows)[number]) => {
    const includeClinicalAlerts = keyMayReadClinicalAlerts || (ctx.auth === 'session' && Boolean(
      ctx.user && shadowPermissionDecision(ctx.user, 'clinical.alerts.read', { area: 'clinical', patientId: client.id }).allowed,
    ));
    return {
      ...client,
      alerts: redactPatientAlerts(patientAlertsFor(ctx.orgId, client.id, { includeClinical: includeClinicalAlerts }), includeClinicalAlerts),
      clinicalAlertsRestricted: !includeClinicalAlerts,
    };
  };
  const includeUpcoming = url.searchParams.get('includeUpcoming') === 'true';
  const enrichedBase = includeUpcoming
    ? rows.map((raw) => {
        const client = visible(raw);
        const next = bookingsFor(ctx.orgId, (b) => (b as { clientId?: string }).clientId === client.id && b.status !== 'cancelled' && new Date(b.startsAt).getTime() > Date.now())
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
        return {
          ...client,
          status: clientStatus(raw),
          upcoming: next
            ? {
                id: next.id,
                startsAt: next.startsAt,
                service: next.service,
                providerName: next.providerId ? providerById(ctx.orgId, next.providerId)?.name : undefined,
                status: next.status,
              }
            : undefined,
        };
      })
    : rows.map((client) => ({ ...visible(client), status: clientStatus(client) }));
  const alertFiltered = url.searchParams.get('alertsOnly') === 'true'
    ? enrichedBase.filter((client) => Array.isArray(client.alerts) && client.alerts.length > 0)
    : enrichedBase;
  const requestedLimit = Number(url.searchParams.get('limit') ?? 0) || undefined;
  const enriched = requestedLimit ? alertFiltered.slice(0, requestedLimit) : alertFiltered;

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  if (enriched.length) {
    // One entry for the search, not one per row: the per-record log answers
    // "who opened *this* file", and a list is not that.
    recordAccess({
      orgId: ctx.orgId,
      resource: 'client',
      resourceId: '*',
      action: 'list',
      actor,
      actorName,
      detail: `${enriched.length} result(s)${url.searchParams.get('q') ? ` for "${url.searchParams.get('q')}"` : ''}`,
    });
  }
  const permittedStats = ctx.auth === 'session' && ctx.user?.roleId
    ? clientStatsFor(clientsFor(ctx.orgId).filter((client) =>
        permissionDecision(ctx.user!, 'clients.read', { area: 'clients', patientId: client.id }).allowed))
    : clientStats(ctx.orgId);
  return ok(
    listBody(enriched, {
      stats: {
        ...permittedStats,
        withAlerts: enriched.filter((client) => Array.isArray(client.alerts) && client.alerts.length > 0).length,
      },
      terms: termsForOrg(ctx.orgId),
      profile: { termPack: practiceProfile(ctx.orgId).termPack },
    }),
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write') ?? requireDeskRole(ctx);
  if (denied) return denied;
  // The import action carries a whole CSV in this body; it gets the import
  // cap, everything else on the route keeps the default.
  const body = await readJson<{
    action?: string;
    csv?: string;
    dryRun?: boolean;
    name?: string;
    number?: string;
    email?: string;
    tags?: string[];
    dateOfBirth?: string;
    address?: string;
    note?: string;
    lookupNumber?: string;
  }>(req, IMPORT_BODY_CAP);
  if (body instanceof NextResponse) return body;
  // The import cap exists for CSV payloads only. Every other action on this
  // route lives under the default cap, so a 300 KB "name" cannot ride in on
  // the import allowance.
  if (body.action !== 'import' && !body.csv && Buffer.byteLength(JSON.stringify(body), 'utf8') > DEFAULT_BODY_CAP) {
    return fail('PAYLOAD_TOO_LARGE', `Request body is too large (limit ${Math.round(DEFAULT_BODY_CAP / 1024)} KB).`, { param: 'body', requestId: ctx.requestId });
  }


  // A client list arriving from another system. Same person twice is the thing
  // that ruins an import, so the number is the key and the first look is dry.
  if (body.action === 'import' || body.csv) {
    if (!body.csv || !String(body.csv).trim()) {
      return fail('VALIDATION_ERROR', '`csv` is required — paste the file contents.', { param: 'csv', requestId: ctx.requestId });
    }
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    const report = importClients(ctx.orgId, {
      csv: String(body.csv),
      dryRun: body.dryRun !== false,
      actor,
      actorName,
      source: 'import',
    });
    const blocked = report.invalid.some((row) => row.line === 1);
    if (blocked) return fail('VALIDATION_ERROR', report.invalid[0].reason, { param: 'csv', detail: report.ignoredColumns.join(', ') || undefined, requestId: ctx.requestId });
    return ok({ report, template: report.total === 0 ? importTemplateCsv() : undefined }, { requestId: ctx.requestId });
  }

  // `lookupNumber` is what the AI receptionist does: given only a number, does
  // this person already have a record? Answered here rather than in the agent.
  if (body.lookupNumber) {
    const identity = resolveExactIdentity(ctx.orgId, 'phone', body.lookupNumber);
    const existing = identity.status === 'unique' ? findClientByNumber(ctx.orgId, body.lookupNumber) : undefined;
    if (existing) {
      const recordDenied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: existing.id });
      if (recordDenied) return recordDenied;
    }
    return ok(
      existing
        ? { found: true, client: existing, match: 'exact_unique' }
        : identity.status === 'ambiguous'
          ? { found: false, reviewRequired: true, conflictId: identity.conflict.id }
          : { found: false },
      { requestId: ctx.requestId },
    );
  }

  const name = String(body.name ?? '').trim();
  const number = normaliseNumber(String(body.number ?? ''));
  if (!name) return fail('VALIDATION_ERROR', '`name` is required.', { param: 'name', requestId: ctx.requestId });
  if (!number) return fail('VALIDATION_ERROR', '`number` is required — it is how the practice finds them again.', { param: 'number', requestId: ctx.requestId });
  const exactIdentity = resolveExactIdentity(ctx.orgId, 'phone', number);
  if (exactIdentity.status === 'ambiguous') {
    return fail('CONFLICT', 'That exact number is linked to more than one patient. Review the identity conflict instead of creating or merging a record.', {
      param: 'number',
      detail: `Identity conflict: ${exactIdentity.conflict.id}`,
      requestId: ctx.requestId,
    });
  }
  const duplicate = exactIdentity.status === 'unique' ? findClientByNumber(ctx.orgId, number) : undefined;
  if (duplicate) {
    const recordDenied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: duplicate.id });
    if (recordDenied) return recordDenied;
    return fail('CONFLICT', `${duplicate.name} already uses ${duplicate.number}.`, {
      param: 'number',
      detail: `Existing client: ${duplicate.id}`,
      requestId: ctx.requestId,
    });
  }

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const client = createClient(ctx.orgId, { name, number, email: body.email, tags: body.tags, dateOfBirth: body.dateOfBirth, address: body.address, note: body.note }, actor, { actorName });
  return ok(client, { requestId: ctx.requestId, status: 201 });
}

/** Resolve or create from a number alone — the agent's "do I know you?" moment. */
export async function PUT(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write') ?? requireDeskRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ name?: string; number?: string; email?: string }>(req);
  if (body instanceof NextResponse) return body;
  const number = normaliseNumber(String(body.number ?? ''));
  if (!number) return fail('VALIDATION_ERROR', '`number` is required.', { param: 'number', requestId: ctx.requestId });
  const identity = resolveExactIdentity(ctx.orgId, 'phone', number);
  if (identity.status === 'ambiguous') {
    return fail('CONFLICT', 'That number has multiple exact patient matches and must be reviewed before it can be linked.', {
      param: 'number', detail: `Identity conflict: ${identity.conflict.id}`, requestId: ctx.requestId,
    });
  }
  const existing = identity.status === 'unique' ? findClientByNumber(ctx.orgId, number) : undefined;
  if (existing) {
    const recordDenied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: existing.id });
    if (recordDenied) return recordDenied;
  }
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const client = ensureClientForBooking(ctx.orgId, { name: body.name ?? existing?.name ?? 'Caller', number, email: body.email }, actor, { actorName });
  return ok({ created: !existing, client }, { requestId: ctx.requestId, status: existing ? 200 : 201 });
}
