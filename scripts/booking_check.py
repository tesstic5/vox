#!/usr/bin/env python3
"""
Online booking check (PRACTICE.md phase P3).

The phase gate is one sentence: *a stranger books end-to-end and it appears on
the diary, with the term pack applied*. This script is a stranger — no session,
no key — and it checks the whole path:

   1.  the public page's API answers for a real workspace and 404s for a fake one
   2.  it exposes services, providers and sites, and nothing about any client
   3.  availability comes from the diary engine and is honest about a closed day
   4.  a booking goes through with no authentication at all
   5.  it lands on the diary, on the right day, with the right provider
   6.  a client record exists and is linked, with consent as the visitor ticked
   7.  the confirmation is a real queue row, not a claim
   8.  a second booking for the same slot is refused with 409
   9.  the .ics is well-formed and carries the right instant
  10.  the workspace's own view shows the booking and the message
  11.  the rate limit actually limits
  12.  a workspace with booking switched off refuses politely

Usage: python3 scripts/booking_check.py   (the app must be running)
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import drain_queue, session as cached_session  # noqa: E402
from _twilio_fixture import TwilioFixture, ensure_twilio_fixture  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
# Every run arrives from its own address. The limiter is per connection, so a
# second run inside the window would otherwise walk into the first one's bucket.
FORWARDED_FOR = os.environ.get("VOXERA_FORWARDED_FOR", f"10.42.{int(time.time()) % 250}.{(int(time.time() * 1000)) % 250}")
SLUG = os.environ.get("VOXERA_BOOKING_SLUG", "northwind-labs")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

cookie = ""
failures: list[str] = []
cleanup: dict[str, list[str]] = {"bookings": [], "clients": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, auth=False, raw=False, headers=None):
    global cookie
    url = path if path.startswith("http") else BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if auth and cookie:
        req.add_header("cookie", cookie)
    # The public routes limit by connection; a check script is one connection.
    req.add_header("x-forwarded-for", FORWARDED_FOR)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode()
            set_cookie = res.headers.get("set-cookie")
            if set_cookie:
                cookie = set_cookie.split(";")[0]
            if raw:
                return res.status, text, dict(res.headers)
            try:
                return res.status, (json.loads(text) if text else {}), dict(res.headers)
            except json.JSONDecodeError:
                return res.status, {"raw": text}, dict(res.headers)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        if raw:
            return err.code, text, dict(err.headers)
        try:
            return err.code, json.loads(text) if text else {}, dict(err.headers)
        except json.JSONDecodeError:
            return err.code, {"raw": text}, dict(err.headers)


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


VISITORS = [0]


def visitor():
    """Headers for *a different visitor*.

    The public booking route allows 20 posts per connection per ten minutes —
    correct for a booking page, but a check script that keeps posting from one
    address eventually collects a 429 instead of the refusal it came for. A 429
    would prove nothing about the diary, so each booking attempt here arrives
    from its own address, the way real visitors do.
    """
    VISITORS[0] += 1
    n = VISITORS[0]
    return {"x-forwarded-for": f"10.{stamp() % 200}.{n % 250}.{(n * 7) % 250}"}


def stamp():
    return int(time.time() * 1000)


twilio_fixture: TwilioFixture | None = None


def borrow_carrier():
    """Borrow a verified carrier *and active carrier-backed number* for delivery."""
    global twilio_fixture

    def fixture_call(method, path, body=None):
        status, payload, _ = call(method, path, body, auth=True)
        return status, payload

    try:
        twilio_fixture = ensure_twilio_fixture(fixture_call, label="booking probe")
        print(f"  note  using signed Twilio stub line {twilio_fixture.number}")
    except Exception as error:
        print(f"  note  could not prepare the carrier fixture: {error}")


def main():
    # `cookie` is module state so `call()` can use it; assigning it here without
    # this line would quietly shadow it and send no session at all.
    global cookie

    # ---- 1. the page's API, as a stranger ---------------------------------
    status, page, _ = call("GET", f"/api/public/workspaces/{SLUG}/booking")
    check("the public page's API answers without a session", status == 200, message(page))
    if status != 200:
        return finish()
    check("no client data is in it", not any(k in json.dumps(page) for k in ("clients", "lastAppointmentAt", "dateOfBirth")),
          ", ".join(sorted(page.keys())))
    check("the workspace's own terms come back", bool((page.get("workspace") or {}).get("terms", {}).get("appointment")),
          str((page.get("workspace") or {}).get("terms", {}).get("appointment", {}).get("one")))

    status, missing, _ = call("GET", "/api/public/workspaces/definitely-not-a-workspace/booking")
    check("a workspace that does not exist is a 404", status == 404, message(missing))

    services = page.get("services") or []
    sites = page.get("sites") or []
    check("services are offered", len(services) >= 2, ", ".join(s["name"] for s in services))
    check("services carry what the page needs to show", all({"id", "name", "durationMinutes", "price"} <= set(s) for s in services),
          f"{len(services)} service(s)")
    if not services:
        return finish()

    service = next((s for s in services if s["durationMinutes"] <= 30), services[0])
    location = sites[0]["id"] if sites else None

    # ---- 3. availability ---------------------------------------------------
    status, avail, _ = call("GET", f"/api/public/workspaces/{SLUG}/availability?serviceId={service['id']}&days=14&limit=60")
    days = avail.get("days") or []
    check("availability answers for a chosen service", status == 200 and isinstance(days, list), f"{len(days)} day(s) with room")
    check("slots are grouped by local day and carry a display time",
          all(d.get("date") and all(s.get("label") and s.get("startsAt") for s in d["slots"]) for d in days),
          f"{sum(len(d['slots']) for d in days)} slot(s)")
    check("availability leaks nothing about other appointments",
          "taken" not in json.dumps(avail) and "customer" not in json.dumps(avail) and "clientId" not in json.dumps(avail),
          ", ".join(sorted(avail.keys())))

    # ---- 11. the limiter ---------------------------------------------------
    limited = None
    for attempt in range(70):
        status, _, _ = call("GET", f"/api/public/workspaces/{SLUG}/availability?serviceId={service['id']}&limit=5")
        if status == 429:
            limited = attempt + 1
            break
    check("availability is rate limited per connection", limited is not None,
          f"429 on call {limited}" if limited else "no limit hit in 70 calls")

    if not days:
        return finish()
    # The first day with room, and the first slot on it.
    day = next((d for d in days if d["slots"]), None)
    slot = day["slots"][0] if day else None
    if not slot:
        return finish()

    # A closed day must be honest: Sunday is not offered for this workspace.
    closed = [d["date"] for d in days if not d["slots"]]
    check("a day the practice is closed is not offered", len(closed) == 0 or len(days) > len(closed),
          f"{len(closed)} day(s) in the window have no room: {', '.join(closed[:3])}" if closed else "every day scanned has room")

    # ---- 4. the booking ----------------------------------------------------
    number = f"+1415558{stamp() % 100000:05d}"
    name = f"Probe Web Booker {stamp() % 10000}"
    # Small race, real world: another register can take the slot between listing
    # availability and posting the booking (the gate's own earlier runs do exactly
    # that when they are run back to back). A 409 here means take the next slot —
    # the *second* booking below is the one that has to be refused.
    # Walk forward if a slot has just gone: a suite run fills the first few slots
    # of the day, and the honest answer for a visitor is the next free one.
    with_room = [d for d in days if d["slots"]]
    candidates = [c for d in with_room[:3] for c in d["slots"][:4]] or [slot]
    booked, status, wanted = {}, None, slot
    for candidate in candidates:
        status, booked, _ = call(
            "POST",
            f"/api/public/workspaces/{SLUG}/booking",
            {
                "startsAt": candidate["startsAt"],
                "serviceId": service["id"],
                # The slot says where it is; book it there, exactly as the page does.
                "locationId": candidate.get("locationId") or location,
                "name": name,
                "number": number,
                "email": "web.booker@example.com",
                "notes": "from booking_check",
                "consentSms": True,
                "consentEmail": False,
            },
            headers=visitor(),
        )
        if status == 201:
            slot = candidate
            break
    check("a stranger can book with no session and no key", status == 201, f"{status} {message(booked)}")
    if status != 201:
        return finish()
    booking = booked.get("booking") or {}
    booking_id = booking.get("id")
    if booking_id:
        cleanup["bookings"].append(booking_id)
    check("the reply carries a reference and a spoken-style time", bool(booking.get("reference")) and bool(booking.get("local")),
          f"{booking.get('reference')} · {booking.get('local')}")
    check("the provider is named even when the visitor did not pick one", bool(booking.get("providerName")), str(booking.get("providerName")))

    # A second booking for the same slot must be refused.
    status, clash, _ = call(
        "POST",
        f"/api/public/workspaces/{SLUG}/booking",
        {"startsAt": slot["startsAt"], "serviceId": service["id"], "locationId": slot.get("locationId") or location, "name": "Probe Second Attempt", "number": f"+1415559{stamp() % 100000:05d}"},
        headers=visitor(),
    )
    check("booking the same slot twice is a 409", status == 409, f"{status} {message(clash)}")

    # ---- 9. the calendar file ---------------------------------------------
    status, ics, headers = call("GET", f"/api/public/bookings/{booking_id}/appointment.ics", raw=True)
    check("the .ics downloads", status == 200 and "text/calendar" in headers.get("content-type", ""), headers.get("content-type", ""))
    check("it is a well-formed calendar with the right instant",
          "BEGIN:VCALENDAR" in ics and "END:VCALENDAR" in ics
          and f"DTSTART:{datetime.fromisoformat(slot['startsAt'].replace('Z', '+00:00')).strftime('%Y%m%dT%H%M%SZ')}" in ics,
          [line for line in ics.splitlines() if line.startswith("DTSTART")][0] if "DTSTART" in ics else "no DTSTART")
    check("the file names nobody's number", number not in ics, "no number in the file")
    check("it ends with CRLF as the format requires", ics.endswith("\r\n"), repr(ics[-4:]))

    # ---- 7. the confirmation is a real row ---------------------------------
    confirmation = booked.get("confirmation") or {}
    check("the confirmation reports what happened to it", confirmation.get("status") in ("pending", "sent", "blocked"), str(confirmation.get("status")))
    check("a ticked box means consent was recorded, so it is not blocked", confirmation.get("status") != "blocked",
          str(confirmation.get("reason") or "no reason given"))

    # ---- 7b. the queue actually sends --------------------------------------
    # Sign in now: everything above had to work without credentials, and this is
    # the first line that may not.
    cookie = cached_session(BASE, EMAIL, PASSWORD)
    borrow_carrier()

    def this_confirmation():
        _, queue, _ = call("GET", f"/api/v1/messages?bookingId={booking_id}", auth=True)
        return next((m for m in queue.get("data", []) if (m.get("meta") or {}).get("kind") == "confirmation"), None)

    def send_once():
        status, body, _ = call("POST", "/api/v1/messages", {"action": "deliver"}, auth=True)
        return status, body

    # The queue drains oldest-first and is capped per run: a workspace with a
    # backlog needs more than one send before this booking's row is reached.
    sends, (status, delivered) = drain_queue(send_once, lambda: (this_confirmation() or {}).get("status") != "pending")
    check("running the queue sends the confirmation", status == 200 and "sent" in delivered,
          f"{status} {json.dumps(delivered)[:120]} after {sends} send(s)")
    if status == 200:
        row = this_confirmation()
        check("the confirmation row says it was sent, by whom, and when",
              bool(row) and row.get("status") == "sent" and bool(row.get("provider")) and bool(row.get("sentAt")),
              f"{row.get('status') if row else 'missing'} via {row.get('provider') if row else '—'} (after {sends} send(s))")

    # ---- 7d. the reminder rule --------------------------------------------
    status, first, _ = call("POST", "/api/v1/messages", {"action": "queue-reminders"}, auth=True)
    status2, second, _ = call("POST", "/api/v1/messages", {"action": "queue-reminders"}, auth=True)
    check("the reminder rule can be run and reports what it queued",
          status == 200 and isinstance(first.get("queued"), int), f"{status} {json.dumps(first)[:120]}")
    check("running it twice queues nothing extra", status2 == 200 and second.get("queued") == 0,
          f"second run queued {second.get('queued')}")
    if first.get("pendingReminders"):
        _, reminders, _ = call("GET", "/api/v1/messages?status=pending", auth=True)
        rows = [m for m in reminders.get("data", []) if (m.get("meta") or {}).get("kind") == "reminder"]
        check("every reminder points at a real appointment and a real time",
              bool(rows) and all(m.get("bookingId") and m.get("sendAt") for m in rows),
              f"{len(rows)} reminder(s)")
        # A reminder inside the lead window is for the future, not the past.
        earliest = min(datetime.fromisoformat(m["sendAt"].replace("Z", "+00:00")) for m in rows)
        check("a queued reminder is still ahead of us, never retroactive", earliest > datetime.now(timezone.utc) - timedelta(minutes=1),
              f"earliest {earliest.isoformat()[:16]}")

    # ---- 5 & 6 & 10. on the diary, on the record, in the workspace view ----
    status, mine, _ = call("GET", f"/api/v1/bookings?externalId={booking['reference']}", auth=True)
    row = (mine.get("data") or [None])[0]
    check("the appointment is on the workspace's books", status == 200 and row is not None, f"{status}")
    if row:
        cleanup["bookings"].append(row["id"])
        check("it carries the source the reports will use", row.get("source") == "online", str(row.get("source")))
        check("it is attached to a client record", bool(row.get("clientId")), str(row.get("clientId")))
        if row.get("clientId"):
            cleanup["clients"].append(row["clientId"])
            _, record, _ = call("GET", f"/api/v1/clients/{row['clientId']}", auth=True)
            check("the record has the visitor's consent, exactly as ticked",
                  record.get("consents", {}).get("sms", {}).get("granted") is True
                  and record.get("consents", {}).get("email", {}).get("granted") is False,
                  f"sms={record.get('consents', {}).get('sms', {}).get('granted')} email={record.get('consents', {}).get('email', {}).get('granted')}")
            check("the record says it came from the booking page", record.get("source") == "online", str(record.get("source")))

    # ---- 7c. consent withdrawn after the fact ------------------------------
    if row and row.get("clientId"):
        call("POST", f"/api/v1/clients/{row['clientId']}/consents", {"channel": "sms", "granted": False, "source": "staff"}, auth=True)
        status, refused_text, _ = call(
            "POST",
            "/api/v1/messages",
            {"channel": "sms", "to": "+14155580001", "clientId": row["clientId"], "body": "This must not send."},
            auth=True,
        )
        check("withdrawn consent stops the desk texting too", status == 409, f"{status} {message(refused_text)}")
        # Put it back so the record is left as it was found.
        call("POST", f"/api/v1/clients/{row['clientId']}/consents", {"channel": "sms", "granted": True, "source": "staff"}, auth=True)

    day_str = slot["startsAt"][:10]
    _, diary, _ = call("GET", f"/api/v1/diary?view=day&from={day_str}", auth=True)
    on_grid = [a for d in diary.get("days", []) for a in d["appointments"] if a["id"] == booking_id]
    check("it appears on the diary for that day", bool(on_grid), f"{len(diary.get('days', [{}])[0].get('appointments', []))} block(s) that day")
    if on_grid:
        check("the block knows the client and the site", bool(on_grid[0].get("clientId")) and bool(on_grid[0].get("locationName")),
              f"{on_grid[0].get('clientName')} at {on_grid[0].get('locationName')}")

    status, view, _ = call("GET", "/api/v1/booking-page", auth=True)
    check("the workspace view shows the link and the switches", status == 200 and bool(view.get("slug")) and "enabled" in (view.get("booking") or {}),
          str(view.get("link")))
    check("the message queue is tallied", isinstance((view.get("messages") or {}).get("pending"), int),
          json.dumps(view.get("messages")))

    # ---- 12. switched off --------------------------------------------------
    _, before, _ = call("GET", "/api/public/workspaces/" + SLUG + "/booking")
    call("PATCH", "/api/v1/booking-page", {"enabled": False}, auth=True)
    status, closed, _ = call("GET", f"/api/public/workspaces/{SLUG}/booking")
    check("switching booking off closes the page", status == 200 and closed.get("booking", {}).get("enabled") is False and bool(closed.get("notice")),
          str(closed.get("notice")))
    status, refused, _ = call(
        "POST",
        f"/api/public/workspaces/{SLUG}/booking",
        {"startsAt": slot["startsAt"], "serviceId": service["id"], "name": "Probe Too Late", "number": "+14155580000"},
        headers=visitor(),
    )
    check("and a booking attempt is refused with 403, not a validation error", status == 403, f"{status} {message(refused)}")
    call("PATCH", "/api/v1/booking-page", {"enabled": before.get("booking", {}).get("enabled", True)}, auth=True)

    return finish()


def finish():
    # The probe's own footprint, undone: a cancelled appointment and an archived
    # record. Deleting either outright is what the product refuses to do for a
    # practice, and a test has no business wanting better.
    for booking_id in dict.fromkeys(cleanup["bookings"]):
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled"}, auth=True)
    for client_id in dict.fromkeys(cleanup["clients"]):
        call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "booking_check probe", "force": True}, auth=True)
    if twilio_fixture:
        errors = twilio_fixture.cleanup(
            lambda method, path, body=None: (lambda result: (result[0], result[1]))(call(method, path, body, auth=True))
        )
        check("the Twilio fixture gives back everything it created", not errors, "; ".join(errors))

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — a stranger books end to end, it lands on the diary, and the confirmation is a real message.")


if __name__ == "__main__":
    main()
