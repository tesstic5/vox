# Class packs — design for sign-off ✅ SIGNED OFF & BUILT

> Built as designed (one refinement: the purchase creates the fenced prepayment
> and its payment receipt rather than a sales invoice — the invoice now appears
> per attended place, which is the same deferred-revenue rule stated more
> exactly). Gate: `scripts/pack_check.py` (29 checks, in the suite).
> Implementation: `lib/server/packs.ts`; hooks in `diary.ts`/`classes.ts`;
> money fencing in `money.ts` (`PaymentDoc.packId`, pack-scoped `applyCredit`,
> `reversePackSettlement`).

# (original design follows)

**What it is:** a client buys a bundle of class places up front — *"10 × Tuesday Yoga for
$200"* — and each place they take is settled from the pack instead of at the door.

**Why this needs your sign-off first:** a pack is a liability. The practice holds money for
sessions it has not yet delivered, so this touches pricing, expiry, cancellations, no-shows
and refunds. The rules below are my recommendation at every point; change any of them before
I build, because changing them after clients hold packs is a migration, not an edit.

**What already exists to build on** (checked, not assumed):

- Money is integer minor units end-to-end (no float drift) — `lib/server/money.ts`.
- Payments already have `prepayment` and `credit` kinds, an on-account credit balance
  (`creditOnAccountMinor`) and a way to settle an invoice from credit (`applyCredit`).
- Invoices are created from bookings (`invoiceFromBooking`) and go
  draft → issued → paid / part-paid / overdue / void.
- A class seat is an ordinary booking carrying a `sessionId`, so attendance, reminders,
  the client timeline and the client's own link already work for seats today.
- Money roles exist: who can read, edit, and take payment (`MONEY_*_ROLES`).

---

## The rules I recommend

### 1. What a pack is
- A **pack product**: name, one class service it applies to, number of places, price, and an
  expiry (in months from purchase). Defined in Practice setup, next to services.
- One pack applies to **one service** (e.g. Yoga), not "any class". Cross-service packs make
  per-place value ambiguous, and per-place value is what revenue reporting divides by.
- **Per-place value** = pack price ÷ places, computed in minor units with the existing
  largest-remainder split so the parts always add up to the whole.

### 2. Buying a pack
- Selling a pack creates a normal **invoice** (one line: the pack) and records the payment
  against it (card / cash / bank transfer / pay link) — exactly like selling anything else.
- The payment is recorded as a **prepayment**: the money becomes on-account credit tied to
  that pack. Places are usable only once the pack is paid for (an issued-but-unpaid pack
  shows its places as *pending* and cannot settle a seat).
- The desk can sell a pack from the client's record and from the class page. Online sale
  from the public booking page is **phase 2** — say so if you want it in phase 1.

### 3. Spending a place (the important one)
- Booking a seat (desk, public page, client link, or by phone) offers *"Use pack — 3 of 10
  left"* whenever the client holds a valid pack for that service. Nothing is spent yet: the
  place is **held** by the pack.
- The place is **spent when the seat is marked attended** (Arrived/Done on the register).
  At that moment the system raises the seat's invoice at the per-place value and settles it
  instantly from the pack's credit (`applyCredit`, tagged with the pack). Revenue is
  therefore recognised when the class happens, not when the pack was sold — the reports
  already read invoices, so practitioner/service revenue stays correct with no new maths.
