# Phase 1 implementation design — clinical data, permissions and documents

**Status:** implemented and locally verified; external clinical-production gates remain open  
**Date:** 2026-09-20  
**Scope:** UK private allied-health foundation; synthetic/test data only until independent approvals are recorded.

This document narrows Phase 1 of the approved implementation plan into code-level invariants. It deliberately does not claim UK GDPR compliance, clinical suitability, malware protection, backup fitness, or approval merely because a local check passes.

## 1. Storage and migration invariants

1. PostgreSQL remains mandatory for clinical **live** mode. SQLite and JSON remain development/test compatibility engines.
2. Schema migrations have a stable ID, SHA-256 checksum, description and ordered SQL. Data migrations have a stable ID/version, explicit algorithm-integrity manifest, checksum, attempts and result. An applied ID with another checksum stops startup; failed data work remains resumable rather than being reported complete.
3. `commitBatch` is the only new-domain multi-document write primitive. It:
   - flushes pending legacy writes first;
   - takes deterministic entity locks;
   - validates expected revisions or required absence;
   - writes all rows and the database version in one database transaction;
   - increments each changed document's `revision` and preserves `createdAt`;
   - invalidates affected collection caches only after commit;
   - leaves no partial state after a conflict or exception.
4. JSON compatibility writes are process/file locked but are never accepted as evidence for clinical live mode.
5. Durable jobs, outbox events and idempotency receipts are ordinary typed documents written through `commitBatch`; workers claim by revision, so two workers cannot both own one attempt.
6. Clinical access events, document versions and scanner evidence are append-only. PostgreSQL and SQLite triggers reject update/delete operations. An intentional full-store replacement can bypass those triggers only inside a transaction-local, non-production maintenance window enabled by an environment switch and an unforgeable process-local capability; the guard is active again before commit.
7. High-volume call consumers use tenant-leading pages, targeted JSON-path lookup, or explicit scalar projection. Operational totals do not hydrate transcripts, recordings, or unrelated restricted fields; the SQLite and PostgreSQL implementations have parity checks.
8. Exhausted durable work becomes a revisioned dead letter with a redacted failure summary. Retry and resolution require explicit permission, revision preconditions and immutable operational evidence; raw provider or clinical payloads are not copied into the failure reason.

## 2. Permission and record-scope invariants

1. Permission strings are explicit and centrally catalogued. New clinical, privacy, document and role routes call the permission engine; hiding navigation is never authorisation.
2. Existing fixed roles map to immutable system templates. Existing users retain their current behaviour while shadow decisions are written when the granular engine disagrees with the legacy decision.
3. A custom role may only grant permissions the assigning actor has. Owner identity and legacy role remain protected; custom assignment cannot remove the final active owner.
4. Record scope is evaluated after permission: all records, assigned practitioner/caseload, explicit patients, or deny. A missing or malformed scope fails closed.
5. API keys continue to require route scopes; session permissions do not silently widen key access.

## 3. Patient identity and alerts

1. A patient/client can have several typed contact points with primary, verified, source and valid-period metadata.
2. Telephone values are canonicalised; email values are lowercase/trimmed. Exact matching may link automatically only when exactly one active record matches.
3. Multiple exact matches create an identity conflict. The workflow does not choose a candidate and never performs fuzzy auto-merge.
4. Legacy primary phone/email values are migrated deterministically and remain mirrored during the compatibility window.
5. An approved merge atomically rehomes mutable patient-owned records and document links, consolidates equivalent contact points, archives the source as a redirect, and emits immutable merge evidence. Reads of legacy phone/email fields remain compatible after consolidation; a race or stale revision aborts the whole merge.
6. Alerts are typed as `administrative` or `clinical`. Clinical content requires clinical-alert permission and never enters the phone assistant context. Legacy embedded medical flags are copied deterministically into the restricted collection, verified row-for-row, then their source text is cleared by a separate resumable migration. The phone assistant receives only booking/contact fields needed for the requested task.

## 4. Privacy, access history and readiness

1. Every patient, clinical note, clinical alert and clinical document read/write emits an append-only clinical access event containing tenant, actor, action, purpose, resource and timestamp.
2. The existing capped `accessLog` remains an operational convenience only; its one-year ageing is not represented as complete clinical history.
3. Processing activities, processors, retention rules, legal holds, deletion workflows and external review attestations are controller-entered records with actor/time history. Voxera supplies no guessed lawful basis or retention duration.
4. A legal hold wins over retention or deletion.
5. Clinical operating mode has three values: disabled, synthetic-test, and live. Live activation fails closed unless PostgreSQL, encrypted blob storage, a non-test scanner with recent append-only clean and infected scan evidence, privacy/controller records, recovery evidence and unexpired independent security/privacy/clinical attestations are all present.
6. Local tests, self-entered assertions and route availability are labelled as implementation evidence, not external approval.

## 5. Document invariants

