# Voxera Phase 3 native-intake verification — 2026-09-20

This record covers synthetic, isolated verification only. It is not security, privacy/legal, clinical-safety or production sign-off. Real patient data remains prohibited.

## Current implementation verified

### Intake administration and compatible address cutover

- Reusable non-patient person/organisation contacts retain normalised details, referrer/payer flags, active state, optimistic revisions and audit evidence.
- Patient relationships support a related patient or reusable contact, explicit guardian/proxy/billing/emergency/referrer flags, effective dates, verification actor/time and non-destructive termination.
- Typed custom-field definitions and values support patient, associated-contact and referral targets. Stable keys/value types are immutable; values enforce target existence, tenant ownership, runtime typing, source, verification and optimistic revisions.
- Contact and referral value-entry APIs and dashboard editors are permission-scoped. Restricted fields are omitted from reception reads and require clinical access to write.
- Form `custom:*` mappings are validated against active definitions and compatible field types/choices. Public answers become pending suggestions; they never silently overwrite a patient value. Authorised acceptance refuses a newer intervening staff write.
- Patient, associated-contact and referral addresses use an expand-compatible structured shape beside the compatibility `address` string. Legacy text is retained verbatim as `legacyText` with `needs_review`; no address components are inferred.
- Only an explicit revision-checked staff review publishes components and reviewer/time evidence. Cross-process review races have one winner and preserve one complete reviewed value.
- Contact-directory field loading is bound to the selected contact identifier, preventing stale asynchronous values from being submitted against a newly selected contact.

### Forms, public referrals, tasks and constrained automation

- Conditional versioned forms, secure assignments, partial save/submit, immutable response evidence, quarantined attachments and explicit update review remain green.
- Public referral forms retain immutable slugs and pinned template versions, opaque hashed draft tokens, exact draft-owned attachments, canonical evidence hashes, privacy headers and explicit emergency/monitoring boundaries.
- Referral submission and conversion preserve decision, document and evidence links without automatic clinical triage or diagnosis.
- Administrative tasks and the constrained automation engine retain allowlisted triggers/actions, immutable rule versions, minimised events, deterministic idempotency, leases/retries, recursion bounds and durable dead-letter evidence.
- `/dashboard/workflows` remains intentionally separate and unavailable; it has not been repurposed as an automation administration page.

### Finalised-letter corrections

- A user with `letters.approve` can correct a `finalised`, `sent` or `failed` letter only by creating a linked draft. The final source version and encrypted PDF are not edited.
- The source is marked `corrected` with actor/time and `correctedByLetterId`; the draft records `correctsLetterId` and a required 10–2,000 character reason.
- The correction begins as an exact content-hash copy, follows the ordinary revise/approve/finalise path, and produces its own encrypted artifact and SHA-256 evidence.
- One direct correction is allowed for each evidence record. Revision checks and migration uniqueness make simultaneous cross-process correction attempts produce one winner.
- Corrected source PDFs remain downloadable and hash-verified. A finalised letter cannot be cancelled as a substitute for correction.
- SQLite and PostgreSQL migration DDL guards the final evidence envelope. Once an artifact hash exists, snapshot, source links, template/version, current content version, approval/finalisation evidence, artifact identifiers/hash and correction-source metadata cannot be changed; deletion is also refused. Delivery/correction status metadata may still advance.

### Referral notifications

- A user with `referrals.triage` can queue a staff-authored administrative update only to the valid email already recorded on the referrer. The UI does not expose an arbitrary destination field.
- Subject/body limits are validated and the destination, referral revision, referral-status snapshot, request actor/time and content SHA-256 are retained as notification evidence.
- A notification and deterministic durable `referral.notification` job are committed atomically. The job creates one deterministic message-queue record and preserves the notification/message link across retries.
- Identical retries for one referral revision converge on one notification/job, including across processes. Competing content for that revision returns a conflict instead of replacing evidence.
- The standard scheduler materialises the controlled message. Notification state reconciles with queued, blocked, failed, cancelled or provider-accepted message evidence.
- These are transactional administrative updates (`respectConsent: false`), not marketing or autonomous clinical advice. The UI explicitly warns staff not to include unreviewed clinical advice.

## Current-tree gates run after the final edits

