# Voxera practice management — Phase 2 build report

**Diary + clients.** Built 2026-10-12, verified against a production build (565/565
prerendered pages) with the app running on `:3000` and both stubs up.

The phase gate from `PRACTICE.md` §11, L83:

> A receptionist can run a full day without touching the API, and no client data
> sits in the browser.

Both halves are now checked by script, not by claim.

---

## 1. What landed

### The diary (new surfaces)

| Piece | Where | Behaviour |
|---|---|---|
| Day / 3-day / work-week / week grid | `app/dashboard/calendar/page.tsx` + `GET /v1/diary` | 07:00–20:00, 0.9 px/min, provider filter, per-day booked/hour stats |
| Create by clicking a slot | same + `POST /v1/bookings` | the modal offers the practice's services and providers; a taken slot returns real alternatives |
| Move by dragging | `POST /v1/bookings/{id}/move` | the engine decides; a refused move toasts the reason and the grid re-reads — nothing moves optimistically |
| Resize by pulling the bottom edge | same route, `durationMinutes` | recorded as a change on the appointment |
| Statuses | `POST /v1/bookings/{id}/status` | `pending → confirmed → arrived → completed`, `cancelled`, `no_show`, with an explicit transition table |
| Wait list | `GET/POST/DELETE /v1/wait-list`, `PATCH/DELETE /v1/wait-list/{id}` | cancelling an appointment surfaces the people who fit the freed slot |
| Repeat series | `POST /v1/series`, `GET/DELETE /v1/series/{id}` | day / week / fortnight / month, up to 52 occurrences; what cannot be booked is reported, not silently dropped |
| Front desk verbs next to the campaign story | `app/dashboard/bookings/page.tsx` | arrived / done / no-show and today's wait list, on the page a receptionist already had open |

### The records

| Piece | Where | Behaviour |
|---|---|---|
| Client records | `lib/server/clients.ts`, `/v1/clients` (+`{id}`) | number is the identity — a second booking from the same number never makes a second person |
| Alerts | `/v1/clients/{id}/alerts` | shown on the record *and* on the diary block (`hasAlerts`), so the desk sees them before the patient is in the room |
| Consents | `/v1/clients/{id}/consents` | `sms`, `email`, `recording`. Booking implies transactional SMS/email and never implies recording |
| Notes, timeline, calls | `/v1/clients/{id}` | appointments, the calls that touched them, notes, and the access log in one read |
| Archive, not delete | `DELETE /v1/clients/{id}` | archives with a reason and a retention date (7 years default); blocked while work is still booked; restorable |
| Access log | `lib/server/access-log.ts` | per-record; views deduped hourly; 200 entries per record; every entry names an actor |
| Retention sweep | `lib/server/maintenance.ts` | purges clients past retention (audited) and expired wait-list rows |

### What the agent does differently

`lib/server/booking-tools.ts` and `lib/server/agent.ts`:

- An unknown number books **as the client on file** — name, email, alerts and consent state come from the record, not from the caller's say-so.
- Times are spoken in the **site's** timezone.
- `send_confirmation` checks consent first: a caller who opted out gets `{ queued: false, blocked: true, reason, note: "Do not promise a message. Read the details out instead…" }` — the agent is told what to do, not just refused.
- A taken reschedule slot returns real alternatives (date, time, offers) instead of "offer another".
- "Can you text me that?" now reaches the confirmation tool instead of re-reading the diary (defect 3 below).

### Roles

`requireConfigRole` added in `lib/server/api.ts` and applied to the 10 practice-config
routes (team, services, sites, rota, rota changes, profile): owner / admin / developer,
or an API key. Receptionists and practitioners still write the diary and records —
the desk is not an admin. `viewer` remains read-only everywhere.

---

## 2. Verification

Run against the production build, app on `:3000`, AI stub `:4020`, Twilio stub `:4010`.

