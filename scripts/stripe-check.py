#!/usr/bin/env python3
"""End-to-end Stripe Checkout acceptance against scripts/stripe-stub.ts.

Proves provider refusal, Checkout Session request shape, public-page boundaries,
webhook signature/replay checks, settlement, and webhook idempotency. This is a
stub-provider gate: it proves our integration contract, not live settlement.
"""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000").rstrip("/")
STUB = os.environ.get("STRIPE_STUB_BASE", "http://127.0.0.1:4030").rstrip("/")
WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "whsec_stub")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

cookie = ""
failures: list[str] = []
cleanup: dict[str, str] = {}


def check(label: str, condition: bool, detail: object = ""):
    print(("PASS  " if condition else "FAIL  ") + label + (f"  — {str(detail)[:180]}" if detail != "" else ""))
    if not condition:
        failures.append(label)


def request(method: str, url: str, body=None, *, auth=True, headers=None, timeout=90):
    target = url if url.startswith("http") else BASE + url
    data = None
    if body is not None:
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    req = urllib.request.Request(target, data=data, method=method)
    if body is not None and not isinstance(body, str):
        req.add_header("content-type", "application/json")
    if auth and cookie:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode()
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"raw": raw}
            return res.status, payload, res.headers
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return err.code, payload, err.headers


def error_message(payload) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error)
        return str(payload.get("message") or payload)
    return str(payload)


def signed_header(payload: str, timestamp: int | None = None) -> str:
    stamp = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(WEBHOOK_SECRET.encode(), f"{stamp}.{payload}".encode(), hashlib.sha256).hexdigest()
    return f"t={stamp},v1={digest}"


def webhook(event: dict, *, signature: str | None = None):
    payload = json.dumps(event, separators=(",", ":"))
    headers = {"content-type": "application/json"}
    if signature is not None:
        headers["stripe-signature"] = signature
    return request("POST", "/api/payments/stripe/webhook", payload, auth=False, headers=headers), payload


