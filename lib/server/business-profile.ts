/** Server-side workspace business profile persistence. */

import { get, update, type Doc } from './db';
import { audit } from './audit';
import { practiceProfile, setPracticeProfile } from './practice';
import { moneySettingsFor, setMoneySettings } from './money';
import {
  effectiveBusinessProfile,
  type BusinessHoursRow,
  type BusinessProfile,
  type BusinessType,
  type EffectiveBusinessProfile,
  type ModuleId,
} from '../business';
import type { TermPackId } from '../terms';

export type OrgWithBusiness = Doc & { businessProfile?: BusinessProfile };

export function businessProfileFor(orgId: string): EffectiveBusinessProfile {
  const org = get<OrgWithBusiness>('orgs', orgId);
  return effectiveBusinessProfile(org?.businessProfile);
}

export function workspaceProfileView(orgId: string) {
  const business = businessProfileFor(orgId);
  const practice = practiceProfile(orgId);
  const money = moneySettingsFor(orgId);
  return {
    business,
    vocabulary: practice.termPack,
    money: { currency: money.currency },
  };
}

export function saveBusinessProfile(input: {
  orgId: string;
  actor: string;
  type?: BusinessType;
  otherDescription?: string;
  modules?: ModuleId[];
  country?: string;
  timezone?: string;
  currency?: string;
  businessHours?: BusinessHoursRow[];
  /** Vocabulary is independent: only an explicit value changes it. */
  termPack?: TermPackId;
}): ReturnType<typeof workspaceProfileView> {
  const current = businessProfileFor(input.orgId);
  const now = new Date().toISOString();
  const next: BusinessProfile = {
    version: 1,
    type: input.type ?? current.type,
    modules: input.modules ? [...input.modules] : [...current.modules],
    otherDescription:
      input.otherDescription !== undefined ? input.otherDescription || undefined : current.otherDescription,
    country: input.country !== undefined ? input.country || undefined : current.country,
    timezone: input.timezone !== undefined ? input.timezone || undefined : current.timezone,
    currency: input.currency !== undefined ? input.currency || undefined : current.currency,
    businessHours: input.businessHours !== undefined ? input.businessHours : current.businessHours,
    updatedAt: now,
    updatedBy: input.actor,
  };

  update<OrgWithBusiness>('orgs', input.orgId, { businessProfile: next } as Partial<OrgWithBusiness>);

  // These are explicit independent settings. A type change alone never relabels
  // historic records or changes the currency used by existing invoices.
  if (input.termPack !== undefined && input.termPack !== practiceProfile(input.orgId).termPack) {
    setPracticeProfile(input.orgId, { termPack: input.termPack }, input.actor);
  }
  if (input.currency !== undefined && input.currency !== moneySettingsFor(input.orgId).currency) {
    setMoneySettings(input.orgId, { currency: input.currency }, input.actor);
  }

  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'workspace.business_profile_updated',
    detail: [
      input.type !== undefined ? `type=${next.type}` : undefined,
      input.modules !== undefined ? `modules=${next.modules.join(',')}` : undefined,
      input.country !== undefined ? `country=${next.country ?? 'unset'}` : undefined,
      input.timezone !== undefined ? `timezone=${next.timezone ?? 'unset'}` : undefined,
      input.currency !== undefined ? `currency=${next.currency ?? 'unset'}` : undefined,
      input.businessHours !== undefined ? 'businessHours' : undefined,
      input.termPack !== undefined ? `vocabulary=${input.termPack}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ') || 'profile confirmed',
  });

  return workspaceProfileView(input.orgId);
}
