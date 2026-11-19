# The line for a place — a full class, and the person behind it

**Date:** 2026-10-17
**Authorisation:** "okay plan that and work on it to make it work properly" — the plan *and* the build,
end to end, in one move.
**Status:** built, verified, reported. **33 gates, 1402 checks, 0 failed**; four browser walks
**125 checks, 0 failed**; offline gate 8/0; the demo carries a full class with somebody in line.
**Build:** `f3GyLH8oF7gMfWN2KGYd9`, tsc 0.

---

## 1. What this is

A class that sells out had no answer for the next person. The public page simply stopped showing it,
so the person who most wanted that class could not even ask. This bundle gives a full class a **line**,
and gives a place that comes free exactly one owner.

The whole thing rests on a distinction the product already had to make:

> **A slot is a stretch of time. A place is a seat in a particular class at a particular hour.**
> The slot wait list offers *when could I come?* — one stretch, up to five people racing for it.
> A class place has one time, one room and one instructor, so the only thing that can come free is
> **a chair**, and a chair offered to five people is four "sorry, that went" texts.

Everything below follows from that: the queue is ordered, the offer is single, and the two
machineries never touch each other.

---

## 2. What shipped

### (a) The line

| What the desk or the client wants | Route | Answer |
|---|---|---|
| Ask for a place from the public page | `POST /api/public/workspaces/{slug}/booking { sessionId, wait: true }` | `{ entryId, position, already, className, spoken }` |
| Ask for a place from the desk | `POST /api/v1/wait-list { sessionId, name, number }` | `201` with `position` (`200` + `already: true` if they are already in it) |
| Add a walk-in to the line | `POST /api/v1/classes/{id} { action: "add-waiter", name, number }` | `201` with `position` |
| Read the line | `GET /api/v1/classes/{id}` | `waitList: { count, waiting[{ position, name, number, status, offerId, offeredUntil }], openOffers, seatsLeft }` |
| Take somebody out | `DELETE /api/v1/wait-list/{entryId}` | `200` |
| **Give a place back** | `POST /api/v1/classes/{id} { action: "remove-seat", bookingId }` | the front of the line is offered the place: `offered: 1` |

The rules that make it a queue rather than a count:

- **A class with places left refuses the line** — `409`, in words: *"There are 2 places left in that
  class — take one instead of waiting for it."* A queue beside an empty chair is a queue nobody
  should join.
- **Order is first-come, first-served, and the person is told their position.** The public receipt
  says *"You are first in line for a place · Group session · Saturday 24 October at 9:00am"* — the
  class and the time, not just a thank-you.
- **One place, one offer.** A second place coming free offers the *next* person; nothing is offered
  to somebody who already has an offer standing (`queue.slice(0, spare)`, `lib/server/class-waitlist.ts:310`).
- **An offer never outlives the class** — `OFFER_TTL_MS` is four hours, capped at the start
  (`class-waitlist.ts:307`). A lapsed offer goes back in the queue while the class is still to come,
  and is `expired` once it has run.
- **A cancelled class empties its line**: offers withdrawn, entries closed, each person told once.
- **A class entry is never matched by the slot machinery.** Its window is the class's own date, so the
  slot matcher skips it, and the desk cannot hand it a private time by hand — that request is a `409`
  naming the class.
- **At most 20 in a line** (`MAX_CLASS_WAITERS`), and a class is not a way to sell a private
  appointment: every seat path still goes through `joinClassSession`, never `upsertBooking`.

The desk sees the same line on the class page: who is in it, in what order, and what is offered and
until when — so a queue being worked looks different from a queue stuck.

### (b) Its own words — the `class_offer` kind

The first cut reused the freed-slot text, which says *first to take it gets it*. That is **false for a
place**, so the message was lying in the one sentence the person actually reads.

A new kind was added end to end:

- `OutreachKind` (`lib/server/outreach.ts`) and `TemplateKind` (`lib/server/templates.ts`) gained `class_offer`;
- `defaultTemplates` gained both channels, and `seedTemplatesForOrg` back-fills them into workspaces
  that predate the change;
- `lib/server/class-waitlist.ts` renders and sends `kind: 'class_offer'` (`:361`, `:378`, `meta.kind` `:380`).

The SMS now reads:

> *Hi Devin — a place in Group session on Saturday 24 October at 9:00am has just come free. You are
> first in line. Take it here: …*

and the link opens `/offer/{token}`, a page that says **a place**, names the class, and has one
button: *Yes, take my place* — no menu of alternative times, because the thing they want is that class.

### (c) The demo carries a queue

The seeder (`scripts/seed-demo-diary.ts`, phase 3b) now stages a **full class**: capacity 2, two
seats, one person in line — through the real functions (`createClassSession` → `joinClassSession` →
`joinClassWaitList`), so the demo cannot contain a shape the product cannot make.

Two things it had to learn:

- **Idempotence, and repair.** If a future class is already full *and* has a line, nothing happens. If
  a class is full and nobody is in line — the state a demo drifts into when the last seat is taken by
  hand — it puts somebody in line rather than making a second full class.
