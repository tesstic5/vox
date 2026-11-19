# Controlled physiotherapy pilot runbook

**Deployment target:** Dokploy/VPS + PostgreSQL, one physiotherapy workspace,
one location, one release owner and a deliberately limited group of staff and
clients.

**Important boundary:** code and stub-provider tests do not establish healthcare
compliance, clinical safety, legal suitability, live delivery or live payment
settlement. No real patient data may enter the system until the named security,
privacy/legal and healthcare-data reviewers approve it in writing.

Use `deploy/DOKPLOY-RUNBOOK.md` for infrastructure and recovery operations.

## 1. Pilot charter (complete before configuration)

| Decision | Recorded value |
|---|---|
| Practice and location | |
| Pilot owner / deputy | |
| Technical on-call | |
| Privacy/legal reviewer | |
| Security reviewer | |
| Clinical safety owner | |
| Start/end dates | |
| Maximum staff and clients | |
| Support hours and contact | |
| Success measures | |
| Stop authority | |

Pilot scope is administrative communication and practice operations: enquiries,
booking, reminders, rescheduling/cancellation, classes where enabled, invoices
and payment links. The assistant must not diagnose, triage emergencies, prescribe,
recommend treatment, claim a practitioner is qualified, or represent notes as a
specialist assessment.

## 2. Entry gates

### Technical staging evidence

- [ ] Immutable image builds and built-container health smoke passes.
- [ ] PostgreSQL integration suite passes on a disposable database.
- [ ] SQLite migration (if needed) agrees on every collection count and canonical
      SHA-256 content digest.
- [ ] PostgreSQL application gates pass under the staging HTTPS hostname.
- [ ] Optimized production build is proven in CI/a host with adequate memory.
- [ ] `/api/health` reports PostgreSQL readable/writable; metrics are private.
- [ ] An **off-box** archive restores into a fresh database and content digests
      match the source; drill evidence records SHA-256 and duration.
- [ ] Trusted-proxy, secure-cookie, origin/CSRF and tenant/role tests pass under
      real Traefik TLS.
- [ ] Representative same-VPS latency/load measurement shows the synchronous
      PostgreSQL client stays inside the agreed event-loop/request budgets.

For the initial one-workspace pilot, the provisional minimum gate is the exact
optimized release running beside PostgreSQL for five minutes at 12 requests/sec
using `npm run check:load`: zero failed or dropped requests; request p95 ≤500 ms
and p99 ≤1,000 ms; static-sentinel p99 ≤500 ms; event-loop interval p99 ≤200 ms
and max ≤1,000 ms; event-loop utilization ≤0.95; RSS ≤1.2 GiB. Retain
`screenshots/sustained-load-check.json`. The pilot charter may set a stricter or
higher representative target, but must not weaken a failed gate after the fact.
This read-heavy local gate does not approve remote PostgreSQL or multi-practice
scale.

### Independent review gates

- [ ] Security/penetration review closed or formally accepted findings.
- [ ] Privacy notice, processor/subprocessor terms, retention and data-subject
      process approved for the pilot jurisdiction.
- [ ] Healthcare-data assessment says exactly which data may be stored and where.
- [ ] Clinical safety owner approves assistant wording, escalation and prohibited
      content.
- [ ] Incident notification and breach contacts are tested.

Until both sections are complete, use fictional records only.

## 3. Fresh workspace configuration

Create a fresh owner account with type **Physiotherapist**. Do not migrate the
repository's demo workspace or credentials.

- [ ] Set legal/practice name, timezone, locale, currency and exact public contact.
- [ ] Owner selects modules explicitly. Recommended pilot starting set:
      **bookings, clients, practice/rota, messaging, notes, reports**; add
      **classes** or **billing** only if the charter needs them.
- [ ] Confirm physiotherapy vocabulary appears in navigation and messages without
      implying specialist/clinical capability the product does not have.
- [ ] Add only real locations, rooms, practitioners, services, durations, buffers,
      prices and capacities. A human verifies practitioner identity/credentials;
      Voxera does not certify them.
- [ ] Configure working hours, holidays, cancellation/reschedule policy, quiet
      hours and reminder lead time.
- [ ] Assign least-privilege roles. Reception staff must not gain practitioner
      note permissions; test an invited receptionist and practitioner separately.
- [ ] Configure retention/consent choices, recording policy and export/deletion
      owner. Do not enable call recording merely because a provider supports it.
- [ ] Write an emergency sentence that directs callers to the practice's approved
      emergency route; the assistant must not perform clinical triage.

## 4. Provider acceptance — one at a time

Stub gates prove integration contracts only. The following require the pilot's
actual accounts and retained evidence with secrets removed.

### Twilio voice and SMS

- [ ] Connect/verify the Twilio account; purchase or adopt one pilot number.
- [ ] Forged voice, gather, stream, status and inbound-message callbacks return
      403; correctly signed callbacks succeed at the public HTTPS URL.