| Gate | Result | Headline reading |
|---|---|---|
| `scripts/client_check.py` (new, P2) | **43 checks ALL PASS** | (run before the closing sweep; it leaves probe records by design, which the tidy sweep then removes) | move refused `409 not working on 2026-10-18 at Northwind HQ — San Francisco`; `409 that time is Lunch`; `completed → no_show` refused; archived record hidden by default, visible with `includeArchived=true` |
| `scripts/privacy_check.ts` (new, P2) | **18 checks ALL PASS** | 252 bundles and both served pages searched for 79 runtime-only fingerprints — none found |
| `scripts/practice_check.py` (P1) | **41 checks ALL PASS** | agent still answers from the diary: *"I have 1:00pm, 1:15pm, 1:30pm, 1:45pm, 2:00pm, 2:15pm on thursday with Dana Whitfield. Which works best?"* |
| `scripts/api_check.py` | ALL PASS | unchanged surfaces hold |
| `scripts/book_check.py` | ALL PASS | campaign calls, sync, outcomes |
| `scripts/smoke.py` | ALL PASS | outbound still explicit: `dialled=False via=none reason=no_carrier` |
| `scripts/nesting-check.py` | 515 pages clean | hydration nesting gate holds |
| `scripts/linkcheck.py` | 515 routes, 0 unresolvable | |
| `scripts/sitemap-check.py` | 470 entries, every indexable route listed | |
| `npx tsc --noEmit` | clean after every edit | |

### The no-client-data-in-the-browser gate

The claim is only worth what the check behind it is worth, so the gate attacks it
from both ends:

1. **The rule** — `lib/privacy.ts`: `strippedForMirror` removes practice collections;
   `findPrivateData` refuses anything record-shaped that survives, including a client
   record nested under an innocent key.
2. **The store** — `lib/store.tsx` reads and writes through both: a stored blob that
   carries a record is deleted rather than loaded, and a state that still carries one
   is not written at all.
3. **The screens** — no practice screen touches `localStorage` / `sessionStorage` /
   `indexedDB`.
4. **The running product** — the served dashboard HTML and all 252 shipped bundles
   are searched for fingerprints that no source file contains: client ids (minted at
   runtime), numbers, and alert labels. None found.

**The gate has teeth.** A client id was injected into a bundle; the check failed with
`client id cli_w0qv4q315p` and passed again once the file was restored byte-identical.
An earlier draft of the probe searched for names and failed on `Caller` and
`Priya Raghavan` — marketing copy and a seeded persona, not records. The probe is now
defined as *anything the source tree does not contain*, which is why those drop out on
their own instead of being special-cased.

---

## 3. Defects found while building P2, and fixed

These are the ones worth knowing about — all found by the new gates, not by reading code.

1. **Dragging could book outside working hours, or over lunch.** `isFree` only looked
   for clashes, so a move bypassed the rota entirely: the slot search would never offer
   03:00, but a drag could land there. Fixed by extracting `windowVerdict` (hours,
   one-off changes, breaks, buffers) and calling it from `isFree` — the write path and
   the read path now share one judgement and cannot drift.
2. **Buffers were not blockers.** An existing appointment blocked only its own length,
   so a job with a 15-minute changeover after it could be booked right up against the
   next one. `busyFrom` now carries each appointment's service buffers.
3. **The agent's acting tool was silently dropped.** The deterministic tool path capped
   a turn at two calls, and reads came first — so "can you text me the confirmation?"
   ran `lookup_order` + `check_availability` and never sent anything. The cap is now
   three, reads are capped at two, and the acting tool cannot be squeezed out.
4. **"Text me that" was not a text request.** The desk path had no route from a message
   request to the confirmation tool; it re-read the diary instead. Added, consent-gated.
5. **History blocked archiving.** A completed appointment in the future counted as
   "upcoming", so a client whose visit was already done could not be archived. Only
   `pending`/`confirmed`/`arrived` work blocks an archive now.