1. Object keys contain random identifiers, never patient names or file names.
2. Each byte version uses a random AES-256-GCM data key. The data key is wrapped with a configured master key; plaintext and the unwrapped key are never stored.
3. Local filesystem and S3-compatible/R2 adapters implement the same object interface. Filesystem storage is development-only for live-readiness purposes.
4. Upload tokens are hashed, short-lived, single-use and constrained by tenant, owner, MIME and size. Upload completion is idempotent.
5. A new version starts quarantined. It is downloadable only after the configured malware scanner returns clean. Missing/error scanners fail closed; infected bytes remain quarantined.
6. Document versions are immutable. Replacing bytes creates a new version; metadata changes are auditable document changes.
7. Downloads are authorised, attachment-only, `nosniff`, no-store, access-logged and tenant checked.
8. Legacy `files` rows become `metadata_only` document records preserving source IDs and metadata. No byte availability, encryption or scan result is invented.
9. Every document has one deterministic typed canonical-owner link. Additional patient, appointment, invoice or clinical-note links are target-validated, tenant-bound and limited to the same patient context; migration `006` enforces link uniqueness and tenant-leading target indexes.
10. Link mutations are revisioned and audited. Phase 1 always refuses `visibleInPortal=true`, protects the canonical owner link from removal, excludes storage/crypto/link internals from generic exports, and exposes only bounded link metadata in controlled manifests.
11. Patient merges rehome document ownership and links atomically and deduplicate equivalent links without changing immutable byte versions or scan evidence.

## 6. API, browser and rollout invariants

1. New clinical content is exposed only through typed `/api/v1` routes. Generic collections remain restricted to notifications; bootstrap/global-search/browser mirrors do not receive clinical content.
2. Mutation routes accept revision preconditions and idempotency keys where retries are plausible. Conflicts return stable 409 responses.
3. Dashboard surfaces show configured facts, missing gates, quarantine states and external-review gaps. They do not display a compliance badge.
4. Existing contractor, calls, booking, waitlist, class, money and deployment paths remain regression-gated.
5. Phase 1 can deploy with clinical mode disabled or synthetic-test. Real patient data remains prohibited until the independent gates are actually completed and live mode is explicitly activated.

## 7. Implementation sequence

1. Checksummed migrations, transaction primitive, locks, jobs/outbox/idempotency.
2. Permission catalogue, system-role migration, record scope and shadow comparison.
3. Contact points, exact-match conflicts, restricted alerts and assistant redaction.
4. Append-only access events, privacy/controller records, holds and readiness evaluator.
5. Encrypted blob adapters, upload tokens, immutable versions, scanner jobs, downloads and legacy metadata migration.
6. Typed APIs and dashboard status/configuration surfaces.
7. Unit, integration, race, security and browser regression checks; release notes and operating boundary update.

## 8. Implementation status and evidence

The Phase 1 source implementation is complete for the synthetic/local boundary described above. The approved plan remains the acceptance source; this section records implementation evidence rather than external approval.

| Area | Implemented evidence |
|---|---|
| Migrations and atomicity | Checksummed schema/data migrations, revision preconditions, deterministic locking, transactional multi-record writes, immutable trigger enforcement and resumable migration state on SQLite and PostgreSQL. |
| Permissions and scope | Granular permission catalogue, immutable system templates, custom roles, record/caseload scope, API-key scope intersection, shadow comparison and guarded break-glass access. |
| Identity and context | Multi-contact identity, exact-only matching, ambiguity queue, atomic patient merge/redirect, restricted alert split and minimum-context assistant reads. |
| Governance | Append-only clinical access events, controller-entered processing/processor/retention records, legal holds, readiness evaluator and fail-closed live-mode gates. |
| Documents | Envelope encryption, local and S3-compatible adapters, immutable versions, scanner quarantine, controlled downloads/exports, metadata-only legacy migration, typed multi-record links and merge-safe link rehoming. |
| Operations | Revisioned durable jobs/outbox/idempotency, redacted dead-letter retry/resolution, tenant-leading call pages and transcript-free operational projections. |
| Product surfaces | Typed clinical APIs, client/document/privacy/role/operations dashboards, generic collection/search/bootstrap/browser-persistence denials and explicit external-review gaps. |

Latest local evidence:

- focused Phase 1 checks: **117/117** (foundation **90/90**, race **15/15**, scanner **6/6**, S3-compatible storage **6/6**);
- PostgreSQL: generic integration **18/18** and clinical foundation **23/23**, including typed document-link migration plus tenant-paged, targeted and projected call reads;
- HTTP/security **45/45**, focused document/operations browser **15/15**, and complete browser aggregate **160/160**;
- TypeScript, production build and **111/111** prerendered-page nesting checks passed;
- all **44** aggregate-runner gates now have passing evidence. The original shared-state run was diagnostic (**31/44**); its 13 affected gates were rerun against restored fixtures and correct per-gate configuration, totalling **644/644** isolated assertions. This is composite evidence, not a claim that one mutation-heavy shared-state run is deterministic;
- separate multi-tenant isolation evidence is **44/44**.

Clinical-production gates remain open: there is no live object bucket, deployed malware scanner, controlled key-recovery/off-box restore drill, processor/transfer assessment, or independent UK security, privacy/legal and allied-health clinical approval. Provider checks use local doubles, not live delivery or settlement. `live` mode must remain unavailable and real patient data remains prohibited until those gates are completed and recorded.
