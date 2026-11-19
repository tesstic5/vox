# Voxera — multi-business and usability plan

**Status:** **implemented and locally re-verified on 2026-11-06.** Business profiles, typed signup, owner-selected modules, profile-aware setup/navigation, and the workspace-scoped contractor workflow are built. Domain, authenticated HTTP, tenant-security, production-build, nesting, full-dashboard browser-console, desktop/mobile, accessibility, keyboard, hydration, data-integrity and loopback performance gates are green. External provider delivery, TLS termination, payment settlement, independent security/compliance review and deployment remain separate release work.

## The outcome

A business chooses **Contractor / home services**, **Dental practice**, **Physiotherapy**, or **Other** when creating a workspace. The workspace then uses appropriate language, setup steps, useful defaults and navigation. An owner can change the business type and choose modules later. Staff see only what their role permits.

Examples:

| Business | Everyday view | Main work |
|---|---|---|
| Contractor | Customers, enquiries, estimates, jobs, schedule, messages, invoices | Enquiry → estimate → accepted work → assigned visit → completion → invoice |
| Dental practice | Patients, appointments, practitioners, notes, reminders, invoices | Book a patient → see them → document and follow up |
| Physiotherapy | Patients, appointments, practitioners, treatment notes, classes, reminders | Book a patient → treatment → follow-up or group session |
| Other | Customers/clients, appointments, calls, messages, invoices | Select the modules that suit the business |

The contractor workflow below is now implemented as distinct enquiry, estimate, job and visit records; it is not a renamed diary appointment. Dental charting, imaging, insurance claims and specialist physiotherapy assessments are still not provided, and this plan does not imply otherwise.

## Implemented state

- Signup requires **Contractor / home services**, **Dental practice**, **Physiotherapy**, or **Other** (with a short Other description) in the human flow. The server stores the type on the workspace; invited staff inherit it. Existing API callers may omit it, and existing workspaces remain explicitly unconfigured rather than being guessed or silently migrated (`components/site/AuthForm.tsx`, `app/api/auth/signup/route.ts`, `lib/server/auth.ts`).
- Owners/admins can change the business profile, explicit vocabulary, locale/currency and selected modules. Type supplies recommendations only; it does not rewrite historical records or custom content (`lib/business.ts`, `lib/server/business-profile.ts`, `app/api/v1/workspace/profile/route.ts`, `app/dashboard/business/page.tsx`).
- Navigation is module-aware and business-aware, while every protected server route retains its own role, module and tenant checks. A hidden link is never treated as authorisation (`components/dash/Shell.tsx`, `lib/server/api.ts`, field API routes).
- Setup and production bootstrap are profile-aware and create no invented assistants, numbers, providers, services, prices, customers or work records for a real new workspace (`lib/server/bootstrap.ts`, `lib/server/onboarding.ts`, `components/dash/OnboardingWizard.tsx`).
- Contractor records and transitions are workspace-scoped: enquiry → versioned estimate and auditable single-use decision → job → one or more availability/conflict-checked visits → completion → draft invoice. Direct jobs, cancellation/reopen rules, assignment scope, duplicate-invoice protection and module-disable behaviour are covered by automated probes (`lib/server/field-service.ts`, `lib/server/field-api.ts`, `app/api/v1/{enquiries,estimates,jobs,visits}/**`).
- The contractor dashboard has real APIs, empty/error states and responsive screens for enquiries, estimates, jobs and dispatch. Assistant tools can capture an enquiry and schedule only approved work against actual workspace data (`components/dash/FieldServiceWorkspace.tsx`, `lib/server/field-tools.ts`, `lib/server/ai/tools.ts`).
- Core settings, usage, observability and number-detail surfaces read server/workspace state or state that a capability is unavailable; they no longer invent a payment card, SSO sessions, provider health, carrier compliance or operational metrics.
- Dental/physio configurations reuse the working patient/client, diary, notes, classes, reminders and money layers. Specialist dental/physio records are not advertised as present.

## 0. Safety and truthfulness — before real customer onboarding

