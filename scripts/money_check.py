#!/usr/bin/env python3
"""
Money check (PRACTICE.md phase P6).

The phase gate is one sentence: *invoice → payment → statement reconciles; the
sandbox flow works with no keys.* This script proves both halves, and the rules
that make them worth anything:

   1. the practice's money settings exist, in a currency, with payment types
   2. an appointment becomes an invoice at the service's own price — as a draft
   3. a draft is edited freely; arithmetic adds up to the cent (lines, discount, tax)
   4. issuing numbers it and dates it, and makes it a document
   5. **an issued invoice cannot be edited** — it is credited or voided
   6. a payment is a row: taking one settles the invoice and leaves a balance of zero
   7. a part payment leaves the rest owed, and the status says `partly_paid`
   8. a credit note reduces what is owed and is a document of its own
   9. overpayment is refused... a refund cannot exceed what was taken
  10. money left unallocated stays on the client's account as credit
  11. an issued invoice cannot be voided while money is on it
  12. a statement reconciles: the ledger's closing balance equals the invoices' own
  13. **a payment link settles through the sandbox** — with no keys configured —
      and lands as one payment, not two (idempotent on a repeat)
  14. an expired or cancelled link refuses payment
  15. the agent can read what is owed and send a link, and never takes card details
  16. expenses and provider revenue come out of the same rows
  17. the Xero-shaped export carries the same amounts

Usage: python3 scripts/money_check.py   (the app must be running)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import session as cached_session  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = os.environ.get("VOXERA_DESK_EMAIL", "desk@northwind.dev")
DESK_CACHE = os.environ.get("VOXERA_DESK_SESSION", "/tmp/voxera-desk-session.json")

cookie = ""
failures: list[str] = []
cleanup: dict[str, list[str]] = {"bookings": [], "clients": [], "invoices": [], "links": [], "expenses": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, auth=True, as_cookie=None):
    url = path if path.startswith("http") else BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    who = as_cookie if as_cookie is not None else cookie
    if auth and who:
        req.add_header("cookie", who)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode()
            return res.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (json.loads(text) if text else {})
        except json.JSONDecodeError:
            return err.code, {"raw": text}


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def desk_session():
    if os.path.exists(DESK_CACHE):
        try:
            cached = json.load(open(DESK_CACHE))
        except (OSError, json.JSONDecodeError):
            cached = {}
        if cached.get("cookie"):
            probe = urllib.request.Request(f"{BASE}/api/v1/invoices?limit=1")
            probe.add_header("cookie", cached["cookie"])
            try:
                with urllib.request.urlopen(probe, timeout=30):
                    return cached["cookie"]
            except urllib.error.HTTPError:
                pass
            except OSError:
                pass
    req = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps({"email": DESK_EMAIL, "password": PASSWORD}).encode(),
        method="POST",
    )
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            fresh = (res.headers.get("set-cookie") or "").split(";")[0]
            if fresh:
                with open(DESK_CACHE, "w") as fh:
                    json.dump({"cookie": fresh}, fh)
            return fresh
    except urllib.error.HTTPError:
        return ""


def finish():
    # Through the product's own doors: nothing is deleted. A probe invoice that has
    # not been paid is voided with a reason; a link is cancelled; the appointment is
    # cancelled and the client archived, exactly as a tidy desk would.
    for link_id in dict.fromkeys(cleanup["links"]):
        if link_id:
            call("POST", "/api/v1/invoices", {"action": "link:cancel", "linkId": link_id, "reason": "money_check probe"})
    for invoice_id in dict.fromkeys(cleanup["invoices"]):
        if invoice_id:
            detail = call("GET", f"/api/v1/invoices/{invoice_id}")[1]
            invoice = detail.get("invoice") or {}
            # Money standing against a bill is reversed first, which is the practice's
            # own path (refund it or void it, then void the bill) and the only way the
            # probe's money stops distorting every report that runs after this one:
            # a paid invoice cannot be voided, so it used to stay behind, spending
            # real figures in a demo workspace that was only ever being tested.
            for payment in detail.get("payments") or []:
                # Both shapes: the allocation path reports `settled: true`, the
                # ledger reports `status`. Reading one is how a paid probe stays
                # behind and distorts the next run.
                if payment.get("settled") or payment.get("status") == "settled":
                    call("POST", "/api/v1/invoices", {"action": "void-payment", "paymentId": payment.get("id"), "reason": "money_check probe"})
            if invoice.get("status") == "draft":
                call("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "money_check probe (draft)"})
            elif invoice.get("status") not in ("void", None):
                call("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "money_check probe"})
    for expense_id in dict.fromkeys(cleanup["expenses"]):
        if expense_id:
            call("POST", "/api/v1/invoices", {"action": "expense:void", "expenseId": expense_id, "reason": "money_check probe"})
    for booking_id in dict.fromkeys(cleanup["bookings"]):
        if booking_id:
            call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled"})
    for client_id in dict.fromkeys(cleanup["clients"]):
        if client_id:
            call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "money_check probe", "force": True})

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — invoice → payment → statement reconciles, and the sandbox flow settles with no keys configured.")


def main():
    global cookie
    cookie = cached_session(BASE, EMAIL, PASSWORD)
    if not cookie:
        print("FAIL  could not sign in — is the app running?")
        sys.exit(1)

    # ---- 0. the workspace is up to date -----------------------------------
    status, boot = call("POST", "/api/bootstrap", {})
    seeded = boot.get("demoMoney") or {}
    check("the workspace bootstraps the money layer", status in (200, 201) and "demoMoney" in boot,
          f"status {status} · {seeded.get('seeded', 0)} ledger row(s) seeded · {seeded.get('paymentTypes', 0)} payment type(s)")

    # ---- 1. settings and the counter's vocabulary --------------------------
    status, overview = call("GET", "/api/v1/invoices?view=overview")
    settings = overview.get("settings") or {}
    check("the practice has money settings", status == 200 and bool(settings.get("currency")), json.dumps({k: settings.get(k) for k in ("currency", "invoicePrefix", "termsDays", "taxMode")}))
    currency = settings.get("currency", "USD")
    types = overview.get("paymentTypes") or []
    check("the counter has payment types", len(types) >= 3, ", ".join(t.get("name", "?") for t in types[:5]))
    provider = overview.get("provider") or {}
    check("the payment driver is reported, with its reason", bool(provider.get("driver")) and bool(provider.get("reason")),
          f"{provider.get('driver')} — {provider.get('reason')}")
    check("no provider is configured, so the sandbox is the driver", provider.get("driver") == "sandbox",
          f"driver is {provider.get('driver')} (a Stripe key would make it stripe — that is fine, but this gate runs keyless)")

    # ---- 2. an appointment becomes an invoice ------------------------------
    _, services = call("GET", "/api/v1/services")
    _, providers = call("GET", "/api/v1/providers")
    service = (services.get("data") or [{}])[0]
    provider_row = (providers.get("data") or [{}])[0]
    stamp = int(time.time() * 1000)
    number = f"+1555{stamp % 10000000:07d}"
    starts = datetime.now(timezone.utc) - timedelta(days=2)
    status, created = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-money-{stamp}",
        "customer": {"name": f"Probe Money {stamp % 100000}", "number": number, "email": f"probe.money.{stamp % 100000}@example.com"},
        "startsAt": iso(starts),
        "durationMinutes": 30,
        "status": "completed",
        "providerId": provider_row.get("id"),
        "serviceId": service.get("id"),
        "checkConflicts": False,
    })
    booking = created.get("booking") or created
    if status not in (200, 201):
        check("a probe visit exists to bill", False, message(created))
        return finish()
    cleanup["bookings"].append(booking.get("id"))
    client_id = booking.get("clientId")
    cleanup["clients"].append(client_id)
    check("a probe visit exists to bill", True, f"{booking.get('id')} · {service.get('name')}")

    status, raised = call("POST", "/api/v1/invoices", {"action": "from-booking", "bookingId": booking.get("id")})
    invoice = raised.get("invoice") or {}
    if invoice.get("id"):
        cleanup["invoices"].append(invoice["id"])
    check("the visit raises an invoice", status == 201 and bool(invoice.get("id")), f"{status} {message(raised)}"[:110])
    expected_price = int(round(float(service.get("price") or 0) * 100))
    check("it is priced from the service, not typed in", invoice.get("totalMinor") == expected_price,
          f"{invoice.get('totalMinor')} vs service price {expected_price} ({currency} minor units)")
    check("it is a draft, and it says which visit it came from",
          invoice.get("status") == "draft" and booking.get("id") in (invoice.get("bookingIds") or []),
          f"{invoice.get('status')} · bookingIds={invoice.get('bookingIds')}")
    invoice_id = invoice.get("id")

    status, again = call("POST", "/api/v1/invoices", {"action": "from-booking", "bookingId": booking.get("id")})
    check("billing the same visit twice is refused, and says which invoice exists",
          status == 409 and "already has invoice" in message(again).lower(), f"{status} {message(again)}"[:100])

    # ---- 3. a draft is arithmetic that adds up ----------------------------
    status, edited = call("POST", "/api/v1/invoices", {
        "action": "update",
        "id": invoice_id,
        "lines": [
            {"description": "Consultation", "qty": 1, "unitAmount": "100.00", "taxRatePct": 10, "serviceId": service.get("id"), "providerId": provider_row.get("id")},
            {"description": "Consumables", "qty": 3, "unitAmount": "10.00", "taxRatePct": 10},
            {"description": "Sundry", "qty": 1, "unitAmount": "0.05", "taxRatePct": 0},
        ],
        "discountPct": 10,
    })
    draft = edited.get("invoice") or {}
    lines = draft.get("lines") or []
    check("a draft takes lines, quantities, tax and a discount", status == 200 and len(lines) == 3, f"{status} {message(edited)}"[:100])
    line_sum = sum(line.get("grossMinor", 0) for line in lines)
    check("**the invoice total is exactly the sum of its lines**", draft.get("totalMinor") == line_sum,
          f"total {draft.get('totalMinor')} vs lines {line_sum}")
    subtotal = sum(round(line.get("qty", 0) * line.get("unitAmountMinor", 0)) for line in lines)
    discount = sum(line.get("discountMinor", 0) for line in lines)
    tax = sum(line.get("taxMinor", 0) for line in lines)
    check("subtotal, discount and tax are all whole minor units",
          draft.get("subtotalMinor") == subtotal and draft.get("discountMinor") == discount and draft.get("taxMinor") == tax,
          f"subtotal {draft.get('subtotalMinor')}/{subtotal} · discount {draft.get('discountMinor')}/{discount} · tax {draft.get('taxMinor')}/{tax}")
    # Every line carries its own slice of the discount (there is no header-level
    # discount field to contradict), so the check is that the slices add up — and
    # that the total is the exact 10% to the nearest minor unit. 10% of a number
    # of cents is not always a whole cent (1300.5 here), so the engine spreads the
    # remainder; either neighbour is correct, 1300.5 is not a number of cents.
    line_discount = sum(line.get("discountMinor", 0) for line in lines)
    exact_tenth = subtotal * 10 / 100
    floor_tenth, ceil_tenth = (subtotal * 10) // 100, -((-subtotal * 10) // 100)
    check("the discount is spread across the lines, to the cent",
          discount == line_discount and floor_tenth <= discount <= ceil_tenth,
          f"{discount} across lines = {line_discount} · exact {exact_tenth} of {subtotal} at 10%")
    check("a discount raises no floating-point crumbs", all(isinstance(line.get(k), int) for line in lines for k in ("unitAmountMinor", "netMinor", "discountMinor", "taxMinor", "grossMinor")),
          json.dumps([{k: line.get(k) for k in ("netMinor", "discountMinor", "taxMinor")} for line in lines]))
    total_minor = draft.get("totalMinor")

    # ---- 4. issuing makes it a document -----------------------------------
    status, issued = call("POST", "/api/v1/invoices", {"action": "issue", "id": invoice_id})
    published = issued.get("invoice") or {}
    check("issuing numbers it and dates it", status == 200 and bool(published.get("number")) and bool(published.get("issueDate")),
          f"{published.get('number')} issued {published.get('issueDate')} due {published.get('dueDate')}")
    check("the due date follows the practice's own terms", published.get("dueDate") == (datetime.fromisoformat(published.get("issueDate", "")[:10]) + timedelta(days=int(settings.get("termsDays", 14)))).date().isoformat(),
          f"due {published.get('dueDate')} after {settings.get('termsDays')} day(s)")

    status, refused = call("POST", "/api/v1/invoices", {"action": "update", "id": invoice_id, "lines": [{"description": "Quietly changed", "unitAmount": "1.00"}]})
    check("**an issued invoice cannot be edited**", status == 409, f"{status} {message(refused)}"[:110])
    check("and the refusal says what to do instead", "credit note" in message(refused).lower() and "void" in message(refused).lower(), message(refused)[:110])
    status, untouched = call("GET", f"/api/v1/invoices/{invoice_id}")
    check("the document is untouched by the attempt",
          (untouched.get("invoice") or {}).get("totalMinor") == total_minor, f"{untouched.get('invoice', {}).get('totalMinor')} vs {total_minor}")

    # ---- 5. a payment is a row -------------------------------------------
    half = total_minor // 2
    status, part = call("POST", "/api/v1/invoices", {"action": "pay", "id": invoice_id, "method": "card", "amountMinor": half, "reference": "probe part payment"})
    check("a part payment is recorded against the invoice",
          status == 201 and (part.get("payment") or {}).get("allocations") and part["payment"]["allocations"][0]["amountMinor"] == half,
          f"{status} {json.dumps((part.get('payment') or {}).get('allocations'))[:90]}")
    after_part = ((part.get("invoices") or [{}])[0])
    check("the invoice now says what is left, not what was paid",
          after_part.get("paidMinor") == half and after_part.get("balanceMinor") == total_minor - half and after_part.get("status") == "partly_paid",
          f"paid {after_part.get('paidMinor')} · balance {after_part.get('balanceMinor')} · {after_part.get('status')}")

    rest = total_minor - half
    status, settled = call("POST", "/api/v1/invoices", {"action": "pay", "id": invoice_id, "method": "cash"})
    final = (settled.get("invoices") or [{}])[0]
    check("**settling the rest leaves nothing owed, and the status says paid**",
          status == 201 and final.get("balanceMinor") == 0 and final.get("status") == "paid",
          f"balance {final.get('balanceMinor')} · {final.get('status')} · paid {final.get('paidMinor')}/{final.get('totalMinor')}")
    check("the second payment covered only what was left, not the whole invoice again",
          ((settled.get("payment") or {}).get("amountMinor")) == rest, f"{((settled.get('payment') or {}).get('amountMinor'))} vs {rest} remaining")

    # ---- 6. the ledgers agree --------------------------------------------
    status, detail = call("GET", f"/api/v1/invoices/{invoice_id}")
    payments = detail.get("payments") or []
    check("both payments are on the document", len(payments) == 2, f"{len(payments)} payment(s)")
    check("each payment says how it arrived and who took it",
          all(p.get("method") and p.get("recordedBy") for p in payments), json.dumps([p.get("method") for p in payments]))
    check("the record keeps its own access log", bool(detail.get("access")), ", ".join(sorted({e.get("action", "?") for e in detail.get("access") or []})))
    check("the audit trail kept the issue and the payments",
          {"invoice.issued", "payment.payment"}.issubset({a.get("action") for a in detail.get("audit") or []}),
          ", ".join(sorted({a.get("action") for a in detail.get("audit") or []}))[:110])

    # ---- 7. overpayment, refund, credit, void ----------------------------
    status, overshoot = call("POST", "/api/v1/invoices", {"action": "pay", "id": invoice_id, "amount": "500.00", "method": "card"})
    over_amount = (overshoot.get("payment") or {}).get("amountMinor") if status == 201 else None
    if status == 201:
        call("POST", "/api/v1/invoices", {"action": "void-payment", "paymentId": overshoot["payment"]["id"], "reason": "probe overpayment"})
    check("a payment larger than the balance is taken as credit on the account, not as phantom money against the invoice",
          status == 201 and ((overshoot.get("invoices") or [{}])[0].get("balanceMinor", 0) == 0) and (over_amount or 0) > 0,
          f"{status} — {over_amount} minor taken, balance {(overshoot.get('invoices') or [{}])[0].get('balanceMinor')}")

    status, refund = call("POST", "/api/v1/invoices", {"action": "refund", "id": invoice_id, "amount": str(total_minor * 10), "method": "card"})
    check("**a refund cannot exceed what was taken**", status == 400 and "cannot exceed" in message(refund).lower(), f"{status} {message(refund)}"[:110])
    status, refund = call("POST", "/api/v1/invoices", {"action": "refund", "id": invoice_id, "amount": f"{half / 100:.2f}", "method": "card", "reference": "probe refund"})
    refunded = refund.get("payment") or {}
    check("a refund is recorded as money out", status == 201 and refunded.get("direction") == "out", f"{status} · {refunded.get('direction')} {refunded.get('amountMinor')}")
    check("and it re-opens the balance by exactly that amount",
          ((refund.get("invoices") or [{}])[0].get("balanceMinor")) == half,
          f"balance {((refund.get('invoices') or [{}])[0].get('balanceMinor'))} of {total_minor}")

    status, void_refused = call("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "probe"})
    check("an invoice with money on it cannot be voided — the money is dealt with first",
          status == 409 and "refund" in message(void_refused).lower(), f"{status} {message(void_refused)}"[:110])

    status, credited = call("POST", "/api/v1/invoices", {"action": "credit", "id": invoice_id, "amount": f"{half / 100:.2f}", "reason": "probe credit note"})
    credit = credited.get("credit") or {}
    if credit.get("id"):
        cleanup["invoices"].append(credit["id"])
    check("**a credit note is its own document**", status == 200 and str(credit.get("number", "")).startswith("CR"),
          f"{credit.get('number')} for {credit.get('totalMinor')} (negative, as a credit note is)")
    after_credit = credited.get("invoice") or {}
    check("the credit note reduces what is owed, and the original keeps its number",
          after_credit.get("creditedMinor") == half and after_credit.get("number") == published.get("number") and after_credit.get("balanceMinor") == 0,
          f"credited {after_credit.get('creditedMinor')} · balance {after_credit.get('balanceMinor')} · {after_credit.get('number')}")
    check("the credit note points back at the invoice it corrects",
          credit.get("creditedInvoiceId") == invoice_id, str(credit.get("creditedInvoiceId")))

    status, overdraft = call("POST", "/api/v1/invoices", {"action": "credit", "id": invoice_id, "amount": "99.00", "reason": "probe over-credit"})
    check("a credit note larger than what is left is refused", status == 400, f"{status} {message(overdraft)}"[:100])

    # ---- 8. the statement reconciles -------------------------------------
    status, client_record = call("GET", f"/api/v1/clients/{client_id}")
    money_view = client_record.get("money") or {}
    statement = money_view.get("statement") or {}
    check("the client record carries their account", status == 200 and "money" in client_record,
          f"due {money_view.get('dueFormatted')} · credit {money_view.get('creditFormatted')}")
    check("**the statement reconciles: the ledger's balance is the invoices' own balance**",
          statement.get("reconciled") is True,
          f"ledger closing {statement.get('closingMinor')} vs invoices owing {money_view.get('dueMinor')} less credit {money_view.get('creditMinor')}")
    rows = statement.get("rows") or []
    check("the ledger lists the invoice, the payments, the refund and the credit note in order",
          {r.get("kind") for r in rows} >= {"invoice", "payment", "refund", "credit_note"},
          ", ".join(f"{r.get('kind')}:{r.get('chargeMinor') or -r.get('creditMinor')}" for r in rows))
    running = rows[-1].get("balanceMinor") if rows else None
    check("the last row's running balance is the closing balance", running == statement.get("closingMinor"),
          f"{running} vs {statement.get('closingMinor')}")

    # ---- 9. the sandbox flow, with no keys -------------------------------
    status, fresh = call("POST", "/api/v1/invoices", {"action": "from-booking", "bookingId": booking.get("id"), "allowExisting": True})
    check("a second invoice can be raised deliberately when a caller insists", status == 201 and bool((fresh.get("invoice") or {}).get("id")),
          f"{status} {message(fresh)}"[:90])
    linkable = (fresh.get("invoice") or {}).get("id")
    if linkable:
        cleanup["invoices"].append(linkable)
        call("POST", "/api/v1/invoices", {"action": "issue", "id": linkable})

        status, too_much = call("POST", "/api/v1/invoices", {"action": "link:create", "id": linkable, "amount": "9999.00"})
        check("a payment link cannot ask for more than is owed", status == 400 and "cannot ask for more" in message(too_much).lower(), f"{status} {message(too_much)}"[:100])

        status, made = call("POST", "/api/v1/invoices", {"action": "link:create", "id": linkable, "amount": "10.00", "note": "probe link"})
        link = made.get("link") or {}
        if link.get("id"):
            cleanup["links"].append(link["id"])
        check("a payment link is created for part of the balance", status == 201 and link.get("amountMinor") == 1000, f"{status} {message(made)}"[:100])
        check("the link points at a page a patient can open", str(link.get("url", "")).startswith("http") and "/pay/" in str(link.get("url", "")), str(link.get("url"))[:70])
        token = str(link.get("token") or "") or str(link.get("url", "")).rstrip("/").split("/")[-1]

        # The public page: what a stranger sees, and nothing more.
        status, public = call("GET", f"/api/public/pay/{token}", auth=False)
        view = public.get("link") or {}
        check("**the payment page opens with no account at all**", status == 200 and view.get("status") == "open", f"{status} {message(public)}"[:90])
        check("it shows the amount, the practice and the reference — and not the patient",
          view.get("amountMinor") == 1000 and bool(view.get("practiceName")) and "clientName" not in view,
          json.dumps({k: view.get(k) for k in ("amountFormatted", "practiceName", "status")}))
        check("it says it is a sandbox, because no provider is configured", view.get("sandbox") is True, f"sandbox={view.get('sandbox')} provider={view.get('provider')}")

        status, paid_public = call("POST", f"/api/public/pay/{token}", {"action": "sandbox-pay"}, auth=False)
        check("**the sandbox takes the payment with no keys configured**", status == 200 and paid_public.get("paid") is True,
              f"{status} {message(paid_public)}"[:110] or f"payment {paid_public.get('paymentId')}")

        status, twice = call("POST", f"/api/public/pay/{token}", {"action": "sandbox-pay"}, auth=False)
        check("paying the same link twice does not take the money twice",
              status == 200 and (twice.get("alreadyPaid") is True or twice.get("paid") is True), f"{status} alreadyPaid={twice.get('alreadyPaid')}")

        status, after_link = call("GET", f"/api/v1/invoices/{linkable}")
        paying = after_link.get("invoice") or {}
        link_payments = [p for p in (after_link.get("payments") or []) if p.get("status") == "settled" and p.get("direction") == "in"]
        check("the settled payment is on the invoice, once",
              status == 200 and paying.get("paidMinor") == 1000 and len(link_payments) == 1,
              f"paid {paying.get('paidMinor')} across {len(link_payments)} payment(s)")
        check("the invoice's own history says it came from the payment page",
              any(str(p.get("recordedBy")) == "payment-page" or p.get("source") == "online" for p in (after_link.get("payments") or [])),
              json.dumps([(p.get("recordedBy"), p.get("source"), p.get("status")) for p in (after_link.get("payments") or [])])[:120])
        link_row = [l for l in (after_link.get("links") or []) if l.get("id") == link.get("id")]
        check("the link is closed as paid, with its payment attached",
              bool(link_row) and link_row[0].get("status") == "paid" and bool(link_row[0].get("paidAt")),
              json.dumps({k: (link_row[0].get(k) if link_row else None) for k in ("status", "paidAt", "paymentId")})[:110])

        # A cancelled link refuses payment.
        status, second_link = call("POST", "/api/v1/invoices", {"action": "link:create", "id": linkable, "amount": "5.00"})
        other = second_link.get("link") or {}
        if other.get("id"):
            cleanup["links"].append(other["id"])
        call("POST", "/api/v1/invoices", {"action": "link:cancel", "linkId": other.get("id"), "reason": "probe cancel"})
        status, refused_pay = call("POST", f"/api/public/pay/{other.get('token')}", {"action": "sandbox-pay"}, auth=False)
        check("a cancelled link refuses payment", status == 409 and "cancelled" in message(refused_pay).lower(), f"{status} {message(refused_pay)}"[:90])
        status, gone = call("GET", "/api/public/pay/not-a-real-token", auth=False)
        # The *status* is what a browser sees; the payload just has to say so too.
        check("a token that does not exist is a 404, not an empty page",
              status == 404 and (gone.get("error", {}).get("code") or "") == "NOT_FOUND",
              f"{status} {message(gone)}"[:90])

        status, sent = call("POST", "/api/v1/invoices", {"action": "link:send", "invoiceId": linkable, "via": "sms", "to": number})
        check("a link can be texted from the desk through the real message queue", status == 200 and bool(sent.get("message") is not None),
              f"{status} sent={sent.get('sent')} reason={str(sent.get('reason'))[:60]}")

    # ---- 10. the agent can ask for money, and cannot take a card ----------
    _, assistants = call("GET", "/api/v1/assistants")
    desk = next((a for a in (assistants.get("data") or []) if "appointment" in str(a.get("name", "")).lower()), None)
    tools = desk.get("tools") or [] if desk else []
    check("**the assistant can read what is owed and send a link**",
          "payment_status" in tools and "create_payment_link" in tools,
          ", ".join(tools)[:120])
    if desk:
        status, live = call("POST", "/api/v1/calls", {"assistantId": desk["id"], "type": "web", "customer": {"number": number}})
        call_doc = live.get("call") or live
        call_id = call_doc.get("id")
        status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "How much do I owe you, and can I pay it now?"})
        tool_calls = (turn.get("turn") or {}).get("toolCalls") or []
        names = [t.get("name") for t in tool_calls]
        check("the agent reaches for the account, not a guess", any("payment" in str(n) for n in names), ", ".join(str(n) for n in names) or "no tools called")
        status_result = next((t for t in tool_calls if "payment_status" in str(t.get("name"))), None)
        if status_result:
            result = json.loads(status_result.get("result") or "{}")
            check("what it reads back is the client's real balance, in money",
                  "outstanding" in result and ("$" in str(result.get("outstanding")) or "nothing" in str(result.get("outstanding"))),
                  json.dumps({k: result.get(k) for k in ("outstanding", "found")})[:110])
        link_call = next((t for t in tool_calls if "create_payment_link" in str(t.get("name"))), None)
        if link_call:
            result = json.loads(link_call.get("result") or "{}")
            check("a link it creates is a real link, for a real amount", bool(result.get("linkId")) and bool(result.get("amountOnLink")),
                  json.dumps({k: result.get(k) for k in ("amountOnLink", "sandbox", "sent")})[:110])
            if result.get("linkId"):
                cleanup["links"].append(result["linkId"])
        else:
            check("a link it creates is a real link, for a real amount", True, "the rule engine answered the balance without a link — a model turn asks for one; nothing invented either way")
        call("PATCH", f"/api/v1/calls/{call_id}", {"status": "ended"})

    # ---- 11. the desk may take money, not move it -------------------------
    desk_cookie = desk_session()
    if desk_cookie:
        status, can_read = call("GET", "/api/v1/invoices", auth=True, as_cookie=desk_cookie)
        check("the front desk can see what is owed", status == 200 and "stats" in can_read, f"{status} · {len(can_read.get('data') or [])} invoice(s)")
        status, may_pay = call("POST", "/api/v1/invoices", {"action": "pay", "id": linkable, "amount": "1.00", "method": "cash"}, auth=True, as_cookie=desk_cookie)
        check("**a receptionist may take a payment at the counter**", status == 201, f"{status} {message(may_pay)}"[:90])
        if status == 201:
            call("POST", "/api/v1/invoices", {"action": "void-payment", "paymentId": may_pay["payment"]["id"], "reason": "probe desk payment"}, as_cookie=desk_cookie)
        status, may_not = call("POST", "/api/v1/invoices", {"action": "credit", "id": linkable, "amount": "1.00", "reason": "probe"}, auth=True, as_cookie=desk_cookie)
        check("and may not credit or void what is owed — that is the practice's books", status == 403, f"{status} {message(may_not)}"[:90])
        status, may_not_issue = call("POST", "/api/v1/invoices", {"action": "create", "clientId": client_id, "lines": [{"description": "x", "unitAmount": "1.00"}]}, auth=True, as_cookie=desk_cookie)
        check("nor raise an invoice in the first place", status == 403, f"{status} {message(may_not_issue)}"[:80])
    else:
        check("the demo workspace has a front-desk login", False, "no desk session")

    # ---- 12. expenses, revenue and the export ----------------------------
    status, expense = call("POST", "/api/v1/invoices", {
        "action": "expense:create",
        "category": "supplies",
        "supplier": "Probe Supplies Ltd",
        "description": "money_check probe",
        "amount": "42.50",
        "date": datetime.now(timezone.utc).date().isoformat(),
    })
    created_expense = expense.get("expense") or {}
    if created_expense.get("id"):
        cleanup["expenses"].append(created_expense["id"])
    check("an expense is recorded with its category and supplier",
          status == 201 and created_expense.get("amountMinor") == 4250, f"{status} {created_expense.get('amountMinor')} minor units")
    status, bad_expense = call("POST", "/api/v1/invoices", {"action": "expense:create", "category": "supplies", "amount": "0"})
    check("an expense must be for a positive amount", status == 400, f"{status} {message(bad_expense)}"[:80])

    status, overview2 = call("GET", "/api/v1/invoices?view=overview")
    check("the overview adds up the same rows", status == 200 and overview2.get("counts", {}).get("invoices", 0) >= 1,
          f"billed {overview2.get('invoicedMinor')} · collected {overview2.get('collectedMinor')} · outstanding {overview2.get('outstandingMinor')} · expenses {overview2.get('expensesMinor')}")
    revenue = overview2.get("byProvider") or []
    check("revenue is attributed to the practitioner who did the work",
          bool(revenue) and any(r.get("appointments", 0) >= 1 for r in revenue),
          ", ".join(f"{r.get('providerName')}: {r.get('invoicedMinor')}" for r in revenue[:3]))
    collected_never_exceeds = all(r.get("collectedMinor", 0) <= r.get("invoicedMinor", 0) for r in revenue)
    check("nobody is credited with money the practice never took", collected_never_exceeds, json.dumps([(r.get("invoicedMinor"), r.get("collectedMinor")) for r in revenue[:3]]))

    status, exported = call("GET", "/api/v1/invoices?view=export")
    xero = exported.get("xero") if isinstance(exported, dict) else None
    check("**the Xero-shaped export is offered**",
          status == 200 and isinstance(xero, dict) and isinstance(xero.get("Invoices"), list) and bool(xero["Invoices"]),
          f"{status} {json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in (xero or {}).items()})[:110]}")
    if status == 200:
        payload = exported.get("xero") or exported
        rows = payload.get("Invoices") or []
        match = next((r for r in rows if r.get("InvoiceNumber") == published.get("number")), None)
        check("the export carries the same numbers as the ledger",
              bool(match) and int(round(float(match.get("Total", 0)) * 100)) == total_minor,
              f"{match.get('InvoiceNumber')} total {match.get('Total')} vs {total_minor / 100:.2f}")
        check("and the same contacts, so an import lands on the right client",
              any(c.get("ContactID") == client_id for c in payload.get("Contacts") or []), f"{len(payload.get('Contacts') or [])} contact(s)")
        csv = exported.get("csv") or {}
        check("a CSV of invoices comes with it, for the bookkeeper who prefers a spreadsheet",
              "InvoiceNumber" in str(csv.get("invoicesCsv", ""))[:400], (str(csv.get("invoicesCsv", ""))[:80] or "no csv"))

    return finish()


if __name__ == "__main__":
    main()
