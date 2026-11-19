# The class wait-list — plan

**Date:** 2026-10-17 · **Status:** planned, then built in this bundle (user: "plan that and work on it").
**Scope:** a *place* given back in a full class hands on to the person next in line for **that class**.

---

## 1. Why this is not the slot wait-list

The product already has a wait list, and it is about **time**: "I could come any afternoon this
week, call me if something opens." Its unit is a *slot* — a stretch of a practitioner's diary that
is free to sell. A class place is the opposite: **the time is fixed, the room is held, and the
instructor is already booked.** Nobody waits for "some time"; they wait for *that class*.

So the wait-list bundle is a second kind of entry, not a new colour on the first one:

| | slot wait-list (exists) | class wait-list (this bundle) |
|---|---|---|
| the question | "when could I come?" | "can I get into that class?" |
| what frees | a time | a place |
| how many people are offered one thing | up to 5 (a race) | exactly 1 (first refusal, in order) |
| what a claim creates | an appointment | a seat in the session |
| when the offer dies | 4 h, or when the slot starts | same, and never after the class has started |

That difference is why the previous bundle's guard says *a place is not a slot*. This bundle does
not weaken that guard; it gives the place somewhere of its own to go.

## 2. Decisions, with the reason each one is the way it is

1. **You wait for a session, not a service.** The entry carries `sessionId`. Without it, a "class"
   wait would be a wish for a class that may never exist, and the desk would have to guess which
   one the person meant.
2. **Waiting is only for a full class.** An empty place is bookable in two taps; letting somebody
   wait while seats exist turns the queue into a soft hold and means the desk sells fewer places.
   Joining a class with places left is refused in words that say how many are left.
3. **First come, first served — and visible.** A class has one time, so the slot list's "soonest
   window first" rule has nothing to sort. Order is `createdAt`, and the person is told their
   position ("2nd in line") because a queue you cannot see is a queue nobody trusts.
4. **One place, one offer.** A class place is a single item. The slot list offers to five because
   it is a race against a link; a class place offered to five people would mean four "sorry, gone"
   texts. The first refusal goes to the person at the front; if they let it pass, it goes to the
   next.
5. **An offer never outlives the class.** `expiresAt = min(now + 4h, session start)`. A place
   offered for a class that has begun is not a place.
6. **A cancelled class empties its queue.** Everyone waiting is told the class is off, once, and
   their entries close — not "expired", because nothing expired: the thing they were waiting for
   no longer exists.
7. **A class entry is never matched by the slot list.** `matchWaitList` skips entries with a
   `sessionId`, in one line, because a class waiter's window is the class's date and would
   otherwise be texted about a private appointment that happens to fall on it.
8. **The desk can put somebody in the queue and take them out.** A phone call is still how most
   practices work: an `add-waiter` action on the class route, and the existing
   `DELETE /api/v1/wait-list/{id}` to take them out.

## 3. What a person sees

**Public page.** A full class is no longer hidden — it is listed as **Full**, with a *Join the wait
list* control. (It used to be filtered out entirely, which is honest only if there is nowhere to
wait.) Joining asks for a name and a number and nothing else, like joining the class does.

**The text.** "Hi Sam — a place in Thursday evening yoga on Tuesday 20 October at 6:00pm has just
come free. You were first in line. Take it here: <link>. The offer stands until 4:00pm today."
The class name, the class's own clock, and the expiry — the same three facts as the slot offer,
said in the class's terms.

**The claim page.** `/offer/<token>` says *A place has opened up*, names the class, and has one
button: **Take my place**. No picker of alternative times — a place in a class is not a menu.

**The desk.** The class screen's roster gains a **waiting** section: who is in line, their
positions, when they joined, and a *Remove* control; the class list shows *2 waiting* beside the
seats; the offers board shows class offers with the class name, so a receptionist can see the
offer that went out.

## 4. Rules the server enforces (not the screen)

| rule | answer when broken |
|---|---|
| the session exists, is scheduled, and is in the future | 404 / 409 *"That class has already run."* |
| the class is full | 409 *"There are 2 places left — book one instead."* |
| already has a seat in it | 409 *"You are already in that class."* |
| already waiting | 200, the entry they have (`already: true`) — pressing twice is not two places |
| the queue is not unbounded | 409 after 20 waiting: *"The wait list for that class is full."* |
| claiming a place that has since gone | 409 *"That place has just been taken."* + the class is named |
| claiming after the class started | 409 *"That class has already run."* |
| a claim on a cancelled class | 409 *"That class was called off."* |

## 5. Surfaces

- **New module** `lib/server/class-waitlist.ts` — the queue: join, positions, offer, close, and
  the desk's read. Self-contained (no runtime import of `classes.ts` or `wait-offers.ts`), so the
  import graph stays acyclic: `classes → class-waitlist` and `wait-offers → classes`.
- `lib/server/diary.ts` — `sessionId` on `WaitEntryDoc`; `matchWaitList` skips class entries.
- `lib/server/wait-offers.ts` — `sessionId` on `WaitOfferDoc`; `claimOffer` seats the client in
  the class instead of booking a slot; expiry is class-aware; the board names the class.
- `lib/server/classes.ts` — giving a place back (`releaseSeat`) offers it; cancelling a session
  (`cancelClassSession`) closes the queue and tells everyone.
- `app/api/v1/classes/[id]/route.ts` — `GET` ships `waitList`; `POST` gains `add-waiter`.
- `app/api/v1/bookings/[id]/status/route.ts` — the seat path answers with the class queue, not the
  slot list.
- `app/api/public/workspaces/[slug]/booking/route.ts` — `{ sessionId, wait: true }` joins the
  queue; the payload lists full classes.
- **UI** — `app/book/[slug]/ClassJoin.tsx` (Full + wait form), `app/dashboard/classes/page.tsx`
  (waiting panel, `add-waiter`, counts), `app/offer/[token]/ClaimOffer.tsx` (class words).

## 6. How it will be proved

- `scripts/class_check.py` gains a wait-list section (~16 checks): join a full class, order,
  the refusals, a place given back → the person at the front is offered *and told*, claim → a
  seat, the queue moves up, a second place → the next person, a slot waiter is *not* offered the
  class hour, a cancelled class closes the queue and texts the waiters, an offer dies at the class
  start.
- `scripts/class-ui-pass.mjs` gains the screen: a staged **full** class shows *Full* on the public
  page with a wait-list control, a stranger joins it, the desk shows *1 waiting* with a position,
  and a place given back offers it. (The walk keeps staging its own class; it never touches the
  demo's.)
- `scripts/demo_check.py`: the demo carries a full class with somebody in line, so the feature is
  visible in the workspace a visitor opens.
- Docs: `/docs/guides/classes` gains *"When a class is full — the queue"*.

## 7. Deliberately out of scope

- **Paying to wait**, deposits, or a place held for a fee — money design first (that is the packs
  bundle).
- **Automatic promotion with no message** — every offer is a message a person can answer; a
  place that arrives silently is a place somebody turns up for and is turned away from.
- **Queues across different sessions of the same class** ("either Tuesday or Thursday") — that is
  a preference, not a queue, and needs its own design.
