# Voxera practice management — Phase 5 build report

**Notes.** Built 2026-10-13, verified against a production build (562 prerendered
routes) with the app running on `:3000` and the carrier stub on `:4010`.

The phase gate from `PRACTICE.md` §7, L85:

> A finalised note cannot be edited without an amendment version; a receptionist
> cannot open it.

Checked by `scripts/notes_check.py` — 55 checks. Both halves of the sentence are
proven directly, and the machinery each half needs (templates, incomplete
sections, attachments, a per-record access log) is proven with them: a gate that
only tested "editing is refused" would pass on a module that refused everything.

---

## 1. What landed

### A note is a record, not a text box

| Piece | Where | Behaviour |
|---|---|---|
| The module | `lib/server/notes.ts` | `NoteDoc` — client, appointment, service, provider, template, sections, version, signature, versions[], attachments, retention. Every write audits and appends to that note's own access log |
| The list | `GET /api/v1/notes` | `stats{}`, `vocabulary{}`, filters `clientId` / `bookingId` / `status` / `include=archived`; `?view=templates` returns the templates in this workspace's vocabulary |
| One note | `GET /api/v1/notes/{id}` | `{note, versions, access, audit}` — the whole record and its history in one read |
| Writes | `POST /api/v1/notes` | `create · update · finalise · amend · archive · restore · attach · detach`. Action-style bodies, the same shape P4's routes use |
| On the client | `GET /api/v1/clients/{id}` | notes travel with the record they belong to, redacted when the role may not read them |

The version chain is the point: **draft** (freely edited) → **finalise** signs it
(a person, named, at a time) → changing a signed note means **amend**, which
requires a reason, reopens it as a draft at `version + 1`, and keeps the signed
snapshot byte-for-byte in `versions[]`. There is no path that overwrites a signed
note; the refusal is in the module, not in one screen, so every door honours it.

### Templates, per service

`seedNoteTemplatesForOrg` writes one general template plus one per active
service, from the workspace's own term pack (`clinical`, `service`, `generic` —
this workspace says "job note"). Sections carry a label, a prompt for the writer,
and whether they are required. A note for a service is written in that service's
template; service-specific beats general. Seeding is idempotent and also runs on
read, so an older workspace tops itself up the first time somebody opens the
Notes tab.

### Incomplete is a visible state, not a silent one

Blank required sections are named (`incomplete: ["Attended", "Work carried out"]`)
and listed while writing. **Finalising is refused while any required section is
blank**, and the refusal names them. The dashboard shows the same thing on the
row and disables the sign button rather than letting someone sign a half-written
record and discover it later.

### The agent drafts; a person signs

`draft_note` is in the appointment assistant's tool set. When a call about an
appointment ends and the agent holds that tool, `endCall` files a draft — tied to
the appointment, the client and the call, marked `draftedBy: 'agent'`, never
finalised, once per call (a retry or a backfill cannot file a second one, and a
call where nobody spoke files nothing). When the agent drafted mid-call, before
the call's own summary existed, **the summary is filled into that same draft when
the call ends** — the note stays unsigned either way. The only thing an AI can do
to a record here is start it.

### RBAC: the desk sees that a note exists, not what it says

`NOTE_READ_ROLES = owner · admin · developer · practitioner`. A receptionist or
viewer gets `redactNote()` — existence, status, version, who signed it, how many
sections and attachments, and what is still missing — and **no body, no sections,
no preview, no attachment names**. Write follows read. A refused open is
recorded in the workspace audit trail as `note.read_refused`, because "somebody
tried to open a record they may not open" is exactly the event a records system
should keep.

The demo workspace now has a front-desk login — `desk@northwind.dev` /
`demo-password-2026`, role `receptionist` — so the rule is watchable rather than
claimed: sign in as the desk, the note row is there, the content is not.

### Attachments, archiving and retention

Attachments are recorded against the note (name, bytes, content type, sha256,
100 MB cap, who and when) — the same register-only model the platform uses for
files, with a zero-byte upload refused. Archiving is a soft delete that keeps the
note, stamps `retentionUntil` (7 years, `DEFAULT_RETENTION_DAYS`) and drops it
from the everyday list; restoring brings it back *as it was* — signed stays
signed.

### The demo opens on a real pair

