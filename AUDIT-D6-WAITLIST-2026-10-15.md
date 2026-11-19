# D6 — the wait list offers the freed time, and A7 — the client says "I am here"

**Date:** 2026-10-15 · **Gates:** `scripts/waitlist_check.py` — **77 checks, 0 failures**, five consecutive runs · `scripts/offer_expiry_probe.ts` — **8 checks, 0 failures** (app stopped) · `scripts/room_window_check.ts` — **175 windows, 0 disagreements** · plus `scripts/manage_check.py` **37 / 0** and the whole standing suite green (every gate, on the production build in the tree).

The audit's D6, in its own words: *"`lib/server/diary.ts:398` returns the matching wait-list entries when a cancellation frees a slot; both screens render them as a toast. Nothing offers the freed time to the people who asked for it. The most valuable minute in a clinic — a cancelled 3pm on a full day — is left to a receptionist's memory."*

That is now closed end to end. A7 — self check-in — is built as the same loop's second half, because both hang off the same artefact: the client's own link.

## What it does now

| Piece | Where | What it does |
|---|---|---|
| The offer engine | `lib/server/wait-offers.ts` | `OFFER_TTL_MS` 4 h (capped at the appointment's own start), `MAX_OFFERS_PER_SLOT` 5, soonest-`from` first. `mintOffer` · `offerFreedSlot` · `nextFreeSlotFor` · `claimOffer` · `claimFromWaitEntry` · `declineOffer` · `withdrawOffer` · `expireOffers` · `releaseEntry` · `offersBoard` · `offerAlternatives` |
| The client's link | `lib/server/manage-links.ts` | `offer:` HMAC tokens, `/offer/<token>`, single-use, no raw token in any rate-limit key (`sha256`) |
| Desk API | `app/api/v1/wait-list/offers/route.ts` | `GET` the board and its counts · `POST` in three shapes — `{bookingId}` *"offer the next opening that fits this window"*, `{entryId,startsAt}` *"offer this person this time"*, `{entryId}` *"find them the next opening"* · `DELETE ?id=` takes one back |
| Client API | `app/api/public/offer/[token]/route.ts` | `GET` 60/min per IP · `POST` claim/decline 20/min. The claim is re-checked against the live diary |
| Client page | `app/offer/[token]/page.tsx` + `ClaimOffer.tsx` | One tap books it; when the time has gone it says so in the words that are true and shows the live openings instead |
| Desk surfaces | `app/dashboard/bookings/page.tsx`, `app/dashboard/calendar/page.tsx` | "Offer the next opening" per wait entry · a **Freed slots out right now** board · the cancel toast now carries the offer action rather than a count |
| The link the desk reads out | `app/api/v1/bookings/[id]/link/route.ts` | `GET` → `{reference, url, token, opens, canChange, canCheckIn, reason}` — for the phone call that ends with *"I'll text you a link"* and the client has no phone |
| Four doors into the offer | `app/api/v1/bookings/[id]/status`, `lib/server/manage.ts` `clientCancel`, `lib/server/inbound.ts` (SMS cancel), `app/api/v1/series/[id]` DELETE | Cancel from the desk, from the client's own link, by text, or a whole series — all of them free the time and offer it |
| **A7 — check-in** | `lib/server/manage.ts` `clientCheckIn`, `app/m/[token]/ManageAppointment.tsx`, action `check_in` | Opens **6 h before** the start, stays open **1 h after**; sets `arrived`, actor `client`; the board picks it up |
| Add to calendar | `lib/server/manage.ts` (`ManageView.calendar`), `app/m/[token]/ManageAppointment.tsx` | The client's page now offers the appointment as a `.ics`, from the route that already existed (`/api/public/bookings/{id}/appointment.ics`) and was reachable from nowhere — the file describes that appointment's own instant and a cancelled one downloads with `STATUS:CANCELLED` rather than a ghost |
| Housekeeping | `lib/server/maintenance.ts`, `scripts/tidy-probe-orgs.ts` | `sweep()` expires offers on their own clock; a closed offer is kept **90 days** like the audit trail; the sweeper knows `waitOffers` |
| Templates | `lib/server/templates.ts` | `waitlist_offer` with `{{claim_link}}` and `{{offer_expires}}`, seeded for SMS and email, editable per workspace |

## The contract, exactly

- **An offer** is a row with a name, a number, a time, an expiry and a channel. `expiresAt = min(now + 4 h, startsAt)` — an offer never outlives the appointment it is offering. At most **5** stand on one slot at a time, and the soonest-fitting entry is offered first.
- **The text** carries the client's own link, and nothing else that could be mistaken for it. The link is the **last thing in the message with no trailing punctuation** — see the defect below for why that sentence is in this report.
- **A claim** books the appointment (`source: 'waitlist'`, `externalId wl-…`), **withdraws the claimer's other open offers** (you cannot hold two slots), and closes the wait-list entry as `booked`.
- **A refusal is honest and specific.** `expired` → *"That offer has closed…"*; `taken` → *"That time has just been taken. Here are the next openings — or call the practice…"*; `not_free` → *"That opening has gone. The list below is live — pick another."* When the answer is `taken` or `not_free`, the page carries **live** alternatives and picking one books it in the same tap.
- **Decline** keeps the person on the list — status stays `waiting`, and the desk can offer again. **Withdraw** puts them back in the queue and kills the link (`409`).
- **Consent still has the last word.** An offer is made to somebody who has opted out — the record exists and the desk can see it — and the message is filed `blocked` with the reason naming the refusal, not a mystery.
- **A7 check-in** is open from 6 h before to 1 h after the start; before that the page says when it opens (*"from 4:30am tomorrow"*) rather than showing a button that would fail. Checking in twice is not an error — the second tap says you are already here. It writes `appointment.client_checkin` to the audit trail and a row to the record's access log.
- **The audit trail** names every step: `waitlist.offered`, `offer_claimed`, `offer_declined`, `offer_withdrawn`, `offer_expired`, `back_in_queue`, `offer_taken_after_expiry`, `appointment.client_checkin`.

## Defects found while verifying, and what they cost

Four real defects fell out of building this loop. Three were in code older than D6.

1. **A link at the end of a sentence, followed by a full stop.** The SMS fallback ended `…First to take it gets it: <link>.` — and the trailing stop is part of what gets tapped, so the link 404s. `withStopLine` keeps the caller's punctuation verbatim, so the fix belongs in the caller: the link is now the last thing in the message and carries no punctuation (`lib/server/wait-offers.ts`, both seeded bodies in `templates.ts`). The gate's link reader now strips trailing `.,;:!?)]` too, because a *human* reading a text does exactly that.
2. **Alternatives only when the offer was already closed.** The page showed the live openings when status was `expired` or `withdrawn` — but an offer can be `open` in our records and fail `taken` on the tap, because somebody booked it in between. The client then got a refusal and nothing to tap. `app/api/public/offer/[token]/route.ts` now returns `alternatives` unless the offer is `claimed` or `declined`.
3. **The move a client was offered was refused by our own diary.** `offeredSlots` (`lib/server/manage.ts`) searches their own practitioner first and falls back to *"anybody who does this job"* — but the slot it returned carried only a **time**, and the move then ran the clash check against the *old* practitioner, who was booked. The diary was offering a time it would not take. Slots now carry `providerId` and `locationId`, the public action takes them, and the page sends them.
4. **The room picker and the clash check disagreed about the same window.** A move asks `freeRoomFor` to choose a room and then `isFree` to approve it. `freeRoomFor` sized the room on the *caller's* minutes while `isFree` used the service's own length (`blockFor`), so a 30-minute appointment of a 60-minute service got a room it was then refused. This is a **property**, not a case, so it is now asserted over a grid: `scripts/room_window_check.ts` checks every practitioner × service × 15-minute window across five days and reports disagreements — **6 before the fix, 0 after** (175 windows).

## What the gate proves, end to end

`scripts/waitlist_check.py`, 77 checks in five blocks:

1. **The desk offers the next opening that fits.** The board names the time in the clinic's own words, the text goes out to the client's own number, and the page it points at names the practice and its phone number.
2. **A cancellation offers the time it freed** — to the person whose window it falls inside, by name, for exactly the freed instant.
3. **The client's link books it** (`201`, reference `wl-…`, source `waitlist`), the link is single-use (`409` on the second tap, and the page then says `claimed` and hands over the `/m/<id>` link to the appointment).
4. **The honest refusals** — a stolen slot, a declined offer, a withdrawn offer, a client who has already been booked, and an offer blocked by consent.
5. **Saying "I am here"** from the appointment link: accepted inside the window, refused before it, twice is not an error, the diary shows `arrived`, the board picks it up, and the audit trail records it.

Offer **expiry** is a four-hour rule, so it is not proved by sleeping in the gate: `scripts/offer_expiry_probe.ts` runs against the file with the app stopped, ages a real row, runs the real sweeper and checks what it did — an aged offer is closed rather than deleted, says why, its entry goes back in the queue while its window is open, an entry whose own window has gone does not, an offer still inside its window is untouched, and the row stays visible for the desk. It takes a backup and removes its own rows.

## Two gate bugs this build exposed, and fixed

- **A gate that only tidies up when it passes** is a gate that makes its own next run worse. Every probe appointment it left behind after a crash sat on the *earliest* free time — the exact resource the assertions are about. `waitlist_check.py` now sweeps its own debris at the start *and* cleans up on every exit path, including the early returns.
- **`onboard_check.py` asserted the wizard's promise after breaking it.** *"demo data is not counted as the client's setup — 1/4 before any action"*: the gate's own verification block creates a draft agent fifty lines earlier, and creating an agent is exactly what marks that step done (`patchOnboarding` in `lib/server/onboarding.ts`). The product was right; the check was reading the state at the wrong moment. It now reads it straight after `POST /api/bootstrap` — a fresh workspace reads **0/4**, and reads **1/4** once the gate has made an agent, which is the sentence the wizard actually promises.

Also fixed while in there: `manage_check.py` assumed a reminder was queued for every probe appointment, and now asserts the calendar file too (`37` checks). Reminders are queued inside their lead window (24 h by default), so on a busy diary the earliest free slot can be three weeks out and correctly has no reminder yet; the gate now reads the link out of whichever message the appointment has, and books through the **public** door as a fallback.

## What it deliberately does not do

- **No client logins.** The link *is* the identity; there is no waiting-list portal.
- **No automatic offering without a decision.** Cancelling surfaces the offer for the desk to send, or it goes out through the doors above — but nothing texts a client at 3am: the offer message obeys the practice's quiet hours like every other message.
- **No bidding or "first to reply wins"** — the list is ordered, and a slot holds at most five standing offers.

## Files

**New:** `lib/server/wait-offers.ts` · `app/api/v1/wait-list/offers/route.ts` · `app/api/public/offer/[token]/{route.ts,page.tsx,ClaimOffer.tsx}` · `app/offer/[token]/*` · `app/api/v1/bookings/[id]/link/route.ts` · `scripts/waitlist_check.py` · `scripts/offer_expiry_probe.ts` · `scripts/room_window_check.ts`

**Changed:** `lib/server/manage.ts` (check-in, offered slots carry their practitioner, `clientReschedule` takes them) · `lib/server/manage-links.ts` · `lib/server/messages.ts`, `templates.ts`, `outreach.ts`, `bookings.ts` · `lib/server/diary.ts`, `bookings.ts` (four cancel doors) · `lib/server/maintenance.ts`, `rooms.ts` · `app/m/[token]/*`, `app/dashboard/bookings/page.tsx`, `app/dashboard/calendar/page.tsx`, `app/dashboard/messaging/page.tsx` · `scripts/manage_check.py`, `scripts/client_check.py`, `scripts/onboard_check.py`, `scripts/tidy-probe-orgs.ts`

**Still open from the audit (not authorised):** D4 (payment receipts), D5 (overdue chase), D7 (per-service recall), D8 (docs + one `npm run check`), A2, A4–A9, and the A1 provider-mismatch note from the first fixes bundle.
