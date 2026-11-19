/**
 * Workspace business profiles and module recommendations.
 *
 * A business type changes words, setup recommendations and navigation. It is not
 * an authorisation boundary: every API continues to enforce its own role and
 * tenant checks whether or not its link is visible in the dashboard.
 *
 * Existing workspaces deliberately have no stored profile. `legacyProfile()`
 * gives those workspaces every module they already had without writing anything
 * back or guessing what kind of business they are. The first owner save is the
 * explicit migration point.
 */

import type { TermPackId } from './terms';

export const BUSINESS_TYPES = ['contractor', 'dental', 'physiotherapy', 'other'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_OPTIONS: Array<{
  id: BusinessType;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    id: 'contractor',
    label: 'Contractor / home services',
    shortLabel: 'Contractor',
    description: 'Enquiries, estimates, jobs, visits, customers and invoices.',
  },
  {
    id: 'dental',
    label: 'Dental practice',
    shortLabel: 'Dental',
    description: 'Patients, appointments, practitioners, reminders and billing.',
  },
  {
    id: 'physiotherapy',
    label: 'Physiotherapy',
    shortLabel: 'Physiotherapy',
    description: 'Patients, appointments, treatment notes, classes and follow-up.',
  },
  {
    id: 'other',
    label: 'Other service business',
    shortLabel: 'Other',
    description: 'Choose the customer, scheduling, communication and business tools you need.',
  },
];

