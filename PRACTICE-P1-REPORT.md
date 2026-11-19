# P1 — Practice core · build report

**Phase gate (from `PRACTICE.md` §11):** availability honours rota, holidays, buffers and timezones · booking a slot removes it everywhere · `scripts/practice_check.py` proves it.

**Status: complete and verified.** Build 47 (`563/563` pages), `tsc` clean, `ALL PASS` on every suite that touches this layer.

---

## What P1 added

| Area | What it is | Where |
|---|---|---|
| Availability engine | One answer to "when is this practice free?" — rota − breaks − one-off changes − existing appointments − buffers, inside min-notice/max-advance, on the *site's* clock, returned as UTC instants with a local echo | `lib/server/availability.ts` |
| Practice records | Providers, services, sites (with rooms), weekly rota, one-off changes, the practice profile (term pack + booking policy) — all audited | `lib/server/practice.ts` |
| Vocabulary | `clinical` / `service` / `generic` term packs; the interface renames, the records never change shape | `lib/terms.ts`, `GET/PATCH /v1/practice/profile` |
| Records API | 8 endpoints, all tenant-scoped and role-guarded | `app/api/v1/{providers,services,locations,rota,rota-changes,availability,practice/profile}` |
| Dashboard | `/dashboard/practice` — Diary · Team · Services · Sites · Hours & rules, plus booking rules and the term-pack picker; new "Practice" group at the top of the nav | `app/dashboard/practice/page.tsx`, `components/dash/Shell.tsx` |
| Agent switch | `check_availability` reads the engine; booking and rescheduling refuse a slot the diary says is taken and offer real alternatives | `lib/server/booking-tools.ts`, `lib/server/agent.ts` |
| Booking writes | `POST /v1/bookings` accepts `providerId`/`serviceId`/`locationId`, inherits duration and price from the service, and returns `409` on a clash | `app/api/v1/bookings/route.ts`, `lib/server/bookings.ts` |
| Seeding | A new workspace arrives with two sites in two timezones, four services with different durations and buffers, three providers, weekday rotas, lunch breaks and booking rules | `lib/server/practice.ts#seedPractice`, wired into `seedOrg` and `/api/bootstrap` |
| Docs | `Practice API` reference page (team, services, sites, hours, availability, profile, booking) in the docs sidebar | `lib/docs-content/api-practice.ts` |

**Endpoints:** `GET/POST /v1/providers` · `GET/PATCH/DELETE /v1/providers/{id}` · `GET/POST /v1/services` · `GET/PATCH/DELETE /v1/services/{id}` · `GET/POST /v1/locations` · `GET/PATCH/DELETE /v1/locations/{id}` · `GET/PUT /v1/rota` · `GET/POST /v1/rota-changes` · `DELETE /v1/rota-changes/{id}` · `GET /v1/availability` · `GET/PATCH /v1/practice/profile`

---

## Verification

`python3 scripts/practice_check.py` — **41 checks, ALL PASS** (runs against the demo workspace; creates and removes its own booking and one-off days).

| Group | Checks and what they proved |
|---|---|
| Records | Practice data seeds and reads back (3 providers, 4 services, 2 sites, 4 rotas); services carry duration and buffers (90m +15m) |
| Vocabulary | Switching to `clinical` renames the interface (`practitioner`, `patients`) *and travels with the list the caller reads*; records unchanged |
| Rota | A working day offers 26 slots, all inside 09:00–17:00, none overlapping the 12:00–13:00 lunch break, each naming who and where |
| Closed days | Saturday refused with a reason (`Nothing free between …`) rather than an empty success |
| One-off changes | A day off closes that weekday for that provider only (others still get slots); removing it reopens the day. Extra hours on a closed Saturday produce exactly 10:00–14:00 and disappear when removed |
| Duration & buffers | Slot lengths are exactly the service's 90m; after a real booking the next offered start is ≥ the after-buffer away, and the booked slot leaves availability (9 left of 14) while the diary view still shows it flagged `taken` |
| Clashes | A second booking on the same provider/time → `409` with the clash named; the booking inherits the service's price (180) and duration |
| Timezones | 9:00am Los Angeles = 16:00Z (PDT) and 17:00Z after the 1 Nov change — same wall clock, different instant; the New York site runs its own 08:00–16:00 and site filtering never leaks across sites |
| Providers ↔ services | Only providers who do the service are offered; a provider who cannot do it gets no slots and a reason |
| The agent | A test call's `check_availability` returns **2026-10-15 at 1:00pm, 1:15pm, 1:30pm, 1:45pm with Dana Whitfield** — inside working hours, outside the break, deduped, and the spoken answer quotes it. The old canned `9:15am / 11:40am / 2:00pm` is gone |