`POST /api/bootstrap` now returns `demoNotes`. On a workspace with completed
appointments it writes up the most recent one and signs it as the practitioner on
the roster, and then **rings** the next one through the real runtime — the call
ends, and the agent's own draft appears on that appointment. The demo therefore
shows both states honestly: one signed note with a frozen v1, one unsigned draft
from a call, with a section still blank.

---

## 2. Verification

`npx tsc --noEmit` clean · `npm run build` clean (562 prerendered routes) · the
whole suite run against that build with the app live:

| Gate | Result |
|---|---|
| `scripts/notes_check.py` (P5 gate) | **55 PASS / 0 FAIL** |
| `scripts/messaging_check.py` (P4 gate) | 77 PASS / 0 FAIL — run twice, green both times |
| `scripts/booking_check.py` | 40 PASS / 0 FAIL |
| `scripts/client_check.py` | 44 PASS / 0 FAIL |
| `scripts/practice_check.py` | 42 PASS / 0 FAIL |
| `scripts/carrier_check.py` | 49 PASS / 0 FAIL |
| `scripts/api_check.py` | 38 PASS / 0 FAIL |
| `scripts/book_check.py` | 31 PASS / 0 FAIL |
| `scripts/smoke.py` | 59 PASS / 0 FAIL |
| `scripts/privacy_check.ts` | ALL PASS — 266 bundles, 80 fingerprints, no record in a shipped bundle |
| `scripts/nesting-check.py` | 518 prerendered pages, no invalid nesting |
| `scripts/linkcheck.py` | 518 static routes, 0 unresolvable targets |
| `scripts/sitemap-check.py` | 472 entries, every indexable route listed |

What the P5 gate actually proves, in order: templates seeded per service; a probe
visit written up in the service's own template; finalising refused while required
sections are blank, with the sections named; a person's signature freezing v1;
**a finalised note refusing an edit (409) and pointing at amendment instead**; a
signed version surviving the attempt unchanged; an amendment without a reason
refused; amendment reopening at v2 with the reason on the record; re-signing
leaving `[amended, finalised]` in the trail with the two bodies different;
attachment registration and detach; the agent's draft appearing at call end,
linked to its call, unsigned, once per call; the note's own access log; the desk
seeing the row but **403 on the note** (read and write), the client record
agreeing, and the refusal landing in the audit trail; archiving keeping the note
with a retention date; restore returning it signed.

