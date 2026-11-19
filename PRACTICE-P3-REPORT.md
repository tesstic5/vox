# Voxera practice management — Phase 3 build report

**Online booking.** Built 2026-10-12, verified against a production build
(566/566 prerendered pages) with the app running on `:3000`.

The phase gate from `PRACTICE.md` §11, L83:

> A stranger books end-to-end and it appears on the diary, with the term pack applied.

Checked by `scripts/booking_check.py` — which *is* a stranger: no session, no API
key, no header of its own.

---

## 1. What landed

### The booking page

| Piece | Where | Behaviour |
|---|---|---|
| The page | `app/book/[slug]/page.tsx` | One URL per workspace, the practice's name in the tab, `noindex`, "Powered by Voxera" in the footer |
| Four steps, one screen | `app/book/[slug]/BookingPage.tsx` | Service → time → details → booked. The steps are visible from the start; nothing is confirmed until the last one |
| Free times | `GET /api/public/workspaces/{slug}/availability` | The same engine the phone agent and the calendar use, grouped by local day, rate-limited |
| Book | `POST /api/public/workspaces/{slug}/booking` | Creates the appointment, the client record and the confirmation |
| Add to calendar | `GET /api/public/bookings/{id}/appointment.ics` | RFC 5545, folded, CRLF, UTC `DTSTART`, `STATUS:CANCELLED` when the appointment is called off |
| The link and the switches | `/dashboard/practice` → **Online booking** tab | Copy the link, open it, turn the page on or off, choose whether visitors pick a person, cap bookings per number, watch the message queue |

### What a stranger can and cannot see

The page API returns services, providers, sites, policy and **free** time — never
a client, a client's number, another appointment, or which slots are *taken*.
"10:20 is busy" is a fact about somebody else, and a booking page has no business
telling the next visitor. The gate asserts this by name.

### Confirmations and reminders

`lib/server/messages.ts` is a real queue, not a promise:

- A confirmation is a **row** with the consent it relied on, the address it went
  to, and — once it goes — the moment and the driver. The agent's
  `send_confirmation` writes one; so does the booking page.
- **Consent is checked twice**: when the row is made, and again at send time.
- A reminder is queued at T-minus 24h (`VOXERA_REMINDER_LEAD_MINUTES`), once per
  appointment — the appointment id is the idempotency key — and **cancelling the
  appointment cancels the reminder**.
- Delivery is a driver. This build ships `log`, which records the send honestly
  without pretending a carrier did it. A row says *why* it did not go, so the desk
  can answer "did they get the text?" without guessing.
- The sweep (`server.ts` → `startMaintenance`) queues and sends on a 15-minute
  timer; `POST /v1/messages {action:'deliver'}` runs it now.

### The agent got better too

`check_availability` with **no day named** used to resolve to "tomorrow" — so
"do you have anything this week?" got a wrong answer. It now scans two weeks and
answers with the day attached: *"Thursday 1:00pm, Friday 9:15am…"*, one opening
per day.

---

## 2. Verification

Production build, app on `:3000`, AI stub `:4020`, Twilio stub `:4010`.

| Gate | Result | Headline reading |
|---|---|---|
| `scripts/booking_check.py` (new, P3) | **39 checks ALL PASS** | stranger books with no credentials → `201`, lands on the diary as `Priya Raman` at `Northwind East — New York`; same slot again → `409`; `.ics` `DTSTART:20261012T210000Z`; queue delivers `1 sent, 0 blocked`; reminder rule `queued 1`, second run `queued 0` |
| `scripts/client_check.py` (P2) | 43 checks ALL PASS | unchanged behaviour, plus the route scan now proves 42 paths the practice screens call all exist |
| `scripts/privacy_check.ts` (P2) | 22 checks ALL PASS | 258 bundles, 86 runtime-only fingerprints, none found |
| `scripts/practice_check.py` (P1) | 41 checks ALL PASS | the agent still answers from the diary |
| `scripts/api_check.py` | ALL PASS | after fixing the check itself (defect 8) |
| `scripts/book_check.py` | ALL PASS | campaign calls, sync, outcomes |
| `scripts/smoke.py` | ALL PASS | |
| `scripts/nesting-check.py` | 516 pages clean | |
| `scripts/linkcheck.py` | 516 routes, 0 unresolvable | after teaching it the booking page is rendered per request |
| `scripts/sitemap-check.py` | 471 entries, every indexable route listed | booking pages excluded on purpose: `noindex`, and the slug belongs to the customer |
| `npx tsc --noEmit` | clean after every edit | |

Verified by hand as well as by script: the public page's HTML carries the
workspace name, `noindex` and the footer, and **no phone number anywhere**; a
cancelled appointment's `.ics` says `STATUS:CANCELLED` so a calendar that already
holds the event updates it rather than keeping a ghost.

