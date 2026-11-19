#!/usr/bin/env python3
"""
The classes gate: one slot, several people, and never one too many (A8).

Groups and classes are the one Cliniko scheduling idea this product did not have:
every appointment was one person, one practitioner, one room, one hour. What this
proves, in the order a practice would live it:

  1. **A class is set up like anything else** — a service with a capacity, offered
     by an instructor who works at the site. The refusals come first, because they
     are the ones that keep the diary honest: one seat is not a class, an
     instructor who does not run it is refused *by name*, and a time already taken
     is refused with the class that took it.
  2. **The class really occupies the diary.** A private appointment cannot be
     booked into its hour (the refusal names the class), the slot search does not
     offer that time, and the room it was given is not offered to anybody else —
     including when nobody has joined yet, which is the case a seats-only model
     gets wrong.
  3. **The public page offers seats, not times** — with the seats left, the
     instructor and the room, and never the roster.
  4. **Capacity is a wall.** Three people join a three-seat class; the fourth is
     refused in words that name the capacity; somebody pressing join twice gets
     the seat they already have rather than a second one.
  5. **A seat is an ordinary booking** — it appears on the client's record, it is
     texted, and its own link can **give the place up** (which returns the seat)
     while refusing to *move* it, because a place in a class is not a private hour.
  6. **The desk runs it from the roster** — add a walk-in, take a place back.
  7. **Cancelling is not deleting**: every seat is released, every holder is told,
     the class leaves the public page, and the diary gets its hour back.
  8. **Nothing here is open to strangers** — the list and the writes both need a
     signed-in desk.

Run it with the app up:

    python3 scripts/class_check.py

Everything it makes is named `Probe Class …`, so a run that dies mid-way is swept
by `npx tsx scripts/tidy-probe-orgs.ts`. On the way out it also puts the
instructor's service list back exactly as it found it.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
SLUG = os.environ.get("VOXERA_SLUG", "northwind-labs")

OWNER = ""
RUN_IP = f"198.51.100.{int(time.time()) % 200}"
STAMP = int(time.time())
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
    """One request. `cookie=None` means the owner's session; `\"\"` means nobody."""
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
                payload = {"_html": raw}
            return res.status, payload, fresh, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {"_html": raw}
        return err.code, payload, "", raw


def message_of(payload):
    if not isinstance(payload, dict):
        return ""
    return (payload.get("error") or {}).get("message") or payload.get("message") or ""


def sign_in(email, password):
    status, payload, cookie, _ = call("POST", "/api/auth/login", {"email": email, "password": password}, cookie="")
    if status == 429:
        time.sleep(61)
        status, payload, cookie, _ = call("POST", "/api/auth/login", {"email": email, "password": password}, cookie="")
    return status, payload, cookie


def claims(text):
    import re

    match = re.search(r"/m/([A-Za-z0-9._-]+)", text or "")
    return match.group(1).rstrip(".,;:!?)]") if match else None


# --------------------------------------------------------------------- set-up

print(f"classes check against {BASE}\n")
status, payload, cookie = sign_in(EMAIL, PASSWORD)
if status != 200:
    print(f"the gate stopped: could not sign in ({status} {message_of(payload)})")
    sys.exit(1)
OWNER = cookie or cached_cookie()

SERVICE_NAME = f"Probe Class Studio Hour {STAMP}"
sessions_made: list[str] = []
instructor_before: list[str] = []
instructor_id = ""
service_id = ""

