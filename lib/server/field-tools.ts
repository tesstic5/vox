/** Built-in assistant tools for contractor enquiries and approved field visits. */
import { businessProfileFor } from './business-profile';
import { enquiriesFor, createEnquiry, jobsFor, visitsFor, scheduleVisit } from './field-service';
import { locationsFor, providersFor } from './practice';
import { resolveWhen, type BookingToolContext } from './booking-tools';
import type { ToolCall } from './agent';

const FIELD_TOOLS = new Set(['capture_field_enquiry', 'schedule_approved_visit']);

function digits(value: unknown) {
  return String(value ?? '').replace(/\D/g, '').slice(-10);
}

function text(value: unknown) {
  return String(value ?? '').trim();
}

export async function runFieldTool(input: {
  ctx: BookingToolContext;
  name: string;
  args: Record<string, unknown>;
  text?: string;
}): Promise<ToolCall | undefined> {
  const { ctx, name } = input;
  if (!FIELD_TOOLS.has(name)) return undefined;
  const started = Date.now();
  const args = { ...input.args };
  const done = (result: Record<string, unknown>, status: 'ok' | 'error' = 'ok'): ToolCall => ({
    name,
    args: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== '')),
    result: JSON.stringify(result),
    ms: Math.max(40, Date.now() - started),
    status,
  });

  if (!businessProfileFor(ctx.orgId).modules.includes('field_service')) {
    return done({ available: false, needsHuman: true, reason: 'field_service_module_disabled', summary: 'Field-service actions are not enabled for this workspace.' }, 'error');
  }

  if (name === 'capture_field_enquiry') {
    // Model retries and carrier retries must not create two enquiries for one call.
    if (ctx.callId) {
      const existing = enquiriesFor(ctx.orgId).find((row) => row.source === 'assistant' && row.callId === ctx.callId);
      if (existing) {
        return done({ captured: true, duplicate: true, reference: existing.reference, enquiryId: existing.id, summary: `The enquiry is already saved as ${existing.reference}.` });
      }
    }

    const customerName = text(args.name);
    const phone = text(args.phone) || text(ctx.callerNumber);
    const description = text(args.description) || text(input.text);
    const line1 = text(args.addressLine1);
    const city = text(args.city);
    const missing = [
      !customerName && 'customer name',
      digits(phone).length < 7 && 'callback number',
      description.length < 5 && 'work description',
      !line1 && 'service address',
      !city && 'city or locality',
    ].filter(Boolean);
    if (missing.length) {
      return done({ captured: false, missing, needsHuman: false, summary: `I still need ${missing.join(', ')} before I can save the enquiry.` }, 'error');
    }

    const urgencyRaw = text(args.urgency).toLowerCase();
    const urgency = ['routine', 'soon', 'urgent', 'emergency'].includes(urgencyRaw) ? urgencyRaw as 'routine' | 'soon' | 'urgent' | 'emergency' : 'routine';
    const result = createEnquiry({
      orgId: ctx.orgId,
      customer: { name: customerName, number: phone, email: text(args.email) || undefined },
      description,
      urgency,
      siteAddress: {
        line1,
        line2: text(args.addressLine2) || undefined,
        city,
        region: text(args.region) || undefined,
        postalCode: text(args.postalCode) || undefined,
        country: text(args.country).toUpperCase() || undefined,
      },
      source: 'assistant',
      callId: ctx.callId,
      actor: { id: ctx.callId ? `call:${ctx.callId}` : 'assistant', label: 'assistant' },
    });
    if (!result.ok) return done({ captured: false, needsHuman: true, reason: result.code, summary: result.error }, 'error');
    return done({
      captured: true,
      reference: result.value.reference,
      enquiryId: result.value.id,
      urgency: result.value.urgency,
      summary: `${result.value.reference} is saved for human review. No price, visit time or arrival promise has been made.`,
    });
  }

  // Scheduling acts only on a visit a person already added to a real job. It
  // cannot create a job, infer approval from a conversation, or quote a price.
  const reference = text(args.jobReference).toUpperCase();
  const callerDigits = digits(ctx.callerNumber);
  let candidates = jobsFor(ctx.orgId).filter((job) => !['completed', 'cancelled'].includes(job.status));
  if (reference) candidates = candidates.filter((job) => job.reference.toUpperCase() === reference || job.id === text(args.jobReference));
  if (callerDigits) candidates = candidates.filter((job) => digits(job.customer.number).endsWith(callerDigits));
  if (!ctx.viewer && !callerDigits) {
    return done({ scheduled: false, needsHuman: true, reason: 'caller_not_verified', summary: 'I need a recognised callback number before changing a customer visit.' }, 'error');
  }
  if (candidates.length !== 1) {
    return done({
      scheduled: false,
      needsHuman: true,
      reason: candidates.length ? 'ambiguous_job' : 'approved_job_not_found',
      references: candidates.slice(0, 5).map((job) => job.reference),
      summary: candidates.length ? 'More than one active job matches; a person must confirm which one.' : 'I could not find one approved active job for this caller.',
    }, 'error');
  }
  const job = candidates[0];
  let visitCandidates = visitsFor(ctx.orgId, { jobId: job.id }).filter((visit) => !['completed', 'cancelled'].includes(visit.status));
  const visitReference = text(args.visitReference).toUpperCase();
  if (visitReference) visitCandidates = visitCandidates.filter((visit) => visit.reference.toUpperCase() === visitReference || visit.id === text(args.visitReference));
  if (visitCandidates.length !== 1) {
    return done({
      scheduled: false,
      needsHuman: true,
      reason: visitCandidates.length ? 'ambiguous_visit' : 'approved_visit_not_found',
      visits: visitCandidates.slice(0, 5).map((visit) => ({ reference: visit.reference, status: visit.status })),
      summary: visitCandidates.length ? 'More than one open visit exists; a person must confirm which one.' : 'No open approved visit is ready to schedule.',
    }, 'error');
  }
  const visit = visitCandidates[0];
  if (visit.status !== 'unassigned') {
    return done({
      scheduled: true,
      alreadyScheduled: true,
      jobReference: job.reference,
      visitReference: visit.reference,
      startsAt: visit.startsAt,
      summary: visit.startsAt ? `The approved visit is already scheduled for ${new Date(visit.startsAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC. A person must approve a change.` : 'This visit is already in progress.',
      needsHuman: true,
    });
  }

  const activeLocations = locationsFor(ctx.orgId).filter((row) => row.active !== false);
  const wantedLocation = text(args.location).toLowerCase();
  const locationCandidates = wantedLocation
    ? activeLocations.filter((row) => row.id === text(args.location) || row.name.toLowerCase() === wantedLocation || row.name.toLowerCase().includes(wantedLocation))
    : activeLocations;
  if (locationCandidates.length !== 1) {
    return done({
      scheduled: false,
      needsHuman: true,
      reason: locationCandidates.length ? 'dispatch_location_required' : 'dispatch_location_not_found',
      locations: locationCandidates.map((row) => row.name),
      summary: locationCandidates.length ? 'A dispatch location must be confirmed before checking its rota.' : 'That dispatch location is not available.',
    }, 'error');
  }
  const location = locationCandidates[0];
  const resolved = resolveWhen({ date: text(args.date), time: text(args.time), timezone: location.timezone });
  if (!resolved.iso) return done({ scheduled: false, needsHuman: false, missing: ['specific date and time'], summary: resolved.error ?? 'I need a specific date and time.' }, 'error');

  const wantedTechnician = text(args.technician).toLowerCase();
  let technicians = providersFor(ctx.orgId).filter((row) => row.active !== false && row.locationIds.includes(location.id));
  if (wantedTechnician) technicians = technicians.filter((row) => row.id === text(args.technician) || row.name.toLowerCase() === wantedTechnician || row.name.toLowerCase().includes(wantedTechnician));
  if (!technicians.length) {
    return done({ scheduled: false, needsHuman: true, reason: 'technician_not_available', summary: 'No active technician matches that dispatch location.' }, 'error');
  }

  const conflicts: string[] = [];
  for (const technician of technicians) {
    const scheduled = scheduleVisit({
      orgId: ctx.orgId,
      id: visit.id,
      startsAt: resolved.iso,
      providerId: technician.id,
      locationId: location.id,
      serviceId: visit.serviceId,
      durationMinutes: visit.durationMinutes,
      travelBufferMinutes: visit.travelBufferMinutes,
      actor: { id: ctx.callId ? `call:${ctx.callId}` : 'assistant', label: 'assistant' },
    });
    if (scheduled.ok) {
      return done({
        scheduled: true,
        jobReference: job.reference,
        visitReference: scheduled.value.reference,
        startsAt: scheduled.value.startsAt,
        durationMinutes: scheduled.value.durationMinutes,
        technician: technician.name,
        dispatchLocation: location.name,
        summary: `${scheduled.value.reference} is scheduled against the live diary. This is a visit time, not a price or guaranteed arrival window.`,
      });
    }
    conflicts.push(`${technician.name}: ${scheduled.error}`);
  }
  return done({
    scheduled: false,
    needsHuman: true,
    reason: 'no_conflict_free_technician',
    conflicts,
    summary: 'That time is not available in the live diary. I have not booked or promised it; a person should offer another time.',
  }, 'error');
}