6. **"Work week" was seven days.** The UI said work week, the API returned a full week.
   `view=workweek` added — five days, snapped to the practice's configured week start.
7. **The access-log tab read `entry.at`.** The API returns `createdAt`; the tab would
   have rendered "Invalid Date" on every row.
8. **The tidy script claimed work it had not done.** Its dry run printed
   "removed N probe client(s)". Gated on `--apply`, and the probe sweep now runs before
   the early exit that used to skip it entirely.

---

## 4. API added in P2

```
GET    /v1/clients?q=&tag=&alertsOnly=&includeArchived=&includeUpcoming=   list + stats + terms
POST   /v1/clients                    create (duplicate number → 409 + the existing record)
PUT    /v1/clients                    ensure-or-create by number (the sync path)
GET    /v1/clients/{id}               record + appointments + calls + access log
PATCH  /v1/clients/{id}               update, or `{restore:true}`
DELETE /v1/clients/{id}               archive (409 while work is booked; `force` overrides)
POST   /v1/clients/{id}/alerts        add alert
DELETE /v1/clients/{id}/alerts        remove alert
POST   /v1/clients/{id}/consents      grant / withdraw sms, email, recording
GET    /v1/clients/{id}/access        who looked at this record
GET    /v1/diary?view=day|3day|workweek|week&from=&providerId=&locationId=
POST   /v1/bookings/{id}/move         time, duration, provider, room; 409 + alternatives
POST   /v1/bookings/{id}/status       transition table enforced
POST   /v1/series                     repeat series, reports what it skipped
GET    /v1/series/{id}                the occurrences as a group
DELETE /v1/series/{id}                cancel from a date on
GET    /v1/wait-list  POST  DELETE ?purge=true
PATCH  /v1/wait-list/{id}  DELETE /v1/wait-list/{id}
```

---

## 5. Deliberately not done in P2

- **Demo alerts on demo clients.** `backfillClientsFromBookings(..., {withDemoRecords:true})`
  exists and stays opt-in: fabricating a clinical alert on a customer's record to make a
  screenshot look better is the wrong default. The alert path is exercised by
  `client_check.py` instead, which adds and removes a real one.
- **Rosters and rooms.** The move route accepts a room and the engine checks it, but
  there is no room list yet (P4 territory).
- **Recurring appointments with exceptions** ("every Tuesday except the 24th") — the
  series model records what it booked; editing one occurrence away from the series is P4.
- **SMS on cancel.** The wait-list match is surfaced to the desk; proactively texting
  everyone on the list needs the messaging provider work already deferred in P1.

---

## 6. State after P2

- **App:** `npx tsx server.ts` on `:3000` (production build, 565/565 pages), AI stub on
  `:4020`, Twilio stub on `:4010` — restarted after the sweep, then re-verified
  (`practice_check` 41 ALL PASS, `smoke` ALL PASS, `privacy_check` 18 ALL PASS).
- **Database:** 2 workspaces (demo `org_507d58b2283b`, Northwind `org_3b5dd38bbd095dd5`),
  25 appointments of which all 25 are linked to clients, 28 client records, 525 call
  rows, 3 numbers including the adopted `+14155550999`. Probe debris (10 records from the
  gate runs above) swept after the last gate; `tidy-probe-orgs.ts` re-run reports
  *nothing to do*. 12 backups in `data/backups/`.
- **Backfill:** the 25 existing Northwind bookings were linked to client records on
  first bootstrap (`{created: 25, linked: 25}`) — idempotent, safe to run again.
- **New scripts:** `client_check.py` (43 checks), `privacy_check.ts` (18 checks),
  `_session.py` (a shared check-session cache, so a suite of gates can run back to back
  without tripping the sign-in limiter — which is itself working as designed).

## 7. Next — P3, online booking

The public booking page: a stranger picks a service, sees real availability from the
same engine the agent and the calendar use, books, and gets the confirmation — with the
client record and consent captured on the way in. Then the rhythm repeats: build →
verify → report → review.
