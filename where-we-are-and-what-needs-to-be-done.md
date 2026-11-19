# Voxera UK Allied Health — Where We Are & What Needs To Be Done

**Date:** 2026-09-20  
**Governing Plan:** `/home/user/voxera-uk-allied-health-implementation-plan-2026-09-20.md`  
**Architecture:** Native, standalone UK allied-health practice-management platform (no competitor integration).

---

## 1. What Is Done

### Phase 3 (Complete Locally)
- Full native scheduling, diary, classes, waitlist, messaging, payments, and evidence workflows.
- Verified locally: TypeScript, production build (**166/166**), workflow (**56**), evidence race (**13/13**), HTTP (**49/49**), browser (**21/21**), two-node race (**21/21**), nesting (**118** pages).

### Phase 4 — Clinical Record & Body Charts (Complete Locally)
- Immutable-version note templates, draft/final/amend clinical-note lifecycle, and existing signing integrity.
- Body-chart templates and annotations.
- Verified locally: domain/migration (**27**), rollback (**17/17**), restore (**14/14**), HTTP (**27/27**), race (**14/14**), browser (**23/23**), mobile (**388/388**), TypeScript (**0**), build (**168/168**), nesting (**119** pages).
- Verified backup checkpoint: `/home/user/00-phase4-body-charts-verified-backup.tar.gz` (SHA-256 `0faee263f6fd0455e02756d6f519271683383c78db07fd4c842a448f792992c2`).

### Phase 4 — Cases, Funding, Coverage, Care Plans & Encounters (Implemented & Partially Verified)
- **Database & Migrations (`lib/server/schema-migrations.ts`, `lib/server/data-migrations.ts`):**
  - Migration `20260920_014_phase4_cases_funding` implemented and verified on isolated SQLite.
  - System-role reconciliation migration `phase4.system_role_case_funding_permissions` added (no historical case inference).
- **Domain Engines:**
  - `lib/server/cases.ts`: Cases, assignments, statuses (`draft`, `active`, `paused`, `closed`), limits, and enforcement modes (`shadow`, `enforced`).
  - `lib/server/coverage.ts`: Payers, encrypted client coverages, default masking (`coverageView(..., false)`), and authorized reveal (`coverageView(..., true)`).
  - `lib/server/funding.ts`: Funding periods, service rules, authorisations, deterministic tax/unit arithmetic, atomic `commitBookingFunding`, settlement (`used`), and reversal (`cancelled`/no-show/late-cancel policies).
  - `lib/server/care-plans.ts` & `lib/server/encounters.ts`: Clinician-authored care plans/goals with optimistic concurrency (no last-write-wins) and one-encounter-per-booking lifecycle.
- **APIs & Lifecycle Integration:**
  - `/api/v1/cases`, `/api/v1/payers`, `/api/v1/authorisations`, `/api/v1/care-plans`, `/api/v1/encounters`, and `/api/v1/clients/[id]/coverages`.
  - Booking creation, move, status, delete, bulk-sync protection, and class-seat funding allocation/reversal.
  - `lib/server/diary.ts`: `createSeries` updated to pass case/coverage/authorisation/override fields and report `BookingFundingError` occurrences in `skipped`.
  - Schema-v2 subject-access (`lib/server/client-export.ts`) and whole-workspace (`lib/server/workspace-export.ts`) exports with authorized coverage projection.
  - Granular permissions, `cases:read`/`cases:write` API-key scopes, and custom-role `cases` scope.
- **Dashboard UI:**
  - `/dashboard/cases` (`app/dashboard/cases/page.tsx`): Draft cases, funding periods, service rules, balances, activation, and authorisation expiry queue.
  - `/dashboard/clients` (`app/dashboard/clients/page.tsx`): Added `ClientCasesTab` (administrative case status & masked coverage) and `CarePlanTab` (clinician-authored plans & goals).
  - `/dashboard/calendar` (`app/dashboard/calendar/page.tsx`): Added case/funding & authorisation selection with deterministic pre-save balance/policy preview in `NewAppointmentModal`, plus case-funded allocation display in appointment details.

### Latest Verification Results
- **TypeScript (`./node_modules/.bin/tsc --noEmit --pretty false`):** Passed (`0` errors).
- **Production build (`npm run build`):** Passed (**169/169** static pages).
- **Nesting check (`python3 scripts/nesting-check.py`):** Passed (**120** prerendered pages, no invalid nesting).
- **Domain, migration & funding suite (`./node_modules/.bin/tsx scripts/phase4-cases-funding-check.ts`):** Passed (**25/25** assertions).
- **HTTP route & auth probes:** Passed (**9/9**: `/api/health` `200`, `/dashboard/{cases,clients,calendar}` `307->200` login redirect, `/api/v1/{cases,payers,authorisations,care-plans,encounters}` `401` unauthenticated).
- **Direct booking writes classification:** Confirmed `packs.ts`, `booking-campaigns.ts`, and `backfill.ts` do not call `upsertBooking` or `setAppointmentStatus` directly; `bootstrap.ts` only uses `upsertBooking` for non-case-funded demo seeding.

---

## 2. What Needs To Be Done

### Immediate Local Verification Gates
1. **HTTP API & Auth Probes:** Run authenticated and unauthenticated HTTP checks against `/api/v1/cases`, `/api/v1/payers`, `/api/v1/authorisations`, `/api/v1/care-plans`, `/api/v1/encounters`, `/api/v1/clients/[id]/coverages`, and `/dashboard/cases`, `/dashboard/clients`, `/dashboard/calendar`.
2. **Cross-Process Race Tests:** Verify concurrent booking allocations against a single funding period/case limit under SQLite.
3. **Browser UI Pass:** Verify `/dashboard/cases`, `/dashboard/clients` (Cases & Care plan tabs), and `/dashboard/calendar` (case-funded booking modal) in headless browser with zero console/page errors.

### External / Deployment Gates (Blocked on External Infrastructure & Reviews)
- **PostgreSQL:** Execute migrations `013` and `014` and run PostgreSQL verification suite.
- **Live Providers:** Configure Twilio, Resend, Stripe live amounts, optional AI keys, and Cloudflare R2 (if selected).
- **Independent Approvals:** Obtain independent security, privacy/legal, and healthcare/clinical sign-off before any real patient data is permitted.
