/** Explicit minimum administrative patient view permitted at the phone-assistant boundary. */

import { clientById } from './clients';
import { resolveExactIdentity } from './patient-identity';
import { patientAlertsFor } from './patient-alerts';

export type PhoneAssistantPatientContext =
  | { match: 'none'; identityConfirmed: false; requiresStaffHandoff: false }
  | { match: 'review_required'; identityConfirmed: false; requiresStaffHandoff: true }
  | {
      match: 'exact_unique';
      identityConfirmed: false;
      patient: {
        id: string;
        name: string;
        primaryPhone: string;
        email?: string;
        smsContactAllowed: boolean;
      };
      requiresStaffHandoff: boolean;
    };

/**
 * A phone number is a lookup hint, never proof of identity. Ambiguity exposes no
 * candidate names or IDs. Alert labels/details, notes, forms, DOB, address,
 * coverage and cross-patient context are never returned; staff receive only a
 * boolean handoff signal derived from active administrative notices.
 */
export function phoneAssistantPatientContext(orgId: string, phone: string): PhoneAssistantPatientContext {
  const identity = resolveExactIdentity(orgId, 'phone', phone);
  if (identity.status === 'none') return { match: 'none', identityConfirmed: false, requiresStaffHandoff: false };
  if (identity.status === 'ambiguous') return { match: 'review_required', identityConfirmed: false, requiresStaffHandoff: true };
  const patient = clientById(orgId, identity.patientId);
  if (!patient || patient.archivedAt) return { match: 'none', identityConfirmed: false, requiresStaffHandoff: false };
  const administrativeNotices = patientAlertsFor(orgId, patient.id, { includeClinical: false });
  return {
    match: 'exact_unique',
    identityConfirmed: false,
    patient: {
      id: patient.id,
      name: patient.name,
      primaryPhone: patient.number,
      email: patient.email,
      smsContactAllowed: patient.consents?.sms?.granted === true,
    },
    requiresStaffHandoff: administrativeNotices.length > 0,
  };
}
