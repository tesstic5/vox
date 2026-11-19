# Voxera — demo coherence + usability pass

**Date:** 2026-10-15 · **Scope:** the last open item in `PRACTICE.md` (§10 Risk 3) plus a friendliness pass over every screen P1–P8 built. Not a parity phase, so it is recorded as **U** rather than P9.

---

## 1. What you asked for

> "okay build this too and make sure everything is super user friendly and quite straightforward for users to use."

Two things: finish the demo-coherence work that was still outstanding, and make sure a clinic owner who is not a developer can use what we built.

## 2. Demo coherence — the demo workspace now reads as a practice

The problem was that the marketing site, the docs and the demo workspace were telling three different stories: new practice records (providers, rooms, sites) sat on top of a month of seeded appointments that had been written straight into the database on the *server's* clock. The result was visits at 2am San Francisco, appointments that belonged to no site, and rooms that no visit had ever used.

`scripts/seed-demo-diary.ts` fixes the workspace itself, not the screenshot of it:

- **A real month.** 324 appointments across 32 days, statuses that follow the clock (209 seen · 79 booked · 17 cancelled · 11 did not attend · 8 not confirmed yet), 195 invoices of which 150 are settled. Six days with no rota are left deliberately empty, because a practice that is closed on a Sunday looks broken if it is not. - **Every legacy row is sited.** The 25 old rows written before sites existed were matched to a practitioner and a room; 18 of them were moved into the first free *legal* hour for that practitioner (inside their rota, off their break, no double-booking). Nothing was deleted.
- **Two sites, one workspace.** Northwind HQ — San Francisco (Mission, Bay) and Northwind East — New York (Hudson). The served diary window reads 94 and 106 visits, and neither diary sees the other's rows — the gate checks both filters for leaks.
- **One vocabulary.** Services, providers, notes and invoices all speak the "practice" term pack; nothing in the workspace still says "appointment type" in one place and "service" in another.
- **Idempotent.** Running the seeder twice is a genuine no-op, per step, so it is safe to re-run before a demo.

**Gate: `scripts/demo_check.py` — 29 PASS / 0 FAIL.** It reads the *served* pages and APIs, not the database file: today's diary, the most recent finished day (12 of 12 attended), both sites populated and both site filters leaking zero rows, 40 sampled visits inside the practitioner's hours and off break, three rooms with zero double-bookings, money that reconciles (25,537.00 billed, 18,832.50 collected, nothing sitting in an unassigned bucket), revenue split by practitioner with nothing unassigned, booking-source attribution across five sources, and utilisation between 20% and 26% — busy, not full.

## 3. Usability pass — every screen answers "what is this, and what do I do next"

| Where | Was | Now |
|---|---|---|
| **Dashboard** | Only the agent wizard — a new owner was told to make an assistant before the practice existed | An emerald **practice checklist** sits first: seven steps (List what you do · Add the people who do the work · Set your opening hours · Name the rooms · Give the front desk a login · Turn on your booking page · Book something in), each with *why* it matters, a plain action name, and a link straight to the tab that does it. The agent card is retitled **"Get to a live call"** and follows it. |
| **Calendar** | Empty diary for a new owner looked broken; statuses read `no_show`, `arrived`, `partly_paid` | When the practice is not runnable yet, the empty state *explains* and offers the two buttons that fix it. Every status now reads in words a receptionist uses — **Not confirmed yet · Booked · Here now · Seen · Did not attend · Cancelled** — each with a hover hint. |
| **Practice setup** | One long page, no way to link to a section | Retitled **Practice setup**, with real tabs and `?tab=services\|team\|hours\|locations\|booking`, so the checklist can deep-link and the browser back button behaves. |
| **Money** | Invoice states were database words: `partly_paid`, `issued`, `void` | **Draft · Awaiting payment · Part paid · Paid in full · Overdue · Cancelled**, each with a sentence of explanation on hover (e.g. "Sent to the client, with the number on it. Nothing more to do until it is paid."). |
| **Reports** | Six tabs with no clue what each one answers | A one-line plain-English hint above the tabs on every tab. |
| **Team** | Roles and a permission matrix | Retitled **Team & roles**; the invite dialog and the member list already explained each role — that wording is now the house vocabulary, and the matrix reads against it. |

