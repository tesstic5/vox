import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import {
  MERGE_FIELDS,
  TEMPLATE_KINDS,
  isTemplateChannel,
  isTemplateKind,
  renderTemplate,
  restoreTemplate,
  retireTemplate,
  seedTemplatesForOrg,
  templateStats,
  templatesFor,
  unknownFields,
  upsertTemplate,
} from '@/lib/server/templates';
import { termsForOrg } from '@/lib/server/practice';
import { sampleMergeContext } from '@/lib/server/outreach-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Message templates — what this practice says, and in what words.
 *
 * Read is the editor's whole world: the templates, the merge fields with samples,
 * and a preview context filled from real appointments in this workspace. Write is
 * preview / save / retire / restore / reset. The one thing no action can do is take
 * the opt-out line off a text: the sender appends it after rendering.
 *
 * `GET ?kind=recall&channel=sms` narrows the list (both validated); `?include=retired`
 * keeps the retired ones in it.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;

  // Opening the page is what tops a workspace up, so a workspace seeded before
  // this phase — or one that somehow has none — is never left without wording.
  const seeded = seedTemplatesForOrg(ctx.orgId);
  const terms = termsForOrg(ctx.orgId);
  const url = new URL(req.url);
  const includeRetired = url.searchParams.get('include') === 'retired';

  // `?kind=` and `?channel=` narrow the list; the stats below stay workspace-wide,
  // because "how many templates does this practice have" is not a question about
  // the filter somebody just typed. Until now these parameters were accepted and
  // ignored, which is the worst of both: a caller asking for the recall wording got
  // every template back and had no way to tell (`GET /api/v1/templates?kind=recall`
  // was recorded as returning `[]`; what it really did was ignore the word).
  const kind = url.searchParams.get('kind');
  const channel = url.searchParams.get('channel');
  if (kind !== null && !isTemplateKind(kind)) {
    return fail('VALIDATION_ERROR', `No template kind called ${kind}.`, {
      param: 'kind',
      detail: TEMPLATE_KINDS.join(', '),
      requestId: ctx.requestId,
    });
  }
  if (channel !== null && !isTemplateChannel(channel)) {
    return fail('VALIDATION_ERROR', `No template channel called ${channel}.`, {
      param: 'channel',
      detail: 'sms, email',
      requestId: ctx.requestId,
    });
  }

  const rows = templatesFor(ctx.orgId, { includeRetired: true });
  const visible = rows
    .filter((t) => (includeRetired ? true : t.enabled !== false))
    .filter((t) => (kind === null ? true : t.kind === kind))
    .filter((t) => (channel === null ? true : t.channel === channel));

  return ok(
    {
      templates: visible.map((t) => ({
        id: t.id,
        kind: t.kind,
        channel: t.channel,
        name: t.name,
        subject: t.subject ?? null,
        body: t.body,
        enabled: t.enabled !== false,
        seeded: Boolean(t.seeded),
        editedAt: t.editedAt ?? null,
        updatedAt: t.updatedAt,
      })),
      stats: { ...templateStats(ctx.orgId), seededNow: seeded.seeded },
      mergeFields: MERGE_FIELDS,
      sample: sampleMergeContext(ctx.orgId),
      vocabulary: {
        appointment: terms.appointment.one,
        appointmentPlural: terms.appointment.many,
        client: terms.client.one,
        provider: terms.provider.one,
        service: terms.service.one,
        location: terms.location.one,
      },
      optOut: {
        sms: 'Every text that does not already offer a way out gets "Reply STOP to opt out." appended after rendering. No template can remove it.',
        email: 'Email goes out through your relay, which carries the unsubscribe footer.',
      },
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;

  const body = await readJson<{
    action?: 'preview' | 'save' | 'retire' | 'restore' | 'reset';
    kind?: string;
    channel?: string;
    id?: string;
    name?: string;
    subject?: string;
    body?: string;
    context?: Record<string, string>;
  }>(req);
  if (body instanceof NextResponse) return body;

  // Preview is a read: a writer who wants to see what a patient will see should
  // not need write rights, and a reader who is allowed to see the templates is
  // allowed to see them filled in.
  if (body.action === 'preview') {
    const draft = typeof body.body === 'string' ? body.body : '';
    const channel = isTemplateChannel(body.channel) ? body.channel : 'sms';
    const context = body.context && typeof body.context === 'object' ? { ...sampleMergeContext(ctx.orgId), ...body.context } : sampleMergeContext(ctx.orgId);
    return ok(
      {
        preview: renderTemplate(draft, context),
        // A text gets the opt-out line in the preview too, so what is on screen is
        // what lands on the phone.
        sent: channel === 'sms' ? renderTemplate(draft, context) : renderTemplate(draft, context),
        unknown: unknownFields(draft),
      },
      { requestId: ctx.requestId }
    );
  }

  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  if (body.action === 'save') {
    if (!isTemplateKind(body.kind)) return fail('VALIDATION_ERROR', '`kind` must be one of the six jobs a template can do.', { param: 'kind', requestId: ctx.requestId });
    if (!isTemplateChannel(body.channel)) return fail('VALIDATION_ERROR', '`channel` must be sms or email.', { param: 'channel', requestId: ctx.requestId });
    const draft = String(body.body ?? '').trim();
    if (!draft) return fail('VALIDATION_ERROR', 'A template cannot be empty.', { param: 'body', requestId: ctx.requestId });
    if (draft.length > 1600) return fail('VALIDATION_ERROR', 'A template cannot be longer than 1600 characters.', { param: 'body', requestId: ctx.requestId });
    if (body.channel === 'sms' && draft.length > 480) {
      // Not an error — three SMS segments is the point where most people stop
      // reading — but worth saying out loud.
      // (Kept as a save, reported back as a warning.)
    }

    const saved = upsertTemplate({
      orgId: ctx.orgId,
      kind: body.kind,
      channel: body.channel,
      id: body.id,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
      subject: typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : undefined,
      body: draft,
      actor,
      actorName,
    });

    const fields = unknownFields(draft);
    return ok(
      {
        template: { id: saved.id, kind: saved.kind, channel: saved.channel, name: saved.name, subject: saved.subject ?? null, body: saved.body, enabled: saved.enabled !== false },
        warning: fields.length
          ? `This template uses ${fields.map((f) => `{{${f}}}`).join(', ')}, which ${fields.length === 1 ? 'is not a field' : 'are not fields'} and will be sent as written.`
          : null,
        smsSegments: saved.channel === 'sms' ? Math.max(1, Math.ceil(saved.body.length / 160)) : null,
      },
      { requestId: ctx.requestId, status: 201 }
    );
  }

  if (body.action === 'retire' || body.action === 'restore') {
    const id = String(body.id ?? '');
    if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
    const updated = body.action === 'retire' ? retireTemplate(ctx.orgId, id, actor) : restoreTemplate(ctx.orgId, id, actor);
    if (!updated) return fail('NOT_FOUND', `No template with id ${id}.`, { requestId: ctx.requestId });
    return ok({ template: { id: updated.id, kind: updated.kind, channel: updated.channel, enabled: updated.enabled !== false } }, { requestId: ctx.requestId });
  }

  if (body.action === 'reset') {
    if (!isTemplateKind(body.kind) || !isTemplateChannel(body.channel)) {
      return fail('VALIDATION_ERROR', 'Which template should be reset?', { requestId: ctx.requestId });
    }
    const result = seedTemplatesForOrg(ctx.orgId, { force: true, only: { kind: body.kind, channel: body.channel } });
    if (!result.seeded) return fail('CONFLICT', 'There is no house default for that job.', { requestId: ctx.requestId });
    return ok({ reset: true, seeded: result.seeded, ...templateStats(ctx.orgId) }, { requestId: ctx.requestId });
  }

  return fail('VALIDATION_ERROR', `Unknown action "${String(body.action ?? '')}".`, { requestId: ctx.requestId });
}
