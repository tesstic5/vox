# Voxera Practice — plan

**Status:** proposed, awaiting your review · **Date:** 2026-10-02
**Decisions locked with you:** hybrid ownership · generic vocabularies from day one · full parity including money · hardened for records + real payments.

This is the spec we build from, phase by phase, in the same rhythm as the rest of Voxera: one phase, then verification, then review.

---

## 1. What we're building, and where the boundary is

Voxera today is a communication layer that books into someone else's scheduler. This turns it into the **clinic system**: the diary, the clients, their notes and the money live here, and the AI receptionist is a first-class user of the same records.

**Voxera owns** — providers, services, rota/availability, the diary, clients, notes, invoices/payments.
**Syncs out (hybrid boundary)** — an external scheduler can still push/pull appointments (`/v1/bookings/sync` stays), accounting exports Xero-shaped data instead of us rebuilding Xero, and every one of the above emits webhooks (`appointment.*`, `invoice.*`, `note.*`).
**Deliberately not built** — see §9.

## 2. Two architectural calls to make now

**2a. Neutral schema, configurable labels.** You chose generic vocabularies, so the database and API use domain-neutral names — `clients`, `providers`, `services`, `appointments`, `notes` — and the *interface* renders a **term pack** per organisation.

| Pack | clients | providers | appointments | notes |
|---|---|---|---|---|
| Clinical (default for a clinic) | Patient | Practitioner | Appointment | Treatment note |
| Service | Customer | Technician | Job | Job note |
| Generic | Client | Team member | Appointment | Note |

One term pack drives the dashboard, the public booking page, confirmation messages and PDFs. No dual endpoints: `/v1/clients` is canonical, docs explain the pack. This avoids the alternative — renaming every table for every vertical — which is a migration every time a customer changes industries.

**2b. `bookings` evolves, it does not duplicate.** The existing `bookings` collection becomes the appointment record: `providerId`, `serviceId`, `locationId`, `roomId`, `clientId`, price snapshot, status lifecycle (`booked → confirmed → arrived → completed | cancelled | no-show`), `seriesId` for repeat appointments. `/v1/bookings` keeps working (it is a real, documented endpoint), the AI tools keep working, and the sync bridge keeps working. One calendar, not two.

## 3. Domain model (new collections)

| Collection | Holds | Notes |
|---|---|---|
| `providers` | name, role, colour, default services, locations, optional linked user | practitioner/technician |
| `services` | name, duration, buffer before/after, price, tax rate, colour, code | price snapshot copied onto the appointment at booking time |
| `locations` | name, address, timezone, rooms[] | timezone is authoritative for that site |
| `rota` | weekly working hours + breaks per provider × location | |
| `rotaChanges` | one-off availability: holidays, extra sessions, impromptu edits | never mutates the regular rota |
| `clients` | contact details, tags, **alerts** (medical flags), **consents** (sms/email/recording), soft-delete + retention | alerts and consents are enforced, not decorative |
| `notes` | notes against an appointment/client, template + field values, draft/incomplete flags, attachments, **immutable once finalised** (amendments are new versions) | |
| `noteTemplates` | field definitions per service | |
| `invoices` + `invoiceLines` | from appointments, attendance details, discounts, tax | |
| `payments`, `credits`, `refunds`, `paymentTypes` | records, prepayments, account credit, refunds | balance is derived, never stored twice |
| `expenses`, `taxRates` | practice costs and tax setup | |
| `outreach` | every SMS/email/call sent to a client, one timeline | campaigns and reminders both write here |
| `accessLog` | who viewed/edited a client, note or invoice, and when | the records-bar requirement |
| `practiceProfile` (on org) | term pack, business details/logo, reminder rules, online-booking settings, default tax | |

## 4. Availability engine — one source of truth

Today `check_availability` subtracts booked slots from a day and nothing else: no working hours, no providers, no rooms. The engine replaces it and is used by **the diary, the public booking page and the AI tools alike**, so all three can never disagree:

```
slots = rota(provider, location)  ∩  not(rotaChanges)  ∩  rooms free
        − appointments  − lead time  − buffer before/after  − breaks
```

Timezone-safe (each location's tz, client's tz on the public page), and it answers "first available with anyone", "next slot for this provider" and "who is free at 2pm".

## 5. Hardened for records (your bar)

