# D8 + A9 — the documentation for the practice layer, and one command to prove it

**Date:** 2026-10-15 · **Status:** built, verified, whole suite green on the production build.

**Gate:** `npm run check` — the new single command — **30 gates, 1201 checks, 0 failures**, then a
confirmation run straight after `tidy-probe-orgs --apply` (**30 gates, 1211 checks, 0 failures**) to show
the suite does not depend on the debris the sweep had just cleared. `npm run check:offline` green as well
(`offer_expiry_probe` 8/0). Evidence: `CHECK-RUN-2026-10-16-D8-A9-handback.txt` (this run, kept under its own name — `CHECK-RUN-2026-10-16.txt` is the later A6 run), per-gate logs in `/tmp/gates/<gate>.txt`.

---

## What D8 asked for

The audit wrote it as a gap: *`lib/docs-content/` covers api/booking·messaging·practice·reports plus the
platform pages; nothing covers notes, invoices/payments, team·roles, the staff board, import/export — or
`practice_report`; `package.json` has no `check` script.*

Two things then. Documentation for the parts of the practice layer a person would actually be handed by a
colleague — and one command that runs the whole suite, because "is it green?" had become a matter of
remembering thirty-two script names and the order they go in.

## 1. Seven new docs pages — 52 → 59 routes

