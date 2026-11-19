/**
 * Small dashboard reference lists. Operational records and prices come from APIs;
 * this module contains no sample tenant data or inferred tariff.
 */

export const KNOWLEDGE_OPTIONS: { name: string; type: string; size: string; chunks: number }[] = [];
export const SCRIPTED_TEST_REPLIES: string[] = [];
export const SIM_SCENARIOS: { id: string; name: string; category: string; persona: string; desc: string }[] = [];

export const NUMBER_COUNTRIES = [
  { code: 'US', label: 'United States', dial: '+1', areaCodes: ['415', '212', '312', '646', '703', '206'], monthly: 'provider quote required' },
  { code: 'GB', label: 'United Kingdom', dial: '+44', areaCodes: ['20', '161', '131'], monthly: 'provider quote required' },
  { code: 'PK', label: 'Pakistan', dial: '+92', areaCodes: ['42', '21', '51'], monthly: 'provider quote required' },
  { code: 'AU', label: 'Australia', dial: '+61', areaCodes: ['2', '3'], monthly: 'provider quote required' },
];

export const WEBHOOK_EVENTS: string[] = [];
export const LOG_PATHS: { method: string; path: string; status: number }[] = [];
export const TEAM_ROLES: { id: string; label: string; desc: string }[] = [];

export const USAGE_RATES = {
  platformPerMin: null,
  providerPerMin: null,
  allInPerMin: null,
  includedMinutes: null,
};