- **RBAC** on the existing role system (`owner | admin | developer | viewer`) extended with **`practitioner`** (sees own diary + own clients' notes) and **`receptionist`** (diary + clients, no clinical notes, no money editing).
- **Per-record access log** for client, note and invoice reads and writes — surfaced on the record as a history tab.
- **Soft delete + retention**: nothing with a legal life is hard-deleted; retention sweep extends the existing maintenance job.
- **Consent enforcement**: no SMS/email/recording where consent is absent; the UI says why instead of silently not sending.
- **No clinical data in localStorage.** Today the dashboard mirrors its whole store into `localStorage`; the new practice entities are server-first (own client layer, excluded from the mirror). This is the one refactor this plan carries, and phase 2 is where it happens.
- **Honest copy**: hardened-for-records standards, *not* a claim of HIPAA certification or a BAA. Where a real deployment needs more (encryption at rest beyond the secrets box, BAAs, audit export), the UI says so.

## 6. Payments (real, test-mode by default)

A `PaymentProvider` interface with **two adapters**: a local sandbox (default; works with no keys) and **Stripe** (test/live keys from the existing secrets store). Invoices get payment links, prepayments create account credit, refunds reference the original payment, statements render per client. Live mode is impossible without real keys — same fail-closed habit as the telephony signature fix.

## 7. Phases

Each phase ends with the suite pattern we already use: build → `tsc` → build 561-ish pages → scripts → tidy → a short report.

| # | Phase | Done when |
|---|---|---|
| **P1** | **Practice core** — providers, services, locations, rota + one-off changes, availability engine, dashboard tabs, `check_availability` switched to the engine | Availability honours rota/holidays/buffers/timezones; booking a slot removes it everywhere; a new `scripts/practice_check.py` proves it |
| **P2** | **Diary + clients** — day/3-day/work-week calendar, create/move/resize, statuses, wait list, repeat series, privacy mode; client records with timeline, alerts, consents; **server-first client data** | A receptionist can run a full day without touching the API; no client data in localStorage (verified by script) |
| **P3** | **Online booking** — public page per workspace: service → provider → slot → details → confirm; .ics + confirmation; consent capture; rate-limited | A stranger books end-to-end and it appears on the diary, with the term pack applied |
| **P4** | **Messaging & reminders** — SMS + email sending, templates, reminder/follow-up/no-show rules, and the missing scheduler (cron-equivalent) driving the queue; campaigns can SMS *and* call | A reminder fires at T-minus N and is logged in `outreach`; no-show rate is reportable |
| **P5** | **Notes** — templates per service, editor with incomplete flags, attachments, finalise + amend, access log, RBAC enforcement | A finalised note cannot be edited without an amendment version; a receptionist cannot open it |
| **P6** | **Money** — invoices from appointments, lines/discounts/taxes, payment types, payments/refunds/prepayments/credits, statements, expenses, provider revenue; Stripe adapter + sandbox; Xero-shaped export | Invoice → payment → statement reconciles; sandbox flow works with no keys |
| **P7** | **Reports** — revenue by provider/service, utilisation, no-shows, recalls, marketing attribution (booking source), CSV/PDF export | A clinic owner can answer "who earns what, what does it cost us, who does not turn up" from one screen |
| **P8** ✅ | **Multi-location + team** — locations/rooms in the diary, role-management UI, internal staff board, import/export finishers | Two locations run in one workspace without data leaking across them |
| **U** ✅ | **Demo coherence + usability pass** (not a parity phase — a cross-cutting pass over the screens P1–P8 built) — one story in the demo workspace, plain words on every state, a practice checklist that tells a new owner what to do next and proves it is not decoration | A stranger can read the demo diary as a real month of a real practice, and every screen answers "what is this and what do I do next" without a developer |

| **P9** ✅ | **What the AI can answer** — `practice_report`: the assistant reports on the practice's own records when a member of the team asks, gated on who is asking (a number on file, or the signed-in role on a dashboard call), aggregates only, every read and refusal audited | The owner rings in and gets last month's numbers, spoken, matching the Reports screen to the cent — and a stranger asking the same question gets a polite refusal and no figure |

**Progress.** P1 ✅ `PRACTICE-P1-REPORT.md` · P2 ✅ `PRACTICE-P2-REPORT.md` · P3 ✅ `PRACTICE-P3-REPORT.md` · P4 ✅ `PRACTICE-P4-REPORT.md` · P5 ✅ `PRACTICE-P5-REPORT.md` · P6 ✅ `PRACTICE-P6-REPORT.md` · P7 ✅ `PRACTICE-P7-REPORT.md` · P8 ✅ `PRACTICE-P8-REPORT.md` · U ✅ `PRACTICE-USABILITY-REPORT.md` (demo coherence §10 Risk 3 closed, usability pass over P1–P8) · P9 ✅ `PRACTICE-P9-REPORT.md` (the AI can report; §8's last line is now true).

**Off-phase bundles** — from `AUDIT-2026-10-15.md`, built one authorised bundle at a time:

- ✅ **`AUDIT-FIXES-2026-10-15.md`** — the audit's recommended three: **D1** the diary on one clock, **D2** a reply that does what the reminder promised, **A1** the client's own link (`/m/<token>`) to move or cancel. Gated by `scripts/manage_check.py` (37 checks).
- ✅ **`AUDIT-D3-AUTH-2026-10-15.md`** — password reset, magic link, the verify code and invitations are real, and `emailVerified` actually gates publishing and provisioning. Gated by `scripts/auth_check.py` (101 checks).
- ✅ **`AUDIT-D6-WAITLIST-2026-10-15.md`** — **D6 + A7 + A3**: a cancellation offers the time it freed, the client books it in one tap from their own link, and arrival is a tap too. Gated by `scripts/waitlist_check.py` (77 checks), `scripts/offer_expiry_probe.ts` (8, offline) and `scripts/room_window_check.ts` (175 windows).

Each phase ends with the same gate: `tsc`, a production build, the whole check suite against that build, a tidy, and a short report before the next phase starts.

## 8. What the AI gains, phase by phase

This is the payoff and it is why the ordering matters: P1 makes "do you have anything Thursday?" truthful; P2 lets the AI move a booking the receptionist sees live; P3 gives it a competitor-free booking page; P4 turns confirmation calls into confirmation calls **plus** SMS with the same rules engine; P5 lets it draft the note summary (never finalise it); P6 lets it read a balance and send a payment link (finished — `payment_status`, `create_payment_link`); P7 reports on the calls it handled versus the ones it did not — finished in **P9**: `practice_report` answers "how did we do last month", "how busy were we", "what's our no-show rate", "where did bookings come from", "who is overdue", "how many calls did we handle" from the same functions the Reports screen calls, on the phone, gated on who is asking.

## 9. Non-goals (explicit)

Telehealth video · inventory/barcodes · insurance claim clearinghouses · native mobile apps · live two-way Xero (export first) · HL7/FHIR · being a certified HIPAA/GDPR product (we build to the standards, we do not claim certification).

## 10. Risks, named

1. **Scope** — "full parity" is 8 phases; mitigated by phase gates and by each phase shipping something a clinic can use.
2. **The localStorage refactor** — the one change that touches existing behaviour; done in P2 with the script check above as the gate.
3. **Demo coherence** — ✅ *closed 2026-10-15; extended 2026-10-17 with classes*. Northwind is a services company: the demo workspace now carries one month of a practice that has actually been running (`scripts/seed-demo-diary.ts`, gate `scripts/demo_check.py`), including **two standing group sessions with real clients seated in them** — laid down through the product's own service, rota and seating calls, and held to account by the gate's class section. The term pack still means both vocabularies stay supported.
4. **Verification cost** — each phase adds scripts; the existing suite (~12 scripts) is the template.

## 11. Immediate next step

P1–P8, U and P9 are built, verified and reported; §7's table ends at P9. What remains from the wider list, in the order I would do it:

1. **The class wait-list shipped (2026-10-17)** — a full class keeps a **line**, and a place given back is offered to the front of it, one person, one tap, on the class's own `class_offer` text. That completes the class layer bar one thing: **class packs** remain **not authorised** (money design first). `scripts/class_check.py` is 74 checks and the classes walk 23; `demo_check.py` proves the demo ships a full class with somebody in line, and the seeder keeps it that way.
2. **Nothing is left of the audit.** Every defect (D1–D10) is closed and every addition is built: A1–A3, A5–A7 and A9 with their own bundles, **A4** as part of the money loop (receipts on payment, the overdue ladder — `/docs/guides/classes` is the newest of the docs pages D8/A9 asked for), and **A8 classes and group appointments** — the one Cliniko scheduling feature this product did not have — as its own bundle with `scripts/class_check.py` as the gate and `scripts/class-ui-pass.mjs` as a browser walk of the class page, the diary block and the public card (`npm run check:browser` runs it with its three siblings in one command). Two rules came out of that build and are enforced by the product, not just written down: a class service cannot be deleted while a session is still to come (`because: "classes"`), and the tidy sweeps a class session whose service is gone — the same debt as an invoice naming a client who left. The practice layer's decided-outs and §9 non-goals stay decided out (recording storage, SMTP, live Stripe settlement, telehealth video, insurance clearinghouses, and so on).
3. The rhythm is unchanged: build → verify → report → review, and no phase starts without a go-ahead.

No phase starts without a go-ahead — the rhythm is still build → verify → report → review.