try:
    # ---- 1. the shape of a class ------------------------------------------------
    sites = call("GET", "/api/v1/locations")[1].get("data") or []
    site = next((s for s in sites if s.get("name", "").startswith("Northwind East")), sites[0] if sites else None)
    if not site:
        raise SystemExit("no site to run a class at")

    providers = call("GET", "/api/v1/providers")[1].get("data") or []
    # The instructor must work at this site; the service is linked in a moment.
    instructor = next((p for p in providers if site["id"] in (p.get("locationIds") or [])), None)
    if not instructor:
        raise SystemExit("no practitioner works at that site")
    instructor_id = instructor["id"]
    instructor_before = list(instructor.get("serviceIds") or [])

    made = call(
        "POST",
        "/api/v1/services",
        {"name": SERVICE_NAME, "durationMinutes": 60, "price": 12, "description": "A class the gate runs."},
    )
    check("the desk can put a class in the service list", made[0] == 201, f"{made[0]} {message_of(made[1])}")
    service_id = (made[1] or {}).get("id") or (made[1] or {}).get("service", {}).get("id") or ""
    if not service_id:
        rows = call("GET", "/api/v1/services?limit=200")[1].get("data") or []
        service_id = next((row["id"] for row in rows if row.get("name") == SERVICE_NAME), "")

    # A class is offered by somebody: link it, remembering the list to put back.
    linked = call("PATCH", f"/api/v1/providers/{instructor_id}", {"serviceIds": instructor_before + [service_id]})
    check("an instructor can be put down for it", linked[0] == 200, f"{linked[0]} {message_of(linked[1])}")

    code, payload, _, _ = call(
        "POST",
        "/api/v1/classes",
        {"action": "create", "serviceId": service_id, "providerId": instructor_id, "locationId": site["id"], "date": "2030-06-04", "time": "10:00", "capacity": 1},
    )
    check("one seat is not a class, and the refusal says so", code == 400 and "2 seats" in message_of(payload), f"{code} {message_of(payload)}")

    # Find a real free rota rather than assuming that fixed offsets happen to be
    # the instructor's weekdays. The old Sunday/Monday-only sequence failed as
    # soon as the calendar moved to a week where this provider worked neither.
    session = None
    for day_offset in range(2, 23):
        date = time.strftime("%Y-%m-%d", time.gmtime(time.time() + day_offset * 86_400))
        for start in ("09:00", "10:00", "11:00", "14:00", "15:00", "16:00"):
            code, payload, _, _ = call(
                "POST",
                "/api/v1/classes",
                {"action": "create", "serviceId": service_id, "providerId": instructor_id, "locationId": site["id"], "date": date, "time": start, "capacity": 3, "notes": "gate probe"},
            )
            if code == 201 and payload.get("sessions"):
                session = payload["sessions"][0]
                sessions_made.append(session["id"])
                break
        if session:
            break
    if not check("the desk can schedule a class session", bool(session), "no free rota in the next three weeks" if not session else f"{session['local']['spoken']} · capacity {session['capacity']}"):
        raise SystemExit(1)

    check(
        "the session carries its own clock, seats and room",
        session["capacity"] == 3
        and session["seats"] == 0
        and session["seatsLeft"] == 3
        and bool(session["local"]["start"])
        and session["local"]["timezone"] == site["timezone"],
        f"{session['local']['spoken']} · {session['local']['timezone']} · room={session.get('roomName')}",
    )
    check("and a room, so the class is somewhere", bool(session.get("roomName")), str(session.get("roomName")))

    code, payload, _, _ = call(
        "POST",
        "/api/v1/classes",
        {"action": "create", "serviceId": service_id, "providerId": instructor_id, "locationId": site["id"], "startsAt": session["startsAt"], "capacity": 3},
    )
    check("a second class cannot be put on top of it", code == 409, f"{code} {message_of(payload)}")

    # ---- 2. it really occupies the diary ---------------------------------------
    code, payload, _, _ = call(
        "POST",
        "/api/v1/bookings",
        {
            "externalId": f"probe-class-clash-{STAMP}",
            "customer": {"name": f"Probe Class Clash {STAMP}", "number": "+15550190701"},
            "service": SERVICE_NAME,
            "durationMinutes": 60,
            "startsAt": session["startsAt"],
            "locationId": site["id"],
            "providerId": instructor_id,
            "checkConflicts": True,
        },
    )
    check(
        "a private appointment cannot be booked into the class hour",
        code == 409 and SERVICE_NAME in message_of(payload) + json.dumps(payload.get("error", {}).get("detail", "")),
        f"{code} {message_of(payload)}",
    )

    # The proof has to bite. Asked about the *class* service alone the search can
    # legitimately return nothing at all — a class service is only ever sold as
    # seats — and then "the hour is not offered" would pass without testing
    # anything. So the same hour is asked about twice: once for an ordinary
    # one-to-one service the instructor really runs (which must offer that day),
    # and the class hour must be missing from *those* slots.
    ordinary_id = next((sid for sid in instructor_before if sid != service_id), "")
    if not ordinary_id:
        rows = call("GET", "/api/v1/services?limit=200")[1].get("data") or []
        ordinary = next((row for row in rows if row["id"] != service_id and row.get("active", True) and row.get("name") != SERVICE_NAME), None)
        if ordinary:
            ordinary_id = ordinary["id"]
            call("PATCH", f"/api/v1/providers/{instructor_id}", {"serviceIds": instructor_before + [service_id, ordinary_id]})

    def instant(iso: str) -> float:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()

    class_start = instant(session["startsAt"])
    class_end = class_start + int(session["durationMinutes"]) * 60

    def overlaps(slot: dict) -> bool:
        start = instant(slot["startsAt"])
        end = instant(slot.get("endsAt") or slot["startsAt"])
        return start < class_end and end > class_start

    # The endpoint answers with its slots under `data` (like every other list in
    # the API) and explains itself under `reason`/`scanned`. Reading `slots`
    # instead — which this gate did until now — returns an empty list every time
    # and makes the assertion below pass without ever looking at a real slot.
    def slot_list(payload: dict) -> list:
        return payload.get("data") or payload.get("slots") or []

    control = call("GET", f"/api/v1/availability?serviceId={ordinary_id}&providerId={instructor_id}&from={session['local']['date']}&days=1&limit=50")[1] if ordinary_id else {}
    control_slots = slot_list(control)
    check(
        "the same day is offered for an ordinary service — so the search was looking",
        len(control_slots) > 0,
        f"{len(control_slots)} slot(s) on {session['local']['date']} from {control.get('scanned')} scanned; {control.get('reason') or 'no reason given'}",
    )
    check(
        "and the class hour is missing from them, not merely absent from the whole day",
        control_slots and not any(overlaps(slot) for slot in control_slots),
        f"{len(control_slots)} slot(s), none overlapping {session['local']['start']}–{session['local']['end']}",
    )

    # ---- 3. the public page offers seats ---------------------------------------
    code, page, _, _ = call("GET", f"/api/public/workspaces/{SLUG}/booking")
    offered = next((c for c in (page.get("classes") or []) if c["sessionId"] == session["id"]), None)
    check("the public page offers the class", bool(offered), f"{len(page.get('classes') or [])} class(es) offered")
    if offered:
        check("with its seats left and no roster", offered["seatsLeft"] == 3 and "roster" not in json.dumps(offered), f"{offered['seatsLeft']}/{offered['capacity']} · {offered.get('instructor')}")

    code, payload, _, _ = call("POST", f"/api/public/workspaces/{SLUG}/booking", {"sessionId": session["id"], "name": f"Probe Class Noshow {STAMP}", "number": "555"})
    check("a seat with no usable number is refused", code == 400, f"{code} {message_of(payload)}")

    # ---- 4. capacity is a wall --------------------------------------------------
    seats = []
    for index, number in enumerate(("+15550190711", "+15550190712", "+15550190713")):
        code, payload, _, _ = call(
            "POST",
            f"/api/public/workspaces/{SLUG}/booking",
            {"sessionId": session["id"], "name": f"Probe Class Attendee {index + 1} {STAMP}", "number": number, "consentSms": True},
        )
        left = (payload.get("class") or {}).get("seatsLeft")
        seats.append(((payload.get("booking") or {}).get("id"), number))
        check(
            f"join {index + 1} of 3 takes a seat",
            code == 201 and left == 2 - index,
            f"{code} seatsLeft={left}",
        )

    code, payload, _, _ = call(
        "POST",
        f"/api/public/workspaces/{SLUG}/booking",
        {"sessionId": session["id"], "name": f"Probe Class Latecomer {STAMP}", "number": "+15550190714", "consentSms": True},
    )
    check(
        "the fourth is refused, in words that name the capacity",
        code == 409 and "3 of 3 seats" in message_of(payload),
        f"{code} {message_of(payload)}",
    )

    code, payload, _, _ = call(
        "POST",
        f"/api/public/workspaces/{SLUG}/booking",
        {"sessionId": session["id"], "name": f"Probe Class Attendee 1 {STAMP}", "number": "+15550190711", "consentSms": True},
    )
    check(
        "pressing join twice gives the seat they have, not a second one",
        code == 200 and payload.get("already") is True and (payload.get("class") or {}).get("seatsLeft") == 0,
        f"{code} already={payload.get('already')} seatsLeft={(payload.get('class') or {}).get('seatsLeft')}",
    )

    # ---- 5. the seat is an ordinary booking, and its own link ------------------
    code, detail, _, _ = call("GET", f"/api/v1/classes/{session['id']}")
    roster = detail.get("roster") or []
    check("the roster shows who holds the places", code == 200 and len(roster) == 3, f"{len(roster)} seat(s)")
    check("and the session counts them", detail["session"]["seats"] == 3 and detail["session"]["seatsLeft"] == 0, f"{detail['session']['seats']}/{detail['session']['capacity']}")

    booking_id = seats[0][0]
    code, link, _, _ = call("GET", f"/api/v1/bookings/{booking_id}")
    holder = (link.get("booking") or link) if isinstance(link, dict) else {}
    check("a seat is a booking like any other", code == 200 and holder.get("sessionId") == session["id"], f"{code} sessionId={holder.get('sessionId')}")

    code, view, _, _ = call("GET", f"/api/public/manage/{claims(json.dumps(call('GET', f'/api/v1/bookings/{booking_id}/link')[1]))}")
    v = (view.get("view") or view) if isinstance(view, dict) else {}
    check(
        "the client's own link knows it is a place in a class",
        bool(v.get("isClassSeat")) and bool(v.get("canCancel")) and not v.get("canChange"),
        f"canCancel={v.get('canCancel')} canChange={v.get('canChange')}",
    )
    token = claims(json.dumps(call("GET", f"/api/v1/bookings/{booking_id}/link")[1]))
    code, payload, _, _ = call("POST", f"/api/public/manage/{token}/action", {"action": "move", "startsAt": session["startsAt"]}, cookie="")
    check("a place cannot be moved out of the class from the link", code == 409, f"{code} {message_of(payload)}")

    code, payload, _, _ = call("POST", f"/api/public/manage/{token}/action", {"action": "cancel", "reason": "Something came up"}, cookie="")
    check("a place can be given up from the link", code == 200, f"{code} {message_of(payload)}")
    after = call("GET", f"/api/v1/classes/{session['id']}")[1]
    check("and the seat goes back to the class", after["session"]["seats"] == 2 and after["session"]["seatsLeft"] == 1, f"{after['session']['seats']} left {after['session']['seatsLeft']}")

    # ---- 6. the desk runs the roster -------------------------------------------
    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "add-seat", "name": f"Probe Class Walkin {STAMP}", "number": "+15550190715"})
    walkin = (payload.get("seat") or {}).get("bookingId")
    check("the desk can put a walk-in in", code == 201 and bool(walkin), f"{code} {(payload.get('seat') or {}).get('name')}")
    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "remove-seat", "bookingId": walkin})
    check("and take a place back again", code == 200 and (payload.get("session") or {}).get("seats") == 2, f"{code} seats={(payload.get('session') or {}).get('seats')}")

    # ---- 7. the register ---------------------------------------------------------
    #
    # A seat is a booking, so marking one is the ordinary status lifecycle. What
    # is new is that the class knows how many places are held and what became of
    # them — and that a class hour is never handed to the wait list as if it were
    # a free slot.
    code, detail, _, _ = call("GET", f"/api/v1/classes/{session['id']}")
    attendance = detail.get("attendance") or {}
    check(
        "the roster counts its places",
        code == 200 and attendance.get("seats") == 2 and attendance.get("confirmed") == 2 and attendance.get("capacity") == 3,
        json.dumps(attendance),
    )

    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "everyone-arrived"})
    attendance = payload.get("attendance") or {}
    check(
        "the room can be marked in one tap",
        code == 200 and payload.get("marked") == 2 and attendance.get("arrived") == 2,
        f"{code} marked={payload.get('marked')} arrived={attendance.get('arrived')}",
    )

    first_seat, second_seat = seats[1][0], seats[2][0]
    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": first_seat, "status": "completed"})
    check(
        "a place that is here can be marked done",
        code == 200 and (payload.get("attendance") or {}).get("completed") == 1,
        f"{code} {(payload.get('seat') or {}).get('status')}",
    )

    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": second_seat, "status": "completed"})
    attendance = payload.get("attendance") or {}
    check(
        "and a second one done makes two",
        code == 200 and attendance.get("completed") == 2 and attendance.get("attended") == 2,
        f"{code} completed={attendance.get('completed')}",
    )

    # The hour is one hour. Two people finishing a 60-minute class is 60 minutes
    # of the practitioner's day, not 120 — the same rule the day view follows, and
    # the reports must agree with it or utilisation is fiction.
    _, usage, _, _ = call("GET", f"/api/v1/reports?view=utilisation&from={session['local']['date']}&to={session['local']['date']}")
    row = next((r for r in (usage.get("rows") or []) if r.get("providerId") == instructor_id), {})
    check(
        "two seats done is the class hour attended once, not twice",
        row.get("attendedMinutes") == session["durationMinutes"],
        f"attended {row.get('attendedMinutes')} minute(s) for a {session['durationMinutes']}-minute class with 2 places done",
    )

    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": second_seat, "status": "confirmed"})
    check("a mis-tap can be undone", code == 200 and (payload.get("seat") or {}).get("status") == "confirmed", f"{code} {(payload.get('seat') or {}).get('status')}")

    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": second_seat, "status": "no_show"})
    check(
        "somebody who did not come is recorded as such",
        code == 200 and (payload.get("attendance") or {}).get("noShow") == 1,
        f"{code} noShow={(payload.get('attendance') or {}).get('noShow')}",
    )

    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": walkin, "status": "arrived"})
    check(
        "a booking that is not a place in this class cannot be marked here",
        code == 404,
        f"{code} {message_of(payload)}",
    )

    # ---- 8. a class hour is not a slot -------------------------------------------
    #
    # Giving a place back does not free the hour: the class is still running in its
    # room with its instructor. Offering that hour to somebody waiting for a private
    # appointment would text them a link the engine refuses — so nothing is offered,
    # and the answer says why. This was a real defect: the status route offered the
    # class hour to a waiting client until the guard was added.
    code, temp, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "add-seat", "name": f"Probe Class Leaver {STAMP}", "number": "+15550190717"})
    leaver = (temp.get("seat") or {}).get("bookingId")
    code, wait, _, _ = call(
        "POST",
        "/api/v1/wait-list",
        {
            "name": f"Probe Class Waiter {STAMP}",
            "number": "+15550190718",
            "serviceId": service_id,
            "providerId": instructor_id,
            "locationId": site["id"],
            "from": session["local"]["date"],
            "to": session["local"]["date"],
        },
    )
    waiter = (wait.get("id") or (wait.get("entry") or {}).get("id")) if isinstance(wait, dict) else None
    check("somebody is waiting for that service that day", bool(waiter), f"{code} {waiter}")

    code, payload, _, _ = call("POST", f"/api/v1/bookings/{leaver}/status", {"status": "cancelled", "note": "probe"})
    offers = payload.get("offers") or {}
    check(
        "giving a place back offers the hour to nobody",
        code == 200 and offers.get("offered") == 0 and not offers.get("names"),
        f"{code} offered={offers.get('offered')}",
    )
    check("and the answer says why rather than leaving an empty list", offers.get("classSeat") is True and "class" in str(offers.get("note", "")).lower(), str(offers.get("note"))[:110])

    code, payload, _, _ = call("POST", "/api/v1/wait-list/offers", {"bookingId": seats[1][0]})
    check(
        "the desk cannot offer a class place as a slot either",
        code == 409 and "class" in message_of(payload).lower(),
        f"{code} {message_of(payload)}",
    )

    code, payload, _, _ = call("POST", "/api/v1/wait-list/offers", {"entryId": waiter, "startsAt": session["startsAt"]})
    check(
        "nor can it hand a waiting client the class hour by hand",
        code == 409,
        f"{code} {message_of(payload)}",
    )
    if waiter:
        call("DELETE", f"/api/v1/wait-list/{waiter}")

    # ---- 8b. the queue for a place ---------------------------------------------
    #
    # A full class is not a dead end. Somebody can ask to be told when a place comes
    # free, the line is first-come-first-served, and one place goes to exactly one
    # person — the opposite of the slot list's five-way race, because a place is a
    # single chair rather than a shared link.
    #
    # This runs on its own session so nothing above is disturbed, and it is
    # cancelled at the end to prove what a cancelled class does to its line.
    print("\n8b. a full class, and the line for a place")

    queue_session = None
    # More candidates than the weekday the instructor actually works needs:
    # offsets 7/14/21 always land on today's weekday, so on a day the rota
    # does not cover (a Sunday, say) the old six all failed together.
    for day_offset, start in ((7, "09:00"), (8, "09:00"), (9, "09:00"), (10, "09:00"), (14, "09:00"), (15, "09:00"), (16, "09:00"), (17, "09:00"), (21, "15:00"), (22, "15:00"), (23, "09:00"), (24, "09:00")):
        date = time.strftime("%Y-%m-%d", time.gmtime(time.time() + day_offset * 86_400))
        code, payload, _, _ = call(
            "POST",
            "/api/v1/classes",
            {"action": "create", "serviceId": service_id, "providerId": instructor_id, "locationId": site["id"], "date": date, "time": start, "capacity": 2, "notes": "gate probe — queue"},
        )
        if code == 201 and payload.get("sessions"):
            queue_session = payload["sessions"][0]
            sessions_made.append(queue_session["id"])
            break
    check("a second class to fill", bool(queue_session), queue_session["local"]["spoken"] if queue_session else "no free rota")

    if queue_session:
        # The names to assert against are the ones the server answers with, not the
        # ones this script typed: a returning client keeps the record they already
        # have, so the phone number decides the name — and a gate that compared its
        # own string would call that correct behaviour a failure.
        first_name = f"Probe Queue First {STAMP}"
        second_name = f"Probe Queue Second {STAMP}"

        # A class with places left is not a class to wait for: the place is right
        # there, and a queue beside an empty chair is a queue nobody should join.
        code, refused, _, _ = call("POST", "/api/v1/wait-list", {"sessionId": queue_session["id"], "name": f"Probe Queue Early {STAMP}", "number": "+15550190720"})
        check(
            "a class with places left refuses the line, and says how many",
            code == 409 and "place" in message_of(refused).lower(),
            f"{code} {message_of(refused)}",
        )

        seat_ids = []
        for index, number in enumerate(("+15550190721", "+15550190722")):
            code, payload, _, _ = call(
                "POST",
                f"/api/v1/classes/{queue_session['id']}",
                {"action": "add-seat", "name": f"Probe Queue Seat {index + 1} {STAMP}", "number": number},
            )
            seat_ids.append(((payload.get("seat") or {}).get("bookingId")))
        check("and it fills", code == 201 and (payload.get("session") or {}).get("seatsLeft") == 0, f"seatsLeft={(payload.get('session') or {}).get('seatsLeft')}")

        code, first, _, _ = call("POST", "/api/v1/wait-list", {"sessionId": queue_session["id"], "name": first_name, "number": "+15550190723"})
        check("somebody can wait for a place in a full class", code == 201 and first.get("position") == 1, f"{code} position={first.get('position')}")
        first_name = str(first.get("name") or first_name)

        code, again, _, _ = call("POST", "/api/v1/wait-list", {"sessionId": queue_session["id"], "name": first_name, "number": "+15550190723"})
        check("pressing twice keeps the place in line they have", code == 200 and again.get("already") is True and again.get("position") == 1, f"{code} already={again.get('already')}")

        code, second, _, _ = call("POST", "/api/v1/wait-list", {"sessionId": queue_session["id"], "name": second_name, "number": "+15550190724"})
        check("the next person is second in line", code == 201 and second.get("position") == 2, f"{code} position={second.get('position')}")
        second_name = str(second.get("name") or second_name)

        code, detail, _, _ = call("GET", f"/api/v1/classes/{queue_session['id']}")
        queue = detail.get("waitList") or {}
        names = [w.get("name") for w in (queue.get("waiting") or [])]
        check("the desk sees the line, in the order they joined", queue.get("count") == 2 and names == [first_name, second_name], f"{names}")

        # The class entry must stay out of the slot machinery entirely: its window
        # is the class's own day, so offering it a private time would be a promise
        # for something the person never asked for.
        code, refused, _, _ = call("POST", "/api/v1/wait-list/offers", {"entryId": first.get("id")})
        check("a class entry is never offered a private time by hand", code == 409 and "class" in message_of(refused).lower(), f"{code} {message_of(refused)}")

        # A place comes free.
        code, freed, _, _ = call("POST", f"/api/v1/classes/{queue_session['id']}", {"action": "remove-seat", "bookingId": seat_ids[0], "reason": "gate probe"})
        check("a place given back is offered to the front of the line", code == 200 and freed.get("offered") == 1, f"{code} offered={freed.get('offered')}")
        waiting = (freed.get("waitList") or {}).get("waiting") or []
        check(
            "and the offer is against that person, not the whole line",
            len(waiting) == 2 and waiting[0].get("status") == "offered" and waiting[1].get("status") == "waiting",
            f"{[w.get('status') for w in waiting]}",
        )

        offer_id = waiting[0].get("offerId") if waiting else None
        rows = call("GET", "/api/v1/messages?kind=class_offer&limit=100")[1].get("data") or []
        message = next((row for row in rows if (row.get("meta") or {}).get("offerId") == offer_id), None)
        body = str((message or {}).get("body") or "")
        check("the person at the front is texted a link", bool(message) and "/offer/" in body, body[:110])
        check("and the text names a place, not a time", "place" in body.lower(), body[:110])

        token = None
        if message:
            spread = re.search(r"/offer/([A-Za-z0-9._-]+)", body)
            token = spread.group(1).rstrip(".,;:!?)]") if spread else None
        code, view, _, _ = call("GET", f"/api/public/offer/{token}", cookie="")
        check(
            "the claim page says it is a place in a class",
            code == 200 and (view.get("view") or {}).get("kind") == "class" and not ((view.get("view") or {}).get("alternatives") or {}).get("days"),
            f"{code} kind={(view.get('view') or {}).get('kind')}",
        )

        code, claimed, _, _ = call("POST", f"/api/public/offer/{token}", {"action": "claim"}, cookie="")
        check("taking it puts them in the class", code == 201 and (claimed.get("booking") or {}).get("status") == "confirmed", f"{code} {(claimed.get('booking') or {}).get('reference')}")

        code, detail, _, _ = call("GET", f"/api/v1/classes/{queue_session['id']}")
        seated = [r.get("name") for r in (detail.get("roster") or [])]
        moved = (detail.get("waitList") or {}).get("waiting") or []
        check("the roster has the person who was waiting", first_name in seated, f"{seated}")
        check(
            "and the line moves up",
            (detail.get("waitList") or {}).get("count") == 1 and moved and moved[0].get("position") == 1 and moved[0].get("name") == second_name,
            f"{[(w.get('position'), w.get('name')) for w in moved]}",
        )

        # The class is called off while somebody is still in line.
        code, cancelled, _, _ = call("POST", "/api/v1/classes", {"action": "cancel", "sessionId": queue_session["id"], "reason": "gate probe"})
        check("cancelling the class closes its line", code == 200 and cancelled.get("queueClosed") == 1, f"{code} queueClosed={cancelled.get('queueClosed')}")

        entries = call("GET", "/api/v1/wait-list?includeClosed=true")[1].get("data") or []
        closed = next((row for row in entries if row.get("id") == (second.get("id") if isinstance(second, dict) else None)), None)
        check("and the entry is closed, not left waiting", bool(closed) and closed.get("status") == "cancelled", f"{(closed or {}).get('status')}")

        told = [
            row for row in (call("GET", "/api/v1/messages?limit=100")[1].get("data") or [])
            if second_name in str(row.get("body") or "") and "called off" in str(row.get("body") or "").lower()
        ]
        check("the person still in line is told the class is off", bool(told), (told[0].get("body") or "")[:110] if told else "no message")

    # ---- 9. the day's other screens --------------------------------------------
    code, diary, _, _ = call("GET", f"/api/v1/diary?from={session['local']['date']}&to={session['local']['date']}&locationId={site['id']}")
    day = (diary.get("days") or [{}])[0]
    drawn = [s for s in (day.get("sessions") or []) if s["id"] == session["id"]]
    check("the diary draws the class once", len(drawn) == 1, f"{len(drawn)} block(s)")
    check(
        "with its places counted, and not as appointments",
        drawn and drawn[0]["seats"] == 2 and drawn[0]["capacity"] == 3 and all(b.get("sessionId") != session["id"] for b in (day.get("appointments") or [])),
        f"seats={drawn[0]['seats'] if drawn else '—'} · appointments={len(day.get('appointments') or [])}",
    )
    code, board, _, _ = call("GET", f"/api/v1/board?date={session['local']['date']}")
    board_site = next((s for s in board.get("sites") or [] if s["id"] == site["id"]), {})
    board_class = next((c for c in (board_site.get("classes") or []) if c["id"] == session["id"]), None)
    check("the desk's board shows it with its count", bool(board_class), f"{(board_class or {}).get('seats')}/{(board_class or {}).get('capacity')}")

    # ---- 10. who may do this ----------------------------------------------------
    check("a stranger cannot read the class list", call("GET", "/api/v1/classes", cookie="")[0] in (401, 403))
    check(
        "a stranger cannot schedule one either",
        call("POST", "/api/v1/classes", {"action": "create", "serviceId": service_id}, cookie="")[0] in (401, 403),
    )

    # ---- 11. cancelling is not deleting ----------------------------------------
    def cancellation_messages():
        rows = call("GET", "/api/v1/messages?limit=100")[1].get("data") or []
        return [m for m in rows if SERVICE_NAME in (m.get("body") or "") and "cancelled" in (m.get("body") or "")]

    before_messages = len(cancellation_messages())
    code, payload, _, _ = call("POST", "/api/v1/classes", {"action": "cancel", "sessionId": session["id"], "reason": "Instructor is unwell"})
    check("the desk can cancel the whole session", code == 200 and (payload.get("session") or {}).get("status") == "cancelled", f"{code} released={(payload or {}).get('cancelledSeats')}")
    check("every place is released", (payload or {}).get("cancelledSeats") == 2, str((payload or {}).get("cancelledSeats")))

    after = call("GET", f"/api/v1/classes/{session['id']}")[1]
    check("the roster empties", len(after.get("roster") or []) == 0, f"{len(after.get('roster') or [])} left")

    code, payload, _, _ = call("POST", f"/api/v1/classes/{session['id']}", {"action": "mark-seat", "bookingId": first_seat, "status": "arrived"})
    check(
        "a class that was called off has no register — a released place cannot be resurrected by marking it",
        code == 409 and "called off" in message_of(payload),
        f"{code} {message_of(payload)}",
    )

    told = cancellation_messages()
    # The two people still holding a place when the class was called off: the one
    # who had already given theirs up earlier in this gate is not owed this text.
    still_holding = [number for _, number in seats[1:]]
    reached = [number for number in still_holding if any(m.get("to") == number for m in told)]
    check("the people holding places are told", len(reached) == len(still_holding), f"{len(reached)}/{len(still_holding)} texted · {len(told)} message(s)")
    check("the queue grew by the messages it sent", len(told) > before_messages, f"{before_messages} → {len(told)} about this class")
    check(
        "in one sentence, with the start time said once",
        bool(told) and all((m.get("body") or "").count(session["local"]["start"]) <= 1 for m in told),
        (told[0].get("body") or "")[:120] if told else "—",
    )

    page_after = call("GET", f"/api/public/workspaces/{SLUG}/booking")[1]
    check("it leaves the public page", all(c["sessionId"] != session["id"] for c in (page_after.get("classes") or [])))

    code, payload, _, _ = call(
        "POST",
        f"/api/public/workspaces/{SLUG}/booking",
        {"sessionId": session["id"], "name": f"Probe Class Maybe {STAMP}", "number": "+15550190716", "consentSms": True},
    )
    check("and nobody can join it", code == 409, f"{code} {message_of(payload)}")

    board_after = call("GET", f"/api/v1/board?date={session['local']['date']}")[1]
    site_after = next((s for s in board_after.get("sites") or [] if s["id"] == site["id"]), {})
    check("the board drops it too", all(c["id"] != session["id"] for c in (site_after.get("classes") or [])))

