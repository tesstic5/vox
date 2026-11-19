# Demo coherence, two honest proofs, and the walks in one command

**Status:** built and verified. **33 gates, 1364 checks, 0 failed** (up from 1359);
**all four browser walks green in one command — 115 checks** (`npm run check:browser`);
offline gate green; `tsc` clean; build `VntkH_HR7KDhn1cPoT2iP` (582/582) running on
`:3000` against a tidied demo. Timestamps in the repo are UTC; this is dated in your
local day.

This bundle was chosen from the "what's next" list: the demo did not show the newest
feature in the product, one proof in the classes gate was passing without testing
anything, and the four browser passes could only be run one at a time by somebody who
remembered the incantation. Two of those turned out to hide real defects.

---

## 1 · The demo runs classes now — and the demo's numbers were wrong about them

The demo workspace had **zero class sessions**, and `scripts/seed-demo-diary.ts` created
none: a visitor to `/book/northwind-labs` saw no class card, the desk's class list was
empty, and the board had nothing to show. The newest thing the product does was invisible
in the workspace built to show what the product does. Worse, when I started, the reports
counted a class as **one appointment per seat** — a four-place hour would have entered the
day view and the utilisation report as four hours of one practitioner's day.

### The defect, named

| Where | What it did |
|---|---|
| `lib/server/day.ts` — `dayBookings` (:436) → `bookedMinutes` (:579) | Summed every row's minutes, and a class seat is a row: three seats in a one-hour class read as three hours |
| `lib/server/reports.ts` — `utilisationReport` (:369–371), `appointments`, `busyDays` | Same sum, per practitioner, over the report window. One class could push a practitioner past 100% utilisation |
| `lib/server/classes.ts` — `joinClassSession` | Built the seat's external reference from `Date.now()`. Two seats taken in the same millisecond produced the **same reference**, and `upsertBooking` merges on the reference — so two people silently became one booking |

The first two were found by reading the code before seeding (the seeder would have
exposed them the moment classes existed). The third was found by *seeding*: the seeder
counted five seats and the database held four.

### The fix, in the product's own words

> A class is **one hour** of the practitioner's diary, however many people are in it.
> Seats are people; the session is the time.

- `day.ts` excludes seats from `bookedMinutes` and reports classes and seats separately
  (`counts.classes` / `counts.seats`), where they already were. The rows stay: a
  practitioner wants to see who is coming.
- `reports.ts` collapses a session's seats into the session's own length, counted once —
  for booked, attended and cancelled minutes — and refuses to count a cancelled session's
  hour at all. It reads `booking.sessionId` and the session file directly rather than
  importing `classes.ts`, because that import would close a cycle (`classes` checks its
  hours through `availability`, which `reports` already depends on).
- `classes.ts` gives each seat a unique reference (`…-MVBHOR4Z-A1B2`), with the reason in
  the code, because the merge rule makes a colliding reference a data-loss bug.

### The seed

`scripts/seed-demo-diary.ts` gained a third step that lays down **the classes the practice
runs**, and it goes through the product's own doors rather than around them:

- the class service is created with `createService` (Northwind is a services company —
  it had no class in its catalogue), the instructor is linked with `updateProvider`, and
  `createClassSession` then sets the service's capacity, exactly as the product does when
  a session is first scheduled;
- the session's time is checked against the instructor's rota with `windowsForDate` before
  it is created, and the engine's `isFree` decides the room — so a seeded class can never
  sit on a real appointment;
- seats are taken with `joinClassSession`, which means the people in the demo's classes are
  the demo's own clients, with ordinary bookings behind them — confirmations, records,
  money and the client's own link treat them like any other visit;
- it is idempotent like the rest of the script (it refuses when sessions already exist),
  and it **verifies itself**: seats counted while writing are compared with seat rows
  afterwards, and a mismatch exits non-zero. That check is what made the reference bug
  visible rather than silent.

What it wrote, verbatim from the apply:

```
  3 practitioner(s), 8 service(s), 82 client(s), USD
  class skipped at Northwind East — New York on 2026-10-18: not working on 2026-10-18 at Northwind East — New York
  class skipped at Northwind East — New York on 2026-10-21: that time is taken
  class skipped at Northwind HQ — San Francisco on 2026-10-18: not working on 2026-10-18 at Northwind HQ — San Francisco
  class skipped at Northwind HQ — San Francisco on 2026-10-24: not working on 2026-10-24 at Northwind HQ — San Francisco
  put on 2 class session(s) with 5 seat(s) taken
```

Two sessions landed — Wednesday 4:00pm at San Francisco with Dana Whitfield (8 seats,
3 taken), Saturday 10:30am at New York with Marcus Ito (6 seats, 2 taken), both with a
room. The skips are the product refusing what it should: a Sunday, a Saturday nobody
works, and an hour already booked. A demo that lied about its rota to fill a grid would be
the same dishonesty this seeder was written to fix.

### What the demo gate now asserts

`scripts/demo_check.py` gained a class section (**37 checks**, was 33) — the practice runs
classes, people are in them, every session names an instructor, a site and a room, the
public page sells the places with the count and no roster, and the day view's arithmetic
agrees. The last one is the interesting one, because it is asserted as an **equality on a
day that really holds a class**:

```
PASS  a class day is on the practitioner's day view at all  — checked 2 class day(s)
PASS  a class seat is not counted as an hour of the practitioner's day  —
      2026-10-21 Northwind HQ — San Francisco: 3 seat(s), 90 booked minute(s),
      2026-10-24 Northwind East — New York: 2 seat(s), 60 booked minute(s)
```

Ninety booked minutes for a day holding a three-seat class is the fix, stated as a number:
the class is 60 of them, and the seats are not the other 180.

