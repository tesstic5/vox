import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireDeskRole, requirePermission } from '@/lib/server/api';
import { archiveClient, clientById, restoreClient, updateClient } from '@/lib/server/clients';
import { actorLabel, accessLogFor, recordView } from '@/lib/server/access-log';
import { bookingsFor } from '@/lib/server/bookings';
import { providerById, serviceById } from '@/lib/server/practice';
import { listAllByOrg, type Doc } from '@/lib/server/db';
import { canReadNotes, notesFor, noteSummary, redactNote } from '@/lib/server/notes';
import { balanceMinorOf, canReadMoney, clientBalance, formatMoney, invoicesFor, paymentsFor, statement } from '@/lib/server/money';
import { patientAlertsFor, redactPatientAlerts } from '@/lib/server/patient-alerts';
import { permissionDecision } from '@/lib/server/permissions';
import { contactPointsFor } from '@/lib/server/patient-identity';
import { formAssignmentsFor, formResponsesFor } from '@/lib/server/forms';
import { referralsFor } from '@/lib/server/referrals';
import { lettersFor } from '@/lib/server/letters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One client, with everything the desk needs in a single read: their details,
 * their history (appointments and the calls that touched them), their alerts and
 * consents, and who has looked at the record.
 *
 * Reading a record is itself logged — once per person per hour, so a refresh
 * loop is not a history entry.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const requestedClient = clientById(ctx.orgId, id) as ReturnType<typeof clientById> & { mergedIntoClientId?: string };
  if (!requestedClient) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  const redirectId = requestedClient.mergedIntoClientId;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: redirectId ?? id });
  if (denied) return denied;
  const client = redirectId ? clientById(ctx.orgId, redirectId) : requestedClient;
  if (!client) return fail('NOT_FOUND', `The merged client redirect for ${id} is unavailable.`, { requestId: ctx.requestId });

  const patientId = client.id;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordView({ orgId: ctx.orgId, resource: 'client', resourceId: patientId, actor, actorName });

  const appointments = bookingsFor(ctx.orgId, (b) => (b as { clientId?: string }).clientId === patientId).sort(
    (a, b) => b.startsAt.localeCompare(a.startsAt)
  );
  const callIds = new Set(appointments.flatMap((b) => b.callIds ?? []));
  const calls = listAllByOrg<Doc & { id: string; assistantName?: string; startedAt?: string; endedReason?: string; analysis?: { summary?: string } }>(
    'calls', ctx.orgId,
  ).filter((c) => callIds.has(c.id)).map((c) => ({ id: c.id, assistantName: c.assistantName, startedAt: c.startedAt, endedReason: c.endedReason, summary: c.analysis?.summary }));

  // Notes travel with the record — the desk needs to know one exists and whether
  // it is signed; a practitioner needs what it says. One read, two shapes.
  // A narrow `clients:read` key may read the client record, not piggyback into
  // clinical notes. Notes routes accept only sessions or an explicit wildcard
  // key, so this aggregate endpoint keeps the same boundary.
  const wildcardKey = ctx.auth === 'key' && Boolean(ctx.key?.scopes.includes('*'));
  const clinicalKey = ctx.auth === 'key' && Boolean(ctx.key?.scopes.includes('clinical:read'));
  const canRead = wildcardKey || clinicalKey || (ctx.auth === 'session' && Boolean(
    ctx.user?.roleId ? permissionDecision(ctx.user, 'clinical.read', { area: 'clinical', patientId }).allowed : canReadNotes(ctx.user?.role),
  ));
  const canReadClinicalAlerts = wildcardKey || clinicalKey || (ctx.auth === 'session' && Boolean(
    ctx.user && permissionDecision(ctx.user, 'clinical.alerts.read', { area: 'clinical', patientId }).allowed,
  ));
  const alerts = patientAlertsFor(ctx.orgId, patientId, { includeClinical: canReadClinicalAlerts });
  const sessionCan = (permission: 'forms.read' | 'forms.review' | 'referrals.read' | 'letters.read') => ctx.auth === 'session' && Boolean(ctx.user && permissionDecision(ctx.user, permission).allowed);
  const keyCan = (scope: 'forms:read' | 'referrals:read' | 'letters:read') => ctx.auth === 'key' && Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes(scope));
  const canReadForms = sessionCan('forms.read') || keyCan('forms:read');
  const canReviewForms = sessionCan('forms.review') || keyCan('forms:read');
  const canReadReferrals = sessionCan('referrals.read') || keyCan('referrals:read');
  const canReadLetters = sessionCan('letters.read') || keyCan('letters:read');
  const notes = notesFor(ctx.orgId, { clientId: patientId, includeArchived: true }).sort(
    (a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt))
  );

  return ok(
    {
      ...client,
      redirectedFrom: redirectId ? id : undefined,
      alerts: redactPatientAlerts(alerts, canReadClinicalAlerts),
      clinicalAlertsRestricted: !canReadClinicalAlerts,
      contactPoints: contactPointsFor(ctx.orgId, patientId),
      notes: canRead ? notes.map((n) => noteSummary(n, { includeBody: false })) : notes.map((n) => redactNote(n)),
      notesRestricted: !canRead,
      ...(canReadForms ? {
        formAssignments: formAssignmentsFor(ctx.orgId, { clientId: patientId }).map(({ tokenHash: _tokenHash, ...assignment }) => assignment),
        formResponses: canReviewForms ? formResponsesFor(ctx.orgId, { clientId: patientId }) : [],
        formResponsesRestricted: !canReviewForms,
      } : { formsRestricted: true }),
      ...(canReadReferrals ? {
        referrals: referralsFor(ctx.orgId).filter((referral) => referral.convertedClientId === patientId),
      } : { referralsRestricted: true }),
      ...(canReadLetters ? {
        letters: lettersFor(ctx.orgId, { clientId: patientId }),
      } : { lettersRestricted: true }),
      // Money travels with the record too (P6): the same read answers "do they owe
      // us anything?" — which is the question the desk asks on every call. The
      // ledger is the client's own: their invoices, their payments, their balance.
      ...(wildcardKey || (ctx.auth === 'key' && Boolean(ctx.key?.scopes.includes('money:read'))) || (ctx.auth === 'session' && Boolean(
        ctx.user?.roleId ? permissionDecision(ctx.user, 'money.read').allowed : canReadMoney(ctx.user?.role),
      ))
        ? (() => {
            const invoices = invoicesFor(ctx.orgId, { clientId: patientId, includeDrafts: true });
            const balance = clientBalance(ctx.orgId, patientId);
            const ledger = statement(ctx.orgId, patientId);
            return {
              money: {
                dueMinor: balance.dueMinor,
                creditMinor: balance.creditMinor,
                balanceMinor: balance.balanceMinor,
                currency: balance.currency,
                dueFormatted: formatMoney(balance.dueMinor, balance.currency),
                creditFormatted: formatMoney(balance.creditMinor, balance.currency),
                balanceFormatted: formatMoney(balance.balanceMinor, balance.currency),
                invoices: invoices.map((invoice) => ({
                  id: invoice.id,
                  number: invoice.number,
                  kind: invoice.kind,
                  status: invoice.status,
                  issued: invoice.issueDate,
                  dueDate: invoice.dueDate,
                  totalMinor: invoice.totalMinor,
                  balanceMinor: balanceMinorOf(invoice),
                  balanceFormatted: formatMoney(balanceMinorOf(invoice), invoice.currency),
                  currency: invoice.currency,
                })),
                payments: paymentsFor(ctx.orgId, { clientId: patientId }).slice(0, 20),
                statement: ledger ? { rows: ledger.rows.slice(-25), reconciled: ledger.reconciled, closingMinor: ledger.closingMinor } : undefined,
              },
            };
          })()
        : { moneyRestricted: true }),
      appointments: appointments.map((b) => ({
        ...b,
        providerName: b.providerId ? providerById(ctx.orgId, b.providerId)?.name : undefined,
        serviceName: b.serviceId ? serviceById(ctx.orgId, b.serviceId)?.name : b.service,
      })),
      calls,
      access: accessLogFor(ctx.orgId, 'client', patientId, 30),
    },
    { requestId: ctx.requestId }
  );
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const requestedClient = clientById(ctx.orgId, id) as ReturnType<typeof clientById> & { mergedIntoClientId?: string };
  if (!requestedClient) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  const canonicalId = requestedClient.mergedIntoClientId ?? id;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: canonicalId }) ?? requireDeskRole(ctx);
  if (denied) return denied;
  if (requestedClient.mergedIntoClientId) {
    return fail('CONFLICT', `Client ${id} has been merged into ${canonicalId}; write to the canonical record.`, {
      param: 'id', detail: `canonicalPatientId=${canonicalId}`, requestId: ctx.requestId,
    });
  }
  const body = await readJson<Record<string, unknown> & { restore?: boolean }>(req);
  if (body instanceof NextResponse) return body;

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  if (body.restore) {
    const unknown = Object.keys(body).find((key) => key !== 'restore');
    if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` cannot accompany a restore.`, { param: unknown, requestId: ctx.requestId });
    const restored = restoreClient(ctx.orgId, id, actor, actorName);
    if (!restored) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
    return ok(restored, { requestId: ctx.requestId });
  }

  const editable = new Set(['name', 'firstName', 'lastName', 'number', 'email', 'dateOfBirth', 'address', 'tags', 'consents', 'note']);
  const unknown = Object.keys(body).find((key) => !editable.has(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is server-managed and cannot be changed here.`, { param: unknown, requestId: ctx.requestId });
  const patch = Object.fromEntries(Object.entries(body).filter(([key]) => editable.has(key))) as Record<string, unknown>;
  const updated = updateClient(ctx.orgId, id, patch as never, actor, { actorName });
  if (!updated) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  return ok(updated, { requestId: ctx.requestId });
}

/**
 * DELETE archives. A client with a history is not deleted — the record keeps
 * its appointments and notes, and can be restored. A purge date exists only
 * when the deployment has an explicit operator retention policy.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const existing = clientById(ctx.orgId, id) as ReturnType<typeof clientById> & { mergedIntoClientId?: string };
  if (!existing) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  const canonicalId = existing.mergedIntoClientId ?? id;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: canonicalId }) ?? requireDeskRole(ctx);
  if (denied) return denied;
  if (existing.mergedIntoClientId) {
    return fail('CONFLICT', `Client ${id} has been merged into ${canonicalId}; archive the canonical record instead.`, {
      param: 'id', detail: `canonicalPatientId=${canonicalId}`, requestId: ctx.requestId,
    });
  }
  const body = await readJson<{ reason?: string; force?: boolean }>(req);
  if (body instanceof NextResponse) return body;

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  // Only work still to come blocks an archive: a completed or no-show visit is
  // history, and history is exactly what archiving is for.
  const upcoming = bookingsFor(
    ctx.orgId,
    (b) =>
      (b as { clientId?: string }).clientId === id &&
      ['pending', 'confirmed', 'arrived'].includes(String(b.status)) &&
      new Date(b.startsAt).getTime() > Date.now()
  ).length;
  if (upcoming > 0 && !body.force) {
    return fail('CONFLICT', `${existing.name} has ${upcoming} upcoming appointment(s). Cancel or move them first.`, {
      param: 'id',
      detail: `Upcoming appointments: ${upcoming}.`,
      requestId: ctx.requestId,
    });
  }
  const archived = archiveClient(ctx.orgId, id, actor, { reason: body.reason, actorName });
  return ok({ ...archived, archived: true }, { requestId: ctx.requestId });
}
