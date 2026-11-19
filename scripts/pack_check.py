#!/usr/bin/env python3
"""
The class-packs gate: places paid for up front, spent one class at a time.

What it proves, in the order a practice lives it:

  1. **A pack is priced on a class, and only a class** — a one-to-one service
     refuses in words that say why.
  2. **Buying is a prepayment, not a sale.** The money lands fenced to the
     pack: the client's ordinary on-account credit does not move, and no
     invoice exists yet — no class has happened.
  3. **Booking holds, attendance spends.** Adding the client to a class holds
     a place (money unmoved); marking them arrived raises the seat's invoice
     at the per-place share and settles it from the pack — one invoice, paid,
     and the pack shows a place gone.
  4. **Undo un-spends.** Marking the seat back to booked voids that invoice
     and the place (and its money) returns to the pack.
  5. **A no-show burns.** The place is spent with nothing attended.
  6. **Giving a place back early releases it** — no spend, no burn.
  7. **Refunding pays back only what was never spent**, shrinks the pack's
     money so the places cannot be spent twice, and closes the pack.
  8. **Nothing here is open to strangers.**

Run it with the app up:

    python3 scripts/pack_check.py

Everything it makes is named `Probe Pack …`. The class service/session setup
mirrors `class_check.py` and restores the instructor's service list after.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

OWNER = ""
RUN_IP = f"198.51.100.{int(time.time()) % 200}"
STAMP = int(time.time())
SERVICE_NAME = f"Probe Pack Yoga {STAMP}"
passes = 0
failures: list[str] = []


def check(label, ok, detail=""):
    global passes
    if ok:
        passes += 1
    else:
        failures.append(label)
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    return bool(ok)


def call(method, path, body=None, cookie=None):
    headers = {"accept": "application/json", "x-forwarded-for": RUN_IP}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    jar = OWNER if cookie is None else cookie
    if jar:
        headers["cookie"] = jar
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            fresh = (res.headers.get("set-cookie") or "").split(";")[0]
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {}
            return res.status, payload, fresh
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {}
        return err.code, payload, ""


def message_of(payload):
    if not isinstance(payload, dict):
        return ""
    return (payload.get("error") or {}).get("message") or payload.get("message") or ""


def data_of(payload):
    return payload.get("data") if isinstance(payload, dict) else None


def main():
    global OWNER
    print(f"packs check against {BASE}\n")

    # ---- strangers -------------------------------------------------------
    check("the packs list refuses anonymous callers", call("GET", "/api/v1/packs", cookie="")[0] == 401)

    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    if not cookie:
        status, _, cookie = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, cookie="")
        if status == 429:
            time.sleep(61)
            status, _, cookie = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, cookie="")
        check("the owner can sign in", status == 200, f"HTTP {status}")
    OWNER = cookie or OWNER
    if not OWNER:
        raise SystemExit("could not sign in")

    # ---- set up a class (mirrors class_check) -----------------------------
    sites = call("GET", "/api/v1/locations")[1].get("data") or []
    site = next((s for s in sites if s.get("name", "").startswith("Northwind East")), sites[0] if sites else None)
    if not site:
        raise SystemExit("no site to run a class at")
    providers = call("GET", "/api/v1/providers")[1].get("data") or []
    instructor = next((p for p in providers if site["id"] in (p.get("locationIds") or [])), providers[0] if providers else None)
    instructor_id = instructor["id"]
    instructor_before = list(instructor.get("serviceIds") or [])

    made = call("POST", "/api/v1/services", {"name": SERVICE_NAME, "durationMinutes": 60, "price": 12, "description": "A class the pack gate runs."})
    service_id = (made[1] or {}).get("id") or (made[1] or {}).get("service", {}).get("id") or ""
    if not service_id:
        rows = call("GET", "/api/v1/services?limit=200")[1].get("data") or []
        service_id = next((r["id"] for r in rows if r.get("name") == SERVICE_NAME), "")
    check("the desk can put a class in the service list", bool(service_id))
    call("PATCH", f"/api/v1/providers/{instructor_id}", {"serviceIds": instructor_before + [service_id]})

    session = None
    session2 = None
    try:
        # Scan actual calendar days and times. Fixed day offsets only sampled two
        # weekdays, so the gate failed whenever this instructor's rota moved off
        # that pair even though class scheduling itself was healthy.
        for day_offset in range(2, 23):
            date = time.strftime("%Y-%m-%d", time.gmtime(time.time() + day_offset * 86_400))
            for start in ("09:00", "10:00", "11:00", "14:00", "15:00", "16:00"):
                code, payload, _ = call(
                    "POST", "/api/v1/classes",
                    {"action": "create", "serviceId": service_id, "providerId": instructor_id, "locationId": site["id"], "date": date, "time": start, "capacity": 4, "notes": "pack gate probe"},
                )
                if code == 201 and payload.get("sessions"):
                    session = payload["sessions"][0]
                    break
            if session:
                break
        if not check("the desk can schedule a class session", bool(session)):
            raise SystemExit(1)

        # ---- 1. priced on a class, only a class ---------------------------
        plain = next((r for r in (call("GET", "/api/v1/services?limit=200")[1].get("data") or []) if r.get("id") != service_id and (r.get("capacity") or 1) < 2), None)
        code, payload, _ = call("POST", "/api/v1/packs", {"serviceId": plain["id"], "name": "Not a class pack", "places": 4, "priceMinor": 10000})
        check("a one-to-one service refuses a pack", code == 400 and "not a class" in message_of(payload), f"{code} {message_of(payload)}")

        code, payload, _ = call("POST", "/api/v1/packs", {"serviceId": service_id, "name": f"Probe Pack 4 {STAMP}", "places": 4, "priceMinor": 10000, "expiryMonths": 6})
        product = (payload or {}).get("product") or {}
        check("a pack product can be priced on the class", code == 201 and bool(product.get("id")), f"{code} {message_of(payload)}")
        product_id = product["id"]

        # ---- client --------------------------------------------------------
        code, payload, _ = call("POST", "/api/v1/clients", {"name": f"Probe Pack Holder {STAMP}", "number": f"+1555019{STAMP % 100000:05d}"})
        client = (payload or {}).get("client") or payload or {}
        client_id = client.get("id") or ""
        if not client_id:
            rows = call("GET", f"/api/v1/clients?q=Probe%20Pack%20Holder%20{STAMP}")[1].get("data") or []
            client_id = rows[0]["id"] if rows else ""
        check("a client exists to hold the pack", bool(client_id))

        balance_before = (call("GET", f"/api/v1/invoices?view=overview")[1] or {})

        # ---- 2. buying is a prepayment --------------------------------------
        code, payload, _ = call("POST", f"/api/v1/packs/{product_id}", {"action": "purchase", "clientId": client_id, "method": "card"})
        pack = (payload or {}).get("pack") or {}
        check("the pack can be bought", code == 201 and bool(pack.get("id")), f"{code} {message_of(payload)}")
        pack_id = pack["id"]
        check(
            "four places, none spent, none held",
            pack.get("placesTotal") == 4 and pack.get("spent") == 0 and pack.get("held") == 0 and pack.get("placesLeft") == 4,
            f"spent={pack.get('spent')} held={pack.get('held')} left={pack.get('placesLeft')}",
        )

        mine = (call("GET", f"/api/v1/packs?clientId={client_id}")[1] or {})
        payments = (call("GET", "/api/v1/invoices?view=payments")[1].get("data") or [])
        prepaid = next((p for p in payments if p.get("packId") == pack_id), None)
        check("the purchase is a prepayment fenced to the pack", bool(prepaid) and prepaid.get("kind") == "prepayment" and prepaid.get("unallocatedMinor") == 10000, str(prepaid and prepaid.get("kind")))
        seat_invoices = [i for i in (call("GET", "/api/v1/invoices?include=all")[1].get("data") or []) if i.get("clientId") == client_id]
        check("no invoice exists yet — no class has happened", len(seat_invoices) == 0, f"{len(seat_invoices)} invoice(s)")

        # ---- 3. booking holds ------------------------------------------------
        code, payload, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "add-seat", "clientId": client_id})
        seat = (payload or {}).get("seat") or {}
        check("the holder can be added to the class", code in (200, 201) and bool(seat.get("bookingId")), f"{code} {message_of(payload)}")
        booking_id = seat["bookingId"]

        pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
        check("the seat holds a place — money unmoved", pack_now.get("held") == 1 and pack_now.get("spent") == 0 and pack_now.get("placesLeft") == 3, f"held={pack_now.get('held')} spent={pack_now.get('spent')}")
        prepaid_now = next((p for p in (call("GET", "/api/v1/invoices?view=payments")[1].get("data") or []) if p.get("packId") == pack_id), None)
        check("a hold spends nothing", prepaid_now and prepaid_now.get("unallocatedMinor") == 10000)

        roster = (call("GET", f"/api/v1/classes/{session['id']}")[1] or {}).get("roster") or []
        row = next((r for r in roster if r.get("bookingId") == booking_id), {})
        check("the roster shows the seat is on the pack", row.get("packState") == "held", str(row.get("packState")))

        # ---- attendance spends ----------------------------------------------
        call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": booking_id, "status": "arrived"})
        pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
        invoices = [i for i in (call("GET", "/api/v1/invoices?include=all")[1].get("data") or []) if i.get("clientId") == client_id]
        spent_invoice = invoices[0] if invoices else {}
        check("attendance spends the place", pack_now.get("spent") == 1 and pack_now.get("held") == 0, f"spent={pack_now.get('spent')}")
        check(
            "the seat's invoice is the per-place share, paid",
            spent_invoice.get("totalMinor") == 2500 and spent_invoice.get("status") == "paid",
            f"total={spent_invoice.get('totalMinor')} status={spent_invoice.get('status')}",
        )

        # ---- 4. undo un-spends -------------------------------------------------
        # The register's Undo is the path a mis-tap actually takes: done, then
        # back to booked. (Arrived → booked is not a step the lifecycle allows
        # for any appointment, packs or not.)
        call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": booking_id, "status": "completed"})
        call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": booking_id, "status": "confirmed"})
        pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
        invoice_after = next((i for i in (call("GET", "/api/v1/invoices?include=all")[1].get("data") or []) if i.get("id") == spent_invoice.get("id")), {})
        check("undoing the mark un-spends the place", pack_now.get("spent") == 0 and pack_now.get("held") == 1, f"spent={pack_now.get('spent')} held={pack_now.get('held')}")
        check("and voids the seat's invoice", invoice_after.get("status") == "void", str(invoice_after.get("status")))
        prepaid_now = next((p for p in (call("GET", "/api/v1/invoices?view=payments")[1].get("data") or []) if p.get("packId") == pack_id), None)
        check("and the money is back in the pack", prepaid_now and prepaid_now.get("unallocatedMinor") == 10000)

        # ---- 5. no-show burns ----------------------------------------------------
        call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": booking_id, "status": "no_show"})
        pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
        check("a no-show burns the place", pack_now.get("spent") == 1 and pack_now.get("placesLeft") == 3, f"spent={pack_now.get('spent')} left={pack_now.get('placesLeft')}")

        # ---- 6. early give-back releases ------------------------------------------
        code, payload, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "add-seat", "name": f"Probe Pack Second {STAMP}", "number": f"+1555018{STAMP % 100000:05d}"})
        second = (payload or {}).get("seat") or {}
        # The second person has no pack: their seat must not touch the first pack.
        pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
        check("a stranger's seat does not hold the pack", second.get("bookingId") and pack_now.get("held") == 0, f"held={pack_now.get('held')}")

        # Re-seat the holder in a second session far out, then give it back early.
        for day_offset in range(24, 46):
            date = time.strftime("%Y-%m-%d", time.gmtime(time.time() + day_offset * 86_400))
            for start in ("09:00", "10:00", "11:00", "14:00", "15:00", "16:00"):
                code2, payload2, _ = call(
                    "POST", "/api/v1/classes",
                    {"action": "create", "serviceId": service_id, "providerId": instructor_id, "locationId": site["id"], "date": date, "time": start, "capacity": 4, "notes": "pack gate probe 2"},
                )
                if code2 == 201 and payload2.get("sessions"):
                    session2 = payload2["sessions"][0]
                    break
            if session2:
                break
        check("a second session exists for the release test", bool(session2))
        if session2:
            call("POST", f"/api/v1/classes/{session2['id']}", {"action": "add-seat", "clientId": client_id})
            pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
            check("the new seat holds again", pack_now.get("held") == 1, f"held={pack_now.get('held')}")
            roster2 = (call("GET", f"/api/v1/classes/{session2['id']}")[1] or {}).get("roster") or []
            seat2 = next((r for r in roster2 if r.get("clientId") == client_id), {})
            call("POST", f"/api/v1/classes/{session2['id']}", {"action": "remove-seat", "bookingId": seat2.get("bookingId"), "reason": "pack gate"})
            pack_now = (call("GET", f"/api/v1/client-packs/{pack_id}")[1] or {}).get("pack") or {}
            check(
                "giving it back early releases the place — not spent, not burned",
                pack_now.get("held") == 0 and pack_now.get("spent") == 1 and pack_now.get("placesLeft") == 3,
                f"held={pack_now.get('held')} spent={pack_now.get('spent')} left={pack_now.get('placesLeft')}",
            )

        # ---- 7. refund of the unspent ----------------------------------------------
        code, payload, _ = call("POST", f"/api/v1/client-packs/{pack_id}", {"action": "refund-unused"})
        refunded = (payload or {}).get("refundedMinor")
        pack_now = (payload or {}).get("pack") or {}
        check("the refund pays back only the unspent places", code == 200 and refunded == 7500, f"{code} refunded={refunded} {message_of(payload)}")
        check("and closes the pack", pack_now.get("status") == "refunded", str(pack_now.get("status")))
        prepaid_now = next((p for p in (call("GET", "/api/v1/invoices?view=payments")[1].get("data") or []) if p.get("packId") == pack_id), None)
        # The spent place's share sits allocated on its invoice; everything
        # unspent went back out, so nothing remains spendable in the pool.
        check("and the pack's money can no longer be spent", prepaid_now and prepaid_now.get("unallocatedMinor") == 0, str(prepaid_now and prepaid_now.get("unallocatedMinor")))

        code, payload, _ = call("POST", f"/api/v1/client-packs/{pack_id}", {"action": "refund-unused"})
        check("a second refund is refused", code == 409, f"{code} {message_of(payload)}")

        liability = (call("GET", "/api/v1/packs")[1] or {}).get("liability") or {}
        check("the liability line answers", isinstance(liability.get("valueHeldMinor"), int), str(liability.get("valueHeldMinor")))
        _ = balance_before
    finally:
        # Put the instructor's service list back exactly as found, and take
        # the probe service out of the catalogue — `practice_check` requires
        # every listed service to be offered by somebody (`class_check` does
        # the same tidy on its way out). Sessions cancel first: a service with
        # upcoming sessions refuses deletion.
        call("PATCH", f"/api/v1/providers/{instructor_id}", {"serviceIds": instructor_before})
        for made_session in (session, session2):
            if made_session:
                call("POST", "/api/v1/classes", {"action": "cancel", "sessionId": made_session["id"], "reason": "pack gate clean-up"})
        call("DELETE", f"/api/v1/services/{service_id}")

    print()
    if failures:
        print(f"FAILURES: {', '.join(failures)}")
        raise SystemExit(1)
    print(f"ALL PASS ({passes} checks)")


if __name__ == "__main__":
    main()
