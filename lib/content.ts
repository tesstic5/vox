import type { ModelOption, TranscriberOption, Voice } from './types';

/** Shared product identity and the small, verified navigation surface. */
export const SITE = {
  name: 'Voxera',
  tagline: 'Calls, bookings and customer care',
  description:
    'Voxera brings appointments, customer communications and an optional AI phone assistant together in one workspace.',
  url: 'https://voxera.ai',
  supportPhone: '',
  supportPhoneDisplay: 'No staffed phone line published',
  email: '',
  salesEmail: '',
  twitter: '',
  github: '',
  discord: '',
  address: 'Deployment operator address not published',
  copyright: `© ${new Date().getFullYear()} Voxera`,
};

export const NAV: {
  label: string;
  href: string;
  columns?: { title: string; links: { label: string; href: string; desc?: string; badge?: string }[] }[];
  featured?: { title: string; desc: string; href: string };
}[] = [
  {
    label: 'Platform',
    href: '/platform',
    columns: [
      {
        title: 'Business records',
        links: [
          { label: 'Business profiles', href: '/solutions', desc: 'Types recommend modules and explicit vocabulary' },
          { label: 'Contractor workflow', href: '/solutions', desc: 'Enquiry through visits and draft invoice' },
          { label: 'Scheduling', href: '/solutions', desc: 'Services, rotas, appointments and classes' },
          { label: 'Money records', href: '/platform', desc: 'Invoices, balances and settlement boundaries' },
        ],
      },
      {
        title: 'Calls and automation',
        links: [
          { label: 'Assistants', href: '/platform', desc: 'Draft, test and publish bounded configurations' },
          { label: 'Calls', href: '/platform', desc: 'Stored transcripts and observed metrics' },
          { label: 'Provider connections', href: '/platform', desc: 'Credentials require target-environment verification' },
          { label: 'Developer APIs', href: '/docs', desc: 'Tenant-scoped routes, keys and webhooks' },
        ],
      },
      {
        title: 'Evidence',
        links: [
          { label: 'Implementation guide', href: '/docs', desc: 'Verified scope and release checks' },
          { label: 'Security boundaries', href: '/security', desc: 'Implemented controls and external work' },
          { label: 'Deployment status', href: '/status', desc: 'Current health without invented uptime' },
          { label: 'Support paths', href: '/support', desc: 'Use request IDs and audit records' },
        ],
      },
    ],
    featured: {
      title: 'Business records first',
      desc: 'Optional providers connect to an already coherent workspace.',
      href: '/platform',
    },
  },
  { label: 'Solutions', href: '/solutions' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: '/docs' },
  { label: 'Security', href: '/security' },
  { label: 'Contact', href: '/contact' },
];

export const STATS = [
  { value: '4', label: 'initial business profiles' },
  { value: '1', label: 'tenant boundary per workspace' },
  { value: '0', label: 'certifications claimed by this build' },
  { value: 'Required', label: 'target-environment provider verification' },
];

/** Retired marketing catalogues stay empty so old imports cannot republish claims. */
type LegacyCard = Record<string, any>;
export const INTEGRATIONS: { name: string; category: string; glyph: string }[] = [];
export const ENTERPRISE_FEATURES: LegacyCard[] = [];
export const CAPABILITIES: {
  id: string;
  eyebrow: string;
  title: string;
  desc: string;
  bullets: string[];
  code: string;
}[] = [];
export const SOLUTIONS: LegacyCard[] = [];
export const INDUSTRIES: LegacyCard[] = [];
export const TESTIMONIALS: LegacyCard[] = [];
export const CASE_STUDIES: LegacyCard[] = [];
export const PRICING_PLANS: LegacyCard[] = [];
export const USAGE_COSTS: LegacyCard[] = [];
export const FAQS: LegacyCard[] = [];
export const CREATORS_TIERS: LegacyCard[] = [];
export const CAREERS: LegacyCard[] = [];
export const CAREER_PERKS: LegacyCard[] = [];
export const CHANGELOG: LegacyCard[] = [];

/**
 * Stored voice identifiers offered by setup. These are provider identifiers,
 * not a promise that the target deployment has access; provider verification is
 * required before live use.
 */
