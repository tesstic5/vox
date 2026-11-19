# Voxera

Voxera is an original multi-business booking and communication application built with Next.js 16, React 19, TypeScript, Tailwind CSS, and a PostgreSQL production store (with SQLite retained for local development and migration recovery).

It supports four explicit workspace profiles:

- Contractor / home services
- Dental practice
- Physiotherapy
- Other, with a short description

The profile recommends terminology, setup, and modules. It is not a permission boundary or a rigid product silo. Owners and administrators can change the profile and enabled modules later; stored terminology and historical records are not silently rewritten.

## Implemented product boundary

### Shared workspace capabilities

- Account signup, login, sessions, invitations, workspace roles, scoped API keys, and audit records
- Assistants, immutable versions, test calls, call transcripts, tools, and optional external model/speech providers
- Clients, appointments, availability, providers, locations, rooms, rotas, classes, notes, reminders, messaging, invoices, payments, and reports
- Server-backed settings and module selection
- Twilio carrier connection, verification, number search/purchase/adoption/release, inbound and outbound voice, SMS, delivery receipts, and media streaming
- Tenant-scoped REST APIs, signed outbound webhooks, exports, backups, and retention jobs

### UK allied-health clinical foundation (Phase 1)

The implemented foundation adds checksummed/resumable migrations, revisioned atomic mutations, granular record/caseload permissions, exact-only multi-contact identity review, restricted clinical alerts, append-only access evidence, controller-managed governance records, encrypted immutable documents, malware quarantine, typed multi-record document links, controlled exports and a fail-closed clinical-readiness gate. Clinical content is available only through typed APIs and is excluded from generic collections, bootstrap/search mirrors and browser persistence.

This is source and synthetic/local-test readiness, not permission to process real patient data. Keep `VOXERA_CLINICAL_DATA_APPROVED=0` and clinical mode disabled or synthetic-test until the live object store/scanner, recovery drill, controller assessments and independent UK security, privacy/legal and allied-health clinical reviews are complete. See `docs/phase-1-clinical-foundation-design.md` and `docs/phase-1-implementation-status.md`.

### Contractor workflow

The contractor module uses workspace-scoped records rather than presentation-only cards:

`enquiry → estimate (versioned acceptance) → job → one or more conflict-checked visits → completion → draft invoice`

### Deliberately not claimed

This repository does **not** provide or imply:

- dental charting, dental imaging, insurance claims, prescribing, diagnosis, or specialist clinical assessments;
- a certification, BAA, legal/compliance attestation, clinical suitability determination, production SLA, or guaranteed support response;
- a native Telnyx, Vonage, Plivo, generic SIP, Five9, Genesys, Avaya, or Amazon Connect connector;
- production TLS/DNS, carrier approval, message/call delivery, payment settlement, or regulatory clearance merely by running the code.

Twilio is the only native carrier connector in this build. Generic unsigned telephony ingress is retired. Stripe settlement and third-party AI/speech providers are optional and require real credentials and independent deployment review.

## Run locally

Requirements:

- Node.js 20.9 or newer
- npm
- Python 3 for the integration gates

```bash
npm install
cp .env.example .env       # optional for local UI/API work
npm run dev                # http://localhost:3000
```

Production-shaped build and server:

```bash
npm run lint
npm run build
npm start                  # custom Next.js + WebSocket media server
```

`npm start` runs `server.ts`. Use it when testing Twilio media-stream WebSockets. `npm run start:next` starts Next.js without the custom WebSocket upgrade path.

### Docker / Dokploy

```bash
cp deploy/dokploy.env.example .env   # fill every required secret privately
docker compose up --build -d
```

The app runs unprivileged; PostgreSQL 17 is internal-only; a backup sidecar writes custom-format archives and SHA-256 sidecars. An optional client-side encrypted Cloudflare R2 overlay is documented in `deploy/CLOUDFLARE-R2-BACKUPS.md`. See `deploy/DOKPLOY-RUNBOOK.md` rather than treating `docker compose up` as production acceptance.

## Storage

Dokploy strict mode requires PostgreSQL:

```dotenv
VOXERA_STORE=postgres
DATABASE_URL=postgresql://voxera:URL_SAFE_PASSWORD@db:5432/voxera
```

The current domain API is synchronous and uses native libpq to avoid a risky one-release rewrite of roughly 800 store calls. PostgreSQL provides JSONB storage, transactional writes, cross-process cache invalidation, database uniqueness, atomic rate buckets and scheduler advisory locking. The local same-host sustained pilot gate is retained in `screenshots/sustained-load-check.json`; it must be repeated on the chosen VPS. This is not a claim that slow remote-database topology or high-scale concurrency is safe.