Regression suite on the same build:

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | `✓ Compiled successfully` · `563/563` pages |
| `api_check.py` | **ALL PASS** |
| `book_check.py` | **ALL BOOKING CHECKS PASS** |
| `smoke.py` | **ALL SMOKE CHECKS PASS** |
| `carrier_check.py` | **ALL CARRIER CHECKS PASS** (three consecutive runs) |
| `endpoint-probe.ts --mode=blocked` | **ALL PASS** |
| `nesting-check.py` | 513 pages, no invalid nesting |
| `linkcheck.py` | 513 routes, 0 unresolvable links |
| `sitemap-check.py` | 470 entries, every indexable route listed |
| Role guard (unit) | viewer blocked from writes; developer/admin/owner/key allowed; all 10 practice write routes reference the guard |
| `onboard_check.py` | **ALL PASS** — a brand-new signup org got its own 3 providers / 4 services / 2 sites / 4 rotas (probe org then removed by tidy) |

---

## Defects found by this phase's verification (all fixed)

1. **Availability returned nothing on a rota day.** Windows were computed from the epoch day instead of the site's local midnight, so `09:00 + offset` landed in 1970 and every candidate slot failed the comparison. Fixed to measure wall-clock minutes from local midnight — which is also what makes the DST weeks land on the right hour.
2. **The agent was still reading the old canned slot list on test and outbound calls.** Booking tools required a booking identity, and only inbound calls carried a caller number, so `check_availability` fell through to the generic executor. Availability is a read of the practice's opening hours, so it no longer needs an identity; a browser test call's own number now also counts as the caller's.
3. **`carrier_check.py` was not idempotent** (pre-existing, unrelated to the practice layer): it released a number by matching the literal carrier SID `PNstub000101`, which only ever matches the first run — afterwards the fallback gave away whichever carrier-managed number came first, which is how the workspace's adopted line kept disappearing. It now releases by id, and hands the adopted line back at the start of a run so it can adopt it again. Three consecutive runs pass and the workspace keeps all three numbers.

Two smaller honesty fixes: the top-level `timezone` on an unfiltered availability scan now only claims a zone when the returned slots agree on one, and identical times across two providers are offered once to a caller (the per-provider picture stays in the diary).

---

## State after P1

- **Database:** 2 workspaces — `Voxera demo line` and `Northwind Labs` — each carrying a real seeded practice (3 providers, 4 services, 2 sites, 4 rotas, a term pack and booking rules). No probe workspaces, no abandoned calls: tidy ran twice, removing the `onboard_check` signup org and 24 abandoned calls, with backups `data/backups/voxera-db.before-tidy-2026-10-12T14-58-42-136Z.json` and `…15-18-24-975Z.json` (9 backups in total).
- **Northwind (the demo account):** 482 calls (473 of them the seeded history), 25 bookings, 3 numbers, and the live diary the dashboard and the agent both read.
- **Numbers:** unchanged — the two seeded lines plus `+14155550999 "Adopted line"`, which the carrier checks adopt and deliberately leave in place; three consecutive runs of that suite leave the workspace identical.
- **App:** running on the production build (`:3000`), AI and Twilio stubs on `:4020` / `:4010`. The final `practice_check.py` and `smoke.py` runs passed on the restarted build, after the tidy.
- **Artefacts the checks leave behind on purpose:** ended web test calls in the workspace (the same thing the dashboard's browser test call produces — the checks end them, and tidy's sweep for *abandoned* calls correctly ignores them).

## Not in P1 (by plan)

Clients and clinical/records data, notes, consent flags and the per-record access log (P2–P3) · SMS/email reminders and the scheduler that fires them (P4) · invoices, payments, Stripe and the sandbox processor (P5+) · the public booking page. The dashboard's client-side rendering was verified through SSR output, the prerender/nesting/link checks and the exact API contracts every tab reads — there is no headless browser in this environment; a viewer-role end-to-end login test waits for the invite flow that gives a teammate a password.
