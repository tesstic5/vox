# The register — per-seat attendance, and a place that is not a slot

**Date:** 2026-10-17
**Authorisation:** "go" — build the bundle the investigation recommended, exactly that, nothing more.
**Status:** built, verified, and reported. **33 gates, 1382 checks, 0 failed**; four browser walks
**120 checks, 0 failed**; offline gate 8/0; the demo clean after the sweep.
**Build:** `iLW1yFuTOuddL8JtnxmMJ` (582/582), tsc 0.

---

## 1. What was asked

After the coherence bundle, the open question was what to build next from the class feature.
Three candidates were on the table — class wait-list, class packs, per-seat attendance — and the
answer was not decided by preference but by looking.

**The investigation, before anything was touched:**

- `offerFreedSlot` in `lib/server/wait-offers.ts` has **five callers**. Reading them showed that
  every one of them funnels through that one function — so a guard there covers the whole product.
- `lib/server/maintenance.ts` has **no auto-complete** pass: nothing in the product moves a
  booking to `completed` on its own, which means an attended place had no path to attendance at
  all. Attendance would have to be *done by a person*.
- A live probe on the demo workspace confirmed the defect that decided the bundle: giving back a
  **class seat** returned `offers: 1` — the freed-place machinery treated a place in a group class
  as a sellable slot and offered it to somebody waiting for a private appointment.

So the recommendation was the **register**: the controls a front desk needs to run a class it has
sold, plus the guard that stops a place ever being mistaken for a slot. The wait-list and class
packs were left alone, deliberately.

---

## 2. What shipped

### (a) Per-seat controls on the booking lifecycle

`POST /api/v1/classes/{id}` gained two actions:

| action | body | what it does |
|---|---|---|
| `mark-seat` | `{ bookingId, status }` | Moves **one place** through the ordinary booking statuses — `arrived`, `completed`, `no_show`, and `confirmed` as **Undo** |
| `everyone-arrived` | `{}` | Marks every place that is still `pending` or `confirmed` as `arrived`, in one tap |

Route: `app/api/v1/classes/[id]/route.ts:133–186`. A seat is an ordinary booking, so these are
ordinary transitions — they are **not** a parallel status system. That is what makes the register
work with reminders, the client's timeline, receipts and the reports without a line of new code.

The desk UI is `app/dashboard/classes/page.tsx`: each row in the roster has its own
**Arrived · Done · No-show · Undo**, and the header carries **Everyone's here**
(`page.tsx:302–303`). The roster reads in words a receptionist would use — `2 of 8 here`
(`page.tsx:544`).

### (b) A seat is not a slot — the phantom offer, closed at the choke point

`lib/server/wait-offers.ts:205–222`: `offerFreedSlot` now returns `classSeat: true` when the
booking carries a `sessionId`, and offers nothing. Because all five callers go through it, the
fix covers every route that can free a place.

The two routes that can be reached directly say so in words rather than failing silently:

- `app/api/v1/bookings/[id]/status/route.ts:54` — the seat cancellation response carries
  `classSeat: true` and the note *"A place in a class was given back — the class is still running,
  so nothing was offered to the wait list."*
- `app/api/v1/wait-list/offers/route.ts:63` returns **409** for a class hour.

And the manual offer screen refuses too, through `sessionOverlapping`
(`lib/server/classes.ts:630`, used at `wait-list/offers/route.ts:104`): *"A class is on at that
time…"*. Three doors, one rule.

### (c) Attendance is counted where the money is

- `attendanceFor(orgId, session)` (`lib/server/classes.ts:604`) returns
  `{ capacity, seats, confirmed, arrived, completed, noShow, free, attended }`.
- `GET /api/v1/classes/{id}` now ships it beside `session`, `roster`, `instructor` and `site`.
- **A class hour is counted once.** `lib/server/reports.ts:363` `heldMinutes()` counts a session
  once however many places were sold in it, while each *attended place* counts once per client —
  the hour is the resource, the place is the visit. `lib/server/day.ts:593` excludes seat rows
  from `bookedMinutes` (the session already holds the time), so the day does not double-count
  either.

