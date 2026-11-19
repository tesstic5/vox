# What Voxera can actually do

**Current implementation note (2026-09-20):** Google/GitHub sign-in remains disabled until a real callback is implemented and verified. Platform admin, sales leads and growth require an explicit `VOXERA_OPERATOR_EMAILS` allowlist; an empty list grants nobody access. The unsafe raw document route is retired and the remaining dashboard bridge is role/tenant constrained. The four workspace profiles, owner-selected modules and contractor workflow are shipped. The UK allied-health Phase 1 clinical/document foundation is also implemented at the synthetic/local boundary; see `README.md` and `docs/phase-1-implementation-status.md` rather than treating the older inventory below as release authority. Real patient data remains prohibited pending the listed external gates.

Ground rule: everything below is a route, a page, a tool or a table that exists in the build. Where something is *shaped* but not *live* (an export instead of a two-way sync, a sandbox instead of real settlement), it says so in the row. Nothing here is aspirational.

**How to read it:** plain sentence = what a person does. *Code* = the thing behind it.

---

## 1. It answers the phone and runs the appointment

The assistant on a live call has these tools (`lib/server/booking-tools.ts`):

| Tool | What actually happens |
|---|---|
| `check_availability` | Reads the real diary — rota, holidays, buffers, existing bookings, room availability — and answers with the **sites** each slot can be taken at (`at`, `siteId`). |
| `book_appointment` | Writes the appointment: client matched or created, practitioner, service, site, **room picked free**, clash-checked, duration from the service. |
| `reschedule_appointment` | Moves it, re-picking the room and re-checking the practitioner's own hours; it cannot land on top of another booking. |
| `cancel_appointment` | Cancels it and cancels any reminders queued for it. |
| `send_confirmation` | Texts/emails the confirmation, with a calendar invite attached (`.ics`). |
| `draft_note` | Writes a draft clinical note; a person finalises it. |
| `create_payment_link` / `payment_status` | Makes a pay link for a balance and reads back whether it has been settled. |
| `transfer_call` | Hands the call on: to the next assistant in a squad (the brief is written into the transcript), or, if there is no next member, forwards it to the number's target. |
| `lookup_order` / `order_status` | The generic-commerce variant of the same idea (used by the support assistant). |
| `practice_report` | Answers a member of the team about the practice — appointments, attendance and no-shows, how busy the diary was, where bookings came from, recalls, the calls handled, and the money (owner/admin only). Gated on who is asking: a mobile on file, or the signed-in role on a dashboard call. |

Around the call: inbound and outbound telephony, number purchase or bring-your-own carrier (credentials encrypted at rest and verified on connect), live transcript, per-call cost attribution, a recording *window* (see "deliberately not" below), and an outbound dialler with attempt budgets, quiet hours and do-not-call enforced by the dialler rather than by a prompt.

**Honest detail:** the demo runs the rules engine, not a model (`engine:'rules'`). With provider keys set, the same loop runs against a real model — the tool calls are identical either way.

## 2. The practice: diary, people, places, hours

- **Diary** (`/dashboard/calendar`) — day · 3-day · work-week · week. Drag to move, pull the bottom edge to extend, click to act. Filters by practitioner and by site; rows carry the room and the site.
- **Practice setup** (`/dashboard/practice`) — tabs for Diary · practitioners · services · locations · hours & rules · online booking. Everything the AI books against is edited here and nowhere else.
- **Availability engine** — one source of truth (`lib/server/availability.ts`): weekly rota, holidays, one-off changes, buffers, per-practitioner timezones, and rooms. `isFree` is what both the diary and the agent ask.
- **Rooms & sites** — rooms belong to a site, a room holds one visit at a time, and a booking knows its room. **Strict site filtering: a diary filtered to one site never shows the other's rows, and never shows an unfiled row** (the leak we fixed).
- **Classes and group appointments** (`/dashboard/classes`) — a service with a capacity of 2 or more is a **class**; the desk schedules **sessions** of it (instructor, site, room, seats, optionally a weekly run) and the public page offers the **places left** beside the services. A *seat* is an ordinary booking carrying a `sessionId`, so reminders, confirmations, money, the timeline and the client's own link all work on it untouched — while the **session, not the seat, occupies the diary**: it blocks the instructor and the room for its length (even with nobody joined yet), the availability search never offers that hour, and a private appointment cannot be booked on top of it. Capacity is a wall — a full class refuses in words that name it, joining twice returns the seat you have rather than a second one, and a place can be **given up from the client's own link right up to the start** (the seat goes back to the class) but never *moved*, because one person out of a group into a private hour is a different appointment. The diary draws one block with its count (`3/8`) and the desk board lists today's classes with how many are here. **The register** runs the class itself: the roster counts who is here in words (`2 of 8 here`), each place has its own **Arrived · Done · No-show · Undo** control, **Everyone's here** marks the whole roster arrived in one tap, and those movements are ordinary booking transitions — so a seat that is done feeds attendance, the reports and the client's timeline exactly like a private visit. Attendance is counted where the money is: **a class hour is counted once** in utilisation and free time, however many places were sold in it, while each attended place is counted once per client — the hour is the resource, the place is the visit. A place is not a slot: giving a seat back never offers it to the wait-list, and the manual offer screen refuses a class hour in words (`That is a place in a class, not a slot`), because the thing a class sells cannot be sold to somebody who wanted a private appointment. Cancelling a session releases every place, texts everyone holding one, and returns the hour to the diary. Docs: `/docs/guides/classes`; gate: `scripts/class_check.py` (74 checks); walk: `scripts/class-ui-pass.mjs` (23 checks, stages its own classes).
- **A full class has a line, and a place goes to the front of it** — the public page keeps a full class visible and says *Full — join the wait list*; joining takes a name and a number and answers with the **position** ("You are first in line for a place in this class"), never a charge. At the desk the same line is a panel on the class: who is in it, in order, and what is offered and until when. Give a place back (`remove-seat`) — or have a client give it up from their own link — and the **front of the line is texted a one-tap claim link**: one place, one person, because a chair offered to five people is four "sorry, that went" texts. The text is its own kind (`class_offer`), so it says *a place has come free* rather than *first to take it gets it*. A class with places left refuses the line in words ("take one instead of waiting for it"); an offer lasts 4 hours at most and never past the start; a lapsed one goes back in the queue; a cancelled class withdraws its offers and closes the line once. A class entry is never touched by the slot machinery — the desk offering it a private time is a `409` naming the class. Gate: `class_check.py` §8b; walk: `class-ui-pass.mjs` §4.