New content files (all data, no components, per the docs engine's own rule):

| File | Pages | Covers |
| --- | --- | --- |
| `lib/docs-content/api-notes.ts` | `api/notes` | `NOTE_READ_ROLES`, the redacted read (`records`/`clinical` split), eight POST actions, finalise → amend → archive, the access log, the `403`/`409`/`400` error table |
| `lib/docs-content/api-money.ts` | `api/money` | the three-role money table, six GET views, **every write on `POST /invoices`**, receipts, the overdue chase, the pay page and its sandbox, statements, settings |
| `lib/docs-content/api-client-links.ts` | `api/client-links` | the derived manage token, `GET/POST /public/manage/{token}` and its four actions, the wait list, offers (`min(now+4h, startsAt)`, five per slot), the staff board |
| `lib/docs-content/api-team.ts` | `api/team` | six roles and the `CAPABILITIES` table, members/roles/invites/sessions views, nine session-only POST actions, the pinboard |
| `lib/docs-content/api-records.ts` | `api/records` | `COLUMN_ALIASES` import, the dry-run-first report, exports including the Xero shape, the per-record access log, archive → retention (7 years) → purge, and the privacy check |
| `lib/docs-content/guides-practice.ts` | `guides/asking-the-ai` | the `practice_report` tool: who may ask (dashboard user / login number / practitioner number / stranger), the seven topics, the windows, `basis` ("Reports → Revenue"), the two refusals, the three audit actions, and the 36-check gate |
| | `guides/verifying-a-change` | the gate pattern itself, and `npm run check` — what it needs running, how the order is chosen, and the rules every gate keeps |

Wired into `lib/docs-content/index.ts` (imports, `DOC_PAGES`, and both `SECTION_SPEC` groups — the REST
reference gains five, Guides gains two, so the sidebar, TOC, search index and prev/next all follow).
`/docs/[...slug]` now statically generates **58 paths**; all seven pages answer `200` on the running app
and render their tables (44 rows on `api/money`, 32 on `api/team`, and so on).

**Honesty rule applied throughout:** every number, field and action named in these pages was read out of
the code that implements it, not from memory — the notes roles are `NOTE_READ_ROLES`, the invoices actions
are the `case` labels in the POST switch, the offer TTL is `OFFER_TTL_MS`, retention is
`DEFAULT_RETENTION_DAYS = 365 * 7`, the import default is `input.dryRun !== false`, and `api-money.ts` says
*"every `case` in the route's POST switch, checked against the file."* Two claims were found stale by that
check and corrected in place (the action count, and `from-appointment` being an alias of `from-booking`).

## 2. A9 — `npm run check`

**`scripts/check.py`** runs the whole live suite against a running app and prints one verdict:

```
npm run check                              # tsc, then 30 gates, in order
npm run check -- --only money              # one family, while iterating on it
npm run check -- --keep-going              # the whole picture after a failure
npm run check -- --list                    # the plan, and why in that order
npm run check:offline                      # the gates that need the app stopped
```

What it does, in order:

1. **Types first.** `tsc --noEmit`; a type error stops the run before a gate touches the workspace.
2. **The app.** It refuses to run against nothing — if `:3000` is silent it prints the exact environment
   to start, and it warns (without failing) when the `:4010`/`:4020` stubs are down, because gates that
   assert a delivery would fail on that rather than on the code.
3. **The gates**, cheapest and broadest first, sign-in-heavy gates **spaced apart** so the login limiter
   is never what fails, fixture-touching gates last, and the three that read the built HTML after those.
4. **One verdict.** Pass counts summed where the gates state them, every failure named with its last
   useful line, full output per gate in `/tmp/gates/<gate>.txt`, and `exit 0` only when the run is clean.

Judgement calls worth recording:

- **A stated count beats a counted line.** Gates that print `N PASS / M FAIL` or `N checks passed` are read
  from those; gates that print one line per check (the majority) are counted from their `PASS` lines. The
  reader deliberately does not match across newlines — a phone number ending a line once read as "1127
  passed".
- **A gate that states no count prints its own summary sentence** rather than an invented number:
  `linkcheck` reads `528 static routes · 0 unresolvable link targets`, `room_window_check` reads
  `175 window(s) checked · 0 disagreement(s)`.
- **`media-check` is skipped before it runs, not after it fails.** The runner asks the app's own
  `/api/telephony/media/status`; if the media pipeline is not live it prints that gate as *not run* with
  the reason and the command that would run it — and a genuine failure in a live pipeline is still a
  failure. (See §3 for the honesty change this required in the status endpoint there.)
- **One suite at a time.** A lock file with the holder's pid: a second concurrent run stops and names the
  first, because the gates book, text and void real rows in one workspace and two runs eat each other's
  evidence. `--force` overrides.
- **It watches the app between gates.** If the server stops answering mid-run, the runner says which gate
  it died in and stops, instead of reporting every gate afterwards as broken. On a 2 GB box the kernel can
  OOM-kill the app under the memory-heavy gates — which is a fact about the machine, not about the code,
  and it is now labelled as such (`exit 137`, and `/tmp/arena-workspace/procs/voxera-app-*/exit` confirms).

## 3. Product changes this bundle needed (found by running it, not by reading it)

The runner and the gate fixes surfaced genuine defects. Each is fixed in the product, not papered over in
the check:

| Defect | Evidence | Fix |
| --- | --- | --- |
| **`GET /api/v1/bookings?clientId=…` was accepted and ignored.** The list came back as the whole diary — 200 rows for a client who has four. Any screen, sync client or script asking for one client's appointments got a wrong answer that looked like a right one. | `clientId=cli_sep27du19l` → 200 rows, **196 belonging to another client**; grep of the route found no `clientId` filter at all | `app/api/v1/bookings/route.ts`: real `clientId`/`serviceId`/`providerId`/`locationId` filters, and an unknown query parameter is now refused by name with the supported list (`VALIDATION_ERROR`). Re-proved live: 4 rows, 0 wrong-client; the export view still works |
| **Check-in said "tomorrow" for any day that was not today.** A visit six days out read *"You can check in from 3:30am tomorrow."* The window is six hours, so this was the **common** branch, not an edge one — a client told to come on the wrong day, or taught to stop believing the text. | `/m/{token}` for a 21 October visit: `"You can check in from 3:30am tomorrow."` | `checkInFromWords` names the day beyond tomorrow (*"3:30am on Wednesday 21 October"*), and the gate now asserts the clock **and** the day it names — the check that would have caught it only runs when the diary has nothing left inside today's window, which is why an evening run found it |
| **The media status endpoint contradicted itself.** With the simulated pipeline on, the socket carried audio, turns and barge-in while `/media/status` reported "no transcriber configured, `ready: false`" — a half-truth that sends an operator hunting for a provider key they do not need. | status endpoint vs `media-check` driving a real WebSocket against the same app | It reports `simulated: true`, names the seam in the transcriber's `detail`, and computes `ready` from it. The runner's skip decision is now read from this endpoint, so live pipeline failures are reported as failures |

## 4. Gate defects fixed (the suite was lying in both directions)

Running the whole thing in one command immediately found gates that fail for reasons other than the code,
and one gate that had stopped testing what it claimed:

- **`demo_check` judged the wrong day.** Its attendance claim was measured on the *most recent finished
  day* — which is the day the gates themselves have been writing to. A single suite run left 119 settled
  rows on that day, 18 of them `completed`, and the workspace read as a practice where nobody turns up.
  It now measures the **seeded month** (the last thirty finished days, minus the two the suite can write):
  *"241 settled visit(s) … 214 of 241 attended (89%)"*. The gate was wrong, not the demo.
- **`money_loop_check` assumed its clock.** Its receipt is deferred by quiet hours — correctly, because a
  receipt goes through the same queue as everything else — so a run at 6:24am in the practice's own clock
  queued a receipt for noon and reported "it never went". The gate now opens the messaging window **before
  the payment** (`sendAt` is decided when a message is queued, not when delivery runs), asserts it, proves
  the carrier path, and puts the window back as it found it. Section 5 still proves the opposite rule with
  the window shut. It also retries delivery up to eight times: the queue is shared and a run takes a slice
  oldest-first.
- **Fixtures were never swept.** `money_loop_check` and `waitlist_check` created a probe client each run
  and never removed them — `created_clients` was collected and unused. 75 `Probe …` records had
  accumulated in the demo workspace, and `money_loop_check` eventually failed on **its own leftovers**
  (`CONFLICT … +141555546551`). Both now delete what they created (bills voided first — a client with
  documents standing is correctly archived, not removed), create with a retry that survives a taken
  number, and report what they removed.
- **"What it left behind" is now visible.** `waitlist_check`'s tidy line reads
  `cancelled 8 probe appointment(s), closed 5 probe wait entry(ies), removed 10 probe client(s)`.

Also carried in the bundle: `messaging_check`'s delivery helper now drains with `limit=200` in up to six
rounds instead of trusting one batch of 25 (one shared queue, every gate's leftovers in it), and
`recall_check`'s tidy was verified to be the reason **the demo diary was lost and rebuilt** — see below.

## 5. What I checked and found fine

- The seven new pages are **grounded in the code** — every constant, action name, view and error code was
  read from its implementation (`NOTE_READ_ROLES`, `MONEY_EDIT_ROLES`, `CONFIG_ROLES`, `ROLES`,
  `DEFAULT_RETENTION_DAYS`, `OFFER_TTL_MS`/`MAX_OFFERS_PER_SLOT`, `COLUMN_ALIASES`, `importReport`,
  the `report-tools` identity table and refusal wording).
- `docs/[...slug]` really does generate all 58 leaves, and every new page is in the sitemap and the
  search index (`sitemap-check`, `linkcheck 528 static routes · 0 unresolvable`).
- The runner's lock, skip-before-run, app-death guard and count reader were each exercised, including a
  deliberate second concurrent run (refused, exit 2) and a deliberate killed app (named, stopped).
- `npm run check:offline` refuses to run while the app is up, and runs when it is down.

## 6. An incident, reported in full

While sweeping probe clients I ran a cleanup that deleted each probe client's bookings using
`GET /api/v1/bookings?clientId=…`. **The route ignored that filter**, so every deletion pass took the
first fifty rows of the *whole* diary. The demo workspace's month of history was cut from 730 appointments
to 37 — and `demo_check` failed on the damaged data, which is how it was caught. No real patient data was
involved (the demo workspace is synthetic), and the workspace was rebuilt with
`npx tsx scripts/seed-demo-diary.ts --apply`: *sited 9 appointments that had no site, moved 8 into working
hours, created 299 across 32 days, 198 invoices (154 settled)*, and `demo_check` went back to `ALL PASS`.

Two things came out of it, and they are the reason it is written down rather than quietly repaired:

1. **The filter defect was real, and is now fixed** (§3). A caller had no way to tell a working answer from
   a wrong one; that is the worst kind of bug in an API a practice's records systems will call.
2. **Every cleanup from here on checks what it is about to delete.** The sweep re-read each row and
   confirmed it belonged to the probe before deleting it; the gates assert the rows they tidy are theirs.
   A sweep that trusts a filter is not a sweep, it is a gamble. The damaged state was kept at
   `/tmp/voxera-db.before-diary-reseed.json`, a backup from the tidy is in `data/backups/`, and the tidy
   itself (`tidy-probe-orgs --apply`) ran at hand-back: **31 abandoned probe workspaces removed, 0 probes
   left in the demo workspace** (68 clients, all of them the practice's own).

## 7. Files

**New** · `scripts/check.py` · `lib/docs-content/api-notes.ts` · `api-money.ts` · `api-client-links.ts` ·
`api-team.ts` · `api-records.ts` · `guides-practice.ts` · `CHECK-RUN-2026-10-16-D8-A9-handback.txt` (the green run, verbatim)

**Changed** · `lib/docs-content/index.ts` (7 pages wired in) · `package.json` (`check`, `check:offline`,
`check:list`) · `README.md` (the one-command section, the restart advice for a small box, docs 59 routes) ·
`app/api/v1/bookings/route.ts` (real filters, unknown params refused) · `lib/server/manage.ts` (check-in
wording) · `app/api/telephony/media/status/route.ts` (says when it is simulated) · `scripts/waitlist_check.py`,
`money_loop_check.py`, `messaging_check.py`, `demo_check.py` (clock, fixtures, delivery drain)

## 8. The hand-back

The run order that leaves the workspace as it was found, now written into `README.md` with the checks:

```
npm run check                                  # green: 30 gates
# stop the app
npx tsx scripts/tidy-probe-orgs.ts             # dry run — what a suite sweep leaves behind
npx tsx scripts/tidy-probe-orgs.ts --apply     # probe records, abandoned probe workspaces, stale calls
# start the app again
```

Run at hand-back: **31 abandoned probe workspaces removed, then 3 more**, 0 probe records left in the demo
workspace (69 clients, all of them the practice's own), `demo_check` back to `ALL PASS`, and the app left
running on `:3000` against the final build.

## 9. Still open (not in this bundle)

- **A6** practitioner day view and **A8** group appointments/classes — never authorised.
- The desk `send` while the recall/outreach rule is off queues one message with the rule disabled
  (undiagnosed, unrelated to this bundle).
- `GET /api/v1/templates?kind=recall` returns `[]`; the messaging Replies tab is not acting on replies.
- D1 (the first-visit flow) has not been walked in a real browser — every gate drives the API and the
  built HTML.