Live checks on the rebuilt app: `/dashboard`, `/dashboard/clients`,
`/dashboard/clients?tab=notes`, `/dashboard/calls`, `/dashboard/messaging` all
200; the demo's two seeded notes visible to the owner (`1 signed by Dana
Whitfield, 1 agent draft from `call_c240558028e4` waiting on a signature`) and
restricted to the desk.

Tidy: `scripts/tidy-probe-orgs.ts` dry-run → `--apply` → re-run "nothing to do".
The tidy learned one thing in this phase: a sweep that removes a probe client now
takes that record's notes with it, so a removed appointment cannot leave a note
behind pointing at nothing (2 probe notes removed; the seeded pair untouched).

---

## 3. Defects found while building P5, and fixed

Found by the gate and the suite, not by reading:

1. **The agent could not actually draft.** `draft_note` was on the assistant and
   in `TOOL_SCHEMAS`, but the `tools` collection had no such row — and
   `assistantConfig()` builds the live tool list from that collection. So
   `endCall` saw an assistant that could not keep notes and filed nothing. The
   gate caught it as "0 agent note(s)". Fix: `draft_note` is in the seeded tool
   catalogue and in `upgradeBookingTools`'s `WANTED` filter, so existing
   workspaces get the row idempotently on the next bootstrap.
2. **A stale process passed itself off as the build.** The first gate run after
   the sandbox reset ran against an app started *before* two rebuilds; the draft
   path simply was not in it. Nothing in the check output said "old server" —
   the fix is discipline (rebuild → restart → then check), and the note in
   `PRACTICE.md` §11 that a phase gate is run against the build it names.
3. **A blank mid-call draft pre-empted the good one.** If the rule engine called
   `draft_note` during the call, that thin draft was the one `endCall` then found
   and left alone — so the record kept "No details were captured on the call."
   Fix: `ensureDraftNoteForCall` fills the call's summary into a draft that is
   still blank, and never touches one a person has written in.
4. **A desk list with nothing to sign is a desk list that proves nothing.** The
   first version of the desk check asserted a signer on the newest row; the
   newest row was correctly an unsigned draft. The check now asserts both states
   at once — signed rows carry a signer, unsigned rows do not — which is what the
   desk actually needs to see.
5. **`undefined` is not a JSON key.** An assertion of the form
   `'signerName' in row` passed in the app and failed over HTTP, because
   `JSON.stringify` drops undefined fields. Assertions on optional fields must
   read the value, not test key presence.
6. **Two icons that do not exist** (`Icons.file`) took tsc down; `EmptyState`'s
   icon prop is `keyof typeof Icons`. Caught by `npx tsc --noEmit`, fixed before
   the build.
7. **`Doc`'s index signature bit the module again** — untyped fields infer `{}`,
   so `.length`, spread and `.find` all fail. The module now casts at the read
   site (`(doc.attachments as NoteAttachment[] | undefined) ?? []`).
8. **`npx tsc` with no `node_modules` is a trap** — it installs the deprecated
   `tsc@2.0.4` package and "checks" nothing. The sandbox reset wiped
   `node_modules` mid-turn; the real sequence is install → typecheck → build.

One environmental anomaly, recorded for honesty: the first post-reset
`messaging_check.py` run reported 7 failures, all downstream of a queued reminder
that never left `pending` (nothing reached the carrier stub or the mail relay).
It did not survive a clean rebuild and restart: the same gate is 77/0 on the
current build, run twice. Nothing in P5 touches the send path, and no failing
check pointed at a code path P5 changed.

---

## 4. API added in P5

```
GET  /api/v1/notes?clientId=&bookingId=&status=&include=archived   list + stats + vocabulary
GET  /api/v1/notes?view=templates[&include=inactive]               templates, per service
GET  /api/v1/notes/{id}                                            note + versions + access + audit
POST /api/v1/notes  { action: create|update|finalise|amend|archive|restore|attach|detach }
```

Read: every role, redacted below practitioner. Write: owner · admin · developer ·
practitioner. `update` on a finalised note → `409 CONFLICT`. Incomplete
`finalise` → `400` with the missing sections named. Refused read → `403` **and**
a `note.read_refused` audit entry.

Agent-facing: `draft_note` (`summary` required, `content` optional) — drafts only,
never signs.

---

## 5. Deliberately not done in P5

- **Notes are not in `/docs/api`.** P4's precedent was to document the new
  webhooks; the notes API is a bigger page than a P4 webhook and is not part of
  this phase's gate, so it is flagged here rather than added quietly. Say the
  word and it lands with P6's docs pass.
- **No full-text search across notes.** `list` filters by client, appointment and
  status. Search is a P7 (reports) problem because the index and the
  redaction rule have to be designed together.
- **No note templates editor in the dashboard.** Templates are seeded and
  per-service; editing the section list is a settings screen, not a records
  control, and nothing in the gate needs it.
- **No file bytes.** Attachments are registered, not stored — the platform's
  existing file model, unchanged since P1.

---

## 6. State after P5

- **`lib/server/notes.ts`** (types, templates, RBAC + redaction, draft →
  finalise → amend, attachments, audit + access log), both routes, `draft_note`
  in the booking tools and the tool schemas, notes on the client record, and the
  Notes tab + editor in `app/dashboard/clients/page.tsx`.
- **Demo workspace:** 5 note templates (1 general + 4 per service), 2 notes —
  one signed by Dana Whitfield, one agent draft from a real call awaiting a
  signature — and the front-desk login for the access rule.
- **Suite green**, database tidied (32 clients, 29 appointments, 69 messages,
  151 outreach rows, 2 notes), app running on `:3000`, carrier stub on `:4010`.

`PRACTICE.md` §7 progress updated to P5 ✅.

---

## 7. Next — P6, money

The phase after this one is **P6 (Money)**: invoices from appointments,
lines/discounts/taxes, payment types, payments/refunds/prepayments/credits,
statements, expenses, provider revenue, a Stripe adapter with a sandbox, and a
Xero-shaped export. Its gate: *invoice → payment → statement reconciles; the
sandbox flow works with no keys*.

Nothing in P5 blocks it: a signed note is a finished record, and the money layer
reads appointments and services, not notes.
