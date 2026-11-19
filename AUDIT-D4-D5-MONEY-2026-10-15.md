# D4 — a payment says thank you, and D5 — the unpaid bill asks

**Date:** 2026-10-15 · **Gates:** `scripts/money_loop_check.py` — **66 checks, 0 failures**, three consecutive runs · plus the whole standing suite green on the production build in the tree: `money_check` · `messaging_check` · `reports_check` · `demo_check` · `smoke` · `api_check` · `onboard_check` · `client_check` · `book_check` · `booking_check` · `notes_check` · `practice_check` · `practice_team_check` · `ai_check` · `carrier_check` · `report_tool_check` **36/0** · `manage_check` **37/0** · `waitlist_check` **77/0** · `auth_check` **101/0** · `linkcheck` **521/0** · `sitemap-check` · `nesting-check` · `room_window_check` **175/0** · `offer_expiry_probe` **8 PASS** · `privacy_check` · `race-check` · `guard-check` · `media-check`.

The audit's D4: *"`recordPayment` settles the invoice and writes the row. Nothing is sent. A client pays at the desk and hears nothing back — no receipt, no balance, no link."* D5: *"`overdueInvoices` exists and the pay page exists. Nothing connects them: no reminder ever goes out about an unpaid bill."*

Both are closed, and they are one loop: money arrives → a receipt; money does not → a chase, on the practice's own schedule, that stops the moment the money lands.

## What it does now

| Piece | Where | What it does |
|---|---|---|
| The words about money | `lib/server/money-format.ts` (new, 60 lines) | `CURRENCIES` · `minorUnits` · `toMinor` · `fromMinor` · `formatMoney` — a leaf, so the parts that *talk* about money can format a figure without importing the ledger that records it |
| The receipt | `lib/server/receipts.ts` (new, 343 lines) | `contactFor` (number first, then email; a channel switched off or opted out is skipped if another will do) · `balanceLine` · `dueDateWords` · `moneyContext` · `queuePaymentNotice` · `pendingChasesFor` · `cancelPendingChases` · `refreshChase` |
| The chase | `lib/server/money-chase.ts` (new, 274 lines) | `daysSinceDue` · `stepFor` · `queueOverdueChases` · `chaseRowsFor` · `chaseStateFor` · `payLinkFor` |
| The funnel | `lib/server/money.ts` | `recordPayment` now cancels any pending chase for the invoices it touched (`part paid — $150.00 still due` / `settled in full`) and queues the notice. `creditInvoice`, `applyCredit`, `voidInvoice` cancel chases too; `voidPayment` audits `invoice.reopened` when a reversal leaves a balance — **5 doors, one behaviour** |
| The schedule | `lib/server/outreach-rules.ts` | `overdue { enabled, offsetsDays: [-3, 0, 7, 21], channels: ['sms'] }` — clamped (−60…365), rounded, deduped, sorted, **max 8** steps |
| The job | `lib/server/scheduler.ts` | `overdue-chase` — *"Chase unpaid invoices"*, every 60 min, returns `queued / refreshed / withdrawn` or *"nothing to chase"*; visible, pausable and run-on-demand on the scheduler screen |
| Desk surfaces | `app/api/v1/invoices/[id]/route.ts`, `app/dashboard/money/page.tsx`, `app/dashboard/messaging/page.tsx` | The invoice screen gains **`notices[]`** and **`chase`** and prints a *"Chasing this bill"* panel: step pills (sent / queued / withdrawn), the last five messages, what is next and when. The messaging screen gains the rule itself — toggle, offsets, channels — and says outright that the payment receipt is **not** switchable |
| Wordings | `lib/server/templates.ts` | `receipt`, `refund`, `overdue` × sms + email, editable per workspace like every other template |

## The contract, exactly

- **A receipt goes out for money that arrives**, through the same queue as everything else (`kind: 'receipt'`, `source: 'payment'`), so consent and quiet hours still apply — *"a receipt at 3am is still a text at 3am"*. It names the amount, the bill and what is left: `Hi Chris — thank you, we have received $120.00 for INV-0012. $80.00 is still due on INV-0012.` Paying the rest earns a second receipt reading `INV-0012 is settled.`
- **A `credit` earns nothing.** Applying credit to an invoice moves money the client already paid and already heard about; a second *"we have received it"* would be a lie about when it arrived. A refund uses the `refund` kind.
- **The link travels only when one exists.** `payLinkFor` reuses an open, unexpired link and never mints one: `createPaymentLink` can open a checkout session with the practice's provider, and a chase must not do that behind the desk's back. With no link, the link line is dropped whole and the message still reads as a sentence.
- **One step per invoice, ever — and the *newest* one that fits.** A bill 30 days late gets **one** message (step 21), not the four it missed. A pass re-reads the balance and refreshes a pending chase in place rather than sending a stale figure.
- **It stops when the money arrives.** A payment (in full or in part), a credit note and a void each take back an unsent chase with a reason the desk can read: `settled in full`, `part paid — $150.00 still due`, `a credit note of $100.00 was applied`, `the invoice was voided`. Running the job twice queues nothing twice.
- **Consent has the last word, and a refusal is recorded.** A client who has opted out of texts is chased by email; one who has opted out of everything gets a row filed `blocked` naming the refusal (*"Probe Money 1792092483 has opted out of sms"*) rather than a silence; a client with no contact details is skipped with an audit line, not an error.
- **The desk can always answer *"why are they annoyed?"*** — the invoice itself lists what went, on which channel, when, and what is next, computed from the same rule the job runs on.

