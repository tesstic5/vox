/**
 * Onboarding.
 *
 * Signup → a working agent → a real number → the first call, with no step that
 * requires a human on our side. Three principles shape this file:
 *
 *   1. **Progress is derived, not stored.** "Have you created an assistant?" is
 *      answered by counting the workspace's assistants, not by trusting a flag
 *      the UI set. A checklist that can be ticked without the thing existing is
 *      worse than no checklist.
 *   2. **Every step is an action.** The wizard does not link out to a form and
 *      hope: it creates the assistant, buys the number, and places the call
 *      through the same code paths the rest of the product uses.
 *   3. **Anything unmovable is named.** With no carrier connected and no managed
 *      telephony on the deployment, the number step says exactly that and where
 *      to fix it, instead of failing at the last moment.
 */

import { get, insert, list, listAllByOrg, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { createCall } from './calls';
import { carrierFor, type CarrierDoc } from './carriers';
import { buyNumber, configureNumber, releaseNumber, searchNumbers } from './providers/twilio';
import { numberClaimConflict, releaseNumberReservation, reserveNumberClaim } from './number-ownership';
import {
  MANAGED_AREA_CODES,
  MANAGED_CARRIER_ID,
  areaCodeLabel,
  dialerFor,
  telephonyMode,
} from './managed';
import { TOOL_LIBRARY } from '../content';
import { businessTypeLabel } from '../business';
import { businessProfileFor } from './business-profile';
import { locationsFor, providersFor, rotaForOrg, servicesFor } from './practice';

export type OnboardingDoc = Doc & {
  orgId: string;
  startedAt: string;
  /** Set when the wizard's last step is acknowledged. */
  completedAt?: string;
  dismissed?: boolean;
  useCase?: string;
  /** The assistant the wizard created, so later steps know which one to use. */
  assistantId?: string;
  numberId?: string;
  firstCallId?: string;
};

export const USE_CASES = [
  {
    id: 'contractor-enquiries',
    label: 'Take service enquiries and arrange approved visits',
    desc: 'Capture the job and service address, then schedule only visits your team has already approved.',
    template: 'support-concierge',
    assistantName: 'Service desk',
    firstMessage: 'Thanks for calling {{business}} — this is the automated service desk. What work do you need help with?',
    prompt:
      'You are the inbound service desk for a contractor or home-service business. Gather the caller’s name, callback number, factual work description, urgency and the address where the work is needed, then save an enquiry for human review. Never invent or quote a price, approve work, promise arrival, authorise a charge or claim a technician is booked. You may schedule only an existing approved visit through the scheduling tool after the caller gives a specific date and time and the tool confirms the live diary. If the tool reports ambiguity, missing approval or a conflict, hand the caller to a person without promising the slot.',
    tools: ['capture_field_enquiry', 'schedule_approved_visit', 'transfer_call'],
    knowledge: [],
  },
  {
    id: 'booking-confirmation',
    label: 'Confirm and reschedule bookings',
    desc: 'Ring tomorrow’s appointments, confirm they are coming, and move or cancel the ones that are not.',
    template: 'appointment-booking',
    assistantName: 'Booking desk',
    firstMessage: 'Hi, this is {{business}} calling about your appointment — is now still a good time?',
    prompt:
      'You are calling customers about an appointment they already have. Confirm they are still coming. If they cannot make it, offer two alternative slots this week; if they want to cancel, cancel it without arguing. Read the appointment back from the booking record rather than guessing, keep the call under a minute, and send a text confirmation of whatever you agree.',
    tools: ['lookup_order', 'check_availability', 'book_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_confirmation', 'draft_note', 'payment_status', 'create_payment_link', 'transfer_call'],
    // Real policies and prices must come from this business, not a sample.
    knowledge: [],
  },
  {
    id: 'inbound-support',
    label: 'Answer support calls',
    desc: 'Answer general questions and pass the caller to a person when needed.',
    template: 'support-concierge',
    assistantName: 'Support line',
    firstMessage: 'Thanks for calling {{business}} — this is the AI assistant on the line. What can I help with?',
    prompt:
      'You are the inbound support assistant. Use only the business information actually provided. Do not invent prices, hours, policies or outcomes. Do not treat a phone number as proof of identity or disclose private account details. Offer to transfer to a person when unsure or asked.',
    tools: ['transfer_call'],
    knowledge: [],
  },
  {
    id: 'lead-qualification',
    label: 'Qualify and follow up leads',
    desc: 'Call new enquiries within minutes, check fit and budget, and book the ones worth a salesperson’s time.',
    template: 'lead-qualification',
    assistantName: 'Lead desk',
    firstMessage: 'Hi, this is {{business}} returning your enquiry — have you got two minutes?',
    prompt:
      'You are calling someone who enquired about the service. Qualify quickly: what they need, when they need it, who decides, and budget. If they are a fit, book a call with a salesperson; if not, thank them and finish politely. Never pressure anyone.',
    tools: ['check_availability', 'book_appointment', 'send_confirmation', 'draft_note', 'payment_status', 'create_payment_link', 'transfer_call'],
    knowledge: [],
  },
] as const;

export type UseCaseId = (typeof USE_CASES)[number]['id'];

export function onboardingUseCases(orgId: string) {
  const profile = businessProfileFor(orgId);
  const ids: UseCaseId[] = [];
  if (profile.modules.includes('field_service')) ids.push('contractor-enquiries');
  if (profile.modules.includes('schedule')) ids.push('booking-confirmation');
  if (profile.modules.includes('assistants')) ids.push('inbound-support');
  if (profile.type === 'other' && profile.modules.includes('schedule')) ids.push('lead-qualification');
  // An untouched legacy workspace keeps the old choices; a configured workspace
  // with assistants disabled has no pretend assistant path.
  if (!profile.configured) return USE_CASES;
  return USE_CASES.filter((useCase) => ids.includes(useCase.id));
}

/* ------------------------------------------------------------------- state */

export function onboardingFor(orgId: string): OnboardingDoc {
  const existing = list<OnboardingDoc>('onboarding', (o) => o.orgId === orgId)[0];
  if (existing) return existing;
  return insert<OnboardingDoc>('onboarding', {
    id: newId('onb_'),
    orgId,
    startedAt: nowIso(),
  } as OnboardingDoc);
}

export function patchOnboarding(orgId: string, patch: Partial<OnboardingDoc>) {
  const doc = onboardingFor(orgId);
  return update<OnboardingDoc>('onboarding', doc.id, patch) as OnboardingDoc;
}

/**
 * What this workspace has actually done, and what is left.
 *
 * Read from the collections rather than from the wizard's own bookkeeping, so the
 * checklist cannot disagree with the rest of the product.
 */
export function onboardingState(orgId: string) {
  const doc = onboardingFor(orgId);
  const profile = businessProfileFor(orgId);
  const availableUseCases = onboardingUseCases(orgId);
  const assistants = list<Doc & { status?: string; source?: string; template?: string; serverUrl?: string }>('assistants', (a) => (a as { orgId?: string }).orgId === orgId);
  const published = assistants.filter((a) => a.status === 'published');
  const numbers = list<Doc & { assistantId?: string | null; number?: string; carrierId?: string; carrierSid?: string; source?: string }>('numbers', (n) => n.orgId === orgId);
  const calls = listAllByOrg<Doc & { type?: string; status?: string; source?: string }>('calls', orgId);
  const webhooks = list<Doc & { active?: boolean; url?: string }>('webhooks', (w) => (w as { orgId?: string }).orgId === orgId && w.active !== false);
  const mode = telephonyMode(orgId);
  const locations = locationsFor(orgId);
  const providers = providersFor(orgId);
  const services = servicesFor(orgId);
  const rotas = rotaForOrg(orgId);
  const foundationReady = locations.length > 0 && providers.length > 0 && rotas.length > 0;

  /**
   * A brand-new workspace arrives pre-provisioned: a demo agent, two numbers and
   * two weeks of calls. That is deliberate — an empty dashboard teaches nothing —
   * but it must not be mistaken for *the client's* setup, or the wizard opens
   * claiming everything is done when the client has done nothing.
   *
   * So each step measures the client's own artefacts:
   *   · a real number has a carrier SID (the demo pair have none),
   *   · a real call was started by a person or a campaign, not by the seeder,
   *   · a real webhook points somewhere other than our own echo endpoint.
   */
  const realNumbers = numbers.filter((n) => Boolean(n.carrierSid));
  const assigned = realNumbers.filter((n) => n.assistantId);
  const ownCalls = calls.filter((c) => ['onboarding', 'dashboard'].includes(String(c.source ?? '')) || String(c.source ?? '').startsWith('campaign'));
  const ownWebhooks = webhooks.filter((w) => !String(w.url ?? '').includes('/api/webhook-echo'));
  const demoAssistants = assistants.filter((assistant) => assistant.source === 'demo' || String(assistant.serverUrl ?? '').includes('api.northwind.dev'));
  const demoNumbers = numbers.filter((number) => number.source === 'demo' || !number.carrierSid);
  const demoCalls = calls.filter((call) => ['simulation', 'seed-api', 'seed-phone'].includes(String(call.source ?? '')));
  const preloaded = demoAssistants.length > 0 || demoNumbers.length > 0 || demoCalls.length > 0;

  const steps: Array<{ id: string; title: string; why: string; done: boolean; detail: string; cta: string; blocking: boolean }> = [];

  steps.push({
    id: 'business_profile',
    title: 'Confirm business details',
    why: 'Type recommends modules and words; country, timezone, currency and hours keep scheduling and money on the right local rules.',
    done: profile.configured && Boolean(profile.country && profile.timezone && profile.currency),
    detail: profile.country && profile.timezone && profile.currency
      ? `${businessTypeLabel(profile.type)} · ${profile.country} · ${profile.timezone} · ${profile.currency}`
      : `${businessTypeLabel(profile.type)} selected · locale details still need review`,
    cta: 'Review business profile',
    blocking: false,
  });

  if (profile.modules.includes('schedule') || profile.modules.includes('field_service')) {
    steps.push({
      id: 'operations',
      title: profile.modules.includes('field_service') ? 'Set up dispatch and technicians' : 'Set up services and availability',
      why: profile.modules.includes('field_service')
        ? 'A customer address is not a dispatch base. Add real dispatch locations, technicians and rotas before any visit can be scheduled.'
        : 'Appointments can be offered only from real locations, services, team members and rotas.',
      done: foundationReady,
      detail: foundationReady
        ? `${locations.length} location${locations.length === 1 ? '' : 's'} · ${providers.length} team member${providers.length === 1 ? '' : 's'} · ${rotas.length} rota${rotas.length === 1 ? '' : 's'}`
        : `${locations.length} locations · ${services.length} services · ${providers.length} team members · ${rotas.length} rotas`,
      cta: 'Configure services and team',
      blocking: false,
    });
  }

  if (profile.modules.includes('assistants')) {
    steps.push({
      id: 'assistant',
      title: 'Create your assistant',
      why: 'An assistant is a reviewed prompt, voice, model and bounded tool set. The recommended use cases below follow this workspace’s enabled modules.',
      done: Boolean(doc.assistantId) && assistants.some((a) => String(a.id) === String(doc.assistantId) && a.status === 'published'),
      detail: doc.assistantId
        ? assistants.some((a) => String(a.id) === String(doc.assistantId) && a.status === 'published')
          ? `${assistants.find((a) => String(a.id) === String(doc.assistantId))?.name ?? 'Your assistant'} is published`
          : 'Draft created — review and publish it when ready'
        : preloaded
          ? `Demo assistants are pre-loaded (${assistants.length}) — make yours from a relevant use case`
          : 'No workspace assistant yet',
      cta: 'Create my assistant',
      blocking: false,
    });
  }

  if (profile.modules.includes('assistants') && profile.modules.includes('communications')) {
    steps.push({
      id: 'number',
      title: 'Get a phone number',
      why: 'A real carrier number lets callers reach the reviewed assistant. No placeholder number counts as configured.',
      done: realNumbers.length > 0,
      detail: realNumbers.length
        ? `${realNumbers.length} number${realNumbers.length === 1 ? '' : 's'} bought${assigned.length < realNumbers.length ? ` · ${realNumbers.length - assigned.length} unassigned` : ''}`
        : mode === 'none'
          ? 'No carrier is connected; browser testing remains available'
          : 'Search live carrier inventory when you are ready',
      cta: 'Choose an area code',
      blocking: false,
    });
    steps.push({
      id: 'first_call',
      title: 'Make the first test call',
      why: 'Call it yourself before a customer does: hear the disclosure, interrupt it and check the transcript and tool outcome.',
      done: ownCalls.length > 0,
      detail: ownCalls.length
        ? `${ownCalls.length} call${ownCalls.length === 1 ? '' : 's'} you started`
        : preloaded
          ? `${calls.length} demo call${calls.length === 1 ? '' : 's'} exist; none counts as your test`
          : 'No workspace test call yet',
      cta: 'Test it in the browser',
      blocking: false,
    });
  }

  if (profile.modules.includes('developer')) {
    steps.push({
      id: 'connect',
      title: 'Connect your system',
      why: 'Use signed webhooks and scoped API keys only if another system needs outcomes or supplies records.',
      done: ownWebhooks.length > 0,
      detail: ownWebhooks.length
        ? `${ownWebhooks.length} endpoint${ownWebhooks.length === 1 ? '' : 's'} subscribed`
        : 'No customer-owned webhook is configured',
      cta: 'Add a webhook',
      blocking: false,
    });
  }

  const done = steps.filter((s) => s.done).length;
  return {
    object: 'onboarding' as const,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    dismissed: Boolean(doc.dismissed),
    useCase: doc.useCase,
    assistantId: doc.assistantId ?? assistants[0]?.id,
    numberId: doc.numberId ?? numbers[0]?.id,
    firstCallId: doc.firstCallId,
    preloaded,
    demo: preloaded
      ? {
          assistants: demoAssistants.length,
          numbers: demoNumbers.length,
          calls: demoCalls.length,
          note: 'This workspace arrived with a demo agent, demo numbers and call history so nothing on screen is empty. The steps below are about making it yours — demo data is never counted as your setup.',
        }
      : undefined,
    steps,
    done,
    total: steps.length,
    percent: Math.round((done / steps.length) * 100),
    complete: done === steps.length,
    workspace: {
      assistants: assistants.length,
      published: published.length,
      numbers: numbers.length,
      assigned: assigned.length,
      calls: calls.length,
      answered: ownCalls.length,
    },
    telephony: {
      mode,
      /** True when the workspace can buy a number right now. */
      canBuy: mode !== 'none',
      managed: mode === 'managed',
      areaCodes: MANAGED_AREA_CODES,
      hint:
        mode === 'workspace'
          ? 'Numbers are bought on the carrier account you connected.'
          : mode === 'managed'
            ? 'Numbers are provisioned on Voxera’s own carrier account — nothing to set up, cancel any time.'
            : 'No carrier is connected. Connect one under Carriers, or set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the deployment to let clients buy managed numbers.',
    },
    profile: {
      configured: profile.configured,
      type: profile.type,
      typeLabel: businessTypeLabel(profile.type),
      modules: [...profile.modules],
      country: profile.country,
      timezone: profile.timezone,
      currency: profile.currency,
    },
    operations: { locations: locations.length, services: services.length, providers: providers.length, rotas: rotas.length, ready: foundationReady },
    useCases: availableUseCases.map((u) => ({ id: u.id, label: u.label, desc: u.desc, tools: u.tools.length })), 
  };
}

export type OnboardingState = ReturnType<typeof onboardingState>;

/* ------------------------------------------------------------------ actions */

/**
 * Step one: create the agent from a use case.
 *
 * The assistant starts as a draft by default. A business must review real
 * instructions and intentionally publish before the setup step counts as done.
 */
export function createOnboardingAssistant(input: {
  orgId: string;
  useCase: string;
  business?: string;
  name?: string;
  /** True to attach the booking tool set even on a non-booking use case. */
  bookingTools?: boolean;
  /** Explicit internal opt-in only; customer setup calls leave this false. */
  publish?: boolean;
}) {
  const available = onboardingUseCases(input.orgId);
  const useCase = available.find((candidate) => candidate.id === input.useCase) ?? available[0] ?? USE_CASES.find((candidate) => candidate.id === 'inbound-support')!;
  const business = (input.business ?? '').trim();
  const name = (input.name ?? useCase.assistantName).trim() || useCase.assistantName;

  // The workspace's tool catalogue: create anything the use case needs that the
  // org does not have yet, so the assistant is usable this second.
  const existing = list<Doc & { name?: string }>('tools', (t) => (t as { orgId?: string }).orgId === input.orgId);
  const catalogue = TOOL_LIBRARY.map((t) => ({ name: t.name.replace(/([A-Z])/g, (m) => m.toLowerCase()), label: t.name, type: t.type, description: t.description }));
  const missing: Doc[] = [];
  for (const tool of useCase.tools) {
    if (existing.some((e) => e.name === tool)) continue;
    const lib = catalogue.find((c) => c.name === tool) ?? catalogue.find((c) => c.label.toLowerCase() === tool);
    missing.push({
      id: `tool_${newId('').slice(1, 9)}`,
      orgId: input.orgId,
      name: tool,
      description: lib?.description ?? `${tool.replace(/_/g, ' ')} — called mid-call by the agent`,
      method: 'POST',
      // These named tools have platform executors. An owner can later replace one
      // with a reviewed endpoint; setup never invents an external integration.
      createdAt: nowIso(),
    } as Doc);
  }
  if (missing.length) {
    for (const tool of missing) insert<Doc>('tools', tool);
  }

  const assistant = insert<Doc>('assistants', {
    id: `asst_${newId('').slice(1, 11)}`,
    orgId: input.orgId,
    name,
    firstMessage: useCase.firstMessage.replace(/\{\{business\}\}/g, business || 'the team'),
    systemPrompt: [useCase.prompt, business ? `The business is called ${business}; use that name when you introduce yourself.` : '']
      .filter(Boolean)
      .join(' '),
    model: '',
    voiceId: '',
    temperature: 0.4,
    transcriber: '',
    language: 'en-US',
    tools: [...useCase.tools],
    knowledge: [...useCase.knowledge],
    serverUrl: '',
    status: input.publish === true ? 'published' : 'draft',
    template: useCase.template,
    calls: 0,
    minutes: 0,
    containment: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
  } as Doc);

  patchOnboarding(input.orgId, { useCase: useCase.id, assistantId: assistant.id });
  audit({
    orgId: input.orgId,
    actor: 'onboarding',
    action: 'assistant.created',
    target: assistant.id,
    detail: input.publish === true ? `published from use case ${useCase.id}` : `draft from use case ${useCase.id}, awaiting review`,
  });

  return { assistant, useCase: useCase.id, toolsCreated: missing.length, published: input.publish === true };
}

/** Number inventory for the wizard, on whichever account this workspace buys from. */
export async function onboardingNumberSearch(input: { orgId: string; areaCode?: string; country?: string }) {
  const mode = telephonyMode(input.orgId);
  const carrier = dialerFor(input.orgId);
  if (!carrier || mode === 'none') {
    return {
      mode,
      areaCode: input.areaCode,
      areaCodeLabel: input.areaCode ? areaCodeLabel(input.areaCode) : undefined,
      available: [] as { number: string; locality?: string; region?: string; price?: string }[],
      hint: 'No carrier is connected, so there is no inventory to search. Connect one under Carriers.',
    };
  }

  const search = await searchNumbers(carrier, { areaCode: input.areaCode, country: input.country, limit: 8 });
  if (!search.ok) {
    return {
      mode,
      areaCode: input.areaCode,
      areaCodeLabel: input.areaCode ? areaCodeLabel(input.areaCode) : undefined,
      available: [],
      hint: `The carrier refused the search: ${search.error}`,
    };
  }
  return {
    mode,
    areaCode: input.areaCode,
    areaCodeLabel: input.areaCode ? areaCodeLabel(input.areaCode) : undefined,
    available: search.data.map((n) => ({
      number: n.phone_number,
      locality: n.locality ?? undefined,
      region: n.region ?? undefined,
      monthlyCost: n.monthly_cost ?? null,
    })),
    hint: mode === 'managed'
      ? 'Provisioning uses the operator-configured carrier account. Price and availability remain the carrier response, not a Voxera quote.'
      : 'The number will be bought on the carrier account you connected; confirm charges with that carrier.',
  };
}

/**
 * Step two: buy a number and point it at the agent.
 *
 * The purchase and webhook wiring happen in one carrier call. Assistant
 * assignment is validated separately and may be left empty; in that case the
 * inbound route uses its explicit unassigned-number response. The local record
 * retains the carrier ID so release and reconciliation can reach the same account.
 */
export async function onboardingBuyNumber(input: {
  orgId: string;
  number: string;
  assistantId?: string;
  label?: string;
  country?: string;
  origin: string;
}) {
  const mode = telephonyMode(input.orgId);
  const carrier = dialerFor(input.orgId);
  if (!carrier || mode === 'none') return { ok: false as const, code: 'NO_CARRIER' as const, error: 'No carrier is connected, so no number can be bought.' };

  const e164 = input.number.replace(/[^\d+]/g, '');
  if (!/^\+\d{7,15}$/.test(e164)) return { ok: false as const, code: 'VALIDATION_ERROR' as const, error: 'That does not look like a phone number.' };

  const already = list<Doc>('numbers', (n) => n.orgId === input.orgId && String(n.number).replace(/[^\d+]/g, '') === e164)[0];
  if (already) return { ok: true as const, number: already, carrier: carrier.id, mode, reused: true };
  if (numberClaimConflict(e164, input.orgId)) {
    return { ok: false as const, code: 'CONFLICT' as const, error: 'That phone number is already claimed by another workspace on this deployment.' };
  }

  const assistantId = input.assistantId ?? onboardingFor(input.orgId).assistantId ?? null;
  if (assistantId) {
    const assistant = get<Doc>('assistants', assistantId);
    if (!assistant || assistant.orgId !== input.orgId) {
      return { ok: false as const, code: 'VALIDATION_ERROR' as const, error: 'That assistant is not in this workspace.' };
    }
  }

  const origin = input.origin.replace(/\/$/, '');
  const reserved = reserveNumberClaim({ number: e164, orgId: input.orgId, carrierId: carrier.id, operation: 'onboarding-purchase' });
  if (!reserved.ok) {
    return { ok: false as const, code: 'CONFLICT' as const, error: 'That phone number is already claimed or is being claimed by a workspace on this deployment.' };
  }
  const reservation = reserved.reservation;
  const purchase = await buyNumber(carrier, {
    phoneNumber: e164,
    label: input.label ?? 'Main line',
    voiceUrl: `${origin}/api/telephony/twilio/voice`,
    statusCallback: `${origin}/api/telephony/twilio/status`,
    smsUrl: `${origin}/api/telephony/twilio/inbound-message`,
  });
  if (!purchase.ok) {
    releaseNumberReservation(reservation);
    return { ok: false as const, code: 'CARRIER_ERROR' as const, error: purchase.error };
  }

  const quotedMonthly = Number(purchase.data.monthly_cost);
  const hasMonthlyQuote = Number.isFinite(quotedMonthly) && quotedMonthly >= 0;
  let record: Doc;
  try {
    record = insert<Doc>('numbers', {
      id: newId('num_'),
      orgId: input.orgId,
      number: e164,
      label: String(input.label ?? 'Main line').trim().slice(0, 120),
      provider: carrier.provider,
      carrierId: carrier.id,
      carrierSid: purchase.data.sid,
      assistantId,
      ...(input.country && /^[A-Za-z]{2}$/.test(input.country) ? { country: input.country.toUpperCase() } : {}),
      status: 'active',
      ...(hasMonthlyQuote ? { monthlyCost: quotedMonthly, monthlyCostSource: 'carrier_response' } : {}),
      inboundCalls30d: 0,
      createdAt: nowIso(),
    } as Doc);
  } catch (error) {
    const rollback = await releaseNumber(carrier, purchase.data.sid);
    releaseNumberReservation(reservation);
    audit({
      orgId: input.orgId,
      actor: 'onboarding',
      action: 'number.purchase_persistence_failed',
      detail: `${e164} (${purchase.data.sid}) — ${error instanceof Error ? error.message.slice(0, 160) : 'local write failed'}; carrier rollback ${rollback.ok ? 'succeeded' : `failed: ${rollback.error}`}`,
    });
    return {
      ok: false as const,
      code: 'INTERNAL_ERROR' as const,
      error: rollback.ok
        ? 'The local number record could not be saved, so the carrier purchase was rolled back.'
        : 'The local number record could not be saved and the carrier rollback failed. Reconcile it in the carrier console.',
    };
  }

  releaseNumberReservation(reservation);
  patchOnboarding(input.orgId, { numberId: record.id, assistantId: typeof assistantId === 'string' ? assistantId : undefined });
  audit({ orgId: input.orgId, actor: 'onboarding', action: 'number.provisioned', target: record.id, detail: `${e164} via ${mode}` });

  return { ok: true as const, number: record, carrier: carrier.id, mode, reused: false };
}

/**
 * Step three: the first call.
 *
 * Browser mode creates the call record the dashboard widget drives, so the client
 * is talking to the real runtime with a mic — not watching a simulation. Phone
 * mode dials their own number through the carrier, which is the only way to hear
 * what a customer will hear.
 */
export async function onboardingFirstCall(input: {
  orgId: string;
  mode: 'browser' | 'phone';
  assistantId?: string;
  to?: string;
  origin?: string;
}) {
  const doc = onboardingFor(input.orgId);
  const assistantId = input.assistantId ?? doc.assistantId;
  if (!assistantId) return { ok: false as const, code: 'NO_ASSISTANT' as const, error: 'Create an assistant first — a call needs something to say.' };

  const assistant = get<Doc & { name?: string }>('assistants', assistantId);
  if (!assistant || (assistant as { orgId?: string }).orgId !== input.orgId) {
    return { ok: false as const, code: 'NO_ASSISTANT' as const, error: 'That assistant is not in this workspace.' };
  }

  if (input.mode === 'browser') {
    const { call } = createCall({
      orgId: input.orgId,
      assistantId,
      type: 'web',
      from: 'browser',
      to: String(assistant.name ?? 'Assistant'),
      customer: { name: 'First test call', number: '' },
      source: 'onboarding',
    });
    if (!call) return { ok: false as const, code: 'INTERNAL_ERROR' as const, error: 'The call could not be created.' };
    patchOnboarding(input.orgId, { firstCallId: call.id });
    audit({ orgId: input.orgId, actor: 'onboarding', action: 'call.started', target: call.id, detail: 'browser test call' });
    return { ok: true as const, call, dialled: false, mode: 'browser' as const };
  }

  const to = String(input.to ?? '').replace(/[^\d+]/g, '');
  if (!/^\+\d{7,15}$/.test(to)) return { ok: false as const, code: 'VALIDATION_ERROR' as const, error: 'Send your number in E.164 format, e.g. +14155550123.' };

  const carrier = dialerFor(input.orgId);
  if (!carrier) return { ok: false as const, code: 'NO_CARRIER' as const, error: 'No carrier is connected, so nothing can be dialled. Use the browser test call instead.' };
  if (!input.origin) return { ok: false as const, code: 'VALIDATION_ERROR' as const, error: 'A public HTTPS origin is required for carrier callbacks.' };
  const numbers = list<Doc & { number?: string; assistantId?: string | null; carrierId?: string; status?: string }>(
    'numbers',
    (n) => n.orgId === input.orgId && n.carrierId === carrier.id && n.status !== 'released'
  );
  const fromRecord = numbers.find((n) => n.assistantId === assistantId && /^\+[1-9]\d{7,14}$/.test(String(n.number ?? '')))
    ?? numbers.find((n) => /^\+[1-9]\d{7,14}$/.test(String(n.number ?? '')));
  if (!fromRecord?.number) {
    return { ok: false as const, code: 'VALIDATION_ERROR' as const, error: 'This carrier has no active workspace number to use as caller ID.' };
  }
  const from = String(fromRecord.number);

  const { call } = createCall({
    orgId: input.orgId,
    assistantId,
    type: 'outbound',
    from,
    to,
    customer: { name: 'First test call', number: to },
    source: 'onboarding',
  });
  if (!call) return { ok: false as const, code: 'INTERNAL_ERROR' as const, error: 'The call could not be created.' };

  const origin = input.origin.replace(/\/$/, '');
  const { placeCall } = await import('./providers/twilio');
  const placed = await placeCall(carrier, {
    to,
    from,
    voiceUrl: `${origin}/api/telephony/twilio/voice`,
    statusCallback: `${origin}/api/telephony/twilio/status`,
    machineDetection: true,
    record: false,
  });

  if (!placed.ok) {
    const failed = update<Doc>('calls', call.id, { status: 'failed', endedReason: 'error' });
    audit({ orgId: input.orgId, actor: 'onboarding', action: 'call.dial_failed', target: call.id, detail: placed.error.slice(0, 200) });
    return { ok: false as const, code: 'CARRIER_ERROR' as const, error: placed.error, call: failed ?? call };
  }

  const { rememberCarrierCall } = await import('./telephony');
  rememberCarrierCall(placed.data.sid, call.id, input.orgId);
  const accepted = update<Doc>('calls', call.id, {
    telephony: { provider: carrier.provider, carrierCallId: placed.data.sid, providerAcceptedAt: nowIso(), direction: 'outbound' },
  });
  patchOnboarding(input.orgId, { firstCallId: call.id });
  audit({ orgId: input.orgId, actor: 'onboarding', action: 'call.submitted_to_carrier', target: call.id, detail: `${to} via ${carrier.provider}` });

  return { ok: true as const, call: accepted ?? call, dialled: true, providerAccepted: true, carrierSid: placed.data.sid, mode: 'phone' as const };
}

/** Numbers already bought that a client can attach to the agent in one click. */
export async function attachExistingNumbers(orgId: string, assistantId: string) {
  const carriers = list<CarrierDoc>('carriers', (c) => c.orgId === orgId);
  const numbers = list<Doc & { assistantId?: string | null; carrierSid?: string; carrierId?: string }>('numbers', (n) => n.orgId === orgId);
  let wired = 0;
  for (const number of numbers) {
    // A number adopted by hand may predate the wizard; its webhooks still need to
    // point at the agent before it can answer.
    if (number.assistantId === assistantId) continue;
    update<Doc>('numbers', number.id, { assistantId });
    // An existing number bought on a carrier account already has webhooks from
    // its purchase; one adopted by hand may not, so re-point it.
    const carrier = carriers.find((c) => c.id === number.carrierId) ?? carrierFor(orgId);
    if (carrier && number.carrierSid) {
      const origin = carrier.webhookBase || process.env.VOXERA_PUBLIC_URL || 'http://127.0.0.1:3000';
      await configureNumber(carrier, number.carrierSid, {
        voiceUrl: `${origin}/api/telephony/twilio/voice`,
        statusCallback: `${origin}/api/telephony/twilio/status`,
        smsUrl: `${origin}/api/telephony/twilio/inbound-message`,
      }).catch(() => undefined);
      wired += 1;
    }
  }
  return { attached: numbers.length, wired };
}

/** The managed account id, exported so the dashboard can label numbers by origin. */
export { MANAGED_CARRIER_ID };
