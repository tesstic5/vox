# Production-readiness evidence register

**As of 2026-11-08. Target:** Dokploy/VPS, PostgreSQL, Twilio voice/SMS,
Resend email, Stripe, optional AI/STT/TTS, and a controlled physiotherapy pilot.

This is an evidence register, **not** a production, compliance, accessibility or
clinical certificate. “Pass” means the named local or deterministic-stub gate
passed. Anything requiring a public VPS, a real provider, off-box recovery, or
an independent reviewer remains open.

## Current local evidence

| Area | Result and retained evidence |
|---|---|
| Reproducible fixture | `fixtures/voxera-ci.sqlite.gz` restores only after SHA-256, SQLite integrity and known synthetic-owner checks: **124,462 documents / 59 collections**, uncompressed SHA-256 `81618d554aba4c0dbf5431fbb498b9a57077d4243d7d988a9089f2a0f28f3d7b`. The fixture is excluded from the production image. |
| Dependency and type gates | `npm run lint` (`tsc --noEmit`) passed. `npm audit --omit=dev --audit-level=high` reported **0 vulnerabilities**. Artifacts: `screenshots/lint-claims-boundary-2026-11-08.txt` and `screenshots/npm-audit-claims-boundary-2026-11-08.txt`. |
| Claims boundary | The executable marketing/implementation boundary passed **82/82 assertions** across **228 user-visible source and handoff files**. The broad SQLite and PostgreSQL suites both include this gate. Artifact: `screenshots/marketing-claims-claims-boundary-2026-11-08.txt`. |
| Optimized build | Next **16.4.3** compiled in **5.4s**, completed TypeScript in **3.6s**, generated **154/154** static pages in **4.3s**, and finished in **16.592s**. Artifact: `screenshots/optimized-build-claims-boundary-2026-11-08.txt`. |
| Static and hydration gates | **106** prerendered pages had no invalid nesting; **106** static routes had 0 unresolved links; every indexable prerendered route was in the sitemap. Artifacts: `screenshots/nesting-claims-boundary-2026-11-08.txt`, `linkcheck-claims-boundary-2026-11-08.txt`, and `sitemap-claims-boundary-2026-11-08.txt`. |
| Strict production config | Representative strict `dokploy` + PostgreSQL + HTTPS + trusted proxy + explicit operators/secrets + direct Resend configuration passed. Executable negative probes refused batch-only transcription as live STT and refused required media without TTS; the positive probe accepted Deepgram streaming STT plus an implemented TTS path. Artifact: `screenshots/production-config-claims-boundary-2026-11-08.txt`. |
| SQLite baseline | After restoring the verified fixture, the optimized SQLite runtime passed **44/44 live gates, 1,644 checks, 0 failures**; the stopped-app sequence passed **2/2 offline gates, 18/18 checks**. Artifacts: `screenshots/sqlite-full-suite-claims-boundary-2026-11-08.txt` and `screenshots/sqlite-offline-suite-claims-boundary-2026-11-08.txt`. |
| PostgreSQL migration | The verified fixture migrated into a fresh PostgreSQL 17 database and matched by collection count and canonical SHA-256 document-content digest: **124,462 documents / 59 collections**. Artifact: `screenshots/postgresql-migration-claims-boundary-2026-11-08.txt`. |
| PostgreSQL engine | Disposable-database schema, CRUD/order, JSONB, transactional replace, database-enforced number/claim uniqueness, cross-process cache invalidation, advisory scheduler failover and atomic rate limiting passed **18/18**. Artifact: `screenshots/postgresql-engine-claims-boundary-2026-11-08.txt`. |
| PostgreSQL broad runtime | The optimized PostgreSQL runtime passed **44/44 live gates, 1,644 checks, 0 failures**. With the app stopped, PostgreSQL passed **2/2 offline gates, 18/18 checks**. Artifacts: `screenshots/postgresql-full-suite-claims-boundary-2026-11-08.txt` and `screenshots/postgresql-offline-suite-claims-boundary-2026-11-08.txt`. |
| Resend outbound contract | **14/14** deterministic checks passed: provider payload/auth/idempotency/tags, refusal handling, raw-body verification, forged/stale rejection, and permanent-versus-temporary bounce consent behavior. Artifact: `screenshots/resend-provider-claims-boundary-2026-11-08.txt`. |
| Resend app route | **6/6** passed against the built PostgreSQL app: forged and stale refusal, declared and chunked body caps, valid signed acceptance, and Svix-id replay idempotency. Artifact: `screenshots/postgresql-resend-webhook-claims-boundary-2026-11-08.txt`. This is signed-route evidence, not live Resend delivery. |
| Stripe contract | **24/24** PostgreSQL/stub assertions passed checkout refusal compensation, exact minor units and metadata, provider-hosted URL, forged/stale webhook rejection, unpaid deferral, signed settlement, duplicate idempotency and one reconciled payment. Artifact: `screenshots/postgresql-stripe-gate-claims-boundary-2026-11-08.txt`. No live charge or app-initiated refund is claimed. |
| Twilio and SMS contract | The broad suites passed deterministic credential, inventory, purchase/adoption compensation, global number ownership, outbound call, signed callback, receipt matching, STOP/START consent and provider-first release checks. These are stub results, not carrier delivery evidence. |
| Auth and workspace behavior | The broad suites include **101/101** authentication checks plus tenant, role, owner-selected module preservation, contractor, booking, notes, money, reporting, export and operator gates. |
| AI contract | The deterministic AI gate passed **40/40** for credentials, model discovery, turns, tools, token attribution, refusal and state restoration. No external AI account was contacted. |
| Browser and automated accessibility | Real Chromium passed **5/5 interaction walks, 141/141 checks**. Desktop and mobile quality runs each passed **18/18 routes**, with zero axe WCAG A/AA violations, no failed same-origin requests, and all local latency/resource guardrails met. Artifacts: `screenshots/browser-acceptance-claims-boundary-2026-11-08.txt`, `screenshots/browser-quality-desktop-claims-boundary-2026-11-08.txt`, `screenshots/browser-quality-mobile-claims-boundary-2026-11-08.txt`, and the corresponding JSON files. Automated evidence is not an independent accessibility review. |
| Controlled-pilot load | Retained five-minute same-host PostgreSQL evidence: **3,600/3,600 HTTP 200**, p95 **62.1 ms**, p99 **82.8 ms**, RSS peak **663.1 MiB**, and 0 scheduler errors. Artifact: `screenshots/sustained-load-check.json`. It does not approve remote PostgreSQL or multi-practice scale. |
| Backup and scratch restore | A fresh PostgreSQL 17 custom archive received a verified SHA-256 sidecar, passed archive inspection, and restored transactionally into a fresh scratch database with a reversible pre-restore dump. Source and scratch both contained **126,670 documents / 64 collections** and the same ordered digest `32f8598708677a10af704a8166cf8a48c3cf3b09bc87fc65988dc25d5a0404e7`. Artifact: `screenshots/postgresql-backup-claims-boundary-2026-11-08.txt`. This is same-host local recovery evidence, not off-box disaster recovery. |
| CI definition | The workflow parses with four jobs: SQLite/static/audit, full PostgreSQL/providers, PostgreSQL browser/WCAG, and shipped-container/Compose health plus checksummed backup inspection. A static contract inspection passed; hosted Actions and Docker execution remain unrun here. Artifact: `screenshots/ci-definition-claims-boundary-2026-11-08.txt`. |