SQLite remains the local/default fallback at `data/voxera-db.sqlite`. JSON is explicit **single-process recovery only** (`VOXERA_STORE=json`). Neither a SQLite file on separate replica disks nor JSON is a shared production database.

Provider and carrier secrets are encrypted before storage. Set `VOXERA_SECRET_KEY` outside database/backup volumes and protect both independently.

Useful commands:

```bash
npm run check:postgres
npm run check:phase1
npm run check:phase1:postgres
npm run migrate:postgres -- --check
npm run store:backup
npm run store:restore
npm run check:migration
```

Never copy or replace a live database as an application-level restore. Use the guarded tools and `deploy/POSTGRES.md`.

## Environment

See `.env.example` for the complete list. Important production settings include:

| Variable | Purpose |
| --- | --- |
| `VOXERA_STORE` / `DATABASE_URL` | Explicit production store and internal PostgreSQL connection |
| `VOXERA_STRICT_CONFIG` / `VOXERA_PRODUCTION_PROFILE` | Fail startup when Dokploy production invariants are missing |
| `VOXERA_PUBLIC_URL` | Canonical externally reachable HTTPS origin used for links and Twilio callback signature verification |
| `VOXERA_TRUST_PROXY` / `VOXERA_TRUST_PROXY_HOPS` | Trust only the documented Traefik proxy path when resolving client IPs |
| `VOXERA_SECRET_KEY` | Wraps stored provider/carrier credentials |
| `VOXERA_CLINICAL_DATA_APPROVED` | Final deployment switch; keep `0` until all independent clinical-readiness gates pass |
| `VOXERA_DOCUMENT_MASTER_KEY` | Separate 32-byte document envelope-encryption key |
| `VOXERA_BLOB_BACKEND` / `VOXERA_S3_*` | Selects local test storage or a production S3-compatible private bucket |
| `VOXERA_MALWARE_SCAN_*` | Configures the fail-closed document scanner command, arguments and timeout |
| `VOXERA_MEDIA_SECRET` | Signs media-stream handshakes |
| `VOXERA_MANAGE_SECRET` | Signs client appointment and offer links |
| `VOXERA_DEMO_SECRET` | Signs public demo turn tokens |
| `VOXERA_OPERATOR_EMAILS` | Explicit deployment-wide operator allowlist; empty grants nobody operator access |
| `VOXERA_SCHEDULER` | Enables reminders, follow-ups, queued sends, and campaign work |
| `VOXERA_EMAIL_PROVIDER` / `VOXERA_EMAIL_API_BASE` | Selects the explicit Resend adapter and its HTTPS API origin |
| `VOXERA_EMAIL_API_KEY` / `VOXERA_EMAIL_FROM` | Authenticates outbound email and fixes the verified sender identity |
| `RESEND_WEBHOOK_SECRET` | Verifies raw-body Resend/Svix delivery and bounce callbacks |
| `STRIPE_SECRET_KEY` | Enables real Stripe settlement rather than the labelled simulator |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures |

Optional model credentials can use the implemented OpenAI-compatible or Anthropic-compatible request paths. Live carrier speech-to-text currently requires Deepgram streaming; OpenAI and Groq transcription helpers are batch-only and do not satisfy live-media readiness. Text-to-speech can use ElevenLabs, Cartesia, or OpenAI. Every account, model and voice identifier still requires target-environment verification. Without suitable credentials, the application either uses its bounded rule path or records that provider-backed media is unavailable; it never treats a missing provider request as delivered.

## Twilio

Connect Twilio under **Dashboard → Carriers** with an Account SID and auth token. Carrier credentials are encrypted and are not returned by the API.

A real deployment must set:

```dotenv
VOXERA_PUBLIC_URL=https://your-public-origin.example
VOXERA_SECRET_KEY=replace-with-a-managed-secret
VOXERA_MEDIA_SECRET=replace-with-a-managed-secret
```

Supported callback paths:

```text
POST /api/telephony/twilio/voice
POST /api/telephony/twilio/gather
POST /api/telephony/twilio/status
POST /api/telephony/twilio/stream
POST /api/telephony/twilio/inbound-message
POST /api/telephony/twilio/message-status
```

Mutating Twilio callbacks are verified against the trusted public URL and the connected account’s auth token. In production, an unverifiable callback is refused. Numbers bought or adopted through the carrier workflow are wired to the canonical public origin. Outbound SMS requires an active E.164 number linked to the selected carrier; legacy/demo rows are not treated as live sender identities.

Transfers use only the number’s explicitly configured fallback destination. If none exists, the caller receives a clear unavailable response instead of being sent to an invented number.

### Transactional email

The production pilot selects the explicit Resend adapter, with signed delivery and bounce callbacks at `POST /api/webhooks/resend`. Configure and accept it with `deploy/RESEND.md`; `npm run check:email-provider` proves the local payload/signature contract without claiming live delivery.