- **A real name.** The first run queued a client literally called `Caller`. It now prefers a name with
  two parts that is not a placeholder; the demo shows **Devin Osei** in line behind a 2/2 class.

`demo_check.py` proves it from the outside: *the demo has a full class with somebody in line*
(`Group session 3:00pm 2/2 · 1 waiting`), *the line is names in an order, not a count*
(`1 in line: ['Devin Osei']`), and *a full class is offered as a queue rather than hidden*
(`full: true` on the public card). **42 checks, three of them new.**

### (d) The screens

- **Public** — the full class stays visible: *Full — join the wait list*. Joining asks for a name and a
  number; nothing is charged and nothing is booked until they take it.
- **Desk** (`/dashboard/classes`) — the queue panel: *1 in line*, the person's name, their place, and
  **Give place back** moving the place to them (`waiting → offered`).
- **The claim page** (`/offer/{token}`) — a place, the class, the time, one button.

### (e) The docs

`/docs/guides/classes` gained **“When a class is full — the line for a place”**: the place-versus-slot
callout, a table of the five operations with their bodies and answers, the public behaviour, the
`class_offer` wording, and the five rules as a list — then an honest *what is deliberately not here*
(deposits to hold a place; a queue across several sessions; class packs). `CAPABILITIES.md`,
`PRACTICE.md` §11 and the `README` were brought to the new counts.

---

## 3. Three defects found while proving it

None of these were in the plan. All three would have shipped as "working".

1. **The copy was the wrong sentence.** Offers for a place went out as `waitlist_offer` — the slot
   wording, promising a race to whoever taps first. Fixed with the `class_offer` kind above. The gate
   had been failing on it and the plan had assumed it was a test bug; reading the template showed the
   test was right.
2. **The gate compared its own names.** §8b invented a first and second name, joined twice, then looked
   for *its* names on the page. But the server reuses the client by number and keeps the name already
   on file, so the assertion could only ever pass by luck. §8b now takes each name from the join
   response and queries messages by `kind=class_offer`.
3. **The seeder cried wolf, then lost the write.** Its seat check compared *this run's* two seats
   against *every* class seat in the workspace — seven, once phase 3b added a second class — printed
   `MISMATCH: … two people may have been merged into one booking`, and `exit(1)`'d **before the flush**,
   so the demo quietly did not persist. It now counts only the sessions this run made
   (`sessionsThisRun`), and the queue is there after a re-run.

---

## 4. How it was verified

| Gate | Result |
|---|---|
| `scripts/class_check.py` | **74 checks, ALL PASS** (was 55; §8b is the new 19) |
| `scripts/demo_check.py` | **42 checks, ALL PASS** (three new) |
| `scripts/class-ui-pass.mjs` | **23 checks** — the full card, the public join and its receipt, the desk panel, *Give place back* → offered; zero console errors |
| `scripts/check.py` (33 gates) | **1402 passed, 0 failed** · linkcheck 532 routes / 0 unresolvable · nesting clean |
| walks: console · day · calendar · classes | 48 + 41 + 13 + 23 = **125, 0 failed** |
| `npm run check:offline` | 8 checks, 0 failed |
| `scripts/tidy-probe-orgs.ts --apply` | removed 15 probe clients, 21 appointments, 5 wait entries, 3 offers, 33 messages, 6 orphaned class sessions, 21 class seats — demo intact |

**A note for the next run:** the live suite's delivery and model gates (`carrier`, `messaging`,
`recall`, `ai`, `money_loop`, `booking`) fail on dead stubs, not on the code. `tsx scripts/twilio-stub.ts`
(:4010) and `tsx scripts/ai-stub.ts` (:4020) must be up before `python3 scripts/check.py`. Found the
hard way: a first pass read 6 red gates and a total of 1372 instead of 1402 purely because the stubs
were down.

Still green from the register bundle: `class_check`'s register half, `demo_check`'s attendance
assertion, `waitlist_check` 77, `room_window` 181 windows / 0 disagreements.

---

## 5. What is deliberately not here

- **Class packs and memberships** — *not authorised*. Money design comes first: a pack is a
  prepayment, a prepayment is a liability, and a liability needs the money model to say where it
  sits before a class can say what it costs.
- **Paying to wait, or a place held by a deposit** — that is money design too.
- **A queue across several sessions of the same class** ("Tuesday or Thursday") — that is a
  preference, not a queue. Two ordered lists are not one list, and choosing between them needs its
  own design: what happens when both come free?

---

## 6. State

- **Build `f3GyLH8oF7gMfWN2KGYd9`** serving on :3000, production, no source newer than the build.
- The demo's today is a **Saturday**: Marcus's day at Northwind East is open with 5 visits, Priya's
  day at the same site is not on the rota, and the workspace holds 6 live visits today — `demo_check`
  asserts the workspace total and the day walk is green on it (41/41).
- Class layer: scheduling · seats · the register · **the line** — all built and gated. **Class packs
  remain the last item, and remain unauthorised.**
