# A8 — group appointments / classes: the plan

**What the audit asked for:** the one Cliniko scheduling feature with no equivalent here —
groups/classes, where one slot holds several clients. "Availability engine already models
rooms and capacity."

**What I found:** it models *rooms*, not capacity. `BookingDoc` is one client, one
practitioner, one room, one time; `availability.isFree` treats any overlapping booking as a
clash, so a second person in the same room is refused by design.

## The shape I am building

Keep one booking per person — every existing machine (reminders, confirmations, the manage
link, money, records, the client timeline, privacy) then works untouched — and add the two
things that make a class a class:

- **`ServiceDoc.capacity`** — how many people one appointment of this type may hold.
  Unset/1 = one-to-one. ≥2 = a class. The catalogue owns the fact.
- **`classSessions`** — a scheduled occurrence: instructor, site, room, start, length,
  capacity, status. Created from the desk, repeatable weekly.
- **A seat** = a normal booking carrying `sessionId`. It is not itself a busy block: *the
  session* is. That one rule is what lets eight people share a room without eight clashes —
  and what makes the class genuinely block the diary against everything else.

## What that buys, and where it shows

| surface | behaviour |
|---|---|
| availability / clash checking | a session blocks its instructor **and** its room for its length; seat bookings do not double-block; a one-to-one booking can no longer be dropped into a running class |
| public booking page | upcoming sessions with **seats left**; joining asks name + number only; the full session refuses with the capacity named; joining twice is idempotent, not a second seat |
| the diary | one block per session (`3/8`), not eight overlapping ones; seats are the roster, not appointments |
| the desk board | the day's classes as rows with their count, alongside the appointments |
| desk page `/dashboard/classes` | create (and repeat weekly), list by site and date, the roster, add somebody from the desk, take a seat back, cancel the whole session |
| the client's own link | a seat can be **given up** from their link even inside the change cutoff (a freed seat is worth more than a rule), and **rescheduling is refused with a reason** — you cannot move one person out of a class into a private slot |
| everything else | untouched: a seat is a booking, so reminders, receipts, the money loop, the timeline and the audit trail all already apply |

## Explicitly not in this build

- Wait-list offers for a full class (the wait list is per-slot today; a full class is a
  different trigger and deserves its own design).
- Attendance-per-seat on the board beyond `arrived` (that is the existing status flow).
- Class packs / memberships (money, not scheduling).

## Done when

`scripts/class_check.py` is green and registered (`check.py` → 33 gates), the full suite is
still green, and the tidy sweeps the probe session, service, seats and clients.
