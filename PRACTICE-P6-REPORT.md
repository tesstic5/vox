# Voxera practice management — Phase 6 build report

**Money.** Built 2026-10-13, verified against a production build (563 prerendered
routes) with the app running on `:3000` and the carrier stub on `:4010`.

The phase gate from `PRACTICE.md` §7, L88:

> Invoice → payment → statement reconciles; sandbox flow works with no keys.

Checked by `scripts/money_check.py` — **73 checks, 0 failures**. Both halves are
proven directly, and the rules that make them worth anything are proven with
them: an issued invoice that cannot be edited, refunds capped at what was taken,
credit notes capped at what is owed, a link that settles once, a desk that may
take money but not move it, and an agent that reads a balance rather than
inventing one.

---

## 1. What landed

### An invoice is a document, not a form

Lines with quantity, unit price and tax; a discount spread across the lines by
largest remainder, so 10% of $130.05 lands as **$13.01** and never as a float
crumb — every field is an integer count of minor units (`JPY` included, where
minor units *are* the unit). From a visit, the invoice is priced from the
service, not typed in, and the same visit cannot be billed twice. While it is a
draft it is a working document; issuing gives it `INV-0001`, an issue date and a
due date from the practice's own terms — and from then on it is immutable. An
edit returns **409** naming the alternative: a credit note for what is wrong, or
a void.

### Money moves in rows, and every row is capped

`recordPayment` takes a payment, a refund or a prepayment; a part payment leaves
`partly_paid` and the rest owed. Naming an invoice without naming an amount means
*settle it* — bounded by that invoice's open balance. Overpayment is not phantom
money against the invoice: it stays on the client's account as credit.
`creditInvoice` raises `CR-nnnn` as its own document, capped at the open balance;
a refund cannot exceed what was taken; a void is refused while money is on the
invoice. Taking money is the desk's job (receptionist included) — crediting,
voiding and raising are the owner/admin/developer's, and a probe signed in as the
receptionist gets **403** on the first two while taking a counter payment
successfully in the same run.

### The statement reconciles, and says so

`statement()` builds the ledger oldest-first — invoices, payments, refunds, credit
notes, prepayments — with a running balance, and returns `reconciled: true` only
when the ledger's closing balance equals the invoices' own balances less credit on
account. The gate asserts that flag, not the arithmetic that produced it.

### Payment links, with no keys at all

Two drivers, reported with their reason: `stripe` when a workspace keys its own
account, `sandbox` when nothing is configured — and the sandbox is not a mock
page, it is the same settlement path (`applySettlement`) the webhook uses. A link
is capped at the balance, opens as a public page carrying only the amount, the
description, the practice and the status (no patient name, no record id), is
labelled *sandbox* and settles through the queue-backed sandbox driver. Paying it
twice is idempotent on the token; a cancelled link refuses; an expired one
expires; an unknown token is a 404. The desk can text the link, and so can the
agent — through the same consent-gated message queue as every other send.

### The agent asks; a person holds the books

`payment_status` reads what a caller owes (refusing to guess when no client
record is attached) and `create_payment_link` sends a capped link, by SMS or
email, only after the caller has agreed to pay. Neither takes card details — the
call script says a secure link is on its way, and the tool description says why.
Both are in the seeded front-desk tools, in the onboarding presets, and in the
drafted-tool list, so a new workspace's appointment assistant has them on day one.

### The desk

`/dashboard/money` — overview, invoices (with the document view and its own audit
trail), payments, links, expenses and provider revenue — through the same shell,
tables and modals as the rest of the dashboard, and offered to every role
including a viewer while writes stay where they belong.

---

## 2. Verification

`npx tsc --noEmit` clean · `npm run build` clean (563 prerendered routes) · the
whole suite run against that build with the app live:

| Gate | Result |
|---|---|
| `scripts/money_check.py` (P6 gate) | **73 PASS / 0 FAIL** |
| `scripts/booking_check.py` | 39 PASS / 0 FAIL |
| `scripts/client_check.py` | 43 PASS / 0 FAIL |
| `scripts/practice_check.py` | 41 PASS / 0 FAIL |
| `scripts/carrier_check.py` | 49 PASS / 0 FAIL |
| `scripts/api_check.py` | 38 PASS / 0 FAIL |
| `scripts/book_check.py` | 31 PASS / 0 FAIL |
| `scripts/smoke.py` | 59 PASS / 0 FAIL |
| `scripts/messaging_check.py` (P4 gate) | 77 PASS / 0 FAIL |
| `scripts/notes_check.py` (P5 gate) | 55 PASS / 0 FAIL |
| `scripts/privacy_check.ts` | ALL PASS — 272 bundles, 92 fingerprints, no record in a bundle |
| `scripts/nesting-check.py` | 519 prerendered pages, no invalid nesting |
| `scripts/linkcheck.py` | 519 static routes, 0 unresolvable targets |
| `scripts/sitemap-check.py` | 472 entries of 563 routes, every indexable route listed |