export const MODULE_IDS = [
  'customers',
  'schedule',
  'communications',
  'field_service',
  'money',
  'reports',
  'clinical_notes',
  'clinical_records',
  'clinical_documents',
  'intake_forms',
  'referrals',
  'correspondence',
  'privacy_governance',
  'classes',
  'assistants',
  'campaigns',
  'developer',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export type ModuleDefinition = {
  id: ModuleId;
  label: string;
  description: string;
  dependencies: ModuleId[];
  consequence?: string;
};

export const MODULES: ModuleDefinition[] = [
  {
    id: 'customers',
    label: 'Customers or patients',
    description: 'Customer records, contact details, history and consent.',
    dependencies: [],
  },
  {
    id: 'schedule',
    label: 'Schedule and availability',
    description: 'Calendar, services, team availability, locations and appointments.',
    dependencies: ['customers'],
  },
  {
    id: 'communications',
    label: 'Calls and messages',
    description: 'Call records, phone numbers, confirmations and customer messages.',
    dependencies: ['customers'],
    consequence: 'Hiding this module does not stop already configured calls, reminders or messages.',
  },
  {
    id: 'field_service',
    label: 'Field service',
    description: 'Enquiries, estimates, jobs, visits and dispatch for work at customer sites.',
    dependencies: ['customers', 'schedule', 'money'],
  },
  {
    id: 'money',
    label: 'Invoices and payments',
    description: 'Draft and issue invoices, record payments and review balances.',
    dependencies: ['customers'],
    consequence: 'Turning this off only hides everyday navigation; it never deletes invoices or pauses payment links.',
  },
  {
    id: 'reports',
    label: 'Reports',
    description: 'Operational, appointment and financial summaries from workspace records.',
    dependencies: [],
  },
  {
    id: 'clinical_notes',
    label: 'Treatment notes',
    description: 'Restricted draft and signed notes linked to patients and appointments.',
    dependencies: ['customers', 'schedule'],
  },
  {
    id: 'clinical_records',
    label: 'Clinical record foundation',
    description: 'Granular clinical access, patient identity review, restricted alerts and readiness controls.',
    dependencies: ['customers', 'schedule'],
    consequence: 'Enabling this module does not permit real patient data or certify clinical suitability; live-mode gates remain separate.',
  },
  {
    id: 'clinical_documents',
    label: 'Encrypted clinical documents',
    description: 'Quarantined encrypted uploads, immutable versions, controlled downloads and metadata-only legacy migration.',
    dependencies: ['clinical_records'],
    consequence: 'Uploads remain unavailable until the configured malware scanner returns clean.',
  },
  {
    id: 'intake_forms',
    label: 'Intake and outcome forms',
    description: 'Versioned form templates, secure patient links, conditional questions, uploads and reviewed demographic updates.',
    dependencies: ['clinical_records', 'customers'],
    consequence: 'A published form can still have active secure links; hiding this module does not revoke them.',
  },
  {
    id: 'referrals',
    label: 'Referral inbox',
    description: 'Receive, triage, assign, risk-flag, accept and convert referrals with a complete decision history.',
    dependencies: ['clinical_records', 'customers'],
  },
  {
    id: 'correspondence',
    label: 'Letters and correspondence',
    description: 'Snapshot-based merge templates, approval, finalised PDFs and controlled delivery evidence.',
    dependencies: ['clinical_records', 'customers', 'communications'],
  },
  {
    id: 'privacy_governance',
    label: 'Privacy and retention governance',
    description: 'Controller-entered processing, processor, retention, legal-hold, deletion and external-review records.',
    dependencies: ['clinical_records'],
    consequence: 'These records support governance; they do not constitute legal advice or a compliance certification.',
  },
  {
    id: 'classes',
    label: 'Classes and wait lists',
    description: 'Group sessions, attendance, capacity, packs and wait lists.',
    dependencies: ['customers', 'schedule'],
  },
  {
    id: 'assistants',
    label: 'Call assistant',
    description: 'Draft, review and publish an assistant for calls and booking tasks.',
    dependencies: [],
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    description: 'Optional outbound call and appointment follow-up campaigns.',
    dependencies: ['communications'],
    consequence: 'Hiding campaigns does not pause a campaign that is already running.',
  },
  {
    id: 'developer',
    label: 'Developer tools',
    description: 'API keys, webhooks, registered HTTP tools, provider configuration and server-backed call diagnostics.',
    dependencies: [],
  },
];

const DEFAULT_MODULES: Record<BusinessType, ModuleId[]> = {
  contractor: ['customers', 'schedule', 'communications', 'field_service', 'money', 'reports', 'assistants'],
  dental: ['customers', 'schedule', 'communications', 'money', 'reports', 'clinical_notes', 'clinical_records', 'clinical_documents', 'intake_forms', 'referrals', 'correspondence', 'privacy_governance', 'assistants'],
  physiotherapy: ['customers', 'schedule', 'communications', 'money', 'reports', 'clinical_notes', 'clinical_records', 'clinical_documents', 'intake_forms', 'referrals', 'correspondence', 'privacy_governance', 'classes', 'assistants'],
  other: ['customers', 'schedule', 'communications', 'money', 'assistants'],
};

export type BusinessHoursRow = {
  /** 0 = Sunday. */
  weekday: number;
  open: boolean;
  start?: string;
  end?: string;
};

export type BusinessProfile = {
  version: 1;
  type: BusinessType;
  otherDescription?: string;
  modules: ModuleId[];
  /** ISO 3166-1 alpha-2. Empty until the owner confirms it. */
  country?: string;
  /** IANA timezone. Empty until the owner confirms it. */
  timezone?: string;
  /** ISO 4217 code. Empty until the owner confirms it. */
  currency?: string;
  /** A compact workspace-level summary; provider rotas remain authoritative for bookable time. */
  businessHours?: BusinessHoursRow[];
  updatedAt: string;
  updatedBy?: string;
};

export type EffectiveBusinessProfile = BusinessProfile & {
  /** False means this is the compatibility view for an untouched workspace. */
  configured: boolean;
  recommendedModules: ModuleId[];
  recommendedTermPack: TermPackId;
};

export function isBusinessType(value: unknown): value is BusinessType {
  return BUSINESS_TYPES.includes(String(value) as BusinessType);
}

export function isModuleId(value: unknown): value is ModuleId {
  return MODULE_IDS.includes(String(value) as ModuleId);
}

export function recommendedModules(type: BusinessType): ModuleId[] {
  return [...DEFAULT_MODULES[type]];
}

export function recommendedTermPack(type: BusinessType): TermPackId {
  if (type === 'contractor') return 'service';
  if (type === 'dental' || type === 'physiotherapy') return 'clinical';
  return 'generic';
}

export function makeBusinessProfile(type: BusinessType, actor?: string): BusinessProfile {
  return {
    version: 1,
    type,
    modules: recommendedModules(type),
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
}

/**
 * Compatibility profile for an organisation created before business profiles.
 * Every old route remains visible, and nothing is persisted until an owner saves.
 */
export function legacyProfile(): EffectiveBusinessProfile {
  return {
    version: 1,
    type: 'other',
    modules: [...MODULE_IDS],
    updatedAt: '',
    configured: false,
    recommendedModules: recommendedModules('other'),
    recommendedTermPack: 'generic',
  };
}

export function effectiveBusinessProfile(stored: unknown): EffectiveBusinessProfile {
  if (!stored || typeof stored !== 'object') return legacyProfile();
  const row = stored as Partial<BusinessProfile>;
  if (!isBusinessType(row.type)) return legacyProfile();
  const modules = Array.isArray(row.modules) ? [...new Set(row.modules.filter(isModuleId))] : recommendedModules(row.type);
  return {
    version: 1,
    type: row.type,
    otherDescription: typeof row.otherDescription === 'string' ? row.otherDescription : undefined,
    modules,
    country: typeof row.country === 'string' ? row.country : undefined,
    timezone: typeof row.timezone === 'string' ? row.timezone : undefined,
    currency: typeof row.currency === 'string' ? row.currency : undefined,
    businessHours: Array.isArray(row.businessHours) ? row.businessHours : undefined,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : undefined,
    configured: true,
    recommendedModules: recommendedModules(row.type),
    recommendedTermPack: recommendedTermPack(row.type),
  };
}

export function moduleDefinition(id: ModuleId): ModuleDefinition {
  return MODULES.find((module) => module.id === id)!;
}

/** Missing dependencies, grouped by the selected module that needs them. */
export function moduleDependencyErrors(modules: ModuleId[]): Array<{ module: ModuleId; missing: ModuleId[] }> {
  const selected = new Set(modules);
  return modules
    .map((id) => ({ module: id, missing: moduleDefinition(id).dependencies.filter((dependency) => !selected.has(dependency)) }))
    .filter((row) => row.missing.length > 0);
}

export function modulesWithDependencies(modules: ModuleId[]): ModuleId[] {
  const selected = new Set<ModuleId>(modules);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...selected]) {
      for (const dependency of moduleDefinition(id).dependencies) {
        if (!selected.has(dependency)) {
          selected.add(dependency);
          changed = true;
        }
      }
    }
  }
  return MODULE_IDS.filter((id) => selected.has(id));
}

export function businessTypeLabel(type: BusinessType): string {
  return BUSINESS_TYPE_OPTIONS.find((option) => option.id === type)?.label ?? 'Other service business';
}

export function labelsForBusiness(type: BusinessType) {
  if (type === 'contractor') {
    return { people: 'Customers', person: 'Customer', schedule: 'Schedule', setup: 'Services & team', home: 'Work overview' };
  }
  if (type === 'dental' || type === 'physiotherapy') {
    return { people: 'Patients', person: 'Patient', schedule: 'Appointments', setup: 'Practice setup', home: 'Practice overview' };
  }
  return { people: 'Clients', person: 'Client', schedule: 'Calendar', setup: 'Business setup', home: 'Overview' };
}