- **Repeat series, wait list, statuses** — `pending → confirmed → arrived → completed | cancelled | no_show`, plain-word rendering ("Not confirmed yet", "Did not attend"). A wait-list entry holds a window (a day, a date range, or by practitioner and service) and, when a time in it frees, the entry is offered that time and books it with one tap.
- **Privacy mode** — flips the grid to masked client names for a screen a client can see.

- **One clock per grid.** The all-sites view takes the practice's own timezone (the filtered site's, else the first site by name — the same rule the reports use), buckets days on DST-safe local midnights, and measures every block against that clock, so what the grid draws and what a drag writes back are the same instant.

## 3. Clients and records

- Client records with a timeline, **alerts** (allergies-ish flags a receptionist must see), **consents**, and a **per-record access log** (`/api/v1/clients/[id]/access`) — who opened whose record, when.
- Server-first: practice records are read from the server on every visit and never cached in the browser — enforced by a script (`scripts/privacy_check.ts`), not by convention.
- CSV **import** (dry-run first, reports what it would do) and CSV **export** for clients and appointments.

## 4. Notes

- Templates per service, an editor with **incomplete flags**, attachments, **finalise → amend** (a finalised note cannot be silently edited, it gains an amendment version), and RBAC: a receptionist cannot open a clinical note.

## 5. Messaging and reminders

- SMS + email, templates, and the rules that send them: reminders at T-minus N, follow-ups after a visit, no-show chasing.
- A real **scheduler** drives the queue (`lib/server/scheduler.ts` → `deliverDueMessages`), with a **sending window** — nothing goes out at 3am because a rule said so.
- Delivery receipts come back and land on the message. Cancelling an appointment cancels its queued reminders.
- **A reply does what the text promised.** `C`/`yes`/`ok` confirms their next appointment; `no`/`cancel` cancels it with the reply as the reason; a day or a time ("Thursday instead?") is filed as a change request for a person — never guessed at. Everything else is answered and queued for the desk on **Messaging → Replies**, where it can be ticked off. Every reply is written into the client's own thread.
- **Reminders can never describe a time that has moved.** Move an appointment and a pending reminder is re-rendered and compared; when the words no longer fit the diary the row is withdrawn and a fresh one is queued.

## 6. Money

