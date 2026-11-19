# Voxera practice management — Phase 7 build report

**Reports.** Built 2026-10-14, verified against a production build (563 prerendered
routes) with the app running on `:3000` and the carrier stub on `:4010`.

The phase gate from `PRACTICE.md` §7, L89:

> A clinic owner can answer "who earns what, what does it cost us, who does not
> turn up" from one screen.

Checked by `scripts/reports_check.py` — **52 checks, 0 failures** — and by the
whole suite against the same build: **559 checks across eleven gates, 0 failures**,
run twice back-to-back to prove the gates are order-independent.

---

## 1. What landed

### One screen, seven tabs

`/dashboard/reports` — the window is set once, at the top, and every tab reads
from it.

| Tab | The owner's question it answers |
|---|---|
| Overview | the headline: earned, cost, margin, attendance, diary fill, recalls due |
| Revenue | who earns what, by practitioner **and** by service, with the residue split exactly |
| Utilisation | how much of the rota each person actually sold, against **their own** hours |
| Attendance | who does not turn up — by practitioner, weekday and hour |
| Costs | practice spending plus call spend, itemised |
| Attribution | where bookings come from: phone, online, front desk, API |
| Recalls | who is overdue under the practice's own recall window, reachable or not |

### Windows that behave

`preset=30d|90d|6m|12m|month|last-month|year`, or an explicit `from`/`to` — an
explicit range always wins. Everything resolves in the **practice's** timezone
(the first location's clock, not the server's), and the window is inclusive at
both ends: seven dates, seven days.

### Numbers that add back up

- **Revenue rows reconcile to the invoice lines they came from**: practitioner
  shares sum to everything billed (290181 = 290181), and the same for collected
  (232657) and owed (44650).
- **Payments are split across the lines they settle in minor units**, using the
  same largest-remainder `splitExact` the money engine uses — no float crumbs, no
  rounding drift between the invoice screen and the report.
- **The report can never outrun the money screen**: report collected 232657 ≤
  money screen 248031, because the report's window is a subset of all time.
- **Cost is metered plus practice spending, added once** — 321465 + 1770 = 323235,
  with the call spend itemised (Platform 911, Transcription 83, Voice 477) rather
  than one mystery number. Margin is the subtraction anybody can check.
- **Utilisation is measured per practitioner against their own rota**
  (Marcus 18480m, Dana 9240m, Priya 9240m — 36960 rota minutes), and the
  percentage is computed from the minutes it prints. Book a 60-minute visit and
  booked minutes move 1050 → 1110; cancel it and they come back, with the time
  reported as cancelled rather than quietly lost.
- **The no-show rate is the counts it was computed from** — 12.1% of 33
  kept-or-missed, not a separate number that can drift from them.
- **Recalls count from the last completed visit**, not from the record being
  created: a client last seen 192 days ago against a 180-day window is overdue by
  12 days, and their own consent decides whether the practice may chase them
  (reachable 0 · without consent 1).

### Leaving with the numbers

CSV export per report, with a filename a bookkeeper can keep
(`revenue_2026-09-15_2026-10-14.csv`), a row count that matches the file it
promised, and money as a decimal a spreadsheet understands (Dana Whitfield
1968.33). Every export writes an `report.exported` audit row naming the window
and the row count. The front desk can read the practice's numbers and take a
recalls list away to work through; the API refuses a view or an export kind it
does not have, and says which exist.

---

## 2. What the phase shook loose

Reports read **every** record P1–P6 create, which is why building them found
things the earlier phases never touched.

### The workspace had one name per job, finally

The practice layer seeded its own price list ("Quick check", "Installation
visit", "Support consultation") while the demo diary had been writing the
receptionist's words into appointments since P2 ("Checkup", "Installation",
"Site visit"). The result was two vocabularies in one workspace: appointments
that credited a service nobody could be rostered onto, and a booking page with
duplicates of the same job.

Fixed by `scripts/align-demo-vocab.ts` — an idempotent repair (dry-run by
default) that merges aliases and duplicates onto the oldest row, adopts the
diary's name and duration, repoints every appointment, invoice line and roster,
and never deletes a booking, invoice or note. Applied: 10 services / 7 job types
→ **7 services, one name per job**, 12 appointments + 1 invoice line repointed,
3 services rostered. Re-running it says "nothing to do". `seedPractice()` now
refuses to seed a workspace that already has a flag, providers or services, so a
second vocabulary cannot grow back.

### A real defect in the clash engine

The public booking page refused slots it had just offered, with the "that time
was taken while you were filling the form" message. It was not the slot and not
the clash guard's intent — it was `isFree` comparing each candidate appointment
against *the first busy block it could find for that practitioner* instead of
against the block belonging to that appointment. Two appointments days apart
were enough to invent a conflict in between. `busyFrom` now tags each block with
the booking it came from, and the check compares like with like. Manual probes
that had been "unexplained" for a whole session became reproducible and then
green.

### The offered slot did not say where it was

The public availability payload dropped `locationId`, so a visitor (or a script)
echoing the slot back to the booking endpoint posted a site the time was not at —
answered with the same misleading clash message. Slots now carry the site they
are at (the site list is already public on that page), which is what the page
itself needed in order to book what it showed.

### Gates that were asserting the wrong things

- `practice_check.py` asserted the pre-merge service names; it now reads the
  workspace's own vocabulary **and** holds the two invariants that keep the split
  fixed: no two services share a name, and every service on the list is offered
  by somebody.
- `client_check.py` picked the first 30-minute service in the list and booked it
  with the first active practitioner, who may not offer it; it now picks a
  service that practitioner is actually rostered for.
- `booking_check.py` fetched availability unfiltered and posted with a site of
  its own choosing; it now books the slot where the slot is, and walks forward to
  the next free time rather than failing on a race it created itself.
- The suite tripped the product's own sign-in limiter (10/minute) when run twice
  back-to-back, because six gates logged in from scratch every time. All gates
  now share one cookie cache keyed per identity, so a repeat run signs in zero
  times. The limiter is product behaviour and was left alone.

---

## 3. Where it lives

- `lib/server/reports.ts` — `rangeFrom`, `revenueReport`, `utilisationReport`,
  `attendanceReport`, `costsReport`, `attributionReport`, `recallReport`,
  `reportsOverview`, `exportReport` + `toCsv`. `splitExact` is exported from
  `lib/server/money.ts` (a module never imports its importer).
- `app/api/v1/reports/route.ts` — one endpoint,
  `view=overview|revenue|utilisation|attendance|costs|attribution|recalls|export`,
  with `preset|from|to|days|limit|recallDays`; CSV answered with
  `content-disposition` and `x-report-rows` / `x-report-range`, audited.
- `app/dashboard/reports/page.tsx` — seven tabs, window controls, export button,
  revenue trend sparkline. Reports sits in the dashboard shell.
- `lib/docs-content/api-reports.ts` — the API page for it.
- `recallDays` (default 180) on `PracticeProfile`, so "overdue" is the practice's
  word, not ours.

## 4. What it does not do yet

- No PDF export — CSV only, deliberately: a PDF that pretends to be a financial
  record is worse than a spreadsheet a bookkeeper can reconcile.
- Reports are computed on read against the whole workspace, which is right for a
  practice of this size and would want a rollup table at a much larger one.
- Recalls are a list with consent state; the chasing itself is P4's messaging
  engine plus a human deciding to press send.

---

**P7 closes.** Next per §7: **P8 — multi-location + team** (locations/rooms in the
diary, role management UI, internal staff board, import/export finishers), done
when two locations run in one workspace without data leaking across them.
