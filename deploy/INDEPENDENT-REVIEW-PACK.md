# Independent review handoff pack

**Status:** assessor input template, not an approval. It was prepared by the
product team and cannot satisfy an independent-review gate by itself.

**Pilot boundary:** one physiotherapy workspace/location, administrative booking
and communication only. No diagnosis, emergency triage, prescribing, treatment
recommendations, practitioner certification, or claim that notes are a specialist
assessment. Real patient data remains prohibited until the applicable reviewers
sign in writing.

## 1. Build and architecture supplied to reviewers

- Source release/build id: ______________________________
- Public staging hostname: ______________________________
- Dokploy/VPS provider and region: ______________________
- PostgreSQL location/region: same VPS / other: __________
- Off-box backup provider/region: ________________________
- Pilot practice jurisdiction(s): ________________________
- Maximum staff/clients and dates: _______________________

Architecture evidence:

- `Dockerfile`, `docker-compose.yml`, `deploy/dokploy.env.example`
- `deploy/DOKPLOY-RUNBOOK.md`, `deploy/POSTGRES.md`
- `deploy/CLOUDFLARE-R2-BACKUPS.md` when enabled
- `PILOT-DEPLOYMENT.md`
- `PRODUCTION-READINESS-EVIDENCE.md`
- CI result and artifacts for the exact immutable SHA
- public staging result: `screenshots/public-staging-check.json`
- PostgreSQL live/offline/browser/load artifacts under `screenshots/`

Secrets, raw patient data, session cookies, card data and full provider payloads
must not be placed in the review packet.

## 2. Security/penetration assessor scope

At minimum, independently test and report:

- owner/admin/practitioner/reception role boundaries and cross-tenant object IDs;
- signup, invite, reset, magic-link, verification, MFA/recovery, revocation and
  account/IP throttling;
- CSRF/origin policy, trusted proxy hops, forged forwarding headers, secure cookie
  attributes, CSP and public/private route exposure;
- API-key scope enforcement and server-authoritative module/role controls;
- public booking/manage/pay/offer token entropy, expiry, replay and wrong-tenant
  behavior;
- Twilio, Resend and Stripe raw-body signature verification, stale/replayed event
  handling and provider-id ownership;
- SSRF and provider base-URL restrictions, webhook destinations and redirect/DNS
  rebinding behavior;
- upload/download paths, content types, direct-object access and stored secrets;
- PostgreSQL credentials/network exposure, backup/restore privileges and key
  separation;
- container user, image contents, dependency findings, Dokploy/Traefik exposure,
  metrics privacy, resource exhaustion and log redaction;
- concurrency: number ownership, booking/class capacity, rate buckets, scheduler
  ownership, payment/webhook idempotency and cache invalidation.

Deliverable: methods, UTC dates, build id, severity/rationale, reproducible evidence,
remediation/retest status and explicit residual-risk decision by the named owner.

## 3. Privacy/legal/healthcare-data assessor scope

The assessor must identify the actual jurisdictions and decide, rather than assume:

- controller/processor roles and contracts for the practice, VPS, Cloudflare R2,
  Twilio, Resend, Stripe and any AI/STT/TTS provider;
- permitted data fields and prohibited data for the pilot;
- lawful basis/consent for SMS, email, calls, recording, transcription and AI;
- privacy notice, retention schedule, export/access/correction/deletion process,
  legal holds and breach-notification contacts/times;
- cross-border transfer/data residency requirements and provider training/data-use
  settings;
- whether health-data or sector-specific rules apply to this practice and region;
- call-recording and telecommunications rules for both ends of a call;
- payment scope and the fact that card details remain on Stripe-hosted Checkout;
- backup retention/deletion and crypt-key custody.

Deliverable: approved pilot data map, retention table, notices/agreements,
subprocessor list, incident obligations and written go/no-go for real patient data.

## 4. Clinical safety owner scope

Use fictional scenarios to review:

- administrative-only assistant wording and explicit human authority;
- emergency language and immediate route to the practice's approved emergency
  instruction, without symptom triage;
- ambiguous symptoms, diagnosis/treatment requests, medication questions,
  safeguarding language and prompt injection;
- human handoff when providers fail or the caller asks for clinical judgment;
- booking/service descriptions that do not certify practitioners or imply
  unsupported assessments;
- note visibility/finalisation/amendment and reception exclusion;
- transcript/recording notices and prohibited retention/content.

Deliverable: approved scripts/policies/test cases, named stop authority, unresolved
hazards and written scope approval.

## 5. Accessibility/manual usability scope

Automated axe results are evidence, not a manual accessibility review. Test the
public booking/manage/payment journeys and staff-critical dashboard workflows with:

- keyboard-only operation and visible focus;
- current NVDA/JAWS + Chrome/Edge and VoiceOver + Safari as applicable;
- zoom/reflow at 200% and 400%, high contrast, reduced motion and mobile screen
  reader;
- errors, status announcements, dialogs, drag alternatives, tables/calendars,
  authentication/MFA and timeout recovery;
- plain-language comprehension with representative staff/users.

Deliverable: WCAG criterion mapping, assistive technology/browser versions,
findings/retests and any documented accommodations.

## 6. Telecom/payment/provider review scope

- Twilio account/number regulatory status, geographic permissions, consent,
  recording, messaging policy, opt-out and abuse controls;
- Resend domain authentication, suppression/bounce/complaint handling and message
  content/data minimisation;
- Stripe account/business activation, webhook ownership, test/live separation,
  refund/dispute/reconciliation procedures and staff authority;
- AI/STT/TTS provider terms, data retention/training controls, model/voice IDs,
  outage behavior and human fallback.

## 7. Sign-off register

| Role | Named independent reviewer | Organisation | Report/version | Decision | Date | Conditions/expiry |
|---|---|---|---|---|---|---|
| Security/penetration | | | | approve / conditional / reject | | |
| Privacy/legal | | | | approve / conditional / reject | | |
| Healthcare-data | | | | approve / conditional / reject | | |
| Clinical safety | | | | approve / conditional / reject | | |
| Accessibility | | | | approve / conditional / reject | | |
| Telecom/payment | | | | approve / conditional / reject | | |
| Practice owner | | | | approve / conditional / reject | | |
| Technical release owner | | | | approve / conditional / reject | | |

A blank row, self-review, expired condition, or unclosed critical/high finding is
not approval. Keep the signed reports outside the source repository and reference
them here only by controlled document id.