finally:
    print("\nclean-up")
    # The instructor's service list goes back exactly as it was found: the probe
    # service is about to stop existing, and a practitioner pointing at a service
    # that is gone is the sort of debris only noticed weeks later.
    if instructor_id and instructor_before is not None:
        code, _, _, _ = call("PATCH", f"/api/v1/providers/{instructor_id}", {"serviceIds": instructor_before})
        print(f"  instructor's services put back  — status {code}")
    for session_id in sessions_made:
        code, payload, _, _ = call("POST", "/api/v1/classes", {"action": "cancel", "sessionId": session_id, "reason": "gate clean-up"})
        if code == 200:
            print(f"  cancelled {session_id} — {payload.get('cancelledSeats')} seat(s) released")
    # …and the class service itself. Deleting it also drops the reference from any
    # practitioner's list, which is why an active service nobody offers never
    # lingers to fail `practice_check`'s "every service is offered by somebody".
    if service_id:
        code, payload, _, _ = call("DELETE", f"/api/v1/services/{service_id}")
        print(f"  removed the probe service  — status {code}{'' if code in (200, 204) else f' ({message_of(payload)})'}")
    print("  anything left is named `Probe Class …`; `npx tsx scripts/tidy-probe-orgs.ts` sweeps it")

print()
if failures:
    print(f"{passes} passed, {len(failures)} FAILED: " + " · ".join(dict.fromkeys(failures)))
    sys.exit(1)
print(
    f"ALL PASS — {passes} checks: a class holds its hour, sells exactly its seats, "
    "gives one back when somebody leaves, hands a given-back place to the front of its own line, "
    "and empties cleanly when it is called off."
)