1. **DONE — close platform-level access by default.** Admin, platform leads and growth now require an explicitly allowlisted operator; an empty list grants nobody access (`lib/server/operator.ts`, `lib/server/leads.ts`).
2. **DONE — disable incomplete Google/GitHub sign-in.** Provider starts and fake callbacks return `OAUTH_UNAVAILABLE` without a redirect or session, and the buttons are removed. A real verified callback, state/CSRF handling and MFA integration remain future work (`app/api/auth/oauth/[provider]/route.ts`).
3. **DONE for the multi-business release surfaces — remove unsupported claims and fake controls.** Entry points describe calls, bookings and field work in business language. Core settings, security, billing, observability and number configuration now use server-backed state or explicit unavailable/sandbox states instead of invented cards, SSO devices, carrier compliance, provider health or delivery success. Specialist clinical and live-provider capabilities remain explicitly bounded.
4. **DONE — make assistant setup safe.** Sample prices/policies were removed; setup and direct creation produce drafts; generic editing cannot change status; explicit publishing still requires a verified address and a configuration role.
5. **DONE — close the generic data bridge.** The raw by-ID route that exposed documents such as password hashes was retired. The remaining dashboard bridge is session-only, allowlisted, config-role protected, audit read-only, API-key inaccessible and collision-safe across workspaces. Viewer mutations fail centrally in `requireAuth` (`app/api/v1/collections/[name]/*`, `lib/server/api.ts`).

**Evidence:** before the fixes, an isolated empty production-mode deployment let a newly signed-up owner become a platform operator and suspend another workspace; the raw by-ID route returned that owner's password hash; the generic bridge let a viewer write and one workspace replace another's colliding document; and unverified assistant creation accepted `status: published`. Fresh isolated reruns after the multi-business implementation passed **44/44** with no operator allowlist and **43/43** with a case/whitespace-normalised allowlist. Each skipped only the email-stub-dependent API-key check; neither recorded a failure.

**Real clinical/patient data remains out of scope for deployment until an independent security review, appropriate legal/compliance assessment and suitable hosting/provider agreements are complete.** Existing controls are not proof of a certification.

## 1. Business profile and signup

- Store a stable business type **on the workspace**, not the person, with optional short “other” description; validate on the server. Existing API callers may omit it for backwards compatibility.
- The signup form requires a selection, explains that it can be changed later, uses the actual eight-character password rule and reports errors accessibly. Invited staff inherit their workspace's type. Future federated signup must reach the same type-selection step.
- For **new** workspaces choose the existing clinical, service or generic vocabulary as appropriate. Existing workspaces keep their current vocabulary and data until an owner changes them; no guessing or silent migration.
- Provide an owner/admin business-profile screen backed by the server. Changing type updates recommendations, not historical records, prices, notes or already customised templates. Keep any independent vocabulary choice explicit.
- Country, time zone, currency and business hours are selected or confirmed during setup rather than assumed from the owner or a sample business.

## 2. User-chosen modules and a simpler dashboard

- One workspace-scoped module registry defines availability, defaults, dependencies and labels. Owners/admins select modules; role permissions and tenant isolation remain independently enforced by the server. Hiding a navigation item is **not** an access control.
- Start with a short, type-appropriate everyday menu; expose permitted advanced tools only when chosen. Classes, patient notes, field-service jobs, campaigns and developer tools are examples of optional modules. The selected type recommends modules, not a rigid product silo.
- A module setting must accurately state its effect. Switching one off never deletes data or silently stops booked visits/reminders. Show dependency and automation consequences before changing it; any pause/resume of live sending is explicit. Keep authorised historical records accessible.
- Existing workspaces retain access to existing functions on upgrade. Owners can restore a hidden module. Server/API behaviour, dashboard state and refresh agree; staff cannot change owner settings.
- Make the dashboard task-based: one clear next action, sensible empty states, real statuses and costs, plain words, mobile navigation, keyboard access and useful errors. No invented payment card, workspace name, delivery success or metrics.

## 3. Guided setup and clearer website

- Replace the one-size-fits-all wizard with a short, resumable checklist: business details → services → team and hours → choose modules → connect and test calls/messages when desired. Booking-only users are not forced to buy a number.
- Give dental/physio and contractor examples without creating fictitious customer records or publishing sample details. Clearly label demo data. Explain which steps require external providers or paid usage.
- Rewrite the homepage and key entry points around outcomes: **answer calls, arrange appointments or visits, communicate with customers and manage work**. Add a clear “how it works” and examples for the three business types, with signup and demo actions.
- Present only functions that are actually implemented and tested; label future field-service features as in development until their gates pass. Review navigation, signup, footer, pricing, security and industry pages for consistent, truthful language.

## 4. Contractor: full field-service workflow

Build as real, workspace-scoped records and actions, not renamed appointment screens:

1. **Enquiry & site.** Capture customer, contact, job description, urgency and a service address per site/job; distinguish contractor enquiries from Voxera's own platform sales-leads inbox. Accept enquiries manually and, when connected, from the assistant. Do not assume a customer's mailing address is the job address.
2. **Estimates.** Draft line items, quantities, unit prices, tax, currency and validity; review before sending. Support sent/accepted/declined/expired states, versioned totals and an auditable customer acceptance. A secure expiring link is single-use where appropriate. No invented price or automatic financial commitment.
3. **Jobs & visits.** Convert an accepted estimate or create a job directly. Keep job status/history separate from the scheduled visits, so one job can have multiple visits. Link customer, site, estimate and assigned worker. Record work performed and completion; cancel/reopen explicitly.
4. **Schedule & dispatch.** Show unassigned and scheduled visits by day and technician; assign, move and reassign with real availability, time-zone, break and collision checks against the existing diary. Support a manual travel buffer; do not claim automatic routing or live GPS unless built separately. Mobile-friendly technician view.
5. **Invoice & communicate.** Create an invoice from confirmed job/estimate lines without duplicate charges; show message delivery status, not presumed delivery. A provider must be configured and a real settlement verified before claiming payments are live.
6. **Assistant handoff.** Let a configured assistant take an enquiry or schedule an approved visit using actual workspace data, with a clear human handoff. It must not quote unknown prices, promise arrival, authorise charges or invent policy.

Each step needs an API, usable screen, role checks, cross-workspace isolation, audit events, realistic empty/error states and end-to-end tests before it is advertised as available.

## 5. Healthcare and other businesses

- Reuse the working calendar, patients/clients, notes, reminders, classes and billing where suitable, with the right terminology and optional modules.
- Dentist-specific charting, insurance claims, imaging and physiotherapy-specific assessments are **not present today**. Specify and build them as separate features if needed; changing a label does not provide them.
- “Other” starts with a sensible generic setup and a module chooser. Adding later business types should be a configuration plus genuinely needed features, not a copy of the product.

## 6. Acceptance and rollout

- Automated and browser journeys: signup each type; validate choices; reload; invite staff; change profile/module choices; verify legacy workspace data is unchanged; check role and cross-tenant denials including when no operator list is configured.
- Contractor end-to-end: enquiry → estimate → acceptance → job → conflict-checked dispatch → completion → invoice, including duplicate, cancellation, expired link and provider-failure cases.
- Test consent, clinical-note permissions, access/audit logs, accessibility, mobile layout and existing diary/booking/security gates. Run `scripts/nesting-check.py` to prevent hydration regressions.
- Distinguish local stubs from real Twilio, email, AI and Stripe tests. A production build and local tests are not a clinical compliance certification or proof of live provider delivery.
- Roll out behind a reversible configuration; take and verify a backup, preserve all existing workspaces, and publish only finished, tested capabilities.
- Production and every multi-process/multi-instance deployment use SQLite. The JSON fallback is explicitly single-process only: its long-lived caches do not refresh after another process writes, so deployment-global conflict, number-ownership and scheduler guarantees are not claimed for JSON. All processes must share the same SQLite file on storage that honours SQLite file locking; separate replica-local disks are separate stores, not deployment-global state.

## Implementation verification — 2026-11-06

- Clean install audit: **0 vulnerabilities**. The pinned Next.js **16.4.3** production build compiles, type-checks and generates all **154 static pages** successfully.
- Complete live API/runtime suite: **43/43 gates, 1,565 checks passed, 0 failed**. Separate offline store suite: **2/2 gates, 18 checks passed, 0 failed**. This includes contractor lifecycle/tools/API, auth/tenant boundaries, booking/practice/day/classes, money, messaging/carriers, race/ownership, media simulation and the standing nesting check.
- Complete browser orchestrator: **5/5 journeys, 140 checks passed** — all **55/55** dashboard routes (including authoritative dynamic detail IDs), practitioner day **40/40**, calendar drag **14/14**, classes **23/23**, and contractor desktop/mobile **8/8**.
- Browser quality audit: **18/18 representative routes at desktop and 18/18 at mobile**, with zero axe WCAG A/AA violations, no failed/bad responses or repeated API reads, and every request/transfer/JS/CSS/4-second local-load budget met. Gradient/overlap cases that axe cannot calculate remain recorded as `incomplete`, not misreported as automated contrast proof; semantic text colours were separately darkened to safe light-background values.
- Loopback production measurements (`screenshots/runtime-performance-check.json`): representative API p95 values ranged from **3.8 ms to 138.1 ms**; the 32-request health burst p95 was **282.9 ms**; two forced retention runs advanced the scheduler count by exactly two, added no failures, and the repeat found nothing to sweep.
- Post-suite cleanup produced a protected backup and an empty dry run. SQLite reported `integrity_check=ok`, `quick_check=ok`, and zero foreign-key violations. SQLite is the supported production/multi-process store; JSON remains a documented single-process fallback.
- The previous deployed release `v01JgjUxIORaRIsJF_EIq` predates these multi-business changes. A new deployment, TLS/provider configuration, real delivery/settlement tests, backup verification and independent security/compliance/legal review are still required before production use with real customer or patient data.
