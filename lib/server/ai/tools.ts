/**
 * The tool contract.
 *
 * A tool has one definition and two callers: the rule engine picks tools by
 * intent, and a model asks for them by name and arguments. Both execute the same
 * implementation (in `lib/server/agent.ts`), so switching an assistant from the
 * rule engine to Claude changes *who decides*, never *what happens*.
 *
 * JSON Schemas live here rather than being generated from the executor, because
 * the schema is the part the model actually reads: the descriptions are prompt
 * engineering, and they are the difference between a model that books correctly
 * and one that books on the wrong day.
 */

import type { AgentTool } from '../agent';
import type { ChatToolSpec } from './chat';

export type ToolSchema = { description: string; parameters: Record<string, unknown> };

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  capture_field_enquiry: {
    description:
      'Save a contractor or home-service enquiry for human review. Gather the caller name, callback number, work needed, urgency, and the actual service address before calling. This creates an enquiry only: never quote a price, promise an arrival time, say a technician is booked, or describe it as a confirmed job.',
    parameters: obj(
      {
        name: str('Customer or caller name'),
        phone: str('Callback phone number; omit only when the live caller number is known'),
        email: str('Email address, if the caller gave one'),
        description: str('What work is needed, in the caller’s own factual words'),
        urgency: str('routine, soon, urgent, or emergency; do not treat this as an emergency-service guarantee'),
        addressLine1: str('Street address where the work would happen'),
        addressLine2: str('Second address line, if any'),
        city: str('City or locality of the service address'),
        region: str('State, province, county, or region'),
        postalCode: str('Postal or ZIP code'),
        country: str('Two-letter country code, if known'),
      },
      ['name', 'description', 'addressLine1', 'city']
    ),
  },
  schedule_approved_visit: {
    description:
      'Schedule one visit that a person has already added to an approved contractor job. Use only after the caller gives a specific date and time. The tool verifies the caller, job, visit, technician rota and diary conflict. It cannot create or approve a job, quote a price, guarantee arrival, or choose between ambiguous jobs; if it returns needsHuman, hand off without promising the slot.',
    parameters: obj(
      {
        jobReference: str('Job reference such as JOB-00012, when known'),
        visitReference: str('Visit reference such as VIS-AB12CD34, when the job has more than one visit'),
        date: str('Specific requested day, such as 2026-11-05 or Thursday'),
        time: str('Specific requested time, such as 2pm'),
        location: str('Dispatch location name, required when the business has more than one'),
        technician: str('Technician name only when the caller or business specified one'),
      },
      ['date', 'time']
    ),
  },
  lookup_order: {
    description:
      'Look up an order or booking by its reference. Call this before answering any question about where something is, what it cost, or when it arrives. Use the reference the caller gave; if they did not give one, call it anyway — the system falls back to the reference on the account.',
    parameters: obj({ orderId: str('Order or booking reference, e.g. NW-1234') }),
  },
  order_status: {
    description: 'Check the status and estimated arrival of an order or booking.',
    parameters: obj({ orderId: str('Order or booking reference') }),
  },
  billing_lookup: {
    description: 'Read the account\'s billing state: plan, current amount, and whether anything is overdue, before discussing money.',
    parameters: obj({ account: str('Account email or reference, if the caller gave one') }),
  },
  issue_refund: {
    description:
      'Issue a refund. Only call this after confirming the amount and what it is for with the caller — refunds are irreversible and are reported on the call record.',
    parameters: obj({ orderId: str('Order being refunded'), amount: str('Amount, e.g. "$42.00"'), reason: str('Why the refund is being issued') }, ['orderId']),
  },
  draft_note: {
    description:
      'Write up what happened on this call as a draft note on the client\'s record. Call it once you have finished the substantive part of the call — after booking, moving or cancelling, or after answering what they rang about. Write what was actually said and agreed, in plain sentences, one section at a time. This is a DRAFT: a person reads and signs it, so never say it is finished, filed, signed or "on their record".',
    parameters: obj(
      {
        summary: str('What the contact was about and what was agreed, in a few sentences'),
        content: str('Section-by-section detail if you have it, as "Label: text" pairs'),
      },
      ['summary']
    ),
  },
  payment_status: {
    description:
      'Read what this client still owes and whether a payment link has been paid. Use it when a caller asks how much they owe or whether their payment went through. Never read out card numbers, and never invent a balance — if it says nothing is outstanding, say the account is clear.',
    parameters: obj({ account: str('Account email, invoice number or reference the caller gave') }),
  },
  create_payment_link: {
    description:
      'Create a secure payment link for what a caller owes and send it to them by text or email. Only call this after the caller has agreed to pay and after checking the amount with payment_status. Never take card details on the call — say you are sending a secure link instead. A person can also take payment at the desk.',
    parameters: obj(
      {
        invoice: str('Invoice number to pay, if the caller named one'),
        amount: str('Amount to ask for, e.g. "45.00". Omit to ask for the full outstanding balance'),
        channel: str('How to send it: "sms" or "email"'),
        to: str('Phone number or email address to send to, if different from what is on file'),
      },
      []
    ),
  },
  check_availability: {
    description:
      'Read the calendar for a day and return the open slots. Always call this before offering any time to a caller, so you never offer a slot that is taken.',
    parameters: obj({ date: str('Day to check, e.g. "Thursday", "2026-10-02", "tomorrow"'), service: str('Service or appointment type') }),
  },
  book_appointment: {
    description:
      'Book an appointment once the caller has named a specific day AND time. Never call it while you are still offering options. If the caller changes the time later in the call, call it again with the new day and time — it reschedules.',
    parameters: obj(
      { date: str('Day of the appointment'), time: str('Time of the appointment, e.g. "2pm"'), name: str('Caller name if known'), service: str('Service or appointment type') },
      ['date', 'time']
    ),
  },
  reschedule_appointment: {
    description: 'Move an existing appointment to a new day and time. Same rules as booking: only once the caller has named both.',
    parameters: obj({ date: str('New day'), time: str('New time'), reference: str('Existing appointment reference if known') }, ['date', 'time']),
  },
  cancel_appointment: {
    description:
      'Cancel the caller\'s appointment. Only call after the caller has clearly said they want to cancel and you have read back the day and time to confirm.',
    parameters: obj({ reference: str('Appointment reference'), date: str('Day being cancelled'), reason: str('Reason given by the caller') }),
  },
  cancel_subscription: {
    description: 'Cancel a subscription or recurring plan. Confirm what will stop and when before calling.',
    parameters: obj({ account: str('Account reference'), reason: str('Reason given by the caller') }),
  },
  send_confirmation: {
    description: 'Send the caller a written confirmation of what was agreed — by SMS if they are on a phone, otherwise email.',
    parameters: obj({ to: str('Phone number or email'), summary: str('One-line summary of what was agreed') }, ['summary']),
  },
  transfer_call: {
    description:
      'Hand the caller to a human. Use it for anything outside your scope, any request for a person, and any upset caller who has already been answered once.',
    parameters: obj({ department: str('Where to route, e.g. "billing", "support"'), reason: str('Why the transfer is needed') }),
  },
  escalate: {
    description: 'Raise a case for a human to pick up when a transfer is not possible.',
    parameters: obj({ summary: str('What needs following up'), priority: str('low, normal, or high') }),
  },
  create_ticket: {
    description: 'Open a ticket so the request is tracked and someone follows up.',
    parameters: obj({ subject: str('Short subject line'), detail: str('What the caller needs'), email: str('Contact email if given') }, ['subject']),
  },
  update_account: {
    description: 'Change account details the caller asked to change (contact number, email, address, preferences).',
    parameters: obj({ field: str('Which detail is changing'), value: str('The new value') }, ['field', 'value']),
  },
  send_sms: {
    description: 'Send a text message to the caller.',
    parameters: obj({ to: str('Phone number'), body: str('Message body') }, ['body']),
  },
  email_receipt: {
    description: 'Email a receipt or invoice.',
    parameters: obj({ to: str('Email address'), reference: str('Invoice or order reference') }, ['to']),
  },
};

/** Unknown, customer-defined tools still get a usable, honest schema. */
function genericSchema(tool: AgentTool): ToolSchema {
  return {
    description: tool.description ?? `Tool ${tool.name}.`,
    parameters: obj({
      query: str('What to look up or act on, in the caller\'s own words'),
      note: str('Anything else the tool needs'),
    }),
  };
}

/**
 * The tools to offer a model for one assistant.
 *
 * Only the assistant's own tools are offered — a model cannot call a tool the
 * customer did not attach, which keeps the blast radius of a prompt injection
 * inside what the assistant was already allowed to do.
 */
export function toolSpecsFor(tools: AgentTool[]): ChatToolSpec[] {
  return tools.map((tool) => {
    const schema = TOOL_SCHEMAS[tool.name] ?? genericSchema(tool);
    return {
      name: tool.name,
      description: tool.description ? `${schema.description} ${tool.description}` : schema.description,
      parameters: schema.parameters,
    };
  });
}

/** Human-readable list for the system prompt, so a model knows what it can do. */
export function toolSummary(tools: AgentTool[]) {
  return tools.map((t) => `- ${t.name}: ${(TOOL_SCHEMAS[t.name]?.description ?? t.description ?? 'custom tool').split('.')[0]}.`).join('\n');
}