- **Early cancellation** (before the practice's cancellation window): the hold is released,
  nothing is spent, the freed place goes to the class wait-list exactly as it does today.
- **Late cancellation and no-show: the place is spent.** It settled the same way as an
  attendance. This is the industry norm, and it is the sentence the client must see at
  purchase time (the design includes showing it on the sale receipt and the client's link).

### 4. Expiry
- Places expire on the pack's expiry date. Expired places are **not refundable** and are
  never spendable. The pack shows *"2 places expired"* rather than silently shrinking.
- Staff with money-edit rights can **extend** a pack; the extension is an audited action
  with a reason, like a note amendment — never a silent edit.

### 5. Refunds
- The desk can refund a pack's **unspent, unexpired places** at their per-place value. Spent
  places are never refundable (the class happened). Expired places are not refundable (§4).
- A refund reverses the unused credit and records a `refund` payment against the purchase
  invoice, so the client's statement reads correctly end-to-end.
- Whole-pack refund before any place is spent = full price back, same mechanism.

### 6. Sharing and transfer
- A pack belongs to one client and is **not transferable** by the client.
- Staff can transfer a pack's remaining places to another client (families share packs in
  real life), but only as an audited action with a reason. The ledger keeps both names.

### 7. What the client sees
- On their own link (`/m/…`): *"Yoga pack — 3 of 10 places left, valid until 12 Mar"*,
  and when booking a class: *"This place will come off your pack."*
- Reminders for a pack-settled seat say nothing about money (nothing is due).
- The pack appears on the client's timeline and statement: purchase, each spent place
  (class, date, per-place value), expiries, refunds, transfers.

### 8. Edge cases the design answers now
- **Class cancelled by the practice:** held places are released back; a place already
  spent because the register ran before the cancellation is un-spent by reversing its
  settlement (credit note against that seat's invoice — the money code already has
  `creditInvoice`).
- **Price changes later:** a held pack keeps the per-place value it was bought at. New
  price applies to new packs only.
- **Two packs, same service:** the one expiring soonest is spent first (FEFO), and the
  booking screen says which pack a place will come off.
- **Pack runs out mid-series:** remaining seats in a repeat series simply bill normally;
  the client is told at booking time which seats the pack covers.
- **Assistant by phone** can report places left (`practice_report`-style, same identity
  gate) but cannot sell a pack or refund one — money movement stays with people in
  phase 1. Selling by phone is a phase-2 decision.

---

## Data shape (for the build, follows existing conventions)

- `packProducts` — id, orgId, serviceId, name, places, priceMinor, currency,
  expiryMonths, active.
- `clientPacks` — id, orgId, clientId, productId, invoiceId (the purchase), placesTotal,
  purchasedAt, expiresAt, perPlaceMinor[], status (active · exhausted · expired · refunded).
- Holds and spends are **not** counters on the pack: they are derived from the seats
  (`booking.packId`, `booking.packState: held | spent | released`), so the register, the
  diary and the pack can never disagree — the same reason a seat is an ordinary booking.
- Settlement reuses `recordPayment` (prepayment) and `applyCredit` with the pack id on
  the allocation, so `clientBalance`, statements and the Xero-shaped export keep working.

## Build order (each behind the suite, like everything else)

1. Pack products in Practice setup + purchase from the client record (invoice + prepayment).
2. Hold/spend on the class register and booking flows (desk first), wait-list interplay.
3. Public page + client link ("use my pack", places left), reminders wording.
4. Refunds, extensions, transfers (audited), timeline/statement entries.
5. Reports: pack liability line ("places outstanding, value held") on Money overview.
6. Gate: `scripts/pack_check.py` (buy → hold → attend spends → late-cancel burns →
   early-cancel releases → expiry → refund of the remainder → statement adds up),
   registered in `scripts/check.py`; browser walk for the register spend.

## Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| 1 | When is a place spent? | On attendance; burned on late-cancel/no-show |
| 2 | Cancellation window that counts as "late" | Reuse the practice's existing cancellation rule |
| 3 | Expiry | Set per product in months; expired places not refundable; staff can extend (audited) |
| 4 | Refunds | Unspent + unexpired places only, at per-place value |
| 5 | Scope of a pack | One service per pack; soonest-expiring spent first |
| 6 | Online sale on the public booking page | Phase 2 (desk sale first) |
| 7 | Selling/refunding via the phone assistant | Report-only in phase 1; no money movement by phone |

Reply with any changes (or "go") and I will build it in the order above.