---

## 3. Defects found while building P3, and fixed

1. **A blank consent box silently revoked consent.** The form wrote
   `granted: false` for every unticked channel — so somebody who agreed to texts
   on the phone last week, then booked online without ticking the box, was marked
   "opted out" on their record, and the reminder they were expecting never went.
   A tick now records permission; a blank box on a **new** record records a denial
   (so the queue can say why), and on an **existing** record records nothing.
2. **A switched-off booking page answered `400`, not `403`.** `PublicBookingResult`
   carried its own `status` that the route ignored, because `fail()` maps the
   *code* to a status. The two disagreed, and one of them was wrong. The result
   now carries only a code, and the route is the single place the status is decided.
3. **`send_confirmation` claimed a text that nothing carried.** The agent said
   "I've sent that" and no row existed. It now queues a real message and reports
   the row's actual status.
4. **A client record could not say which door it came through.** Bookings made
   online and by phone both produced `source: 'booking'`. The record now records
   `online`, `import` or `booking` to match the appointment.
5. **The tidy sweep missed its own scripts' debris.** `booking_check` creates
   records to book on behalf of; they were not caught by the `Probe` name rule.
   Names now follow one convention and the sweep covers them — and a dry run no
   longer says "removed" for work it has not done.
6. **`api_check`'s filter check was comparing unlike things** — a whole-set filter
   result against how often a value appeared on the *first page*. It passed by luck
   and failed once the call mix changed. Now: filter total vs full total.
7. **Two leftover probe appointments were holding real slots** (from runs made
   before defect 5). Cancelled and archived through the server modules, so the
   audit trail records the cleanup as itself.
8. **P2 deferral closed:** *privacy mode* was in the P2 spec and had not been built.
   The calendar now has a **Names / Private** toggle that masks clients to initials
   on the grid and the wait list. It is stored as a *preference* — a whitelisted,
   scalar-only key in `lib/prefs.ts`, never a record — and `privacy_check.ts` holds
   that line rather than leaving it to judgement.

---

## 4. API added in P3

```
GET    /public/workspaces/{slug}/booking          services, providers, sites, policy (no auth)
GET    /public/workspaces/{slug}/availability     free time by day, rate limited (no auth)
POST   /public/workspaces/{slug}/booking          the booking itself (no auth)
GET    /public/bookings/{id}/appointment.ics      calendar file (no auth)
GET    /v1/messages?status=&bookingId=&clientId=  what has been sent, with a tally
POST   /v1/messages                               action: send | deliver | queue-reminders
DELETE /v1/messages?id=                           cancel a queued message
GET    /v1/booking-page                           the link, the switches, the queue
PATCH  /v1/booking-page                           change them
```

Docs: `lib/docs-content/api-booking.ts` → **/docs/api/booking** (page, availability,
booking, `.ics`, messages, settings, rate limits).

---

## 5. Deliberately not done in P3

- **A real carrier driver.** The queue's default records the send. Wiring Twilio's
  messaging API needs a messaging-enabled number and the provider work already
  deferred in P1; the row format is ready for it.
- **Email delivery.** The `email` channel is modelled, consent and all — there is
  no SMTP driver, and inventing one that says "sent" without a recipient server
  would be the same lie defect 3 was.
- **Templates per workspace.** Message bodies are composed from the term pack, which
  is what keeps "your job is Monday" correct for a services firm and "your
  appointment is Monday" correct for a clinic. Per-practice wording is P4.
- **Deposits and payments at booking.** That is P6, and the booking page will take
  a payment link when it exists.

---

## 6. State after P3

- **App:** `npx tsx server.ts` on `:3000` (production build, 566/566 pages), AI stub
  `:4020`, Twilio stub `:4010` — restarted after the sweep and re-verified
  (`booking_check` 39, `practice_check` 41, `privacy_check` 22, `api_check` ALL PASS).
- **Database:** 2 workspaces, 29 appointments (4 of them booked through the public
  page and since cancelled by the checks), 32 client records (4 archived probes with
  retention dates rather than deleted), 548 call rows, 14 messages (8 sent, 2 blocked,
  2 cancelled, 2 pending), 3 numbers. `tidy-probe-orgs.ts` re-run reports *nothing to
  do*. 14 backups in `data/backups/`.
- **Booking links live now:** `/book/northwind-labs` and `/book/voxera-demo`.
- **New scripts:** `booking_check.py` (39 checks). `api_check.py` corrected.

## 7. Next — P4, messaging & reminders

The queue exists; P4 is what makes it a system: per-workspace templates, the
no-show follow-up and the "we missed you" cadence, campaigns that SMS *and* call
against the same rules engine, an inbox view of what went out, and a carrier driver
so `provider` stops saying `log`. Same rhythm: build → verify → report → review.