export const VOICES: Voice[] = [
  {
    id: '21m00Tcm4TlvDq8ikWAM',
    name: 'ElevenLabs default voice ID',
    provider: 'elevenlabs',
    gender: 'feminine',
    accent: 'provider-defined',
    age: 'middle',
    description: 'Provider voice identifier; verify access and suitability with the connected ElevenLabs account.',
    tags: ['verification-required'],
  },
  {
    id: 'a0e99841-438c-4a64-b679-ae501e7d6091',
    name: 'Cartesia default voice ID',
    provider: 'cartesia',
    gender: 'neutral',
    accent: 'provider-defined',
    age: 'middle',
    description: 'Provider voice identifier; verify access and suitability with the connected Cartesia account.',
    tags: ['verification-required'],
  },
  {
    id: 'alloy',
    name: 'OpenAI alloy',
    provider: 'openai-tts',
    gender: 'neutral',
    accent: 'provider-defined',
    age: 'middle',
    description: 'Provider voice identifier; verify availability with the connected OpenAI account.',
    tags: ['verification-required'],
  },
];

/**
 * Selectable model identifiers. Prices, context limits and latency are not
 * maintained as billing truth here; the connected provider remains authoritative.
 */
export const MODELS: ModelOption[] = [
  ['gpt-5-chat', 'GPT-5 Chat', 'openai'],
  ['gpt-5-mini', 'GPT-5 mini', 'openai'],
  ['gpt-4.1', 'GPT-4.1', 'openai'],
  ['gpt-4o-mini', 'GPT-4o mini', 'openai'],
  ['claude-sonnet-4.5', 'Claude Sonnet 4.5', 'anthropic'],
  ['claude-haiku-4.5', 'Claude Haiku 4.5', 'anthropic'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash', 'google'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro', 'google'],
  ['llama-4-scout', 'Llama 4 Scout', 'groq'],
  ['groq-gpt-oss-120b', 'GPT-OSS 120B (Groq)', 'groq'],
  ['deepseek-v3.2', 'DeepSeek V3.2', 'deepseek'],
  ['mistral-large', 'Mistral Large', 'mistral'],
].map(([id, label, provider]) => ({
  id,
  label,
  provider: provider as ModelOption['provider'],
  context: 'provider-defined',
  latency: 'unknown',
  inputCost: 0,
  outputCost: 0,
  strengths: ['Verify with provider'],
}));

export const TRANSCRIBERS: TranscriberOption[] = [
  {
    id: 'deepgram-nova-3',
    label: 'Deepgram Nova-3',
    provider: 'deepgram',
    languages: 'provider-defined',
    costPerMin: 0,
    latencyMs: 0,
    streaming: true,
  },
];

export const STARTER_TEMPLATES = [
  {
    id: 'blank-receptionist',
    name: 'General receptionist draft',
    category: 'General',
    desc: 'A factual first-line draft with no tools attached and no provider delivery implied.',
    firstMessage: 'Hello. How can I help today?',
    prompt: 'Be concise and factual. Use only information explicitly provided by this workspace. Do not claim an action succeeded unless a registered tool returned success. Transfer or take a message when unsure.',
    voiceId: '',
    model: 'gpt-4o-mini',
    tools: [],
  },
  {
    id: 'appointment-admin',
    name: 'Appointment administration draft',
    category: 'Scheduling',
    desc: 'Availability, booking, rescheduling and cancellation against configured workspace records.',
    firstMessage: 'Hello. I can help with an appointment. What would you like to do?',
    prompt: 'Handle administrative scheduling only. Read availability from registered tools, repeat the chosen time and location, and never invent a slot or confirm before a tool succeeds.',
    voiceId: '',
    model: 'gpt-4o-mini',
    tools: ['check_availability', 'book_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_confirmation', 'transfer_call'],
  },
  {
    id: 'contractor-enquiry',
    name: 'Contractor enquiry draft',
    category: 'Field service',
    desc: 'Capture an enquiry and schedule only work that has reached the approved job flow.',
    firstMessage: 'Hello. Tell me what work you need help with and where it is located.',
    prompt: 'Capture the customer request accurately. Do not quote a price, promise attendance, or schedule work unless the corresponding registered tool succeeds. Escalate emergencies and uncertain requests.',
    voiceId: '',
    model: 'gpt-4o-mini',
    tools: ['capture_field_enquiry', 'schedule_approved_visit', 'transfer_call'],
  },
  {
    id: 'practice-admin',
    name: 'Practice administration draft',
    category: 'Practice',
    desc: 'Administrative scheduling and draft notes only—no diagnosis, treatment, charting, insurance claim or clinical assessment.',
    firstMessage: 'Hello. I can help with administrative appointment questions. How can I help?',
    prompt: 'Handle administrative scheduling only. Never diagnose, assess symptoms, discuss results, provide treatment advice, or imply dental charting, imaging or insurance-claim capability. Transfer clinical questions to a person.',
    voiceId: '',
    model: 'gpt-4o-mini',
    tools: ['check_availability', 'book_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_confirmation', 'draft_note', 'transfer_call'],
  },
  {
    id: 'payment-status',
    name: 'Payment status draft',
    category: 'Money',
    desc: 'Read recorded invoice state and create a provider-boundary payment link without claiming settlement.',
    firstMessage: 'Hello. I can help explain the payment status recorded in this workspace.',
    prompt: 'Read only recorded invoice and payment state. Never collect card details in conversation and never claim provider settlement. A payment link is pending until the configured provider confirms it.',
    voiceId: '',
    model: 'gpt-4o-mini',
    tools: ['payment_status', 'create_payment_link', 'transfer_call'],
  },
] as const;

