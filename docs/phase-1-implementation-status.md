# Phase 1 implementation status — clinical data, permissions and documents

**As at:** 20 September 2026  
**Release boundary:** source-complete and synthetic/local-test complete; **not approved for real patient data or clinical production**  
**Acceptance source:** `/home/user/voxera-uk-allied-health-implementation-plan-2026-09-20.md`

## Executive status

Phase 1 is implemented across the SQLite compatibility path and the production PostgreSQL path. It establishes checksummed/resumable migration, atomic revisioned mutations, granular record-scoped permissions, exact-only patient identity, restricted clinical context, append-only governance evidence, encrypted immutable documents, typed document links, durable operations and fail-closed clinical readiness.

The implementation does not constitute UK GDPR, security, clinical or malware-protection approval. Live object-store credentials, a deployed scanner, an off-box restore/key-recovery drill, processor/transfer assessment and independent reviewers are still absent. Clinical `live` mode and real patient data therefore remain prohibited.

## Acceptance matrix

| Plan requirement | Implementation status | Principal evidence |
|---|---|---|
| Checksummed, resumable schema/data migrations | Implemented | Schema migration ledger and integrity checks; resumable data-migration ledger; migrations through `006`, including typed document-link uniqueness/target indexes. |
| Atomic multi-document mutation, revision preconditions and locks | Implemented | Transactional `commitBatch`, deterministic locks, required-absence and expected-revision checks, cache invalidation after commit, rollback/race tests on SQLite and PostgreSQL. |
| Granular roles, API-key intersection and record/caseload scope | Implemented | Permission catalogue, immutable system roles, custom roles, access policies/assignments, shadow comparison and guarded break-glass flow. |
| Multi-contact identity with exact conflict review and no fuzzy merge | Implemented | Canonical phone/email contact points, deterministic legacy migration, exact unique match only, ambiguous conflict records, atomic approved merge and archived redirect. |
| Restricted clinical/admin alerts and minimum-context assistant | Implemented | Typed alert visibility, restricted clinical permission, legacy alert migration/clearing, assistant context builder that excludes clinical alerts, documents and unrestricted transcripts. |
| Append-only access history and controller-owned governance records | Implemented | Immutable clinical access events; processing, processor, retention, legal-hold and external-attestation records; holds override retention. |
| Fail-closed clinical readiness | Implemented | Disabled/synthetic/live modes; PostgreSQL, storage, governance, recovery and unexpired independent-attestation gates. Scanner readiness requires recent append-only clean **and infected** evidence from the configured non-test command. Local assertions are not treated as approval. |
| Encrypted blobs, immutable versions and quarantine | Implemented | AES-256-GCM envelope encryption, random object keys, local and S3-compatible adapters, immutable versions/scan evidence, single-use upload sessions and clean-only controlled download. |
| Honest legacy file migration | Implemented | Metadata-only document records; no invented bytes, checksum, scan result or download. |
| Typed multi-record document links | Implemented | Deterministic canonical owner link, additional same-patient validated links, revisioned mutation API, uniqueness/index migration, merge rehoming/deduplication and portal-sharing refusal. |
| Client export and generic-surface exclusion | Implemented | Controlled manifests expose bounded link metadata; generic export omits blob/crypto/link internals; clinical content is denied from generic collections, bootstrap, generic search and browser persistence. |
| Clinical module/profile IDs and readiness surfaces | Implemented | Owner-selected module defaults, typed settings/privacy/readiness dashboards and explicit missing-gate messaging rather than compliance badges. |
| Durable jobs, outbox, idempotency and dead letters | Implemented | Revisioned claims, redacted failure summaries, guarded retry/resolution and immutable operational evidence. |
| High-volume call access without transcript hydration | Implemented | Tenant-leading paged reads, carrier-SID JSON-path lookup and explicit scalar projections on SQLite/PostgreSQL; operational totals omit transcripts. |
| Existing contractor/phone/booking/waitlist/money/deployment behaviour | Composite regression green | All 44 aggregate-runner gates have passing evidence; provider- and state-sensitive gates were isolated rather than misrepresented by one shared mutable run. |

## Verification evidence