Every step of the checklist is also **proved, not decorative**: the new gate asserts each ticked step is backed by a row that actually exists (`services` → a service, `hours` → a rota, `rooms` → a room, `desk` → more than one login, …). A checklist that can lie is worse than no checklist.

**Verified against a genuinely new workspace, not the demo:** I signed up as `owner@newclinic.example` → **0 of 7 done, `empty: true`**, every step showing its action and destination, and the calendar reporting `ready: false` so it explains itself instead of looking broken. That probe workspace was then removed by `tidy-probe-orgs.ts` (backup: `data/backups/before-p9-tidy.json`).

## 4. The three failures I was chasing

All three were **the gates being wrong about a workspace that had grown up**, not product defects — and all three are now fixed in the gate, with the diary left as it is:

1. `practice_check.py` "renaming a room keeps the id its appointments point at" — it re-read `/api/v1/bookings?limit=400` to find its own booking. The list endpoint caps a page at 200, so once the diary held 324 rows the probe had fallen off the page. It now asks for its own `externalId`.
2. `book_check.py` "the dry run names who it would call" — the check created a campaign with the default `maxPerRun` while five bookings were due, so the booking it expected (`CHK-2`) fell outside the run. The check now sets `maxPerRun: 50`, which is what "who it *would* call" means.
3. `book_check.py` "a booking is not called twice for the same version" — the same cap made the *second* run dial five rows and look like a repeat. Same fix; the check is now genuinely about versions, and it asserts the cleanup too (it deletes its own `CHK-*` rows by id rather than by paging). It does now prove the real property: run twice, dial once.
4. A fourth, found by running the suite cold after the tidy: `demo_check.py` read the revenue table's **Unassigned** row, which a *probe* left behind on this run. The demo's own story is about named practitioners, and that is what the gate asserts now — the size of Unassigned was already bounded by the check above it, so nothing was weakened.

## 5. The suite, green

Run against the production build with all probes applied:

```
demo 29 · practice 56 · practice_team 68 · reports 52 · money 73 · notes 55 ·
messaging 77 · booking 39 · client 44 · api 38 · carrier 49 · book 31 · smoke 59
                                                          TOTAL = 670 PASS / 0 FAIL
```

Plus `privacy_check` (all pass — practice records never reach the browser cache), `nesting-check` (522 prerendered pages, no invalid nesting), `linkcheck` (522 routes, 0 unresolvable targets) and `sitemap-check` (473 entries, every indexable route listed). Nothing was added to the diary to make a number work; nothing was softened to make a check pass.

## 6. What is genuinely left

Nothing outstanding in the practice layer from this pass. Still open from the wider list, in the order I would do them:

1. **Give the AI a reporting tool** (§8) — today the assistant can book, move, cancel and answer about one client, but it cannot answer "how was last month?".
2. **API reference pages** for notes · money/invoices · team·board · import-export — the docs cover P1–P4's surface only.
3. The decided-outs and §9 non-goals stay decided out (recording storage, SMTP, live Stripe settlement, telehealth video, insurance clearinghouses and so on).

## 7. Files that matter

- `scripts/seed-demo-diary.ts` — the seeder (dry-run by default; `--apply` writes).
- `scripts/demo_check.py` — the 10-section demo gate, including the new "the guidance tells the truth" section.
- `scripts/book_check.py`, `scripts/practice_check.py` — gate fixes above.
- `lib/server/practice-setup.ts` — the seven steps + `practiceIsRunnable`.
- `app/dashboard/page.tsx`, `app/dashboard/practice/page.tsx`, `app/dashboard/calendar/page.tsx`, `app/dashboard/money/page.tsx`, `app/dashboard/reports/page.tsx`, `app/dashboard/team/page.tsx`.
- `components/ui.tsx` — `Pill` now takes a `title` so a state label can explain itself.
- Backups: `data/backups/before-demo-diary.json`, `…before-p9-tidy.json`, `voxera-db.before-tidy-2026-10-15T09-33-49-670Z.json`.
