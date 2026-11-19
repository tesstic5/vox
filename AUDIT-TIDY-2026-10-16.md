# The carried-over tidy — four items, a walk, and the two defects the walk found

**Status:** built, gated, verified in a browser. **32 gates, 1319 checks, 0 failed**;
three browser passes green (**47/47** console sweep · **39/39** day-view pass ·
**13/13** the new D1 drag walk); offline gate green; `tsc` clean; build
`u9TVx6h3VHw5z_sptGGUC` (580/580), running on `:3000` against the tidied demo.

This was the "next tidy" read-out, taken as a go-ahead: the four small items carried
from earlier stages, plus the D1 browser walk. Two of the four turned out to be
*already built and never proved*, one was a live defect nobody had noticed, and the
walk found two more.

---

## 1 · `days:1` returning two rows — not a quirk

The note was wrong, and the code says so plainly: a row is a **practitioner's day at
a site**, and `lib/server/day.ts` builds one per (practitioner × site). Marcus Ito
works at both Northwind sites, so `days=1&providerId=prv_99d18356bbbc56a0` is two
rows on the same date — different hours, and *different clocks* (New York and San
Francisco are three hours apart). The page already keys and heads them by site.

So nothing was broken; the behaviour was simply undocumented and unproved. It is
now a contract in `day_check.py`:

```
PASS  somebody who works at two sites has a row for each of them  — Marcus Ito: 2 row(s) for 2 site(s)
PASS  no site appears twice, and every row carries the site's own clock  — Northwind East — New York=America/New_York, Northwind HQ — San Francisco=America/Los_Angeles
PASS  and the totals count the days, not the dates  — days=2
```

## 2 · The desk `send` with the rule off — by design, now gated

