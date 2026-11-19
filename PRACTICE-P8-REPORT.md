# Voxera practice management — Phase 8 build report

**Multi-location + team.** Built 2026-10-14, verified against a production build
(566 prerendered routes) with the app on `:3000`, the carrier stub on `:4010` and
the model stub on `:4020`.

The phase gate from `PRACTICE.md` §7, L88:

> Two locations run in one workspace without data leaking across them.

Checked by the new `scripts/practice_team_check.py` — **68 checks, 0 failures** on
a run that creates the locum, **66** on a repeat run (the invite-path checks only
count once), run twice back-to-back — and by the whole suite against the same
build: **639 checks across twelve gates, 0 failures**, also run twice. The four
static gates stay green: privacy, `nesting-check.py` (522 pages), `linkcheck.py`
(522 routes, 0 broken targets), `sitemap-check.py` (473 entries).

---

## 1. What landed

### A room is a record, not a label

Until this phase a room was a name inside a location, and the dashboard derived
its id from that name (`room_bay-room`). Renaming "Bay Room" to "Bay 1"
therefore *changed the id*, and every appointment already in it pointed at a room
that no longer existed: the diary could not say where the patient was meant to
be, and the clash check stopped seeing the room, so two visits could be
double-booked into the same four walls.

Rooms are now records with ids of their own (`/api/v1/rooms`: `create`,
`update`, `delete`, `?locationId=&includeInactive=`), the location carries only a
mirror written by one function (`mirrorRooms`), and the whole inline history
migrates itself on first read **keeping the same ids** — so no appointment lost
its room. Renaming is a rename. A room with visits still to come cannot be
deleted; it is retired (`active: false`) and history stays readable. The diary's
`Locations` tab adds, renames, retires, brings back and removes them.

Northwind runs two sites with three rooms: Mission + Bay at HQ, Hudson at East —
and nothing crosses between them.

### The diary says where to walk

The calendar now names the site and the room on the block itself, carries a site
switcher in the toolbar (only when there is more than one), and the diary payload
carries the room by name plus the list of sites it covers. A record id is no use
to a receptionist:

```
PASS  the diary names the room            — Mission Room
PASS  the diary names the site            — Northwind HQ — San Francisco
PASS  the diary offers every site it covers — Northwind East — New York, Northwind HQ — San Francisco
```

Room choice follows the same one-writer rule the rest of the diary does: a
booking takes a free room at *its* site; a move re-picks one at the new time; a
resize keeps the room and is no longer refused by the appointment itself.

### Team and roles, on the server

`/dashboard/team` + `/api/v1/team` (`view=members|roles|sessions`;
`invite|role|deactivate|reactivate|password|sessions:revoke`). Six roles —
owner, admin, developer, receptionist, practitioner, viewer — and a capability
table derived from the real allow-lists (`money.read`, `notes.write`,
`practice.config`, `team.manage` …), so the screen can never promise something
the server refuses. Adding somebody returns a **one-time** password (the hash is
all that is stored, and it is never handed back), the last owner cannot be
demoted or deactivated, nobody can deactivate their own login, and deactivating
or resetting ends that person's live sessions. Session-only: an API key is
refused with *"Managing the team needs a signed-in person, not an API key."*

### The staff board

`/dashboard/board` — one card per site for a chosen day: the clock it runs on,
who is on the rota and when they are on, which rooms are in use and from when,
the day's counts (booked, confirmed, arrived, completed, no-shows), what needs a
decision (unconfirmed, arrived but not closed) and what is next up. Plus
pinned-first staff notes, which are staff-only: they never appear on a client's
timeline, and every write is audited.

### Import and export finishers

- `POST /api/v1/clients {action:'import', csv}` — **dry run by default**: the
  report names the columns it recognised, the ones it ignored, the rows it would
  add, the ones already on file (matched on the normalised phone number) and the
  ones it cannot read, each with its line number. Committing adds exactly what
  the dry run promised; a second import of the same file adds nobody.
- `GET /api/v1/clients?view=export` → a real CSV file with a row count in
  `x-client-rows`, audited as an `export`.
- `GET /api/v1/bookings?view=export&from&to&locationId` → the diary's own export,
  honouring the range and the site, with `x-appointment-rows`.

---

## 2. What the phase shook loose

Building a *second* site and a *team* is what found these; each one was a real
defect, fixed and then proved by the gates.

### A login that had been taken away still worked

The worst of them. `POST /api/auth/login` checked the password and never looked
at `active`, so a deactivated account signed in with the password it had — and a
cookie minted before the deactivation kept working, because `currentUser()`
resolved sessions without consulting the user either. Deactivation now refuses
the sign-in (**403**, *"That account has been deactivated…"*), `currentUser()`
refuses an inactive user's session as a second line of defence, and the gate
proves both: *"deactivating ends the sessions it was holding — 1 live before,
1 ended"*, *"a deactivated login can no longer sign in — 403"*.