| Gate | Result |
|---|---:|
| Workspace dependency install (`npm ci`) | 108 packages; 0 vulnerabilities |
| TypeScript (`tsc --noEmit --incremental false`, generated `.next` types temporarily excluded) | pass |
| Next.js production build | pass; 166/166 pages generated |
| `scripts/phase3-workflow-check.ts`, isolated SQLite | 56 assertions |
| `scripts/phase3-evidence-race-check.ts`, independent SQLite processes/direct DB probes | 13/13 |
| `scripts/phase3-api-check.py`, isolated **production** HTTP server | 49/49 |
| `scripts/phase3-ui-pass.mjs`, Chromium on production server | 21/21 |
| `scripts/phase3-race-check.py`, two production app nodes sharing SQLite/blob root | 21/21 |
| `scripts/intake-admin-check.ts`, isolated SQLite | 59 assertions |
| `scripts/intake-admin-race-check.ts`, two SQLite processes | 8/8 |
| `scripts/intake-admin-api-check.py`, isolated production HTTP | 48/48 |
| `scripts/intake-admin-ui-pass.mjs`, desktop/mobile Chromium | 15/15 |
| `scripts/tasks-automations-check.ts`, isolated SQLite | 56 assertions |
| `scripts/tasks-automations-sqlite-check.sh`, direct SQLite gate | 12/12 |
| `scripts/public-referrals-check.ts`, isolated SQLite | 43 assertions |
| `scripts/public-referrals-api-check.py`, isolated production HTTP | 30/30 |
| `scripts/public-referrals-ui-pass.mjs`, desktop/mobile Chromium | 17/17 |
| `scripts/nesting-check.py` | 118 prerendered pages; no invalid nesting |

The 56-assertion workflow gate now covers notification idempotency/job/message reconciliation, immutable original letter retrieval, linked correction finalisation, encrypted-artifact tamper refusal and direct final-letter evidence-envelope mutation refusal.

The 13-assertion evidence race gate covers one-winner correction, exact-artifact preservation, convergent identical notification retries, one-winner competing notification content, migration indexes/triggers/checksums, and direct SQLite update/delete refusal.

The 49-assertion production HTTP gate covers role denial, deterministic notification retry/conflict, scheduler materialisation, final-letter cancellation refusal, correction creation/conflict, exact source-PDF preservation and finalisation of a distinct superseding artifact. The 21-assertion Chromium gate exercises the fixed referrer destination, queued evidence, correction chain, superseded source/PDF access and the existing public mobile form.

## Migration `20260920_011_phase3_corrections_and_referral_notifications`

Fixed checksums:

- SQLite: `f2e31ce0bf63f018f8463110cc24741b6692f18fcf06402952e65099552f703c`
- PostgreSQL: `82bbdc1e4555e317282ba076aff71570cd9b727a3a1fc0e3caa7c4386f590f2d`

Verified on disposable SQLite:

- `docs_letter_correction_source`
- `docs_referral_notification_revision`
- `docs_referral_notification_state`
- `docs_final_letter_evidence_update`
- `docs_final_letter_evidence_delete`
- one checksummed migration-ledger row;
- direct artifact-hash update rejected;
- direct final-letter delete rejected.

The PostgreSQL statements and checksum are present, but this increment was **not executed against PostgreSQL locally** because no PostgreSQL client/server tools are available in the current environment. Previous migrations `008`, `009` and `010` retain their historical disposable-PostgreSQL evidence; that historical evidence is not represented as a rerun of migration `011`.

## Isolation and fixture integrity

All mutating domain, HTTP, browser and race checks used isolated synthetic stores and blob roots. Two-node race checks shared only their disposable store/blob root.

The canonical synthetic fixture was not intentionally migrated or mutated. Its final SHA-256 remains:

`131b135fbd4034e09de3132299e25598b446ff667ea0f02925a5125c6943ffca`

No verification server remains running.

## Scope still open before Phase 3 can be called complete

The planned internal correction, referral-notification, generic contact/referral value-entry and structured-address workflows are implemented and locally evidenced. Phase 3 is still **not complete** because the following evidence is unavailable:

1. execution of migration `011` and the focused gates against disposable PostgreSQL;
2. controlled-destination live Resend/Twilio delivery and callback evidence (provider accounts/destinations are not ready);
3. independent security review;
4. independent privacy/legal review;
5. independent UK allied-health workflow and clinical-safety review.

No claim of Phase 3 completion, production clinical suitability or full feature-for-feature replacement is made. Real patient data remains prohibited until the independent gates are complete.