- [ ] Real inbound and outbound calls produce the expected call record and human
      handoff; provider outage/failure is visible, not reported as success.
- [ ] SMS arrives on two real carriers; signed delivery status updates the one
      message row. STOP blocks later sends and START restores consent.
- [ ] Recording/transcription notice and consent wording is approved and heard.

### Email

Follow `deploy/RESEND.md` for the selected provider, signed webhook and safe test addresses.

- [ ] Sender/domain authentication (SPF/DKIM/DMARC as applicable) is verified.
- [ ] Invite, verification, confirmation, reminder and reset mail arrive in real
      inboxes; bounce/rejection evidence reaches operations.
- [ ] No message contains unsupported clinical claims or unnecessary health data.

### Stripe (only if billing is in scope)

- [ ] Test-mode checkout creation, forged/stale webhook rejection and duplicate
      webhook idempotency pass.
- [ ] Webhook endpoint is exactly
      `/api/payments/stripe/webhook`; browser redirects never mark payment paid.
- [ ] One approved low-value live payment and refund reconcile between Stripe,
      invoice, payment row and statement. Voxera does not initiate Stripe refunds:
      an authorised operator performs the refund in Stripe, then records/reconciles
      that provider reference in Voxera. Record IDs/amounts, not card details.

### Optional AI/STT/TTS

- [ ] Provider/subprocessor and data-use terms are approved before sending any
      permitted data.
- [ ] Assistant policy is administrative and bounded; tests cover ambiguous
      symptoms, emergency language, prompt injection and requests for diagnosis.
- [ ] Timeout, provider refusal and outage produce a safe fallback/handoff.
- [ ] Transcript/redaction/retention behavior matches the approved data policy.
- [ ] Voice IDs are provider-specific and tested; no cross-provider mapping is
      assumed.

## 5. Pilot progression

### Stage A — synthetic technical rehearsal

Use only fictional people. Run the complete journey at least twice:

1. enquiry/call → booking → confirmation;
2. client manage link → reschedule/cancel → diary/reminder updates;
3. practitioner day view → check-in/completion → note access by correct roles;
4. invoice → provider-backed pay link → verified webhook → receipt (if in scope);
5. workspace export contains expected records and no provider secrets;
6. password reset, invite acceptance, session revocation and operator audit.

### Stage B — staff-only rehearsal

Staff use their own contact details for a minimum agreed period. Review every
assistant transcript/message and reconcile every booking and payment daily.
Fix defects and repeat Stage A; do not waive failures because the group is small.

### Stage C — controlled live cohort

Only after all entry/sign-off gates:

- Enrol no more than the charter's maximum, with explicit practice onboarding and
  an alternative phone/manual booking route.
- Keep one workspace/location and one app replica for the first cohort.
- Make human staff authoritative for diary changes, clinical decisions and money
  reconciliation.
- Expand modules, providers or cohort only through a recorded change decision.

## 6. Daily operations

**Opening check**

- [ ] App/database healthy; no 5xx or scheduler-owner anomaly.
- [ ] Latest backup succeeded, is within the age objective and has left the VPS.
- [ ] Twilio/email/SMS/Stripe/AI dashboards show no unresolved rejection spike.
- [ ] Pending/failed messages and upcoming appointments reviewed by staff.

**Closing reconciliation**

- [ ] Today's bookings, changes, no-shows and messages agree with staff records.
- [ ] Every provider delivery claim has provider evidence.
- [ ] Stripe payments/refunds agree with invoices/statements (if enabled).
- [ ] Assistant conversations sampled for prohibited clinical content and handoff.
- [ ] Incidents, workarounds and user feedback recorded with UTC time/build ID.

## 7. Immediate stop conditions

Disable the affected workflow or the whole pilot when any occurs:

- suspected cross-workspace/role exposure or forged callback acceptance;
- wrong-person booking, message, manage link or disclosure;
- payment marked settled without verified provider evidence, or reconciliation
  mismatch;
- assistant gives diagnosis/treatment/emergency triage or fails required handoff;
- provider failure is presented to staff as successful delivery;
- backup is stale beyond the agreed objective or restore integrity is uncertain;
- material security/privacy incident, repeated 5xx, data corruption or unexplained
  scheduler duplication.

Preserve audit/log/provider IDs, notify the named owners, use the manual booking
route, and follow the Dokploy incident/rollback runbook. Never "fix" an incident
by bulk-deleting historical records.

## 8. Exit and sign-off

At pilot end:

- [ ] Export/reconcile the workspace; action retention/deletion commitments.
- [ ] Revoke temporary staff/provider access and rotate pilot-only credentials.
- [ ] Complete one final off-box restore drill.
- [ ] Review success measures, incidents, accessibility/user feedback and support
      load; document unresolved risks.
- [ ] Security, privacy/legal, clinical, practice and technical owners each sign
      **expand**, **extend unchanged**, or **stop**. A successful technical pilot
      is not automatic approval for more practices or broader clinical scope.