### The agent booked the wrong building

A caller saying *"at the East clinic"* had their visit filed at the
practitioner's **first** site: the site was never read from the caller, never
spoken back, and the confirmation said only "Thursday at 10 am". Worse, a move
could put an appointment into a room somebody was already sitting in, because the
agent's reschedule path never re-picked the room the diary's own move does.

The site is now read from the practice's **own** names in the caller's sentence
(with a shared word like "Northwind" deliberately ignored rather than guessed),
the clash check runs at the site the visit is at, the room is re-picked for the
new time, and a site with no room left says so instead of double-booking:

```
PASS  the caller's site reaches the booking        — Northwind East — New York
PASS  the site is named back to the caller         — Appointment on Thursday, November 26 at 10:00 AM at Northwind East
PASS  a move into a full site is refused, and says where — Every room at Northwind East — New York is taken at that time.
PASS  the room moved with the time rather than being left behind — room Hudson Room
```

Same area, second defect: the assistant's slot matcher read the date in
*"on 2026-11-26"* as a **phone number**, so the booking lost its day and anything
that texts "the number on file" would have sent to a date. Dates are now read as
dates, and only 7–15-digit numbers are treated as phones.

### Two rooms came back from the dead

`ensureRooms` diffed the location's inline list on **every read**, so a room that
had just been deleted was re-inserted on the next request. It is now one-way per
site (`LocationDoc.roomsMigratedAt`). The two bugs this exposed — a move carrying
its old room into a false 409, and `isFree` counting an appointment against
itself so a resize was refused — are fixed (`freeRoomFor` on relocation,
`ignoreBookingId` in the busy list).

### The board said nothing about a free room

The per-site room list only carried `inUseBy`/`until`, so "free" was implied by
absence. A desk reading it cannot tell "free" from "unknown": rooms now carry an
explicit `inUse`, always stated.

### The tidy script would have deleted the Northwind workspace

`scripts/tidy-probe-orgs.ts` decides which workspaces are throwaway. Its rule was
written the wrong way round — it *un-doomed* the workspaces whose every user is a
probe, and doomed a real workspace as soon as a single probe address appeared
inside it. Adding one locum login (`.test` address) was enough to schedule the
demo workspace for deletion; the dry run caught it. The rule is now "a workspace
is a probe only if everybody in it is", the two project workspaces
(`northwind-labs`, `voxera-demo`) are never swept, and the sweep also takes the
leavings of this phase — probe rooms, board notes and logins, with their
sessions.

### The gates were wrong three times

Worth recording, because a failing gate is not automatically a failing product:
a check made with somebody else's session was overwriting the run's own cookie
(so later checks silently ran *as the receptionist*); an export assertion
measured a day with no appointments in it and called the emptiness a failure; and
one asserted an audit row for a role change it never performed. All three are
fixed in the gate, and the DST probe now measures the **site's offset** instead
of comparing the first slot of two days — which moved as soon as a slot was
booked, i.e. it was measuring the diary rather than the timezone.

---

## 3. The acceptance, in one screen

Two locations run in one workspace without data leaking across them:

- **Records**: rooms belong to a site (`?locationId=`), the diary filters to one
  site, an export honours the site it was given, and the agent files the visit
  where the caller was told to go.
- **People**: the front desk can run the whole diary and take a payment, cannot
  read clinical notes (it is told the notes exist, not what they say), cannot
  change practice setup and cannot manage the team — each refusal naming why.
- **The board**: per site, with its own clock, its own rota and its own rooms.
- **The trail**: `team.invited`, `team.role_changed`, `team.deactivated`,
  `team.reactivated`, `team.password_reset`, `team.sessions_revoked`,
  `board.note_created|updated|deleted`, `clients.imported`, and an `export` row
  for every export taken.

## 4. Deliberately not in it

- **The agent does not move an appointment between sites.** A move keeps the
  visit where it is; a cross-site move is a decision for the desk (and the diary
  supports it, room and all).
- **A booking at a site whose rooms are all busy is recorded without a room**
  rather than refused — a site that rooms only some visits must stay bookable —
  and the board shows it as needing attention. A *move* into that state is
  refused, because there the room was already allocated.
- **The running demo answers from the rules engine** (no model provider keys in
  this workspace), so the hosted-model path — the stubs on `:4020`/`:4010` — is
  exercised by the AI gate, not by every check above. The site behaviour proved
  here is the product's, not a model's.
