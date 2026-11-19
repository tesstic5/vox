/**
 * Message templates.
 *
 * A practice does not want to write every confirmation from scratch, and it does
 * not want to be stuck with ours either. So: a template per job-to-be-done, with
 * merge fields, seeded in the workspace's own vocabulary and editable from the
 * dashboard.
 *
 * Four decisions worth stating:
 *
 *   - **Merge fields are `{{name}}`, written by us and rendered by us.** Not
 *     Handlebars, not `eval`. A template is data a customer can edit, and data a
 *     customer can edit must not be able to run anything.
 *   - **The rendered text is what gets stored.** The message row keeps the body
 *     that was actually sent, so editing a template tomorrow does not rewrite what
 *     somebody received today.
 *   - **Templates are never deleted, only retired.** Somebody will one day ask what
 *     the wording used to be.
 *   - **One switch per job, not two.** Whether a job runs at all is the *rule*
 *     (`outreach-rules.ts`); a template only decides the wording. A retired
 *     template does not silence a rule — the message falls back to a plain
 *     sentence, because "we had no wording for this" is not a reason to leave a
 *     patient uninformed.
 */

import { insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { termsForOrg } from './practice';
import type { Terms } from '@/lib/terms';

export type TemplateKind =
  | 'confirmation'
  | 'reminder'
  | 'followup'
  | 'no_show'
  | 'winback'
  | 'recall'
  | 'waitlist_offer'
  /** A place in a class, offered to one person in its line. */
  | 'class_offer'
  /** Money in: "we have received it". */
  | 'receipt'
  /** Money out: "we have sent it back". */
  | 'refund'
  /** Money still owed, on a schedule the practice sets. */
  | 'overdue';
export type TemplateChannel = 'sms' | 'email';

export const TEMPLATE_KINDS: TemplateKind[] = [
  'confirmation',
  'reminder',
  'followup',
  'no_show',
  'winback',
  'recall',
  'waitlist_offer',
  'class_offer',
  'receipt',
  'refund',
  'overdue',
];

export type TemplateDoc = Doc & {
  orgId: string;
  kind: TemplateKind;
  channel: TemplateChannel;
  name: string;
  /** Plain text for both channels. SMS bodies are short by nature, that is all. */
  body: string;
  /** Email only. */
  subject?: string;
  /** `false` means retired: kept for the record, not used to send. */
  enabled: boolean;
  /** Set when a workspace edits a seeded template, so the list can say "yours". */
  editedAt?: string;
  seeded?: boolean;
};

/**
 * The fields a template may use.
 *
 * Each carries a sample so the editor can show what it will look like filled in
 * without a template author having to guess what `{{reference}}` means.
 */
export const MERGE_FIELDS: { key: string; description: string; sample: string }[] = [
  { key: 'client_first_name', description: "The client's first name", sample: 'Amara' },
  { key: 'client_name', description: "The client's full name", sample: 'Amara Osei' },
  { key: 'appointment', description: 'The word this workspace uses for an appointment', sample: 'appointment' },
  { key: 'service', description: 'What is being booked', sample: 'Initial consultation' },
  { key: 'provider', description: 'Who is seeing them', sample: 'Dr Nadia Rahman' },
  { key: 'location', description: 'Which site', sample: 'Northwind Clinic — Riverside' },
  { key: 'when', description: 'Day and time, in the workspace timezone', sample: 'Thursday 6 November at 09:30' },
  { key: 'when_date', description: 'Just the day', sample: 'Thursday 6 November' },
  { key: 'when_time', description: 'Just the time', sample: '09:30' },
  { key: 'reference', description: 'The booking reference', sample: 'BK-4821' },
  { key: 'business', description: 'The workspace name', sample: 'Northwind Clinic' },
  { key: 'claim_link', description: 'The link that takes a freed slot (wait-list offers)', sample: 'https://clinic.example/offer/wo_8f21ab' },
  { key: 'booking_link', description: 'The public booking page — how a message asks somebody to book', sample: 'https://clinic.example/book/northwind' },
  { key: 'last_seen', description: 'The day of their last visit (day and month)', sample: '14 April' },
  { key: 'offer_expires', description: 'When a freed-slot offer stops standing', sample: '4:30pm today' },
  // --- money. Four fields, each of which says plainly what it is: a receipt and a
  // chase are the same shape of sentence, so they share the vocabulary.
  { key: 'amount', description: 'The money this message is about — received, refunded, or still owed', sample: '$120.00' },
  { key: 'invoice_number', description: 'Which invoice (more than one is joined with commas)', sample: 'INV-0012' },
  { key: 'due_date', description: 'The day an invoice was due', sample: 'Thursday 3 October' },
  {
    key: 'balance_line',
    description: 'What is left owing, written as a sentence — “INV-0012 is settled.”, “$240.00 is still due on INV-0012.”',
    sample: 'INV-0012 is settled.',
  },
  { key: 'pay_link', description: 'The link that takes the payment for what is left owing', sample: 'https://clinic.example/pay/8f21ab0c' },
];

export const MERGE_FIELD_KEYS = MERGE_FIELDS.map((f) => f.key);

export type MergeField = string;
export type MergeContext = Record<string, string | undefined>;

/**
 * Renders a template.
 *
 * Unknown fields are left visible (`{{typo}}`) rather than blanked: a confirmation
 * that says "Hi ," is worse than one that says "Hi {{client_first}}", because the
 * second tells somebody what to fix. The preview in the dashboard shows the same.
 */
export function renderTemplate(body: string, context: MergeContext): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, name: string) => {
    const value = context[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

/** The fields a template uses — for the editor's "these are the pieces" hint. */
export function fieldsUsed(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) found.add(match[1].toLowerCase());
  return [...found];
}

export function unknownFields(body: string): string[] {
  return fieldsUsed(body).filter((key) => !MERGE_FIELD_KEYS.includes(key));
}

/**
 * The opt-out line, appended to every SMS that does not already offer one.
 *
 * Not a merge field on purpose: a customer editing a template must not be able to
 * remove the thing that makes texting people lawful. Email gets the same treatment
 * through the relay's footer.
 */
export function withStopLine(body: string): string {
  if (/\b(stop|opt out|opt-out|unsubscribe)\b/i.test(body)) return body;
  return `${body.trimEnd()} Reply STOP to opt out.`;
}

/* ------------------------------------------------------------------ defaults */

/**
 * The seeded set, in the workspace's vocabulary.
 *
 * Written the way a good receptionist writes: short, specific, and never "please
 * do not hesitate to contact us". The clinic that wants more words can add them.
 */
export type TemplateSeed = {
  kind: TemplateKind;
  channel: TemplateChannel;
  name: string;
  body: string;
  subject?: string;
  enabled: boolean;
  seeded?: boolean;
};

export function defaultTemplates(terms?: Terms): TemplateSeed[] {
  terms = terms ?? termsForOrg('');
  const appt = terms.appointment.one;
  const provider = terms.provider.one;
  const site = terms.location.one;
  return [
    {
      kind: 'confirmation',
      channel: 'sms',
      name: 'Booking confirmation',
      // The line is only sent when the deployment knows its own address; see
      // `dropUnfilledLinkLines`, which takes the whole line out otherwise rather
      // than leaving "Change it here:" dangling in somebody's text.
      body: `Hi {{client_first_name}} — your ${appt} is {{when}} with {{provider}} at {{location}}. {{service}}. Reference {{reference}}.\nNeed to change it? {{manage_link}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'confirmation',
      channel: 'email',
      name: 'Booking confirmation (email)',
      subject: `Your ${appt} — {{when_date}}`,
      body: `Hi {{client_first_name}},\n\nYour ${appt} is booked for {{when}} with {{provider}} at {{location}}.\n\nService: {{service}}\nReference: {{reference}}\n\nMove or cancel it here: {{manage_link}}\nOr call {{business}} and we will do it for you.\n\n— {{business}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'reminder',
      channel: 'sms',
      name: 'Reminder',
      body: `Hi {{client_first_name}} — a reminder: your ${appt} is {{when}} with {{provider}} at {{location}}. Reply C to confirm, or move it here: {{manage_link}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'followup',
      channel: 'sms',
      name: 'After the visit',
      body: `Hi {{client_first_name}} — thanks for coming in today at {{location}}. If anything does not feel right, call {{business}} and we will sort it.`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'no_show',
      channel: 'sms',
      name: 'Missed appointment',
      body: `Hi {{client_first_name}} — we missed you at {{when_time}} today. No charge and no judgement: reply with a day that suits and we will rebook you.`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'winback',
      channel: 'sms',
      name: 'We have not seen you in a while',
      body: `Hi {{client_first_name}} — it has been a while since your last ${appt} at {{business}}. Would you like us to find you a time?`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'waitlist_offer',
      channel: 'sms',
      name: 'Freed slot',
      // The link line is dropped whole when the deployment does not know its own
      // public address (`dropUnfilledLinkLines`), so the text still makes sense
      // without it — it just stops being answerable in one tap.
      body: `Hi {{client_first_name}} — a ${appt} has just opened up: {{when}} with {{provider}} at {{location}}. First to take it gets it here — {{claim_link}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'class_offer',
      channel: 'sms',
      name: 'A place in a class',
      body: `Hi {{client_first_name}} — a place in {{service}} on {{when}} has just come free. Take it here — {{claim_link}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'class_offer',
      channel: 'email',
      name: 'A place in a class (email)',
      subject: `A place in {{service}} — {{when_date}}`,
      body: `Hi {{client_first_name}},\n\nA place in {{service}} on {{when}} has just come free, and you were next in line.\n\nIf you want it, take it here:\n{{claim_link}}\nThe place is held for you until {{offer_expires}} — after that it goes to the next person in line.\n\n— {{business}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'waitlist_offer',
      channel: 'email',
      name: 'Freed slot (email)',
      subject: `Something opened up — {{when_date}}`,
      body: `Hi {{client_first_name}},\n\nA ${appt} has just come free: {{when}} with {{provider}} at {{location}}.\n\nIf you want it, take it here:\n{{claim_link}}\nThe offer stands until {{offer_expires}} — after that it goes to somebody else on the list.\n\n— {{business}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'recall',
      channel: 'sms',
      name: `Due for a ${appt}`,
      // Two ways to answer a recall, because the two kinds of client are real:
      // the one who will tap a link, and the one who texts back "Thursday?".
      body: `Hi {{client_first_name}} — it has been a while since your last ${appt} at {{business}}. Book when it suits you:
{{booking_link}}
Or reply with a day and we will find you a time.`,
      enabled: true,
      seeded: true,
    },

    {
      kind: 'recall',
      channel: 'email',
      name: `Due for a ${appt} (email)`,
      subject: `Time for your next ${appt}?`,
      body: `Hi {{client_first_name}},

It has been a while since your last ${appt} at {{business}} — your last visit was {{last_seen}}.

Whenever it suits you, book here:
{{booking_link}}

Or reply to this with a day and we will find you a time.

— {{business}}`,
      enabled: true,
      seeded: true,
    },
    /* ---------------------------------------------------------------- money */
    {
      kind: 'receipt',
      channel: 'sms',
      name: 'Payment received',
      // The link line is only kept when there is a link to put in it — an open
      // payment link we already made for this invoice. See `dropUnfilledLinkLines`.
      body: `Hi {{client_first_name}} — thank you, we have received {{amount}} for {{invoice_number}}. {{balance_line}}\nPay what is left here: {{pay_link}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'receipt',
      channel: 'email',
      name: 'Payment received (email)',
      subject: `Payment received — {{amount}}`,
      body: `Hi {{client_first_name}},\n\nWe have received {{amount}} for {{invoice_number}}. {{balance_line}}\nPay what is left here: {{pay_link}}\n\nThank you,\n{{business}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'refund',
      channel: 'sms',
      name: 'Refund sent',
      body: `Hi {{client_first_name}} — we have sent {{amount}} back to you. {{balance_line}}\nQuestions? Call {{business}}.`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'refund',
      channel: 'email',
      name: 'Refund sent (email)',
      subject: `Refund sent — {{amount}}`,
      body: `Hi {{client_first_name}},\n\nWe have sent {{amount}} back to you. {{balance_line}}\n\nIf it has not appeared in a few working days, call {{business}} and we will chase it with the bank.\n\n— {{business}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'overdue',
      channel: 'sms',
      name: 'Invoice still open',
      // No full stop after the link, and the link is the last thing in the body:
      // one that ends a sentence picks up the punctuation when it is tapped.
      body: `Hi {{client_first_name}} — a reminder that {{amount}} is still owing on {{invoice_number}} (due {{due_date}}).
Pay here: {{pay_link}}`,
      enabled: true,
      seeded: true,
    },
    {
      kind: 'overdue',
      channel: 'email',
      name: 'Invoice still open (email)',
      subject: `{{invoice_number}} — {{amount}} still owing`,
      body: `Hi {{client_first_name}},\n\n{{invoice_number}} was due on {{due_date}} and {{amount}} is still owing.\n\nPay it here:\n{{pay_link}}\n\nAlready paid? Ignore this — the two will cross over in the post.\n\n— {{business}}`,
      enabled: true,
      seeded: true,
    },
  ];
}

/**
 * Adds the client's own link to templates a workspace already has.
 *
 * Templates are data, and a practice is entitled to rewrite them — so this
 * touches **only** rows we seeded (`seeded: true`) that nobody has edited
 * (`editedAt` unset, which the editor stamps on every save) and that do not
 * already carry a link. A template somebody has touched is theirs, and leaving it
 * alone is the whole difference between an upgrade and an ambush.
 *
 * The wording itself may change in the upgrade — the reminder stops saying "call
 * {{business}} to change it" because it now has a better answer — so the check is
 * that the row still uses the fields the house default uses, and nothing the
 * house default never had.
 *
 * Idempotent: run it every boot and the second run does nothing.
 */
export function upgradeTemplatesForOrg(orgId: string): { upgraded: number } {
  const terms = termsForOrg(orgId);
  // `Doc` carries an index signature, so `Omit<TemplateDoc, …>` would widen every
  // field to `unknown`; the three fields this compares are named instead.
  const wanted: TemplateSeed[] = defaultTemplates(terms);
  let upgraded = 0;

  for (const template of list<TemplateDoc>('templates', (t) => t.orgId === orgId)) {
    if (!template.seeded) continue;
    if (/\{\{\s*manage_link\s*\}\}/i.test(template.body)) continue;
    if (template.editedAt) continue;
    const next = wanted.find((t) => t.kind === template.kind && t.channel === template.channel);
    if (!next || !/\{\{\s*manage_link\s*\}\}/i.test(next.body)) continue;
    // Every field the new wording uses has to be one this row already uses: an
    // extra field of the practice's own means they wrote something here, and the
    // row is left alone.
    const had = new Set(fieldsUsed(template.body));
    const wantedFields = fieldsUsed(next.body.replace(/\{\{\s*manage_link\s*\}\}/g, ''));
    if (!wantedFields.every((field) => had.has(field))) continue;
    update<TemplateDoc>('templates', template.id, { body: next.body, updatedAt: nowIso() } as never);
    audit({ orgId, actor: 'template-upgrade', action: 'template.linked', target: template.id, detail: `{{manage_link}} added to ${template.kind}/${template.channel}` });
    upgraded += 1;
  }
  return { upgraded };
}

/**
 * Brings house wording up to date in workspaces that already exist.
 *
 * Templates are data: a practice edits them and those edits are theirs. So this
 * touches **only** rows we seeded (`seeded: true`) that nobody has ever edited
 * (`editedAt` unset — the editor stamps it on every save), and only when the row
 * uses nothing the current house wording does not (`fieldsUsed` subset). A row
 * with a field of its own is somebody's sentence, and it is left exactly as it is.
 *
 * It exists because wordings are code: the receipt that named no bill, the chase
 * that put the payment link on the sentence's own line — so that an invoice with
 * no open link rendered as an *empty* text — and a refund that said "Call site."
 * were all shipped, and a workspace should not have to open a screen, or wait for
 * a client to notice, to be rid of them.
 *
 * Idempotent: run it every boot and the second run finds nothing that differs.
 */
/**
 * Wordings we shipped that were simply wrong, each matched against the exact text
 * that went out.
 *
 * A general "bring house wording up to date" rule cannot repair these: the new
 * sentence uses a merge field the old one never used, so the subset guard — which
 * exists to protect a practice's own words — reads the difference as somebody's
 * edit and leaves it alone. So the wrong ones are named, matched by their own
 * text, and fixed on sight. A practice that typed one of these sentences itself is
 * indistinguishable from us having written it, and is better off with the fix.
 */
const WRONG_WORDINGS: { kind: TemplateKind; channel: TemplateChannel; match: RegExp; why: string }[] = [
  {
    kind: 'refund',
    channel: 'sms',
    match: /Questions\?\s*Call\s+(?:site|clinic|practice|studio|salon|office|shop)\s*\.\s*$/i,
    why: 'the refund text carried a raw vocabulary fragment ("Call site.") instead of the practice\'s name',
  },
  {
    kind: 'overdue',
    channel: 'sms',
    match: /Pay here:\s*\{\{\s*pay_link\s*\}\}\s*$/i,
    why: 'the payment link shared its line with the sentence, so a bill with no link chased the client with an empty text',
  },
  {
    kind: 'recall',
    channel: 'sms',
    match: /Reply with a day and we will book you in at\s+(?:site|clinic|practice|studio|salon|office|shop)\b/i,
    why: 'the recall text offered no way to book and read out a raw vocabulary fragment ("book you in at site") instead of pointing at the booking page',
  },
];

export function repairTemplateWordingForOrg(orgId: string): { repaired: number } {
  const wanted = defaultTemplates(termsForOrg(orgId));
  let repaired = 0;

  for (const template of list<TemplateDoc>('templates', (t) => t.orgId === orgId)) {
    if (!template.seeded || template.editedAt) continue;
    const next = wanted.find((t) => t.kind === template.kind && t.channel === template.channel);
    if (!next) continue;
    if (next.body === template.body && (next.subject ?? '') === (template.subject ?? '')) continue;
    const wrong = WRONG_WORDINGS.find((w) => w.kind === template.kind && w.channel === template.channel && w.match.test(template.body.trim()));
    const had = new Set(fieldsUsed(template.body));
    const wants = fieldsUsed(`${next.body} ${next.subject ?? ''}`);
    if (!wrong && !wants.every((field) => had.has(field))) continue;
    update<TemplateDoc>('templates', template.id, { body: next.body, subject: next.subject, updatedAt: nowIso() } as never);
    audit({
      orgId,
      actor: 'template-upgrade',
      action: 'template.reworded',
      target: template.id,
      detail: wrong ? `${template.kind}/${template.channel} — ${wrong.why}` : `${template.kind}/${template.channel} — brought up to the current house wording`,
    });
    repaired += 1;
  }
  return { repaired };
}

/* ---------------------------------------------------------------------- CRUD */

export function templatesFor(orgId: string, filter: { kind?: TemplateKind; channel?: TemplateChannel; includeRetired?: boolean } = {}) {
  const rows = list<TemplateDoc>('templates', (t) => {
    if (t.orgId !== orgId) return false;
    if (!filter.includeRetired && t.enabled === false) return false;
    if (filter.kind && t.kind !== filter.kind) return false;
    if (filter.channel && t.channel !== filter.channel) return false;
    return true;
  });
  return rows.sort(
    (a, b) =>
      TEMPLATE_KINDS.indexOf(a.kind) - TEMPLATE_KINDS.indexOf(b.kind) ||
      String(a.channel).localeCompare(String(b.channel)) ||
      String(a.name).localeCompare(String(b.name)) ||
      String(a.createdAt).localeCompare(String(b.createdAt))
  );
}

export function templateById(orgId: string, id: string) {
  return list<TemplateDoc>('templates', (t) => t.orgId === orgId && t.id === id)[0];
}

/** The wording for a job: the active template for that kind and channel. */
export function templateFor(orgId: string, kind: TemplateKind, channel: TemplateChannel) {
  return templatesFor(orgId, { kind, channel }).find((t) => t.enabled) ?? templatesFor(orgId, { kind, channel })[0];
}

export function isTemplateKind(value: unknown): value is TemplateKind {
  return TEMPLATE_KINDS.includes(value as TemplateKind);
}

export function isTemplateChannel(value: unknown): value is TemplateChannel {
  return value === 'sms' || value === 'email';
}

export function createTemplate(
  orgId: string,
  input: { kind: TemplateKind; channel: TemplateChannel; body: string; name?: string; subject?: string; enabled?: boolean },
  actor: string
) {
  const template: TemplateDoc = {
    id: newId('tpl_'),
    orgId,
    kind: input.kind,
    channel: input.channel,
    name: input.name ?? `${input.kind} (${input.channel})`,
    body: input.body,
    subject: input.subject,
    enabled: input.enabled ?? true,
    seeded: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  insert<TemplateDoc>('templates', template);
  audit({ orgId, actor, action: 'template.created', target: template.id, detail: `${template.kind}/${template.channel}` });
  return template;
}

export function updateTemplate(
  orgId: string,
  id: string,
  patch: { name?: string; body?: string; subject?: string; enabled?: boolean },
  actor: string
) {
  const existing = templateById(orgId, id);
  if (!existing) return undefined;
  const allowed: Partial<TemplateDoc> = {};
  for (const key of ['name', 'body', 'subject', 'enabled'] as const) {
    if (patch[key] !== undefined) (allowed as Record<string, unknown>)[key] = patch[key];
  }
  const updated = update<TemplateDoc>('templates', id, {
    ...allowed,
    editedAt: nowIso(),
    updatedAt: nowIso(),
  } as never);
  if (updated) audit({ orgId, actor, action: 'template.updated', target: id, detail: Object.keys(allowed).join(', ') });
  return updated;
}

/**
 * Retiring, never deleting.
 *
 * A retired template stays in the list with its wording, because "what did we
 * used to send?" is a question that gets asked exactly when it is hardest to
 * answer.
 */
export function retireTemplate(orgId: string, id: string, actor: string) {
  const existing = templateById(orgId, id);
  if (!existing) return undefined;
  const retired = update<TemplateDoc>('templates', id, { enabled: false, updatedAt: nowIso() } as never);
  audit({ orgId, actor, action: 'template.retired', target: id, detail: existing.name });
  return retired;
}

export function restoreTemplate(orgId: string, id: string, actor: string) {
  const existing = templateById(orgId, id);
  if (!existing) return undefined;
  const restored = update<TemplateDoc>('templates', id, { enabled: true, updatedAt: nowIso() } as never);
  audit({ orgId, actor, action: 'template.restored', target: id, detail: existing.name });
  return restored;
}

/** Create-or-update, by id when given, by kind+channel otherwise. */
export function upsertTemplate(input: {
  orgId: string;
  kind: TemplateKind;
  channel: TemplateChannel;
  body: string;
  name?: string;
  subject?: string;
  actor: string;
  actorName?: string;
  id?: string;
}) {
  const existing = input.id ? templateById(input.orgId, input.id) : templateFor(input.orgId, input.kind, input.channel);
  if (!existing) {
    return createTemplate(input.orgId, { kind: input.kind, channel: input.channel, body: input.body, name: input.name, subject: input.subject }, input.actor);
  }
  return (
    updateTemplate(input.orgId, existing.id, { name: input.name, body: input.body, subject: input.subject, enabled: true }, input.actor) ?? existing
  );
}

/**
 * Makes sure a workspace has a set to start from.
 *
 * Idempotent: it looks at what is already there (retired rows included, so a
 * deliberately retired template is not resurrected by a page load) and seeds only
 * what is missing. `force` + `only` is the "reset this one to the house default"
 * path, which replaces rather than duplicates.
 */
export function seedTemplatesForOrg(
  orgId: string,
  options: { force?: boolean; only?: { kind: TemplateKind; channel: TemplateChannel } } = {}
): { seeded: number; existing: number } {
  const terms = termsForOrg(orgId);
  const wanted = defaultTemplates(terms).filter((t) => (options.only ? t.kind === options.only.kind && t.channel === options.only.channel : true));
  const existing = list<TemplateDoc>('templates', (t) => t.orgId === orgId);

  let seeded = 0;
  for (const template of wanted) {
    const clash = existing.find((t) => t.kind === template.kind && t.channel === template.channel);
    if (clash && !options.force) continue;
    if (clash) {
      // Reset: retire the old wording, write the house default as a fresh row, so
      // the previous body is still readable in the list.
      update<TemplateDoc>('templates', clash.id, { enabled: false, updatedAt: nowIso() } as never);
      audit({ orgId, actor: 'template-reset', action: 'template.retired', target: clash.id, detail: 'reset to house default' });
    }
    insert<TemplateDoc>('templates', {
      id: newId('tpl_'),
      orgId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...template,
      body: String(template.body).trimEnd(),
    } as TemplateDoc);
    seeded += 1;
  }
  return { seeded, existing: existing.length };
}

/**
 * The house wording for one job and channel.
 *
 * Exported because a message with no stored template must still say something
 * worth reading — and "something worth reading" already exists, here. A caller
 * that wrote its own fallback sentence would be a second copy of the wording,
 * and the two would drift apart the first time either was edited.
 */
export function houseDefaultTemplate(
  kind: TemplateKind,
  channel: TemplateChannel,
  orgId?: string
): { body: string; subject?: string } | undefined {
  const found = defaultTemplates(orgId ? termsForOrg(orgId) : undefined).find((t) => t.kind === kind && t.channel === channel);
  return found ? { body: found.body, subject: found.subject } : undefined;
}

export function templateStats(orgId: string) {
  const all = list<TemplateDoc>('templates', (t) => t.orgId === orgId);
  const active = all.filter((t) => t.enabled);
  const jobs = TEMPLATE_KINDS.map((kind) => ({
    kind,
    channels: all.filter((t) => t.kind === kind && t.enabled).map((t) => t.channel),
  }));
  return {
    active: active.length,
    retired: all.length - active.length,
    // A job with no wording on any channel still sends (a plain sentence), but the
    // dashboard should say so rather than let somebody discover it from a patient.
    unwritten: jobs.filter((j) => j.channels.length === 0).map((j) => j.kind),
  };
}

/* ------------------------------------------------------------------ rendering */

export type RenderInput = {
  orgId: string;
  kind: TemplateKind;
  channel: TemplateChannel;
  context: MergeContext;
  /** Used when no active template exists for that kind — the message still goes. */
  fallback?: string;
  /** The subject that goes with `fallback`, for email. */
  fallbackSubject?: string;
};

/**
 * Drops lines that were meant to carry a link and have nothing to carry.
 *
 * `{{manage_link}}` is empty when the deployment does not know its own public
 * address, and a text reading "Change it here:" with no link after it is worse
 * than a text without the line at all. Decided *before* rendering, while we can
 * still see which line was the one asking for the link.
 */
function dropUnfilledLinkLines(body: string, context: MergeContext): string {
  const empty = ['manage_link', 'pay_link', 'claim_link', 'booking_link'].filter((key) => !String(context[key] ?? '').trim());
  if (!empty.length) return body;
  const pattern = new RegExp(`\\{\\{\\s*(?:${empty.join('|')})\\s*\\}\\}`, 'i');
  const kept = body.split('\n').filter((line) => !pattern.test(line));
  // The ordinary case: the link had a line of its own, so the line goes and the
  // sentence it belonged to is untouched.
  if (kept.join('\n').trim()) return kept.join('\n').replace(/\n{3,}/g, '\n\n');

  // The whole message was the link line — a practice's own one-liner like
  // "… $40 is owing. Pay here: {{pay_link}}". Dropping the line there would send
  // an *empty* text, which is worse than one that reads a little bare, so the link
  // itself is removed and the words that led into it are tidied away with it.
  const tidy = (line: string) =>
    line
      .replace(pattern, '')
      .replace(/\s+(?:pay(?:\s+it)?(?:\s+here)?|pay\s+now|here|link|online|at)\s*[:.,;—-]?\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*[:.,;—-]\s*$/, '')
      .trimEnd();
  return kept
    .concat(body.split('\n'))
    .filter((line, index, all) => all.indexOf(line) === index)
    .map((line) => tidy(line))
    .join('\n')
    .trim();
}

export function renderFor(input: RenderInput): { body: string; subject?: string; templateId?: string; usedFallback: boolean } {
  const template = templateFor(input.orgId, input.kind, input.channel);
  const finish = (body: string) => (input.channel === 'sms' && body.trim() ? withStopLine(body) : body);
  if (!template) {
    return {
      body: finish(renderTemplate(dropUnfilledLinkLines(input.fallback ?? '', input.context), input.context)),
      subject: input.fallbackSubject ? renderTemplate(input.fallbackSubject, input.context) : undefined,
      usedFallback: true,
    };
  }
  return {
    body: finish(renderTemplate(dropUnfilledLinkLines(template.body, input.context), input.context)),
    subject: template.subject ? renderTemplate(template.subject, input.context) : undefined,
    templateId: template.id,
    usedFallback: false,
  };
}
