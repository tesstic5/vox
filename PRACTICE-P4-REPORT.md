# Voxera practice management — Phase 4 build report

**Messaging & reminders.** Built 2026-10-13, verified against a production build
(562 prerendered routes) with the app running on `:3000`, the AI stub on `:4020`
and the carrier stub on `:4010`.

The phase gate from `PRACTICE.md` §11, L84:

> A reminder fires at T-minus N and is logged in `outreach`; no-show rate is reportable.

Checked by `scripts/messaging_check.py` — 77 checks, both halves of the sentence,
and the machinery each half needs to be true rather than merely observed once.

---

## 1. What landed

### The queue became a system

P3 left a real queue with nowhere to go: rows were written, consent was checked,
and the send path recorded a `log` provider. P4 makes delivery real and keeps the
one property that matters — **a row is the truth, not a claim**.

| Piece | Where | Behaviour |
|---|---|---|
| Carrier driver | `lib/server/transports.ts` | SMS goes out through the workspace's own carrier (or the managed account) via the messaging API. A send that the carrier refuses comes back `failed` with the carrier's reason, never `sent` |
| Email driver | `lib/server/transports.ts` | Through a relay (`VOXERA_EMAIL_API_BASE`), so a workspace with no mail provider still sends, and a deployment can point it at a real one |
| Delivery receipts | `POST /api/telephony/twilio/message-status` + `applyDeliveryReceipt()` | `sent` means a carrier accepted it; `delivered` means a phone acknowledged it. The receipt **upgrades the one row** — it never adds a second. A receipt for a message this workspace never sent is ignored |
| Replies | `POST /api/telephony/twilio/inbound-message` | STOP (and UNSUBSCRIBE, CANCEL, END, QUIT) withdraws texting consent for that person, with the reply kept as the evidence, and refuses anything already queued for them. START/UNSTOP gives it back. Anything else is recorded and left for a human |
| Numbers wired for replies | `buyNumber` / `configureNumber` | Buying or adopting a number sets `SmsUrl` — otherwise every text promises "Reply STOP to opt out" and nothing is listening |
| Retries | `messages.ts` | `maxAttempts` with a widening gap; a failure is a row with a reason, not a lost message |

### Templates, in the practice's own words

`lib/server/templates.ts` holds six kinds — confirmation, reminder, follow-up,
no-show, win-back, recall — in both channels, seeded per workspace on first read
and editable at `/dashboard/messaging → Templates`.

- Eleven merge fields, each with a sample, rendered by `renderFor`.
- An unknown field is **left visible in the preview on purpose**: `Hi {{client_first}}`
  tells somebody what to fix; `Hi ,` does not.
- The opt-out line is appended by the sender (`withStopLine`), never part of the
  template. A customer editing their wording must not be able to remove the thing
  that makes texting people lawful.
- Retire, don't delete: a retired template keeps its wording and can be restored.

### Rules that know what time it is

Four rules, each switchable, each idempotent, only the first two on by default —
the others are marketing decisions a platform should not make on a practice's behalf.

- **Reminder** — `leadMinutes` (default 24 h) is when it arrives; `queueAhead` plus
  the lead is when it appears in the queue at all; an appointment inside
  `skipInsideMinutes` (60) is left alone. The moment is `max(now, start − lead)`,
  pushed into the next quiet-hours window.
- **No-show follow-up** — only for a missed appointment, never one the person
  cancelled themselves, within a window after the fact.
