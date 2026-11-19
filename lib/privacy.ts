/**
 * What may live in the browser.
 *
 * The dashboard mirrors its working state into `localStorage` so a refresh
 * cannot lose an unsaved edit — sensible for a widget or a draft prompt, wrong
 * for records. A patient list, a medical alert or a consent state kept in
 * browser storage survives sign-out, syncs to nobody, and cannot be audited.
 *
 * So practice records are server-first: the dashboard reads them from the API on
 * every visit and writes changes straight back. The rest of the store keeps its
 * cache, minus anything a record might hide in.
 *
 * Two guards, because one is not enough:
 *
 *   `strippedForMirror`  removes whole collections before a write
 *   `findPrivateData`    refuses a write that still carries record fields
 *
 * `scripts/privacy_check.ts` fails the build if either stops working.
 */

/**
 * Top-level state keys that must never be written to client-side storage.
 *
 * None of these exist in the browser mirror today — which is the point: the
 * guard has to bite the moment somebody adds one, not after the fact. `alerts`
 * and `invoices` are deliberately absent: the console has its own alerts and
 * billing invoices, and a practice record is identified by more than a word.
 */
export const SERVER_ONLY_COLLECTIONS = [
  'clients',
  'patientRecords',
  'clientAlerts',
  'clientConsents',
  'consents',
  'appointments',
  'diaryAppointments',
  'notes',
  'accessLog',
  'clinicalAccessEvents',
  'patientContactPoints',
  'identityConflicts',
  'clientMergeEvents',
  'patientAlerts',
  'clinicalPatientAlerts',
  'clinicalDocuments',
  'documentLinks',
  'clinicalDocumentVersions',
  'documentScanEvents',
  'documentUploadTokens',
  'privacyProfiles',
  'processingActivities',
  'processorRecords',
  'processors',
  'communicationDataPolicies',
  'retentionPolicies',
  'legalHolds',
  'deletionRequests',
  'externalAttestations',
  'recoveryEvidence',
  'documentDownloadManifests',
  'clinicalProfiles',
  'caseloadAssignments',
  'recordGrants',
  'accessGrants',
  'permissionShadowEvents',
  'domainJobs',
  'deadLetters',
  'integrationCredentials',
  'providerSnapshots',
  'calls',
  'waitList',
  'series',
] as const;

/**
 * Fields that betray a record, wherever they turn up.
 *
 * A cached object carrying any of these is a record no matter what the key it
 * arrived under is called — and a client record nested inside a "recently
 * viewed" list is exactly how this leaks in real products.
 */
export const SERVER_ONLY_FIELDS = [
  'dateOfBirth',
  'retentionUntil',
  'medicalAlerts',
  'normalizedValue',
  'article9Condition',
  'wrappedKey',
  'dataAuthTag',
  'guardianName',
  'medicareNumber',
] as const;

export type ServerOnlyCollection = (typeof SERVER_ONLY_COLLECTIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Paths to private data found anywhere in a value, e.g. `state.clients[3]`.
 *
 * Returns every path rather than the first, because a leak usually arrives in
 * more than one place.
 */
export function findPrivateData(value: unknown, path = 'state'): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findPrivateData(item, `${path}[${index}]`)));
    return found;
  }
  if (!isRecord(value)) return found;

  for (const [key, inner] of Object.entries(value)) {
    if ((SERVER_ONLY_COLLECTIONS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
      continue;
    }
    if ((SERVER_ONLY_FIELDS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
      continue;
    }
    found.push(...findPrivateData(inner, `${path}.${key}`));
  }

  // A practice record under a name nobody thought of: a person, a contact
  // number and a diary link is a client record whatever it is called.
  const looksLikeClient =
    typeof value.number === 'string' &&
    typeof value.name === 'string' &&
    ('alerts' in value || 'consents' in value || 'clientId' in value || 'lastAppointmentAt' in value);
  if (looksLikeClient) found.push(`${path} (looks like a client record)`);

  return found;
}

/**
 * The mirror-safe copy of the dashboard state.
 *
 * Shallow on purpose: the practice collections are top-level, and copying deeply
 * to filter things that cannot be there would only make the guard harder to
 * read. Fields are still caught by `findPrivateData` before anything is written.
 */
export function strippedForMirror<T extends Record<string, unknown>>(state: T): Partial<T> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if ((SERVER_ONLY_COLLECTIONS as readonly string[]).includes(key)) continue;
    copy[key] = value;
  }
  return copy as Partial<T>;
}

/** Is this payload safe to persist in the browser? */
export function isCacheable(value: unknown): boolean {
  return findPrivateData(value).length === 0;
}

/** One line for the UI, so the claim is visible rather than implied. */
export const PRIVACY_STATEMENT =
  'Practice records are read from the server on every visit and never kept in this browser.';