/** Descriptions for platform executors created by guided setup. */
export const TOOL_LIBRARY = [
  { id: 'capture_field_enquiry', name: 'capture_field_enquiry', type: 'apiRequest' as const, description: 'Create a tenant-scoped field-service enquiry.', parameters: [] },
  { id: 'schedule_approved_visit', name: 'schedule_approved_visit', type: 'apiRequest' as const, description: 'Schedule a visit for an approved job, subject to server conflict checks.', parameters: [] },
  { id: 'lookup_order', name: 'lookup_order', type: 'query' as const, description: 'Run the built-in demonstration order lookup; no external commerce system is implied.', parameters: [] },
  { id: 'check_availability', name: 'check_availability', type: 'query' as const, description: 'Read workspace availability from configured services, rotas and bookings.', parameters: [] },
  { id: 'book_appointment', name: 'book_appointment', type: 'apiRequest' as const, description: 'Create a workspace appointment after server availability checks.', parameters: [] },
  { id: 'reschedule_appointment', name: 'reschedule_appointment', type: 'apiRequest' as const, description: 'Move a workspace appointment after conflict checks.', parameters: [] },
  { id: 'cancel_appointment', name: 'cancel_appointment', type: 'apiRequest' as const, description: 'Cancel a workspace appointment.', parameters: [] },
  { id: 'send_confirmation', name: 'send_confirmation', type: 'apiRequest' as const, description: 'Queue a confirmation through the configured message transport.', parameters: [] },
  { id: 'draft_note', name: 'draft_note', type: 'apiRequest' as const, description: 'Create an unsigned draft note linked to a workspace record.', parameters: [] },
  { id: 'payment_status', name: 'payment_status', type: 'query' as const, description: 'Read recorded invoice and payment status; this does not prove provider settlement.', parameters: [] },
  { id: 'create_payment_link', name: 'create_payment_link', type: 'apiRequest' as const, description: 'Create a payment-link record through the configured provider boundary.', parameters: [] },
  { id: 'transfer_call', name: 'transfer_call', type: 'transferCall' as const, description: 'Request a transfer when carrier delivery is configured.', parameters: [] },
];

export const COMPARISON = [
  { feature: 'Business records', voxera: 'Tenant-scoped application records', diy: 'You design and implement them', legacy: 'Vendor-specific' },
  { feature: 'Provider delivery', voxera: 'Requires configured third parties', diy: 'You integrate providers', legacy: 'Depends on vendor contract' },
  { feature: 'Security evidence', voxera: 'Application controls plus deployment review', diy: 'Your responsibility', legacy: 'Request evidence from vendor' },
  { feature: 'Uptime commitment', voxera: 'Not supplied by this codebase', diy: 'Your responsibility', legacy: 'Depends on signed agreement' },
];

export const SECURITY_ITEMS = [
  { title: 'Tenant checks', desc: 'API reads and writes verify the authenticated workspace.', icon: 'building' },
  { title: 'Role checks', desc: 'Sensitive changes are enforced by server-side role gates.', icon: 'users' },
  { title: 'Two-factor authentication', desc: 'Authenticator codes and recovery codes are implemented.', icon: 'shield' },
  { title: 'Hashed API keys', desc: 'Secrets are shown once, scoped and stored as hashes.', icon: 'key' },
  { title: 'Audit records', desc: 'Sensitive actions write tenant-owned audit entries.', icon: 'terminal' },
  { title: 'External review required', desc: 'No certification, BAA or compliance attestation is claimed.', icon: 'alert' },
];

export const PLATFORM_CODE_SAMPLES: Record<string, { label: string; lang: string; code: string }[]> = {};

export function TalkToSupport() {
  return null;
}

export const BLOG_CATEGORIES = ['All'] as const;
export const LEGAL_UPDATED = 'November 4, 2026';
export const FOOTER_COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [];