- **Visit follow-up** and **recall** — off by default.
- **Quiet hours** (08:00–20:00 in the practice's timezone) hold back what the
  practice starts by itself. A confirmation somebody asked for — an online booking,
  or one the agent read out on a call — is transactional and goes straight out.
- **`reconcileReminders`** re-times a queued reminder when its appointment moves and
  cancels rows for appointments that were cancelled, missed or completed. A reminder
  that arrives for a time the patient is not coming is worse than none.

### The scheduler that was missing

`lib/server/scheduler.ts` — six jobs (`deliver-messages` every 2 minutes,
`queue-reminders`, `no-show-followups`, `visit-followups`, `campaign-tick`,
`retention`), a tick every 60 seconds, per-job pause, and **Run now** from the
dashboard. Every job is idempotent, which is what makes it safe to point a cron at
`{"action":"tick"}` instead. A job that throws records a failure and does not stop
the tick; state lives in the `scheduler` collection.

### Campaigns can text as well as call

`channels: { call, sms }` on a booking campaign. A text goes out first because it is
cheap and lands in writing; a call follows when the text has not settled it. A
text-only run never dials, its dry run says what it *would* text, and `stats.texted`
counts what it sent.

### The report that answers the money question

`noShowReport(orgId, {days})` → rate (missed ÷ attended+missed), the period before it,
breakdowns by provider, service and weekday, what outreach went alongside it, and the
**unsettled rows** (appointments that are past but have no outcome) that keep the rate
honest rather than flattering. `view=summary` defines "reached" as calls answered
plus texts the carrier reported delivered — not texts a carrier merely accepted.

---

## 2. Verification

Production build, app on `:3000`, carrier stub on `:4010` (so delivery has somewhere
real to go), AI stub on `:4020`.

| Gate | Result | Headline reading |
|---|---|---|
| `scripts/messaging_check.py` (new, P4) | **77 checks ALL PASS** | reminder queued at T-minus 24 h and sent through the carrier as `SMstub…`; the log row says `sms/reminder/sent` with the message id; a moved appointment re-times its queued reminder to `2026-10-13T19:53Z` while still pending; replying STOP withdraws consent with the reply as the evidence and the queued reminder is refused; the carrier's receipt turns `sent` into `delivered` without adding a row; email goes through the relay, not the carrier; the rate is `4 missed of 33 = 12%` during the run |
| `scripts/booking_check.py` (P3) | 39 checks ALL PASS | a stranger books end to end; the confirmation is a real row that the queue sends (`1 sent, 0 blocked`) |
| `scripts/client_check.py` (P2) | 43 checks ALL PASS | unchanged, plus the consent flow that STOP now drives |
| `scripts/practice_check.py` (P1) | 41 checks ALL PASS | the agent still answers from the diary |
| `scripts/privacy_check.ts` (P2) | 22 checks ALL PASS | 264 bundles, 76 record fingerprints, none found |
| `scripts/carrier_check.py` | **ALL CARRIER CHECKS PASS** | incl. new: a bought and an adopted number are told where replies go |
| `scripts/api_check.py` | ALL PASS | |
| `scripts/book_check.py` | ALL PASS | campaign calls, sync, outcomes |
| `scripts/smoke.py` | ALL SMOKE CHECKS PASS | |
| `scripts/nesting-check.py` | 518 prerendered pages clean | |
| `scripts/linkcheck.py` | 518 routes, 0 unresolvable | |
| `scripts/sitemap-check.py` | 472 entries, every indexable route listed | |
| `npx tsc --noEmit` | clean after every edit | |

Verified by hand as well as by script: `/docs/api/messaging` carries the new
replies-and-receipts section (rebuilt before checking, because docs pages are
prerendered), and the workspace is back to its own quiet hours afterwards (the gate
pins them open for its run and restores them).

---

## 3. Defects found while building P4, and fixed

1. **The opt-out line was a promise nothing kept.** Every outgoing text ended
   "Reply STOP to opt out." — and nothing processed a reply, and no bought number was
   ever given an SMS webhook for the carrier to deliver one to. Both halves now exist:
   `SmsUrl` is set at purchase and adoption, and `inbound-message` resolves the
   workspace from the `To` number and the person from the `From` number.
2. **The transport advertised a status callback with no route behind it.**
   `transports.ts` sent `statusCallback` pointing at `/api/telephony/twilio/message-status`;
   the endpoint did not exist, so `sent` was the last word anyone heard. The route and
   `applyDeliveryReceipt()` now exist, and the receipt refines the existing row.
3. **`req.formData()` throws on a body that is not a form.** A probe or health-check
   POST returned a 500. Every carrier webhook route now tolerates a non-form body and
   answers `{"ok":true,"ignored":"missing_sid_or_status"}` — carriers retry, and a
   webhook that 500s on a probe gets switched off.
4. **The email relay sat behind the stub's Twilio auth.** Real Twilio never calls a
   relay; our stub rejected it with a 401, which looked exactly like an email bug.
   The relay endpoints moved above the auth check.
5. **A reminder-reconciliation test passed for the wrong reason.** It moved an
   appointment whose reminder had already been sent, so there was no row left to
   re-time. It now moves the far booking, whose reminder is still queued.
6. **The gate's meaning depended on the wall clock.** Quiet hours decide whether
   "due now" is due now, so a run at 02:00 local failed on the time of day rather than
   on the code. The gate now pins its own workspace's window open and restores it —
   and the deferral rule got its own test with an explicitly closed window.
7. **A confirmation was queued as if it were marketing.** At 21:00 the text a person
   had just asked for at the booking screen waited until 08:00. Confirmations (online
   and read out by the agent) are now `immediate`; reminders and campaigns keep
   obeying quiet hours, and the dashboard copy says which is which.
8. **The demo seeder was not idempotent end to end.** Its call rows were re-offered on
   every run; they now check `outreach` for the `callId` first — the same pattern any
   new seeder section needs.
9. **The tidy sweep deleted history it had promised not to.** Probe-addressed rows
   (a non-numeric `to`, a probe domain) were left behind, and the second pass then
   deleted the outreach rows they orphaned. The sweep now removes them by name, and
   the demo history is restored with `scripts/seed-messaging-demo.ts`, which is
   idempotent.

---

## 4. API added in P4

```
GET    /v1/templates                              the library, seeded on read (?include=retired)
POST   /v1/templates                              action: preview | save | retire | restore | reset
GET    /v1/outreach?view=log|rules|report|summary the log, the rules, the no-show report, the tally
POST   /v1/outreach                               action: log-touch | save-rules | save-settings
GET    /v1/messages?bookingId=&status=&clientId=  the queue, with a tally
POST   /v1/messages                               action: send | deliver | queue-reminders
GET    /v1/scheduler                              jobs, runs, failures, rules, tick length, server time
POST   /v1/scheduler                              action: tick | run (force) | toggle
POST   /api/telephony/twilio/inbound-message      a reply: STOP | START | anything else
POST   /api/telephony/twilio/message-status       the carrier's word on a text: queued | sent | delivered | failed
```

`/v1/booking-campaigns` gained `channels` and `stats.texted`.

Docs: `lib/docs-content/api-messaging.ts` → **/docs/api/messaging** (the queue, the
templates, the rules, the log, the report, the scheduler, replies and receipts,
campaigns).

---

## 5. Deliberately not done in P4

- **Automatic replies to anything but STOP/START.** An answer to a question is a
  conversation, and a practice that auto-replies to "can I move Thursday?" with a
  robot is worse than one whose desk reads it.
- **HELP.** The carrier's own advanced opt-out answers it; a second reply from us is
  one more text to somebody who asked for fewer.
- **A real SMTP driver.** Email goes through a relay URL; wiring a provider is
  deployment work, not product work, and the relay is one env var away.
- **A second carrier.** The transport interface is there; Telnyx and Vonage drivers
  are the same shape as P1's deferred telephony drivers.
- **Distributed media workers and a real cron.** The scheduler is in-process and
  idempotent, so an external cron is a deployment choice rather than a rewrite.
- **Recording storage.** Still deferred from P1, and still the right call: a
  recording is patient data with a retention clock, and it should not be bolted on.

---

## 6. State after P4

- **App:** `npx tsx server.ts` on `:3000` (production build, 562 prerendered routes),
  AI stub `:4020`, carrier stub `:4010` — restarted after the sweep and re-verified.
- **Database:** 2 workspaces, 29 appointments (20 completed, 5 cancelled, 3 no-show,
  1 confirmed), 32 client records, 563 call rows, **69 messages**, **151 outreach
  rows** (sms/sent 138 · call/answered 6 · call/no_answer 7), 7 templates, 3 numbers,
  1 campaign. `tidy-probe-orgs.ts` re-run reports *nothing to do*; the demo history is
  intact and the seeder has nothing to add.
- **Readings:** no-show **13 %** (considered 23 · attended 20 · missed 3 · cancelled 5),
  unsettled 0; report outreach `{followUpsSent 5, remindersSent 58, confirmationsSent 58,
  blocked 0, failed 0}`; summary total 151, reached 6; scheduler running, 6 jobs,
  `deliver-messages` every 2 minutes with 10 runs and 0 failures; rules active:
  reminders + no-show follow-ups.
- **New scripts:** `messaging_check.py` (77 checks) and `seed-messaging-demo.ts`
  (dry-run by default, backs up first, idempotent including its call rows).
- **Backup before the final sweep:** `data/backups/voxera-db.before-tidy-2026-10-13T08-55-16-513Z.json`.

## 7. Next — P5, notes

The diary, the client record, the booking page and the messaging are all real now, so
the next gap is what the practice writes down about an encounter. P5 is **notes**: the
agent drafts a summary of what was discussed and what was decided, a person edits and
signs it, and it is filed against the appointment and the client — with the same
access log, retention and versioning the rest of the records already have. Same rhythm:
build → verify → report → review.