What the P6 gate proves, in order: settings and the counter's payment types; the
appointment becoming an invoice at the service's own price; a draft taking lines,
quantities, tax and a discount with the total equal to the sum of its lines to the
cent; issuing numbering and dating it from the practice's terms; **an issued
invoice refusing an edit (409) and naming credit note or void**; a part payment
leaving the rest owed; **settling the rest leaving nothing owed and the status
`paid`**; both payments on the document with their method and who took them; the
record's own access log and audit trail; overpayment held as account credit; a
refund capped at what was taken; a credit note `CR-nnnn` as its own document,
capped at the open balance; a void blocked while money is on the invoice; **the
statement reconciling**; the keyless sandbox link flow (capped, public view
carrying no patient data, sandbox-labelled, idempotent, cancelled link refusing,
unknown token 404, texted through the real queue); **the agent reaching for the
ledger in a live call with a real balance**; desk RBAC; expenses; provider
revenue; and the Xero-shaped export with the same amounts and contacts plus a
spreadsheet CSV.

Live checks on the rebuilt app: `/dashboard/money` 200; the public page
`/pay/<token>` rendering *Pay $186.50* with the sandbox notice and no patient
name; `POST /api/bootstrap` idempotent (`created: false`, same link).

Tidy: `scripts/tidy-probe-orgs.ts` dry-run → `--apply` (**49 probe clients, 42
appointments, 64 messages, 43 outreach rows, 4 notes, 15 invoices, 30 payments, 2
campaigns, 2 templates**) → re-run "nothing to do". The sweep now also removes a
probe's invoices, payments, links and expenses, and it matches a probe marker
anywhere in a name, because the scripts name their records after what they were
checking ("Statement Probe", "Slot Probe A") — the six seeded demo invoices were
left untouched, checked by listing what would go before applying it.

### The demo, after the tidy

USD · invoiced **$1,744.00** · collected **$1,239.50** · outstanding **$504.50** ·
overdue **$343.00** · expenses **$3,172.15** · net **−$1,932.65** · 6 invoices
(4 paid, 1 overdue) · 6 payments · 5 expenses · 1 open link for $186.50 ·
6 payment types · provider `sandbox` with the reason *"no payment provider is
configured"*.

Revenue is attributed to the practitioners who did the work — Priya Raman
$736 / $393, Dana Whitfield $527 / $527, Marcus Ito $481 / $294.50 — with nobody
credited with money the practice never took.

---

## 3. Defects found while verifying P6, and fixed

Verification found eight things. Three were mine in the gate, five were real.

1. **Payment links carried the bind address.** A link created on the live app read
   `http://0.0.0.0:3000/pay/<token>` — an address to bind, not one to click. New
   `publicOrigin(req)` in `lib/server/api.ts`: an explicit `VOXERA_PUBLIC_URL`,
   then the forwarding headers (`x-forwarded-host`, `x-forwarded-proto`), then the
   request's own host, then `localhost` as the last honest fallback. Both the link
   creator and the bootstrap seeder use it, so a link built behind the sandbox's
   preview proxy points at the host the visitor actually reached.
2. **A refund did not re-open the invoice it came from.** Refunds were recorded
   with no allocations — client-level money only — so after refunding $64.37 on a
   settled invoice, the invoice still read *paid in full* while the ledger had the
   money going back out. The statement therefore reported `reconciled: false`, by
   exactly the refunded amount. Fixed twice over: a refund now allocates to the
   invoice it is refunded from, and `resyncInvoice` nets refunds off that
   invoice's `paidMinor` (so the cap on the *next* refund is what is still held,
   not what was once received).
3. **"Take the payment for this invoice" was a validation error.** Naming an
   invoice without an amount returned *"A payment is for a positive amount"* — a
   reasonable guard for a typo, and a silly one for the desk's commonest gesture.
   Omitting the amount now settles exactly what that invoice owes, bounded by the
   open balance; an explicit figure still wins, and a refund still has to state
   its own amount.
4. **Payments were invisible from the invoice.** The audit row was written against
   the payment's id, so opening the invoice showed the issue and the edits but no
   money. Each settlement now also writes a row against the invoice it settled,
   with the payment id in the detail.
