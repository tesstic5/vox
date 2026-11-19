# Voxera — P9: what the AI can answer

**Date:** 2026-10-15 · **Scope:** the last line of `PRACTICE.md` §8. The assistant could act — book, move, cancel, read one client's balance — but it could not *report*. "How did last month go?" was answered on the Reports screen and nowhere else, which is no use to the person most likely to ask it.

**Gate:** `scripts/report_tool_check.py` — **36 PASS / 0 FAIL**, plus the whole suite: **706 PASS / 0 FAIL** (14 gates + smoke), `privacy_check`, `nesting-check`, `linkcheck`, `sitemap-check` all clean.

---

## 1. What was built

One tool, `practice_report`, granted to the appointment assistant. It answers seven questions over nine windows:

| Topic | The question it answers |
|---|---|
| `revenue` | Billed, collected, still outstanding, collection rate — who earned most (owner/admin only) |
| `appointments` | How many on the books, how many seen, by practitioner, empty days |
| `attendance` | Seen, no-shows, cancellations, no-show rate with its denominator, against the previous window |
| `utilisation` | Busy % of the hours the team was open, with the practitioner split |
| `sources` | Where bookings came from, and the assistant's share of them |
| `recalls` | How many clients are past the recall interval and how many can be contacted (counts only) |
| `calls` | The calls it **handled versus the ones it did not** (§8's own words): handled, transferred to a person, failed, minutes, appointments produced |

Windows: today · yesterday · this week · last week · this month · last month · last 30 days · last 90 days · this year — resolved on the **practice's** calendar, so "last month" means the practice's last month and not UTC's.

## 2. The three rules it is built on

1. **The figures are computed once.** Every number comes from the same functions the Reports screen calls (`reports.ts`, `attributionReport` for call outcomes). A spoken figure and a screen figure cannot drift apart, because there is only one calculation. The gate asserts this: last month's billed total on the phone equals `/api/v1/reports?view=revenue` to the cent.
2. **Aggregates, never records.** No client name, no client's balance, no clinical content — not even to the owner. A phone call can be overheard in a waiting room; the screen is where names belong. The gate fetches 42 client names and asserts none of them appears in any answer.
3. **Identity decides scope.**

| Who is asking | What they get |
|---|---|
| A number the practice knows (a login's mobile, or a practitioner's) | The practice's numbers |
| …and the login is **owner** or **admin** | …including the money |
| …a **receptionist** or **practitioner** | The diary numbers — `utilisation`, `appointments`, `attendance`, `sources`, `recalls`, `calls`. Asking about money gets: *"I can share the diary numbers with you, but the practice's money is owner and admin only."* |
| A call placed from the dashboard | Answered as the signed-in person — their role, no number needed |
| Anybody else | *"I can't share the practice's figures on this line — they're for the team."* and no figure at all |

Every read (`report.read`) and every refusal (`report.denied`) is written to the audit trail with who asked, what they asked and whether they rang in or were signed in.

## 3. How a practice turns it on

**Ring in from a number the practice knows.** That is the whole setup:

- **Team → a member's row → `+ mobile`** sets the number. The invite dialog takes one too. Numbers are normalised to E.164, one number can belong to one person (the API 409s a clash), and a number that could never match a live call is refused rather than stored.
- New workspaces get the tool and the grant automatically at boot; existing ones get it through the same idempotent upgrade path that has carried every practice tool since P1.

The Reports screen now points at it: a line above the tabs saying the assistant can read the figures out, with a link to the team list where the numbers live.

## 4. What the check proves (36 assertions)

- The grant is real: the tool is on the assistant **and** in the workspace's tool registry with a description a person can read.
- The owner's number goes on file through the API; the team screen shows it; a bad number is refused (400); a duplicate number is refused (409).
- The owner rings in: the question is answered, the topic is money, the numbers match the screen, and **the sentence it speaks contains the figure** — the gate asserts the reply text, not just the tool result.
- Six further phrasings route to the right topic — "how many did we see last month", "what's our no-show rate", "how busy were we last week", "where did our bookings come from", "who is overdue for a recall", "how many calls did we handle".
- Call outcomes match `/api/v1/reports?view=attribution` exactly (handled 410, transferred 13), and the sentence distinguishes what the assistant handled from what it did not.
- A stranger asking the same question is refused in a sentence, and the refusal carries **not one digit**.
- The receptionist gets utilisation, is refused money, and is told what they *can* have.
- A dashboard call answers as the signed-in person.
- 42 client names: none appears on any topic.
- 22 reads and 3 refusals are in the audit trail, each naming what was asked.

## 5. Defects found and fixed on the way

1. **"How did we do?" was classified as an appointments question.** The intent rules only knew the *formal* vocabulary ("revenue", "no-show rate"), not the sentence an owner actually says. Three patterns were too narrow: `how did we do`, `what did we bill`, `where did bookings come from`, `how many calls`, `who is overdue`. All widened; the topic extractor was widened with them.
2. **A question that never reached the tool at all.** "What did we bill last month?" matched the *billing* intent (the client-balance path) because `bill` is a billing word. The report patterns now take first-person-plural phrasing ahead of it — "how much do **I** owe" is still a client's balance; "what did **we** bill" is a report.
3. **A gate assertion that assumed the wrong order** — it checked the team listing for a `phone` field *before* setting one. The gate now sets the numbers first and then asserts the screen shows them.

## 6. Files

**New:** `lib/server/report-tools.ts` (the tool, the identity rules, the ranges, the sentences) · `scripts/report_tool_check.py` (the gate).

**Changed:** `lib/server/agent.ts` (report intent + patterns, the scoped and unscoped planning, the spoken reply, a safe answer when there is no workspace behind the call) · `lib/server/auth.ts` + `lib/server/team.ts` + `app/api/v1/team/route.ts` (`phone` on a login, `normalisePhone`, `setMemberPhone`, the `phone` action) · `app/dashboard/team/page.tsx` (a mobile per member, in the invite and on the row) · `lib/server/bootstrap.ts` (the tool, its description, and the grant — new workspaces and upgrades) · `lib/server/calls.ts` + the two turn routes (a dashboard call knows who placed it) · `lib/server/booking-tools.ts` (the tool context carries `viewer`) · `app/dashboard/reports/page.tsx` (the hint that points at the phone) · `scripts/ai-stub.ts` (a scripted model that asks for the report, so the hosted path is exercised too).

**Backups:** `data/backups/voxera-db.before-tidy-2026-10-15T11-01-38-492Z.json`, plus the earlier `before-p9-tidy.json`.

## 7. What this leaves

§7's table in `PRACTICE.md` now ends at **P9**, and §8's last line is true rather than aspirational. The remaining work is documentation rather than product: **API reference pages** for notes · money/invoices · team·board · import-export, which the docs do not cover yet. The decided-outs and §9 non-goals stay decided out.