### (d) Gate, walk, docs

- `scripts/class_check.py` — **55 checks** (was 41).
- `scripts/class-ui-pass.mjs` — **18 checks** (was 15).
- `/docs/guides/classes` — a new section, *"The register — who actually came"*, plus five blocks:
  the two actions with examples, the `attendance` field list, and the class-hour-once callout.
  The freed-place callout now names the single choke point and the manual screen.

### The knock-on the bundle exposed: the demo's "today" decays

`scripts/seed-demo-diary.ts` seeds a *month* anchored to the day it ran, so a day later the screen
a visitor actually opens — today's diary — is thin. `demo_check.py` caught it on this build:
**4 visits on 2026-10-17**, against a threshold of 5.

The fix is **phase 2b, "today is alive"**: every run tops today up to `TODAY_MIN_VISITS = 5` live
visits across the sites, placed through `isFree` like everything else, later in the day first,
deterministic per `(date, provider, site, window)`, with ids `NW-T-<date>-<hhmm>-<provider4>` and
`metadata.demoDiary = <tag>-today`. It reports `todayAdded`.

Two defects in my own first version were caught by running it rather than reading it:

1. It sat **inside `if (!already.length)`** — the branch that runs only on an *unseeded* database,
   which is the one case where it is not needed. On the already-seeded demo it was dead code.
   Hoisted out; it now runs every time, and running it twice changes nothing (verified: the dry run
   immediately after `--apply` said *"would add 0"*).

---

## 3. Proofs (all from a live workspace)

### `scripts/class_check.py` — 55/55

| proof | result |
|---|---|
| Everyone's here | `marked=2` |
| done ×2 | `completed=2, attended=2` |
| utilisation | **60 min for a 60-minute class with two places done** — counted once |
| undo | back to `confirmed` |
| no-show | 1 |
| a stranger's booking id | **404** *"That booking is not a place in this class."* |
| seat cancelled | `offered=0`, `classSeat: true` |
| desk offer for that hour | **409** *"That is a place in a class, not a slot…"* |
| class-hour entry on the manual screen | **409** *"A class is on at that time…"* |
| marking a cancelled session | **409** *"That class was called off — its places are gone, so there is no register to mark."* |

### `scripts/class-ui-pass.mjs` — 18/18

The walk **stages its own class every run** and tears it down in a `finally`. It used to borrow any
upcoming session, and once the register controls existed that meant it marked the *demo's* real
clients arrived and done. That is fixed at the source: a walk must never grade on the workspace's
own fixtures.

It proves: the desk page titled with `2/8`; the roster opening; **"0 of 2 here"** → Everyone's here
→ **"2 of 2 here"** → Done → *"2 of 2 here · 1 done"*; the grid block `11am class 2/8`;
the public page offering *"6 places left"*; a stranger booking a place and getting the receipt
*"Place booked · … · Tuesday 20 October at 11:00am"*; and both pages console-clean.

### `scripts/demo_check.py` — 38/38

`today's diary has a day in it — 6 visit(s) on 2026-10-17`, plus its new attendance assertion: the
demo class's `attendance` agrees with what the public list says it has left.

---

## 4. Three gate defects found while verifying — and fixed

A bundle is not done when its own gate is green; the *suite* has to be green on the new build, and
three things were in the way. Each was a fault in a check, not in the product.

1. **`carrier_check` could not repair its own precondition.** It released a leftover adopted
   number only `if existing.get("carrierId")` — but the tidy strips a dangling `carrierId`, so the
   number stayed attached and adoption answered **409 "already attached to this workspace"**. Eleven
   checks failed. The guard now keys on the number itself, and all 49 pass.
   (`scripts/carrier_check.py`, the comment there records why.)