5. **The agent had the tools and never reached for them.** *"How much do I owe
   you, and can I pay it now?"* classified as **pricing** (a balance is not a
   price), and the billing branch pushed the simulated `billing_lookup` /
   `issue_refund` tools a practice assistant does not have — so a practice call
   about money called no tools at all. Now: balance vocabulary (`owe`, `balance`,
   `outstanding`, `pay`) classifies as billing; a practice assistant selects
   `payment_status` first and `create_payment_link` only once the caller agrees to
   pay; and the spoken reply quotes the ledger — *"You have $130.00 outstanding:
   INV-0025 — $130.00 due 2026-10-27. I can text you a secure link to pay it now —
   no card details on this call."*
6. **The gate compared a payload to a status code.** `a token that does not exist
   is a 404` read the *response body* and compared it with `404`. It now asserts
   the status and the error code.
7. **Two brittle assertions of my own.** `Invoices` sits well past the first 200
   characters of a real Xero export, and *"the discount is spread across the
   lines"* compared against a header-level discount that does not exist — and
   10% of $130.05 is 1300.5 cents, not a number of cents. The discount check now
   asserts the strong part (the lines' slices sum to the discount, and the total is
   the exact tenth to the nearest minor unit) and the export check looks at the
   structure it claims to test.
8. **A gate that failed once in a dozen runs, for a reason worth knowing.** The
   public booking route allows 20 posts per address per ten minutes. The booking
   suite kept posting as one address, so a repeat suite run could collect a **429**
   where it expected a **409** — the check would have reported "the same slot
   cannot be booked twice" as broken when the rate limiter was simply doing its
   job. Confirmed by burning the bucket deliberately from one address: codes
   `{409: 20, 429: 2}`. Each booking attempt in the gate now arrives from its own
   visitor address, the way real visitors do.

The tidy learned one thing as well: it matches a probe marker anywhere in a client
name, not only at the front, because the earlier sweeps had been leaving the
gates' own records ("Statement Probe", "Slot Probe A") behind.

---

## 4. API added in P6

- `GET /api/v1/invoices` — `view=overview | payments | expenses | links |
  payment-types | export` (`?include=`), with the export offered in Xero's shape
  plus a CSV.
- `POST /api/v1/invoices` — `create · from-booking · update · issue · void ·
  credit · pay · prepay · refund · apply-credit · void-payment · link:create ·
  link:send · link:cancel · expense:create · expense:update · expense:void ·
  settings`.
- `GET /api/v1/invoices/{id}` — the document, its payments and credit notes, its
  links with their public view, the client's account, its access log and audit
  trail, and what the signed-in role may do with it.
- `GET | POST /api/public/pay/{token}` — the patient's page, and the sandbox's
  settle call.
- `POST /api/payments/stripe/webhook` — signature-verified; refuses rather than
  accepts when no secret is configured, and never settles an event it cannot
  attribute to a workspace.
- `GET /api/v1/clients/{id}` now carries the client's ledger (or a restricted
  marker for a role that may not see it).

---

## 5. Deliberately not done in P6

- **Live Stripe settlement.** The adapter, the webhook and the driver selection
  are built and typechecked, but "verified" here means the sandbox path; a real
  key is a configuration away and was not part of a keyless gate.
- **Product/inventory sales and stock**, insurance claim clearinghouses, tax
  returns, and multi-currency per invoice — all named as non-goals in
  `PRACTICE.md` §9 or P7-shaped work.
- **PDF rendering** of invoices and statements: the page prints, and the export
  is Xero-shaped and CSV.
- **Scheduled statement emails** — the statement is on demand; the messaging rules
  engine could carry it later.

---

## 6. State after P6

`data/voxera-db.json` — two workspaces (the marketing demo and Northwind Labs),
the Northwind demo carrying the money above. The app is running on `:3000`
(production build) with the carrier stub on `:4010`; the scheduler ticks, the
maintenance sweep expires links and refreshes overdue invoices through
`firstMoney()`.

Code: `lib/server/money.ts` (integer minor units, `splitExact`, the write union,
`canReadMoney`), `lib/server/payments.ts` (drivers, links, settlement,
`publicLinkView`), `lib/server/providers/stripe.ts`, the invoice/checkout APIs, the
pay page, `/dashboard/money`, the two agent tools, the export, and
`scripts/money_check.py`.

## 7. Next — P7, reports

The gate there is a sentence a clinic owner can answer from one screen: *who earns
what, what does it cost us, who does not turn up* — revenue by provider and
service, utilisation, no-shows, recalls, marketing attribution by booking source,
CSV/PDF export. The rows it needs already exist: P1's rota and services, P2's
statuses, P3's booking source, P4's outreach log, P5's notes, P6's money.