## 2 · The vacuous proof was vacuous for a reason nobody had noticed

The audit's last weak spot: *"the slot search does not offer the hour the class is in"*
passed without testing anything, because the query it used returned no slots at all. The
note in the audit blamed the class being unsellable by time.

**It was the gate reading the wrong field.** `/api/v1/availability` answers with its slots
under `data` — like every other list in this API — and the check read `slots`. It returned
empty every time, for every query, by construction. The proof was not weak because the
product was hard to test; it was weak because the test was looking at nothing, and the
"0 slots" observation had been recorded as a product fact.

The fix is a **control**: the same day is asked about twice, once for the class service and
once for an ordinary one-to-one service the instructor really runs. The control must offer
that day — which is what proves the search was looking — and the class hour must be missing
from those slots, whether or not it was absent from the whole list:

```
PASS  the same day is offered for an ordinary service — so the search was looking
      — 7 slot(s) on 2026-10-22 from {'days': 1, 'providers': 1, 'dateFrom': '2026-10-22',
        'dateTo': '2026-10-22'} scanned; no reason given
PASS  and the class hour is missing from them, not merely absent from the whole day
      — 7 slot(s), none overlapping 10:00am–11:00am
```

Seven slots on the day, none of them in the class's hour. The classes gate is now
**41 checks**, and it says why in the code so the next reader does not have to rediscover
the field name.

## 3 · The browser walks are one command

Four passes existed, each with its own env and its own verdict, which is how a pass rots.
`npm run check:browser` runs them in order, streams their output, and prints one table:

```
── summary
   ✔ 48 passed                  console — every dashboard page renders without an error
   ✔ 39 passed                  day — the practitioner's day, on a phone and a desk
   ✔ 13 passed                  calendar — the diary drags what it drew
   ✔ 15 passed                  classes — classes, from the desk and from the public page

all 4 walk(s) green — 115 check(s) passed, 0 failed.
```

They stay **out of `scripts/check.py`** on purpose — they need Playwright, a browser and a
live workspace, and the suite must stay runnable without any of that. `--only classes` runs
one. The re-run on this build exercised the demo's own class: the diary drew it once as a
dashed block reading `7pm class 3/8 Group session` — 7pm because the diary's default view
is on one clock (New York) and the class is at 4pm San Francisco, which is the clock rule
D1 fixed, visible on screen.

Two pieces of debris the walks and gates produce are worth stating plainly, because both
are handled rather than hidden: the classes walk **took a place in the demo's class as a
stranger** (that is the check — a real booking under the name `Probe Class Browser`), and
the classes gate leaves a cancelled session whose service it deleted. The tidy sweeps both:
the apply after the walks removed `1 class session(s) (1 orphaned)` and 4 probe seats, and
took the demo's classes back to their seeded **3 and 2** seats. The next dry run reported
**"nothing to do"** — which is the point: the demo ends where it started, with five people
in two classes that a real practice put on.

## 4 · One gate fix, and one not-a-defect worth recording

**`onboard_check` was failing on its own timeout, not on the product.** Provisioning a
brand-new workspace seeds a whole demo workspace — three assistants, template sets, a
carrier pair, 168 calls with transcripts. On this box that measured **68.5s** and **72.4s**
on two fresh workspaces, against a 60s timeout. Reading the code first: `lib/server/bootstrap.ts`
does not import `reports.ts` or `day.ts` at all, so nothing in this bundle caused it — it is
inherent provisioning cost and the timeout was simply marginal. The gate now gives that one
call room to finish (240s) and says why; every other call keeps 60s. A crash mid-provision
also used to poison the *next* run (the fixed probe account sat at 1/4 of its checklist),
which is why this bundle's verification included a tidy between runs — that is the existing
documented interplay, not a new one.

## 5 · State of the workspace

| | |
|---|---|
| Build | `VntkH_HR7KDhn1cPoT2iP`, 582/582 pages (`/tmp/build-coh2.log`) |
| App | running on `:3000`, stubs on `:4010` / `:4020` |
| Suite | `python3 scripts/check.py` → **33 gates, 1364 checks, 0 failed** (`/tmp/check-coh2.txt`) |
| Browser | `npm run check:browser` → **115 checks, 0 failed** (48 + 39 + 13 + 15) |
| Offline | `npm run check:offline` → 8 checks, 0 failed |
| Types | `npx tsc --noEmit` clean |
| Database | tidied four times (each dry run before an apply); the final dry run reports **"nothing to do"**; two workspaces; **2 class sessions, 5 seats, 0 orphan sessions, 0 dangling references** |
| Backups | `…before-tidy-2026-10-16T21-44-56-609Z.json`, `…21-49-30-237Z.json`, `…22-03-25-993Z.json`, `…22-04-26-641Z.json` |

To reproduce, in order: app up → `python3 scripts/check.py` · `npm run check:browser` (needs
`npx playwright install chromium && npx playwright install-deps chromium` once) → app
stopped → `node --import tsx scripts/tidy-probe-orgs.ts --apply` → `npm run check:offline`.
The seeder's own order is: app **stopped** → `npx tsx scripts/seed-demo-diary.ts` (dry) →
`--apply`.

## 6 · What is still open

Nothing from the audit, and nothing in this bundle. What remains are the three product
choices that were deliberately left as choices: a **class wait-list** (a full class offering
the place somebody gives back), **class packs / memberships** (money, so a bigger design),
and **per-seat attendance** beyond the ordinary statuses. The demo now makes all three
visible as absences rather than invisible features: the class exists, fills, and is sold —
it simply does not yet have a queue, a price bundle, or a register.