2. **The day walk assumed the day.** It asserted that *today* held appointments, which was true the
   day it was written and false on the first Saturday it ran — Priya's rota has no Saturday, so her
   day was correctly empty and the walk called three green behaviours red. It now reads the rota
   first, says so when today is a day off (`not on the rota`), widens the window, and judges the day
   that has a diary — from data, not from a fixture. **38 → 41 checks**, and it is now true on every
   day of the week. (The day strip is `hidden sm:flex` below 640 px, so the walk does not tap it: on
   a phone those days are not controls a person has.)
3. **The seeder's top-up was dead code** (above).

Because two gates take shorter idempotent branches when a previous run left a workspace or a locum
behind, the suite total moves by state: `onboard_check` 41 on the returning-workspace path and 49
fresh, `practice_team_check` 66 when the locum already exists and 68 when it does not. The number
below is the **full-path** run, taken after a sweep.

---

## 5. Final verification

| | result |
|---|---|
| Build | `iLW1yFuTOuddL8JtnxmMJ` — `rm -rf .next && npx next build`, 582/582 |
| `python3 scripts/check.py` | **33 gates, 1382 checks, 0 failed** (`/tmp/check-final.txt`) |
| `npm run check:browser` | **120 checks, 0 failed** — 48 console · 41 day · 13 calendar · 18 classes |
| `npm run check:offline` | 8 checks, 0 failed (app stopped) |
| `python3 scripts/demo_check.py` | 38/38 — today has 6 visits |
| `python3 scripts/class_check.py` | 55/55 |
| `tidy-probe-orgs.ts` | first sweep removes what the gates wrote; second says *"nothing to do"* |
| `tsc --noEmit` | 0 |

**The workspace after the sweep:** orgs `['Voxera demo line', 'Northwind Labs']`; class sessions
`ses_1d4217d92ce08506` (8 seats, 3 taken) and `ses_3c3dccbe8f49c1db` (6 seats, 2 taken), both
`scheduled`; one `Group session` service; 5 seats, every one `confirmed` with a client that
resolves.

*One detail worth naming:* one of the seeded places belongs to a client recorded as **"Caller"** —
an anonymous inbound caller from the demo month, seated by the seeder from the practice's own client
list. That is what a practice's list actually looks like, so it stays.

---

## 6. Files

**Product:** `lib/server/classes.ts` (`attendanceFor`, `sessionOverlapping`) ·
`app/api/v1/classes/[id]/route.ts` (`attendance` on GET; `mark-seat`, `everyone-arrived`) ·
`lib/server/wait-offers.ts` (`classSeat` guard) · `app/api/v1/bookings/[id]/status/route.ts` ·
`app/api/v1/wait-list/offers/route.ts` · `app/dashboard/classes/page.tsx` (the register) ·
`lib/server/reports.ts` (`heldMinutes`) · `lib/server/day.ts` (seats out of `bookedMinutes`).

**Docs:** `lib/docs-content/guides-classes.ts` (new section + five blocks, gate count corrected) ·
`README.md` (walk line: 41 day · 18 classes) · `CAPABILITIES.md` (the register, in the classes
capability) · `PRACTICE.md` §11 (per-seat attendance shipped; wait-list and packs named as *not
authorised*).

**Checks:** `scripts/class_check.py` (55) · `scripts/class-ui-pass.mjs` (18) ·
`scripts/demo_check.py` (attendance assertion) · `scripts/seed-demo-diary.ts` (phase 2b) ·
`scripts/carrier_check.py` (precondition) · `scripts/day-ui-pass.mjs` (rota-aware).

**Report:** this file.

---

## 7. What is deliberately *not* built

Neither was authorised, and each needs its own design before code:

1. **The class wait-list** — a place given back handing on to a waiting person. This bundle's guard
   is the groundwork (the product now knows a place is not a slot); the *policy* — order, expiry,
   how many offers, what happens when the session is called off — is a design question, not a
   patch.
2. **Class packs** — last, and money design comes first: a pack is a prepayment that has to survive
   a cancellation, a refund and a no-show without inventing a balance nobody can reconcile.

The register was the right first step because it made the class feature *operable* — a desk can now
run the class it sold, and the product can no longer sell the same hour twice in two different
directions.