def cleanup_probe():
    invoice_id = cleanup.get("invoice")
    if invoice_id:
        status, detail, _ = request("GET", f"/api/v1/invoices/{invoice_id}")
        for payment in (detail.get("payments") or []) if isinstance(detail, dict) else []:
            if payment.get("status") == "settled" or payment.get("settled") is True:
                request("POST", "/api/v1/invoices", {"action": "void-payment", "paymentId": payment.get("id"), "reason": "stripe-check probe"})
        request("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "stripe-check probe"})
    if cleanup.get("booking"):
        request("POST", f"/api/v1/bookings/{cleanup['booking']}/status", {"status": "cancelled"})
    if cleanup.get("client"):
        request("DELETE", f"/api/v1/clients/{cleanup['client']}", {"reason": "stripe-check probe", "force": True})


def main():
    global cookie

    # Sign in and reset only the provider stub, not product state.
    status, login, headers = request("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, auth=False)
    cookie = (headers.get("set-cookie") or "").split(";")[0]
    check("demo owner signs in", status == 200 and bool(cookie), status)
    if not cookie:
        return finish()

    status, reset, _ = request("POST", STUB + "/__reset", {}, auth=False)
    check("Stripe stub resets", status == 200 and reset.get("reset") is True, reset)

    status, overview, _ = request("GET", "/api/v1/invoices?view=overview")
    provider = overview.get("provider") or {}
    check("the deployment selects Stripe instead of sandbox", status == 200 and provider.get("driver") == "stripe", provider)

    _, services, _ = request("GET", "/api/v1/services")
    _, providers, _ = request("GET", "/api/v1/providers")
    service = (services.get("data") or [{}])[0]
    practitioner = (providers.get("data") or [{}])[0]
    stamp = int(time.time() * 1000)
    starts_at = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat().replace("+00:00", "Z")
    status, made, _ = request(
        "POST",
        "/api/v1/bookings",
        {
            "externalId": f"stripe-check-{stamp}",
            "customer": {
                "name": f"Stripe Check {stamp % 100000}",
                "number": f"+1555{stamp % 10000000:07d}",
                "email": f"stripe.check.{stamp}@example.test",
            },
            "startsAt": starts_at,
            "durationMinutes": 30,
            "status": "completed",
            "providerId": practitioner.get("id"),
            "serviceId": service.get("id"),
            "checkConflicts": False,
        },
    )
    booking = made.get("booking") or made
    cleanup["booking"] = str(booking.get("id") or "")
    cleanup["client"] = str(booking.get("clientId") or "")
    check("a completed visit exists to bill", status in (200, 201) and bool(cleanup["booking"]), error_message(made))
    if not cleanup["booking"]:
        return finish()

    status, raised, _ = request("POST", "/api/v1/invoices", {"action": "from-booking", "bookingId": cleanup["booking"]})
    invoice = raised.get("invoice") or {}
    cleanup["invoice"] = str(invoice.get("id") or "")
    check("the visit raises a draft invoice", status == 201 and bool(cleanup["invoice"]), error_message(raised))
    if not cleanup["invoice"]:
        return finish()
    status, issued, _ = request("POST", "/api/v1/invoices", {"action": "issue", "id": cleanup["invoice"]})
    check("the invoice is issued before collection", status == 200 and (issued.get("invoice") or {}).get("status") == "issued", error_message(issued))

    # A provider rejection must stop before a local payment-link row is claimed.
    request("POST", STUB + "/__control", {"failCreates": 1}, auth=False)
    status, refused, _ = request("POST", "/api/v1/invoices", {"action": "link:create", "id": cleanup["invoice"], "amount": "5.00"})
    check("Stripe checkout rejection is surfaced", status == 400 and "Stripe refused" in error_message(refused), error_message(refused))
    _, before, _ = request("GET", f"/api/v1/invoices/{cleanup['invoice']}")
    check("a rejected checkout leaves no local payment link", len(before.get("links") or []) == 0, len(before.get("links") or []))

    status, created, _ = request("POST", "/api/v1/invoices", {"action": "link:create", "id": cleanup["invoice"], "amount": "5.00", "note": "stripe-check"})
    link = created.get("link") or {}
    token = str(link.get("token") or "")
    session_id = str(link.get("providerRef") or "")
    check("a Stripe payment link is created", status == 201 and link.get("provider") == "stripe" and bool(session_id), error_message(created))
    check("the patient URL is Stripe-hosted", str(link.get("url") or "").startswith(STUB + "/checkout/"), link.get("url"))

    status, state, _ = request("GET", STUB + "/__state", auth=False)
    sessions = state.get("sessions") or []
    session = next((row for row in sessions if row.get("id") == session_id), {})
    check("Stripe receives the exact minor-unit amount and currency", status == 200 and session.get("amount_total") == 500 and bool(session.get("currency")), session)
    check(
        "Stripe receives invoice, workspace and token metadata",
        session.get("metadata", {}).get("invoiceId") == cleanup["invoice"]
        and session.get("metadata", {}).get("token") == token
        and session.get("client_reference_id") == token
        and bool(session.get("metadata", {}).get("orgId")),
        session.get("metadata"),
    )
    check("success and cancel URLs return to the same payment token", token in str(session.get("success_url")) and token in str(session.get("cancel_url")), {"success": session.get("success_url"), "cancel": session.get("cancel_url")})

    status, public, _ = request("GET", f"/api/public/pay/{token}", auth=False)
    view = public.get("link") or {}
    check("the public page is minimal and marks this as provider-backed", status == 200 and view.get("sandbox") is False and "clientName" not in view, view)
    status, blocked, _ = request("POST", f"/api/public/pay/{token}", {"action": "sandbox-pay"}, auth=False)
    check("the public sandbox door cannot settle a Stripe link", status == 400 and "provider" in error_message(blocked).lower(), error_message(blocked))

    event = {
        "id": "evt_stripe_check_completed",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": session_id,
                "payment_status": "paid",
                "client_reference_id": token,
                "payment_intent": session.get("payment_intent"),
            }
        },
    }
    (status, forged, _), payload = webhook(event)
    check("an unsigned Stripe webhook is rejected", status == 400 and forged.get("error", {}).get("code") == "UNAUTHORIZED", forged)
    (status, stale, _), _ = webhook(event, signature=signed_header(payload, int(time.time()) - 900))
    check("a correctly signed but stale webhook is rejected", status == 400 and stale.get("error", {}).get("code") == "UNAUTHORIZED", stale)

    unpaid_event = json.loads(payload)
    unpaid_event["id"] = "evt_stripe_check_unpaid"
    unpaid_event["data"]["object"]["payment_status"] = "unpaid"
    unpaid_payload = json.dumps(unpaid_event, separators=(",", ":"))
    (status, unpaid, _), _ = webhook(unpaid_event, signature=signed_header(unpaid_payload))
    check("a signed event does not settle before payment clears", status == 200 and unpaid.get("applied") is False and "not cleared" in str(unpaid.get("reason")), unpaid)

    status, controlled, _ = request("POST", STUB + "/__control", {"sessionId": session_id, "paymentStatus": "paid", "status": "complete"}, auth=False)
    check("the provider now reports the session paid", status == 200 and (controlled.get("session") or {}).get("payment_status") == "paid", controlled)

    (status, settled, _), payload = webhook(event, signature=signed_header(payload))
    payment_id = settled.get("paymentId")
    check("a current signed paid event settles the link", status == 200 and settled.get("applied") is True and bool(payment_id), settled)

    (status, replay, _), _ = webhook(event, signature=signed_header(payload))
    check("the same Stripe event is idempotent", status == 200 and replay.get("paymentId") == payment_id, replay)

    status, detail, _ = request("GET", f"/api/v1/invoices/{cleanup['invoice']}")
    links = [row for row in detail.get("links") or [] if row.get("id") == link.get("id")]
    payments = [row for row in detail.get("payments") or [] if row.get("status") == "settled" and row.get("direction") == "in"]
    check("the invoice records the Stripe payment exactly once", status == 200 and len(payments) == 1 and (detail.get("invoice") or {}).get("paidMinor") == 500, {"payments": len(payments), "paidMinor": (detail.get("invoice") or {}).get("paidMinor")})
    check("the payment link closes with its payment attached", len(links) == 1 and links[0].get("status") == "paid" and links[0].get("paymentId") == payment_id, links[0] if links else {})
    check("the ledger preserves Stripe's provider reference and webhook source", payments and payments[0].get("providerRef") == session.get("payment_intent") and payments[0].get("source") == "webhook", payments[0] if payments else {})

    finish()


def finish():
    try:
        if cookie:
            cleanup_probe()
    finally:
        print()
        if failures:
            print(f"{len(failures)} STRIPE CHECK(S) FAILED: " + "; ".join(failures))
            sys.exit(1)
        print("ALL STRIPE CHECKS PASS — stub contract verified; no claim of live settlement.")


if __name__ == "__main__":
    main()