## Defects found while verifying, and what they cost

Six real defects fell out of driving this loop. Five were in code older than D4/D5.

1. **A settings change could break invoicing outright.** `POST /invoices {action:'settings'}` sent `undefined` for every field the caller left out; `setMoneySettings` stored it; `nextNumber` then called `.replace` on `undefined` — so changing the payment terms from any screen made **every subsequent invoice fail with a 500** (`settings.invoicePrefix.replace`). Reproduced twice, then fixed at both ends: the route sends only what was sent, the settings writer ignores `undefined`, and the reader heals a row that arrives without a prefix. The gate now walks that path every run.
2. **A chase for a bill with no payment link went out empty.** `dropUnfilledLinkLines` takes out the line that asks for a link it cannot fill — right when the link had a line of its own, wrong when the line *was* the message: the house overdue SMS was one line, so the body rendered as `''`. Two fixes: the wording gives the link its own line, and the guard can no longer empty a message (it strips the link and the words leading into it instead — *"the link is the whole message so the message is not the thing that goes"*).
3. **Money could be taken against a draft or a void bill.** `createPaymentLink` has always refused both; `recordPayment` did not — so a payment could be recorded against a document the report excludes, and *"collected"* stopped adding up to the rows underneath it (measured live: rows 2,138,909 vs total 2,150,909, off by exactly one $120 payment that sat on a draft). The payment path now refuses with the link path's own words: *"is still a draft — issue it before taking money against it, or take the money on account."*
4. **The revenue report's rows did not add up to its own totals.** Money the window could not place on one of its invoices — taken on account, settled before the window opened — was counted in the total and put on no row. The remainder now lands under **Unassigned**, which is the truth, on both the practitioner and the service axis, with `unattributedMinor` exposed. The reports gate now asserts the service axis as well as the practitioner one, all three columns.
5. **New house wording never reached a workspace that already existed.** Templates are data, seeded once: a workspace older than D4/D5 had no receipt, refund or chase wording at all, so it sent the bare fallback sentence — *"thank you, we have received $120.00"*, no bill, no balance. The boot sweep now seeds what is missing and brings **untouched** seeded wording up to date; a template somebody edited is theirs and is left exactly as written (its `editedAt` stamp is the boundary).
6. **"Questions? Call site."** The refund text was seeded with a raw vocabulary fragment instead of the practice's name. General repair could not catch it (the fixed sentence uses a field the old one never used, and that difference reads as an edit), so it is a **named** wrong wording, matched against the exact text that went out and fixed on sight with an audit line saying why.

Two gates also left money behind, which is what quietly turned `demo_check` and `reports_check` red in the first place: a **paid** probe invoice cannot be voided, so it stayed, spending real figures in the demo workspace (`demo_check`'s Unassigned row had reached 9.86% against a 2% ceiling). `money_check` and `money_loop_check` now reverse the probe's payments and *then* void — the practice's own path — and the workspace is left as it was found.

## What the gate proves, end to end

`scripts/money_loop_check.py`, 66 checks in seven blocks, driven entirely through the API as the desk and the client do — including the public pay page with no session:

1. **A settings change cannot break invoicing** — the regression check for defect 1.
2. **A payment says thank you** — part payment, the amount, the balance, the bill, the client's own number, the link the desk already made (reused, not remade), the carrier actually accepting it, then the second receipt reading *settled* with no dead link in it.
3. **And so does a payment from the link** — the public page opens with no session, the sandbox payment goes through, one receipt per payment, and it names the bill.
4. **The schedule** — due today → step 0; three days out → the −3 courtesy nudge; ten days late → step 7; thirty days late → **one** message, step 21; ten days out → nothing yet; a second pass queues nothing; a chase carries the pay link when there is one, with nothing glued to the end of it.
5. **It stops** — full payment, part payment, credit note and void each withdraw an unsent chase with a reason, and a settled bill is never chased again.
6. **Consent, contact details and the hour** — opted out of texts → email; opted out of everything → a blocked row naming the refusal; a chase due outside working hours waits for the window to open **in the practice's own clock** (measured: queued 20:00Z for a 16:00 New York opening).
7. **The desk can see all of it** — the schedule, the steps as steps, `Settled — 1 message went out about this bill`, the job in the scheduler, and the rule read back from the messaging screen.

## What it deliberately does not do

- **No receipt for a credit**, by design — see above.
- **A chase never creates a payment link**, and a bill with no link gets a message without one.
- **A receipt is not switchable.** Quiet hours and consent still govern it, but *"we received your money"* is transactional, not marketing, so there is no toggle that turns it off; the messaging screen says so rather than hiding it.
- **No second receipt for a webhook.** The sandbox pay page and the Stripe path both land in `recordPayment`, which is the only door that queues a notice — one payment, one message (`settleLink` returns the existing payment for an already-paid link).

## Files

**New:** `lib/server/money-format.ts` · `lib/server/receipts.ts` · `lib/server/money-chase.ts` · `scripts/money_loop_check.py`
**Edited:** `lib/server/money.ts` · `lib/server/templates.ts` · `lib/server/outreach.ts` · `lib/server/outreach-rules.ts` · `lib/server/scheduler.ts` · `lib/server/maintenance.ts` · `lib/server/reports.ts` · `app/api/v1/invoices/route.ts` · `app/api/v1/invoices/[id]/route.ts` · `app/dashboard/money/page.tsx` · `app/dashboard/messaging/page.tsx` · `scripts/reports_check.py` · `scripts/money_check.py`