### Local carrier stubs

The repository includes Twilio/email, AI, and Stripe stubs for deterministic integration testing:

```bash
npx tsx scripts/twilio-stub.ts
npx tsx scripts/ai-stub.ts
npx tsx scripts/stripe-stub.ts
```

Point local test processes at them with the variables described by the individual gate scripts. Stubs are test infrastructure, not evidence of production provider delivery.

## Payments

Invoices, credits, payment records, allocations, refunds, and receipts are durable application records. When Stripe is not configured, the payment UI and APIs identify the simulated processor. Stripe Checkout and signed settlement webhooks are integrated; Voxera does **not** initiate provider refunds. An authorised operator refunds in Stripe and records/reconciles the provider reference in Voxera. Real charging, refunds, disputes, payouts and reconciliation require controlled account-level acceptance.

## Security model

- Every tenant-owned record is resolved against the authenticated workspace.
- Dashboard navigation visibility is not authorization; API routes enforce role and tenant checks.
- Narrow API keys are accepted only by routes declaring the required supported scope. `*` is full workspace API authority.
- CSRF checks protect session-authenticated mutations; API keys use bearer authentication.
- Carrier-backed E.164 claims are deployment-global, normalized on write, and storage-constrained against duplicate active claims.
- Provider callbacks and public links use signatures; secrets are not written to audit or delivery payloads.
- Historical appointments, classes, money records, clinical notes, and contractor records are not deleted merely because a module or setup resource is retired.

These are application controls, not a certification. A production deployment still needs independent security, privacy, legal, accessibility, provider, backup/restore, incident-response, and regulatory review.

## Verification

Type and production build gates:

```bash
npm run lint
npm run build
```

Gate discovery and orchestrated suites:

```bash
npm run check:list
npm run check
npm run check:browser
npm run check:offline     # run only with the application stopped
npm run media:check
npm run check:migration
npm run check:postgres     # destructive: point at a disposable PostgreSQL DB
npm run check:stripe       # requires Stripe stub + Stripe-configured app
npm run check:email-provider # generic relay + Resend payload/signature contract
npm run check:resend-webhook # signed live route; requires the app + webhook secret
npm run check:production-config
npm run check:staging      # public TLS/proxy/cookie/metrics gate; requires acceptance env
npm run check:performance  # bounded loopback probe against the built runtime
npm run check:load         # 5-minute, 12 req/s controlled-pilot load gate
```

Fresh-clone CI restores `fixtures/voxera-ci.sqlite.gz` with
`scripts/restore-ci-fixture.py`. The compressed fixture is fictional, checksum
verified, SQLite-integrity checked, and excluded from the production image. Never
migrate it into staging or production; it exists only so CI does not depend on an
ignored developer database.

Many focused scripts under `scripts/` exercise tenant isolation, roles, carrier compensation, booking conflicts, classes, notes, money, reminders, contractor workflows, migrations, browser behavior, accessibility, and performance. Read each script’s preamble before running it: several create test records, require the Twilio/AI stubs, or require exclusive access to the store.

`check:load` is intentionally a same-host, read-heavy **single-workspace pilot** gate. Its defaults are five minutes at 12 requests/second with zero failed/dropped requests, request p95 ≤500 ms, p99 ≤1,000 ms, static-sentinel p99 ≤500 ms, event-loop interval p99 ≤200 ms, event-loop max ≤1,000 ms, peak event-loop utilization ≤0.95, and RSS ≤1.2 GiB. Override the `VOXERA_LOAD_*` variables only when the pilot charter records a different target. This gate does not prove high-scale or remote-database safety.

A previous green result is not a release guarantee. Run the gates against the exact build and environment being released, inspect failures, and separately verify real provider behavior in a controlled account.

## Production checklist

Before real customer, patient, payment, call, or message data is used:

1. Build the exact release and run migration, security, integration, browser, accessibility, and performance gates.
2. Configure an operator-controlled HTTPS origin and stable secrets outside the data volume.
3. Connect and test real provider accounts with controlled destinations.
4. Verify callback signatures, tenant routing, number ownership, compensation behavior, and rate limits.
5. Set and document retention, backup, restore, key rotation, audit access, and incident-response policy.
6. Publish operator-specific terms, privacy information, subprocessors, support boundaries, and legally reviewed agreements.
7. Obtain independent clinical, privacy, security, accessibility, payment, and telecommunications review appropriate to the deployment.

The concrete infrastructure and controlled physiotherapy procedures are in `deploy/DOKPLOY-RUNBOOK.md` and `PILOT-DEPLOYMENT.md`.

## Brand

Voxera’s copy, naming, and marks are original. The project may draw on common voice-agent and scheduling product patterns, but it must not copy another provider’s name, logo, mark, or verbatim marketing copy.