- **Class packs** (`lib/server/packs.ts`, design signed off in `PLAN-CLASS-PACKS.md`) — a bundle of class places paid up front ("10 × Yoga for $200"), priced per class service in Practice setup's Classes page and sold from the client record. Buying records a **prepayment fenced to the pack** — no invoice exists until a class happens, and ordinary on-account credit can never spend pack money (nor a pack place settle from anything but its own pack). Booking a seat **holds** a place (soonest-expiring pack first); the register spending it is the ordinary status lifecycle: **attendance spends** (an invoice at that place's share of the price, settled instantly from the pack), a **late cancel (inside 2 hours, the client's-link window) or no-show burns**, an **early give-back releases**, **undoing the register mark un-spends** (invoice voided, money back in the pack), and the practice cancelling a session releases/un-spends — never burns. The roster shows `on pack` / `pack · spent`; the client's own link says the place comes off their pack and how many are left. Desk actions after the sale are reasoned and audited: **extend**, **transfer** the remaining places (the money moves with them), **refund the unspent, unexpired places** at per-place value (held places block it). Expired places are never spendable or refundable. The Money overview carries the liability line — money held for undelivered places — which becomes revenue place by place as classes are attended. The phone assistant cannot sell or refund a pack (money movement stays with people). Gates: `scripts/pack_check.py` (29 checks); walk: classes page packs panel + client record (screenshots `screenshots/class-packs.png`, `client-packs.png`).
- **Invoices from visits** — lines, quantities, discounts, taxes, in **integer minor units** (no float drift, and shares split by largest-remainder so a total always adds up).
- Lifecycle **draft → issued → paid / part paid / overdue / cancelled(void)**, with the plain-word labels in the UI.
- **Payments, part payments, refunds, prepayments, credits, statements, expenses, payment types**, provider revenue.
- A public **pay link** (`/pay/{token}`) and a Stripe adapter that runs end-to-end in sandbox with no keys.
- **Xero-shaped export** — see "deliberately not" for what that is not.

## 7. Reports — the owner's question, one screen

`/dashboard/reports`: revenue **by practitioner** and **by service**, appointments-vs-attended, **utilisation**, **no-show rate** (with the denominator shown), **recalls**, **where bookings came from** (phone/assistant, booking page, front desk, other system, imported), plus CSV export from the same rows the screen reads. **And the assistant reads the same figures out over the phone** — see `practice_report` above.

## 8. Online booking and the public surfaces

- **A booking page per workspace** (`/book/{slug}`) — service → practitioner → slot → details → confirm, with consents captured and rate limiting. A booking made there lands on the diary as a normal appointment with its source attributed.
- **The client's own link** (`/m/<token>`) — every confirmation and reminder carries it. What is booked, when, where, one button to confirm, and (up to two hours before) real openings to move to or a short list of reasons to cancel with. The token is *derived* from the appointment id and a secret — nothing stored, one appointment per link, a tampered one is a 404, and rotating the secret invalidates every link at once. A move through it goes through the same guards as a move at the desk (rota, clash, room, reminder reset, wait list), and a cancel records the client's reason and offers the freed slot to the wait list.
- **A freed slot is offered, not remembered** (`/offer/<token>`). Cancel an appointment — from the desk, from the client's own link, by text, or as a whole series — and the time is offered to the people whose wait-list window it falls inside, by name, by text or email, with **their own single-use link**. One tap books it; the desk sees the board of what is out right now and can take an offer back. An offer lives 4 hours at most (never past the appointment it is offering), at most 5 stand on one slot, and the ordered list wins rather than whoever replies first. If the time is gone before they tap, the page says so in plain words and shows the **live** openings — picking one books it in the same tap. Declining keeps them on the list and back in the queue; expiry does the same.
- **The desk can read the link out** — `GET /api/v1/bookings/{id}/link` returns the client's own reference and URL, so a phone call can end with *"I'll text you a link"* (or read it out) instead of a form.
- **Self check-in** — the appointment link opens **6 hours before** the start and stays open **1 hour after**: one tap says *"You are checked in — the desk knows you are here."* The diary goes to `arrived`, the staff board picks it up, and the record's access log and the audit trail both name it (`appointment.client_checkin`). Before the window opens the page says when it opens rather than offering a button that would fail.
- Public **pay link**, public **availability API** for a workspace, and a **web SDK demo you can talk to with no signup**.

## 9. The platform around it

- **Assistants** — versioned config (model, voice, prompt, tools, guardrails), publish/rollback, per-version history.
- **Squads** — groups of assistants handing off mid-call with a written handoff brief.
- **Tools & MCP** — register a function or an MCP server, then allowlist it per assistant; enforcement in the runtime, so an assistant cannot call what it was not granted.
- **Workflows** — the parts of a call that must not be improvised (identity checks, disclosures, lookups, and the failure path for each).
- **Knowledge** — documents/URLs retrieved from, with the answer traced back to its source.
- **Evals, simulations, playground** — score calls against a rubric with the human verdict kept beside the machine score; synthetic hostile callers; a live API playground.
- **Campaigns & batch calls** — pacing, retries, disposition per call, cost estimated before you dial.
- **Observability, analytics, logs, audit, notifications, billing** — latency breakdowns, cost attribution by assistant, every API request with its bodies, who-did-what-to-which-object, and an itemised bill (platform minutes, provider usage, telephony — never one number).
- **Team & roles** — owner · admin · developer · receptionist · practitioner · viewer, enforced server-side, with last-owner protection, session revocation, and a mobile per person so the assistant recognises them when they ring in.
- **Accounts and access** — self-serve signup and sign-in; password reset by a single-use 15-minute link that also ends every other session on the account; magic-link sign-in; and invitations that are a real emailed **7-day single-use revocable link** which sets the person's name and password and signs them in — with a one-time password kept as the read-it-out-over-the-phone fallback. Tokens and codes are **hashed at rest**, no endpoint reveals whether an address exists, and every step lands in the audit trail (`auth.reset_requested`, `auth.password_reset`, `auth.magic_link_used`, `auth.email_verified`, `team.invite_accepted`).
- **Email verification with teeth** — six digits, five tries, then an hour's lock that re-sending cannot clear. It is not decorative: **an unverified account can draft agents but cannot publish one, buy or import a number, or mint an API key** (`requireVerifiedEmail`). The dashboard says so in a banner, and the wizard offers the verify step instead of a dead end.
- **Keys, webhooks, carriers, numbers, orgs, security settings** — signed and retried webhooks, encrypted carrier credentials verified on connect, and several workspaces under one login.

## 9b. Sales: the enquiry becomes a lead

- **The Contact sales form stores the enquiry** (`POST /api/public/sales-lead`, validated, rate-limited per IP, honeypot for bots) as a lead in `salesLeads`, and emails it to `VOXERA_SALES_NOTIFY_EMAIL` when the relay is configured — best-effort, so a mail outage never loses the lead. It used to show a thank-you and store nothing.
- **A leads inbox** (`/dashboard/leads`, gate: `scripts/leads_check.py`) — the pipeline in counts (new · contacted · demo · won · lost), a filter per stage, and a working panel per lead: move it, assign it, add a note; every move and note is written into the lead's own log, and stage changes land in the audit trail. Access is gated to explicitly allowlisted operator emails (`VOXERA_OPERATOR_EMAILS`); an empty list grants nobody access, and an API key cannot read it.
- **The Analytics export button downloads a real CSV** of the rows on the screen (summary, by assistant, by intent, by day, per call). It used to toast "check your email" and generate nothing.
- **The whole workspace exports too** — `lib/server/workspace-export.ts` behind `GET /api/v1/workspaces/export` (owner/admin only, signed-in session only: an API key can never pull a workspace's data out), downloaded from Settings → Data & compliance. One JSON file with the workspace's own rows from every collection, runtime machinery excluded, and every value under a secret-shaped key (password hashes, tokens, key material) replaced with `[redacted]`, so the file is safe to hand over. The export itself is recorded in the audit trail (gate: `scripts/workspace_export_check.py`).
- **And the growth funnel** — `lib/server/growth.ts` behind `GET /api/v1/growth` and `/dashboard/growth`, operator-gated like the leads inbox: signed up → created an assistant → published → connected a number → first call → first booking → got paid, computed from each workspace's earliest rows, with the median time to first call (workspaces whose history predates the workspace row are left out rather than making it negative), the steepest drop named, and a twelve-week signup series. The demo workspace and workspaces with no owner (every probe fixture) are excluded so the funnel shows real customers (gate: `scripts/growth_check.py`). No tracking pixel anywhere.

## 10. Marketing site and docs

57 public pages — home, platform, solutions, industries, integrations, pricing, compare, customers, trust/security, legal, glossary, library, templates, blog, changelog, careers, status, sales. Docs are a real route tree, and the whole site is checked by scripts (521 prerendered pages, 0 broken links, sitemap complete).

---

## Deliberately not there (and why)

| Not there | What exists instead |
|---|---|
| Live Stripe settlement | A sandbox adapter that runs the whole flow with no keys |
| Two-way Xero sync | A Xero-shaped **export** |
| Recording *storage* | The recording window and metadata on the call |
| Real SMTP | The send path, with a local transport and the stub |
| Telehealth video, inventory, insurance clearinghouses, HL7/FHIR | Out of scope by decision (`PRACTICE.md` §9) |
| Second carrier driver | One carrier driver + bring-your-own credentials |
| Notes full-text search, template editor | Templates and finalise/amend, without the editor |

**How any of this is known to work:** `npm run check` runs the whole server-side suite (37 gates, 1,464 checks) and `npm run check:browser` drives the four screens a person actually uses in a real browser (125 checks) — the console sweep, the practitioner's day, the diary's drag gesture and the classes walk, which stages its own class. The demo workspace itself is seeded by `scripts/seed-demo-diary.ts` and held to account by `scripts/demo_check.py`: a month of visits on two sites, money in it, **two standing classes with people in them**, and every number on the reports screen computed from rows that exist.

**The gap that used to be here is closed:** the assistant can now report (P9). Ring the practice line from a number on the team's list and ask "how did we do last month?" — you get the same figures the Reports screen shows, spoken, and a caller the practice does not know gets a polite refusal with nothing leaked. The one piece of setup is that number: Team → the member's row → **+ mobile**.
