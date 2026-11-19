# Voxera — Dokploy/PostgreSQL production plan

**Locked target (2026-11-06):** Dokploy on one VPS, PostgreSQL as the production store, Twilio + email/SMS + Stripe + optional AI/STT/TTS integrations, and a controlled physiotherapy pilot.

**Current state (updated 2026-11-08):** Phase 1 hardening and the PostgreSQL engine, digest-verified migration, checksummed backup and transactional scratch restore are implemented. The checksum-verified synthetic fixture migrated into a fresh PostgreSQL 17 target, and both optimized SQLite and PostgreSQL runtimes passed **44/44 live gates, 1,644 checks, 0 failures**, followed by **2/2 offline gates, 18/18 checks**. The PostgreSQL engine/concurrency suite passed **18/18**; the Stripe stub contract passed **24/24**; the Resend adapter passed **14/14** and its signed application route passed **6/6**. Strict configuration now rejects batch-only transcription as live STT and requires Deepgram streaming STT plus an implemented TTS path when live media is mandatory. Real Chromium passed 5/5 interaction walks and 141/141 checks; desktop and mobile quality runs each passed 18/18 routes with zero automated axe WCAG A/AA violations. A same-host PostgreSQL scratch restore matched its source at **126,670 documents / 64 collections** and an identical ordered digest. The fixture, four-job CI definition, Dokploy package, container smoke definition and physiotherapy runbook are present; public Dokploy/TLS, Docker and hosted-CI execution, off-box recovery, live providers and independent approvals remain open. See `PRODUCTION-READINESS-EVIDENCE.md` for exact artifacts and blockers. None of this converts local/stub evidence into live-provider, clinical-compliance or production sign-off.

## Phase 1 — improve and harden the existing application

1. Trust proxy headers only when the deployment explicitly enables it; direct clients must not bypass IP limits by forging `X-Forwarded-For`.
2. Remove the global Arena iframe allowance from ordinary production CSP. Permit preview framing only in Arena or through a validated explicit allowlist.
3. Add strict production configuration validation: HTTPS public origin, PostgreSQL URL, durable secrets, explicit operators, safe outbound/telephony switches, paired provider settings, and no media simulation.
4. Make every operational path honour `VOXERA_DATA_DIR`; add graceful scheduler/maintenance/store shutdown.
5. Finish webhook operations with audited pause/resume and delete actions so a dead endpoint can be stopped without direct database edits.
6. Keep health responses useful but make readiness include the actual configured store and writable operational directory.

## Phase 2 — PostgreSQL engine and migration

1. Add a PostgreSQL document engine behind the existing server data API, retaining SQLite only for local fallback and rollback.
2. Use PostgreSQL JSONB, transactional upserts/deletes, insertion ordering, tenant query indexes, and database-enforced global phone-number/claim uniqueness.
3. Add cross-process cache versioning, PostgreSQL advisory locking for one scheduler owner, and standby re-election during rolling deploys.
4. Make rate-limit increments atomic on PostgreSQL.
5. Add idempotent schema migration, SQLite-to-PostgreSQL copy, count verification, empty-target/replace safeguards, and rollback instructions.
6. Add PostgreSQL backup/restore commands for local drills; use Dokploy’s database-aware off-server backups in production.
7. Run type, build, full runtime, offline-equivalent, browser, accessibility, integrity, race and performance gates against PostgreSQL.

**Implementation constraint:** the current domain layer has roughly 140 database-importing files and about 800 synchronous store calls. Rewriting every domain/API call to async in one release would be a high-risk product rewrite. The first PostgreSQL engine will preserve that API with the maintained native libpq client, and must meet measured event-loop and request-latency budgets on the same-VPS topology before it is accepted. Horizontal application replicas remain disabled unless those measurements and cache-coherence gates pass.

## Phase 3 — Dokploy release package

1. Ship a Dokploy-specific Compose/application definition with PostgreSQL on an internal network, no public database port, non-root app, healthcheck, restart policy, resource budgets and strict configuration enabled.
2. Store secrets in Dokploy environment/vault references; never commit `.env`, data files or provider credentials.
3. Configure the public domain and Traefik TLS, preserve forwarded HTTPS, enable trusted-proxy handling, and verify secure cookies/CSRF under the real hostname.
4. Configure PostgreSQL backups to S3-compatible off-server storage, retention, pre-migration snapshots and a scratch restore drill.
5. Add deployment, rollback, key-recovery, provider outage and database recovery runbooks.
6. Make CI run audit, type/build, static gates, application suites, PostgreSQL migration/integration checks and a built-container health smoke.

## Phase 4 — real integration and physiotherapy pilot acceptance

1. Fresh production database only; never copy the verification database or `.voxera-key`.
2. Configure the physio workspace explicitly: locale/time zone/currency, services, practitioners, rooms, rotas, notes/classes/reminders/billing modules, consent and retention. Do not imply specialist assessments, clinical certification or insurance claims.
3. Twilio: verified account, owned number, signed callbacks, inbound/outbound call, recording/consent choice, real transcript/media path and failure handling.
4. Email/SMS: authenticated sender, delivery/bounce/failure evidence, opt-out and reminder checks.
5. Stripe: test-mode webhook and idempotency, then one approved low-value live payment. Any refund is performed by an authorised operator in Stripe and its provider reference is recorded/reconciled manually in Voxera; the application does not initiate provider refunds.
6. AI/STT/TTS: provider credentials, timeout/fallback/redaction behaviour, bounded assistant policy and human handoff.
7. Independent penetration/security review plus privacy, legal, provider and healthcare-data assessment before real patient data.
8. Pilot one workspace with monitored rollback, daily delivery/backup review and a defined support owner.

## Release definition

“Production ready” means all code/configuration/deployment gates above are green on the PostgreSQL staging deployment, a backup has been restored, live integrations have been exercised with the operator’s credentials, and the independent reviews required for real patient data are complete. Local stubs, a production build or a successful Dokploy deploy alone do not satisfy that definition.
