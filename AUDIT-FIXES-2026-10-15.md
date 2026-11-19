# D1 + D2 + A1 — the client keeps their own appointment

**Date:** 2026-10-15 · **Scope:** the audit's recommended bundle, and nothing else — `AUDIT-2026-10-15.md` items **D1** (the diary's clock), **D2** (a reply that does something) and **A1** (the client's own link). D3–D8 and A2–A9 are untouched.

**Verification:** `npx tsc --noEmit` clean · production build clean · **`scripts/manage_check.py`: 31 PASS / 0 FAIL** · the whole existing suite re-run green (below).

---

## What was wrong, and what it is now

### D1 — the diary drew one clock and dragged another

`diaryRange` fell back to `'UTC'` whenever no site was chosen — which is the *default* view — while every row was still measured in its own site's minutes. Blocks looked right; the arithmetic was hours out. Measured before the fix: a 14:00 drop landed at 10:00 New York, and a 20:30 New York appointment was not on the day column at all.

Now: **one clock per grid.** `practiceTimezone(orgId, site)` (the filtered site, else the first site by name — the same rule the reports already used) decides the grid; days are bucketed with `zonedToUtc(y, m, d + 1)` so a DST week still has a midnight; every row offset is measured against that same `dayStart`; and the payload returns the clock it used together with `gridSiteId`. The route that defaults "today" uses the same function, so the day the view opens on is the practice's day, not Greenwich's.

### D2 — the reminder promised an answer nobody was listening for

`Reply C to confirm` had been in the seeded copy since the messaging layer shipped; the webhook ignored everything but STOP/START. `lib/server/inbound.ts` now reads a reply four ways:

| The client texts | What happens |
|---|---|
| `C`, `yes`, `ok`, `1`, `confirmed` … | the next pending appointment is **confirmed** through `setAppointmentStatus` — the desk's own path, so reminders and the wait list behave |
| `no`, `can't make it`, `cancel` … | **cancelled** with the reply as the reason, and the freed slot is checked against the wait list |
| a weekday, a time, "tomorrow", "instead" | filed as a **change request** for a person and acknowledged — never auto-booked. Guessing a booking from "maybe Thursday?" is worse than a phone call |
| anything else | recorded and answered as "a person will get back to you", and put in the desk's queue |

Every branch writes an `outreach` row, so the reply appears in the client's own thread. The desk reads them on **Messaging → Replies** — who, what they said, which appointment — and ticks each one off (the row stays in the thread; only the flag changes).

### A1 — the link that makes the text actionable

`{{manage_link}}` is in the confirmation (SMS and email) and the reminder, and in the confirmation the online booking page and the voice agent send. It opens `/m/<token>`: what is booked, when, where, one button to confirm, and — up to two hours before — real openings to move to or a short list of reasons to cancel with.

- **The token is derived, not stored:** `base64url(HMAC-SHA256(VOXERA_MEDIA_SECRET, "manage:" + bookingId))`, prefixed by the booking id. Nothing to expire, yesterday's text still works, and rotating the secret invalidates every link at once.
- **It names one appointment.** No session, no key, no client record, no sibling booking; a tampered signature is a 404. `noindex`, like the payment link.
- **A move goes through `moveAppointment`** — clash, rota, room pick, reminder reset, wait list, all the desk's guards — so a client moving themselves cannot do anything a receptionist could not. `CHANGE_CUTOFF_HOURS = 2` after which the page says to ring instead, and the practice's own number is on it.
- **A cancel records the client's reason** and hands the freed slot to the wait list.
- **If the deployment has no public address,** the link is left out of the text rather than printed broken (`manage_link` empty → the whole line is dropped).

## The three things found while building it

1. **A reminder could go out describing the old time.** `reconcileReminders` re-timed pending reminders after a move but never re-rendered them. A client who moved an appointment to a Monday still had "your job is Friday at 9:00am" waiting to send. Now the body is re-rendered and compared; when the words no longer describe the booking the row is withdrawn and the next pass queues one that does. Probe: reminder `pending` with the old day → after the move, `cancelled — the appointment changed after this was written`.
2. **"Their practitioner is booked" left the client with nothing to choose.** `offeredSlots` asked only for the client's own practitioner, so a practitioner who no longer offers that service at that site produced an empty page. It now asks for their practitioner first and then anybody who does that job at that site, naming the different person on the button.
3. **A tampered token and a missing token are not the same answer** — both are refused, but the page's copy distinguishes "that link does not match an appointment" from a page that never existed.

## Evidence

`scripts/manage_check.py` (new, 31 checks) drives the running app:

```
D1 — the diary keeps one clock
  PASS  the all-sites clock is the practice's own
  PASS  a filtered diary keeps that site's clock
  PASS  a row's drawn position reconstructs its real instant
  PASS  a time the engine offers is accepted as a drop
  PASS  the appointment is drawn where the drop landed
  PASS  and the stored instant is the one the drop meant
  PASS  the site's own view agrees about the instant
A1 — the client's own link
  PASS  the reminder carries a link the client can open
  PASS  the page opens with no session        PASS  the page is not indexable
  PASS  the link answers with that one appointment
  PASS  it offers real openings               PASS  a tampered token is refused
  PASS  the client can move their own appointment
  PASS  and the desk's diary says the same instant
  PASS  the move is on the record, not silent
  PASS  the client can cancel from the link   PASS  the appointment really is cancelled
  PASS  a second cancel is refused, not repeated
D2 — a reply does what the text promised
  PASS  the reply is answered, not swallowed  PASS  and it says which appointment
  PASS  the appointment is confirmed in the diary
  PASS  a change request is never auto-booked
  PASS  it lands in the desk's queue          PASS  the desk can tick it off
```

The clock assertions are rebuilt in Python with `zoneinfo` — deliberately the same arithmetic the calendar does with `Intl`, written twice so a bug would have to be the same bug twice.

One live run, read back from the desk's own API:

```
reminder  "…Reply C to confirm, or move it here: http://127.0.0.1:3000/m/4337a2eb72596231.xq-Oc81p0ugrS3BcIvLXyT"
GET  /m/<token>           200, "Friday 16 October at 9:00am", twelve real openings offered
POST …/move               200, "Moved to Monday 19 October at 9:00am."
desk booking              startsAt 2026-10-19T16:00:00.000Z · history: created → moved → moved → status:cancelled
POST …/cancel "I am unwell"  200 — note on the record: "cancelled by the client: I am unwell"
Body=C (inbound)          <Message>Confirmed — Thursday 15 October at 9:00am with Marcus Ito…</Message>
desk queue                Bilal Probe · "Can I come Thursday instead?" · Thursday 15 October at 9:00am  → resolved
```

## Files

| File | What it is |
|---|---|
| `lib/server/manage-links.ts` | **new** — the leaf module: token, URL, `publicBaseUrl`, `rememberOrigin`, `manageLinkFor`. Crypto and the database, so both the page and the message layer can use it without a cycle |
| `lib/server/manage.ts` | the page's server side: `bookingForToken` (one appointment, constant-time), `manageView`, `offeredSlots`, `clientReschedule`, `clientCancel` |
| `lib/server/inbound.ts` | **new in D2** — the four intents, `deskRequests`, `resolveDeskRequest` |
| `app/m/[token]/page.tsx` + `ManageAppointment.tsx` | the page the client opens — phone first, one appointment, real slots, `noindex` |
| `app/api/public/manage/[token]/route.ts` + `.../action/route.ts` | public read and write, rate limited, no session |
| `app/api/v1/messages/replies/route.ts` | the desk's queue behind the new **Messaging → Replies** tab |
| `lib/server/diary.ts`, `practice.ts`, `app/api/v1/diary/route.ts` | the one-clock fix |
| `lib/server/templates.ts` | `{{manage_link}}` in the seeded confirmation and reminder, `dropUnfilledLinkLines`, and `upgradeTemplatesForOrg` — an idempotent upgrade for workspaces that already have their templates (seeded rows nobody has edited, only) |
| `lib/server/maintenance.ts` | reminders are re-rendered before they are re-timed |
| `app/api/bootstrap/route.ts` | remembers the address the workspace was reached at, and runs the template upgrade |

## Suite

Re-run on the built tree — and then re-run again on a *fresh* `npm ci` + production build after the sandbox was recycled mid-session, which is the run the numbers below come from:

| | pass / fail |
|---|---|
| `manage_check.py` (**new**) | **31 / 0** |
| `practice` 56 · `practice_team` 68 · `reports` 52 · `money` 73 · `notes` 55 | 304 / 0 |
| `messaging` 77 · `booking` 39 · `client` 44 · `api` 38 · `carrier` 49 | 247 / 0 |
| `book` 31 · `ai` 40 · `onboard` 41 · `demo` · `smoke` 59 · `report_tool` 36 | 207 / 0 |
| **total** | **789 / 0** |

…plus `guard` · `race` · `privacy` · `nesting` (522 pages) · `links` (522 routes, 0 broken) · `sitemap`, and `media-check` with the app's own `VOXERA_MEDIA_SECRET` (`ALL CHECKS PASS`).

`scripts/media-check.ts` is not part of the suite and failed on the first run only because it defaults `VOXERA_MEDIA_SECRET` to `'dev-media-secret'` while the app was started with `demo-media-secret-9f2a` — the socket was closed 1008. Run with the app's own secret it passes (`ALL CHECKS PASS`). Worth knowing when running gates by hand: pass the same secret the server has.

**Tidy.** The gate leaves the appointments it makes (it deletes them through the API), and the clients it made from a phone number go with `npx tsx scripts/tidy-probe-orgs.ts --apply` — the project's existing sweeper, which matches them on the `Probe` name this gate gives them. One run cleared the residue of the whole day's suite: **27 probe clients, 16 appointments, 20 messages, 4 invoices, 7 payments, 1 probe template, 1 abandoned workspace, 40 abandoned calls**. The demo workspace now reads **326 appointments · 195 invoices · 45 clients**, with a backup written by the sweeper at `data/backups/voxera-db.before-tidy-*.json`.

Ten appointments in there are still check leavings: four cancelled online-booking probes (`WEB-…` — the id the *product* mints, so the sweeper cannot treat the prefix as debris), three `book_check` appointments (`CHK-*`, which that gate clears at the start of its next run), and three call probes. They are left deliberately: the sweep's own rule is "matched by name on purpose — a sweep must never touch a real record", and widening it to catch those would put real rows at risk. The `Caller` clients are the product's own default name for an unknown caller (`lib/server/clients.ts:410`), not debris.