Read, then driven. The recall/overdue switches govern the **automation**; a person
pressing send is not the automation. With `recall.enabled` false, a manual send is
accepted and queued (`201 {status: pending}`), filed as `kind: manual` with
`source: desk:desk@northwind.dev`, and the automated loop stays quiet in the same
state (proved next door: *"the loop ships switched off"* / *"and the job says so
rather than sending"*). Both halves are now pinned in `messaging_check.py`.

**A finding hiding behind it:** the demo workspace has no connected carrier — by
design, so the connect-a-carrier journey is real. The consequence is that nothing
can actually leave, and the queue says so honestly: *"No carrier connected — connect
one at Dashboard → Carriers to send texts."*

## 3 · `templates?kind=recall` — worse than the note said

The stale note said it returns `[]`. It did something worse: **the filter was
accepted and ignored**, so a caller asking for the recall wording got all 16
templates back with no way to tell. Now `?kind=` and `?channel=` narrow the list,
and an unknown value is refused with the list of real ones rather than ignored:

```
PASS  ?kind=recall answers with the recall wording and nothing else  — 2 of 16 row(s), kinds=['recall']
PASS  and ?channel=sms narrows it again, without contradicting it  — 1 row(s)
PASS  a kind that does not exist is refused rather than ignored  — 400 … No template kind called recallz.
```

## 4 · The Replies tab — built, and never once acted on

The tab existed, called a real endpoint, and was wired end to end. What was missing
was *proof that the button does anything*: every gate checked that a reply
**arrives**, none checked that the desk can **tick it off**. Worse, the demo's queue
was full of junk — **12 replies from an interrupted `recall_check` run on 15
October**, each one attributed to a probe client, waiting for a person who was
never going to answer.

Three things came out of it:

- **The action is now proved**, from the desk's own login, in `recall_check.py` §5:
  `resolve` → 200 `{resolved: …}` → gone from the queue; a second press is
  harmless (200, idempotent); a reply that never existed is a **404**, not a silent
  success; and an anonymous caller gets **401**.
- **The gate's pre-flight now clears a crashed run's replies** — it can archive a
  probe client but the outreach row survives, so the row is ticked off instead
  (`ticked off 12 reply(ies) left waiting by an earlier run`).
- **The tidy learned the legacy probe name.** `recall_check.py`'s own pattern
  documents `Recall\d{6}` as what an interrupted old run leaves behind, and the
  tidy did not know it — which is why twelve dead fixtures sat on a screen for a
  day. It also now **detaches a number whose `carrierId` names a carrier that is not
  in the file** — the state `carrier_check` leaves when a run dies between deleting
  the carrier and releasing its number, and which reads as "connected" to one half
  of the product and "not connected" to the other.

---

## 5 · D1, walked in a browser — and it was still broken

D1 ("the diary is on a UTC clock — dragging moves appointments 4–7 hours") was fixed
on 15 October and proved twice: through the API, and against the built HTML. The fix
note admitted the gap: *"D1 has not been walked in a real browser."* The walk needed
a driver that speaks the **HTML5 drag protocol** (Playwright's `dragTo`, not raw
mouse events — a raw sequence silently does nothing, which cost an hour), and it
found:

**The clock is right.** Default all-sites view: `timezone=America/New_York`, and a
2pm appointment is drawn on the 2pm line (648px, exact). Dragging an hour down
lands on `19:00Z` — the correct New York instant, *not* `14:00Z` (the old UTC bug)
and *not* `23:00Z` (the timezone applied twice). Dropped on tomorrow's column, the
day moves and the clock is kept.

**Two defects the API could not see:**

1. **A drop landed on nothing.** The only `onDrop` was on the appointment block
   itself, so releasing anywhere else — which is everywhere a person actually drops
   something — hit no handler and the appointment did not move. The **column** now
   owns the drop: it highlights while a drag is in flight, snaps to the practice's
   own `slotStepMinutes`, clamps to the grid, and does nothing when you drop a block
   back where it started.
2. **The resize grip could not resize.** The handle lived inside a `draggable`
   block, so a press-and-pull started a *drag* — the appointment moved instead of
   lengthening. `preventDefault()` on the handle's `mousedown` hands the gesture to
   the handler; the walk now pulls 20 minutes onto a 30-minute appointment and reads
   `30 → 50 minutes` back from the API.

`scripts/calendar-drag-pass.mjs` is the standing pass: **13 checks**, its own
fixtures (a probe room/service/client/appointment, all removed at the end, the
client archived), a pre-flight that clears anything an earlier run left in the probe
room — and it treats a **409 from a refused move as the product working**, not as
console noise, while everything else on the page has to stay silent.

---

## Evidence

| what | result |
|---|---|
| full suite | **32 gates · 1319 checks · 0 failed** (`CHECK-RUN-2026-10-16-TIDY.txt`) |
| `day_check.py` | 59 → **62** (the two-site contract) |
| `messaging_check.py` | 77 → **87** (kind/channel filter, the desk's send with the rule off) |
| `recall_check.py` | 62 → **67** (the tick-off, idempotence, 404, 401 — and a pre-flight that clears a crashed run's replies) |
| `mirror_check.py` | 31 (one fewer than 32: `invoices` deliberately left the mirror list in the previous bundle) |
| D1 browser walk | **13/13** · `screenshots/d1-calendar-drag.png` · `screenshots/d1-calendar-browser-pass.json` |
| console sweep | **47/47** dashboard routes clean |
| day-view pass | **39/39** |
| offline gate | 1 gate · 8 checks · 0 failed |
| `npx tsc --noEmit` | clean, unpiped |
| tidy | three workspaces removed, 222 probe clients, 36 abandoned calls, one number detached from a phantom carrier; demo left at 81 clients / 310 bookings / 393 invoices / 3 numbers / no carrier, `recall` off, **Replies queue: 0 waiting** |

## What I checked and found fine

- The **two-site rows** were correct all along (hours, clocks, `totals.days`), and
  the diary's default clock was already the practice's after the D1 fix.
- The **Replies tab** was fully wired; only its proof and its housekeeping were
  missing.
- The **`?kind=`/`?channel=validation`** path does not disturb the unfiltered list,
  the retired/restore flow, or the reset action (all still green in the same gate).
- The **drag change** does not double-fire: dropping a block onto another block
  bubbles to the column once, and the pass re-ran clean after the change.
- **`carrier_check`** is right to delete every carrier row: the demo is meant to
  ship unconnected, and the gates that need a carrier borrow the stub and hand it
  back.

## Left open

**A4** (unbuilt) and **A8** (unauthorised) — unchanged, and the only two items left.
Everything else in the audit is closed.

## Files

**New** — `scripts/calendar-drag-pass.mjs` · `CHECK-RUN-2026-10-16-TIDY.txt`
· `screenshots/d1-calendar-drag.png` · `screenshots/d1-calendar-browser-pass.json`.

**Changed** — `app/api/v1/templates/route.ts` (kind/channel honoured and validated)
· `app/dashboard/calendar/page.tsx` (the column is the drop target; the grip
suppresses the native drag; one `moveTo` for every way of moving) ·
`scripts/{day_check,messaging_check,recall_check,tidy-probe-orgs}.py|ts` ·
`README.md` (the new pass, next to the other two).