| Evidence set | Result |
|---|---:|
| Phase 1 clinical foundation | **90/90** |
| Phase 1 race | **15/15** |
| Malware scanner contract | **6/6** |
| S3-compatible/R2 adapter contract | **6/6** |
| **Focused Phase 1 total** | **117/117** |
| PostgreSQL generic integration | **18/18** |
| PostgreSQL clinical foundation | **23/23** |
| Phase 1 HTTP/security | **45/45** |
| Focused document/client/operations browser | **15/15** |
| Full browser aggregate | **160/160** |
| Multi-tenant isolation | **44/44** |
| Production prerender/nesting | **111/111** pages |

TypeScript compilation and the production build passed. Strict production-configuration checks also prove that the final clinical-data switch refuses a missing document key, non-S3 storage, absent scanner and test binaries; workspace readiness separately requires recent clean/infected scanner evidence. The PostgreSQL clinical result includes migration `006`, append-only trigger enforcement, stale-batch rollback, migration integrity, document-link indexes, tenant-paged call reads, targeted carrier lookup and transcript-free operational projections.

### Aggregate-runner closure

A single configured `scripts/check.py --keep-going` run passed **31/44** gates. That run was diagnostic, not a release verdict: it reused authentication/rate-limit state, mutated one provider double across gates, used an HTTP public origin that correctly prevents production carrier programming, and omitted the media secret/simulated pipeline.

The 13 affected gates were then run against restored fixtures and the configuration each contract requires:

| Isolated gate | Result |
|---|---:|
| Operator/admin | **15/15** |
| Security/auth boundary | **19/19** |
| Authentication flows | **101/101** |
| Onboarding | **56/56** |
| Public booking | **40/40** |
| Client manage link/replies | **38/38** |
| Waitlist/check-in | **77/77** |
| Messaging | **88/88** |
| Carrier programming/webhooks | **45/45** |
| Money loop | **69/69** |
| Recall loop | **68/68** |
| Growth funnel | **11/11** |
| Media WebSocket simulation | **17/17** |
| **Isolated total** | **644/644** |

Carrier-dependent runs used the trusted HTTPS origin `https://voxera.test`; request traffic remained local while webhook signatures and programmed callback URLs used that canonical origin. The HTTP-origin carrier attempt is intentionally not evidence because production carrier configuration correctly rejects it.

## Important implementation boundaries

- Clinical content is available only through typed APIs. The generic collection bridge remains limited and cannot expose clinical, privacy, document, credential, audit or provider-secret collections.
- Every document has a canonical typed owner link. Additional links must resolve to the same workspace and patient context. `visibleInPortal=true` is refused in Phase 1.
- Patient merges do not infer identity. Only an explicitly approved conflict resolution can merge; it atomically rehomes mutable records and links, consolidates equivalent contacts and preserves an archived redirect plus immutable evidence.
- Non-clean or unscanned bytes remain quarantined. Scanner absence/error fails closed.
- Operational call totals and carrier callback lookup do not load whole call collections or transcripts.
- No local test proves live Resend/Twilio delivery, Stripe settlement, Cloudflare R2 operation, off-box disaster recovery, Dokploy execution or an independent approval.

## Open clinical-production gates

1. Select and provision the production S3-compatible object store (Cloudflare R2 remains only under consideration), then run controlled upload/download and restore evidence.
2. Deploy and monitor a real malware scanner; test clean, infected, unavailable and error paths in the target environment.
3. Establish master-key custody, rotation and recovery; complete an off-box encrypted backup plus PostgreSQL/blob restore drill.
4. Complete controller records, DPIA/lawful-basis review, processor/subprocessor register and international-transfer assessment.
5. Obtain independent security, UK privacy/legal and allied-health clinical review; record scoped, dated and expiring attestations without treating them as a generic compliance badge.
6. Configure and test production HTTPS origin, controlled Twilio/Resend destinations and live provider credentials. Live AI remains optional and no AI provider account currently exists.
7. Re-run the deployment runbook on the user's Dokploy VPS and retain target-environment evidence.

Until all required readiness gates pass, keep clinical mode disabled or synthetic-test only and do not enter real patient data.