## Release package implemented

- PostgreSQL 17 Dokploy Compose stack with an internal-only database, strict
  startup, non-root app, health checks, graceful shutdown and resource budgets.
- Matching PostgreSQL 17 dump/restore tools inside the runtime image.
- Checksummed backup/restore with retention, destructive confirmation, safety
  backup, metrics status and a documented scratch-restore procedure.
- Optional Cloudflare R2 overlay using client-side encrypted, copy-only transfer;
  mutable `status.json` is excluded from the immutable archive set.
- Resend adapter with outbound idempotency, signed raw-body callbacks, terminal
  receipt precedence, bounded request streaming and bounded event retention.
- Stripe Checkout and signed-settlement boundary. Refunds are performed by an
  authorised operator in Stripe and manually recorded/reconciled in Voxera.
- Four-job CI definition, public-staging probe, provider acceptance procedures,
  Dokploy/recovery runbooks, controlled-pilot charter and independent-review
  handoff pack.

## External gates still open

1. **Hosted CI and shipped container:** GitHub Actions and the Docker job have
   not run in this workspace; the definition and its locally available commands
   passed, but that is not a hosted/container result.
2. **Public Dokploy staging:** deploy the immutable source revision, prove
   Traefik TLS, trusted-hop behavior, secure cookies, private metrics, resource
   limits, rollback, and repeat browser/load acceptance on the public hostname.
3. **Off-box recovery:** provision R2 or another independent destination; upload
   an encrypted archive, download it, verify SHA-256, restore into scratch, and
   record content comparison, RPO and RTO. No R2 bucket or credentials exist yet.
4. **Live providers:** real Twilio calls/SMS, Resend domain authentication and
   delivery/bounce callbacks, Stripe test plus an approved low-value live
   payment, and any selected AI/STT/TTS timeout/fallback path remain unexecuted.
   Controlled destinations and an approved live amount are not yet available.
5. **Independent approvals:** security/penetration, privacy/legal,
   healthcare/clinical, accessibility and telecom/payment reviewers are not
   engaged and cannot be self-attested.

## Verdict

The repository is a **locally validated staging candidate and operator handoff**.
It is not production-approved for real patient data, live-provider claims, or a
physiotherapy pilot. Use only synthetic or authorised staff-rehearsal data until
every applicable external gate above is closed with retained evidence.
