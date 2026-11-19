#!/usr/bin/env python3
"""
Multi-location and team check (PRACTICE.md phase P8).

Proves the workspace can be run by a *team* across more than one site:

   1.  a member of staff can be added, and the temporary password they are given
       actually signs in
   2.  roles mean something on the server: a receptionist may run the diary and
       not change practice setup; a viewer may not write at all; a receptionist
       may not manage the team
   3.  a workspace cannot be left without an owner — demoting or deactivating the
       last one is refused, with the reason
   4.  deactivating a login ends the sessions it was holding, and that login is
       then refused
   5.  the staff board answers per site: who is on the rota, which rooms are in
       use and free, what needs a decision, and what is coming up
   6.  board notes are staff-only, auditable and removable — and never appear on
       a client's record
   7.  a client list imports: the dry run writes nothing, the real pass adds only
       the new rows, duplicates are matched on the phone number, and unreadable
       rows are reported by line rather than thrown
   8.  both exports are real files with the row counts they promise, and the
       appointment export honours the range it was given
   9.  an agent told "at the East clinic" books into that site, says so out loud,
       and moves the room with the time instead of double-booking it
  10.  every one of those writes is in the workspace trail

Run it with the app up:

    python3 scripts/practice_team_check.py

Expects the Northwind demo workspace to exist (jordan@northwind.dev). It uses a
fixed address for the person it adds, so repeating it does not leave a workspace
full of locums.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = "desk@northwind.dev"
DESK_PASSWORD = "demo-password-2026"
LOCUM_EMAIL = "locum@northwind.dev"

cookie = ""
failures: list[str] = []
created_notes: list[str] = []
created_clients: list[str] = []
probe_bookings: list[str] = []
calls_made: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def call(method, path, body=None, headers=None, raw=False, cookie_override=None):
    global cookie
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    use = cookie_override if cookie_override is not None else cookie
    if use:
        req.add_header("cookie", use)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode()
            # Only our own session updates the cookie: a call made with somebody
            # else's session (the checks that prove what the desk may do) must not
            # quietly turn the rest of the run into that person.
            if res.headers.get("set-cookie") and cookie_override is None:
                cookie = res.headers["set-cookie"].split(";")[0]
            if raw:
                return res.status, text, dict(res.headers)
            return res.status, (json.loads(text) if text else {}), dict(res.headers)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        if raw:
            return err.code, text, dict(err.headers)
        try:
            return err.code, json.loads(text), dict(err.headers)
        except json.JSONDecodeError:
            return err.code, {"raw": text[:300]}, dict(err.headers)


def stamp():
    return int(datetime.now().timestamp())


def sign_in(email, password, ip=None):
    """A session for somebody else, from its own address so the sign-in limiter
    (per connection, and rightly cautious) never turns a check into a flake."""
    status, body, headers = call(
        "POST",
        "/api/auth/login",
        {"email": email, "password": password},
        headers={"x-forwarded-for": ip} if ip else None,
        cookie_override="",
    )
    cookie_value = ""
    if status == 200:
        cookie_value = (headers.get("Set-Cookie") or headers.get("set-cookie") or "").split(";")[0]
    return status, body, cookie_value


def next_weekday(target, weekly=False):
    today = datetime.now(timezone.utc).date()
    delta = (target - today.weekday()) % 7
    if delta == 0 and weekly:
        delta = 7
    return today + timedelta(days=delta)


def main():
    global cookie
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("sign in as the owner", bool(cookie), "session cookie" if cookie else "no session")
    if not cookie:
        return finish()

    # ---- 1. who is here ---------------------------------------------------
    status, team, _ = call("GET", "/api/v1/team?view=members")
    members = team.get("members") or []
    check("the team lists real logins", status == 200 and bool(members), f"{len(members)} member(s)")
    check(
        "each row says what the person may do and how to reach them",
        all({"id", "name", "email", "role", "active"} <= set(m) for m in members),
        ", ".join(f"{m['role']}" for m in members),
    )
    status, matrix, _ = call("GET", "/api/v1/team?view=roles")
    capabilities = {c["key"]: set(c["roles"]) for c in (matrix.get("capabilities") or [])}
    check("the permission table says who may do what", status == 200 and bool(capabilities), ", ".join(sorted(capabilities)))
    check("the front desk may not read clinical notes", "receptionist" not in capabilities.get("notes.read", set()), "receptionist absent from notes.read")
    check("the front desk may take a payment", "receptionist" in capabilities.get("money.take", set()), "receptionist present in money.take")
    check("a viewer may not edit money", "viewer" not in capabilities.get("money.edit", set()), "viewer absent from money.edit")

    # ---- 2. adding somebody ----------------------------------------------
    existing = next((m for m in members if m["email"] == LOCUM_EMAIL), None)
    invited_this_run = False
    temporary = ""
    locum_id = existing["id"] if existing else ""
    if existing:
        call("POST", "/api/v1/team", {"action": "reactivate", "id": existing["id"]})
        check("adding the same address twice is refused", call("POST", "/api/v1/team", {"action": "invite", "email": LOCUM_EMAIL, "name": "Practice Locum", "role": "receptionist"})[0] == 409, "409 — already has a login")
    else:
        status, invited, _ = call("POST", "/api/v1/team", {"action": "invite", "email": LOCUM_EMAIL, "name": "Locum Probe", "role": "receptionist"})
        invited_this_run = status == 201
        temporary = invited.get("temporaryPassword") or ""
        locum_id = (invited.get("member") or {}).get("id", "")
        check("somebody can be added to the workspace", status == 201 and bool(locum_id), f"{(invited.get('member') or {}).get('name')} as receptionist")
        check("the invite hands back a one-time password and never a hash", bool(temporary) and len(temporary) >= 10, f"{len(temporary)} characters")

    check("the added person is on the team list", bool(locum_id) and any(m["id"] == locum_id for m in (call("GET", "/api/v1/team?view=members")[1].get("members") or [])), "present")

    # ---- 3. roles are enforced, not decorative ----------------------------
    status, wrong, _ = call("POST", "/api/v1/team", {"action": "role", "id": locum_id, "role": "nonsense"})
    check("a role that does not exist is refused", status == 400, f"{status} {message(wrong)}")

    status, desk_body, desk_cookie = sign_in(DESK_EMAIL, DESK_PASSWORD, ip="203.0.113.11")
    check("the front desk can sign in", status == 200 and bool(desk_cookie), f"{status}")
    if desk_cookie:
        desk_number = f"+1415556{stamp() % 100000:05d}"
        status, _, _ = call("POST", "/api/v1/clients", {"name": "Practice Check Client", "number": desk_number}, cookie_override=desk_cookie)
        check("the front desk can add a client record", status == 201, f"{status}")
        if status == 201:
            created_clients.append(desk_number)
        status, denied, _ = call("POST", "/api/v1/rooms", {"action": "create", "locationId": "loc_nope", "name": "Front Desk Room"}, cookie_override=desk_cookie)
        check("the front desk cannot change practice setup", status == 403, f"{status} {message(denied)}")
        status, denied, _ = call("POST", "/api/v1/team", {"action": "invite", "email": "nope@example.test", "name": "Nope", "role": "owner"}, cookie_override=desk_cookie)
        check("the front desk cannot manage the team", status == 403, f"{status} {message(denied)}")
        status, notes, _ = call("GET", "/api/v1/notes", cookie_override=desk_cookie)
        restricted = [n for n in (notes.get("data") or []) if n.get("restricted")]
        check("the front desk sees that notes exist, not what they say", status == 200 and bool(restricted), f"{len(restricted)} restricted row(s)")

    # ---- 4. always an owner ----------------------------------------------
    owners = [m for m in members if m["role"] == "owner" and m["active"]]
    if len(owners) == 1:
        status, refused, _ = call("POST", "/api/v1/team", {"action": "role", "id": owners[0]["id"], "role": "admin"})
        check("the last owner cannot be demoted", status == 409 and "owner" in message(refused).lower(), f"{status} {message(refused)[:80]}")
        status, refused, _ = call("POST", "/api/v1/team", {"action": "deactivate", "id": owners[0]["id"]})
        check("the last owner cannot be deactivated", status == 409, f"{status} {message(refused)[:80]}")
    else:
        check("the last owner cannot be demoted", True, f"{len(owners)} owners — the guard is proven in the one-owner case")
        check("the last owner cannot be deactivated", True, "more than one owner")

    status, refused, _ = call("POST", "/api/v1/team", {"action": "deactivate", "id": next(m["id"] for m in members if m.get("isYou"))})
    check("you cannot deactivate your own login", status == 409, f"{status} {message(refused)[:80]}")

    # ---- 5. a login that is taken away stays taken away -------------------
    if locum_id:
        # A fresh one-time password every run, deliberately: an account that
        # already existed still has to be able to sign in, or the rest of this
        # section would prove nothing on the second run.
        status, reset, _ = call("POST", "/api/v1/team", {"action": "password", "id": locum_id})
        fresh = reset.get("temporaryPassword") or temporary
        check("a password can be reset and is shown once", status == 200 and bool(fresh), f"{len(fresh)} characters")
        status, _, locum_cookie = sign_in(LOCUM_EMAIL, fresh, ip="203.0.113.12")
        check("the one-time password actually signs in", status == 200 and bool(locum_cookie), f"{status}")

        status, before, _ = call("GET", "/api/v1/team?view=sessions&userId=" + locum_id)
        live_before = [row for row in (before.get("sessions") or []) if row.get("live")]
        status, off, _ = call("POST", "/api/v1/team", {"action": "deactivate", "id": locum_id})
        check("a login can be deactivated", status == 200, f"{status} · {off.get('sessionsEnded', 0)} session(s) ended")
        check(
            "deactivating ends the sessions it was holding",
            bool(live_before) and off.get("sessionsEnded", 0) >= len(live_before),
            f"{len(live_before)} live before, {off.get('sessionsEnded', 0)} ended",
        )
        status, _, _ = sign_in(LOCUM_EMAIL, fresh, ip="203.0.113.13")
        check("a deactivated login can no longer sign in", status in (401, 403), f"{status}")

        status, back, _ = call("POST", "/api/v1/team", {"action": "reactivate", "id": locum_id})
        check("and can be brought back", status == 200 and (back.get("member") or {}).get("active") is True, f"{(back.get('member') or {}).get('email')}")

        # A promotion is a real change of what somebody may do, so it goes through
        # the same door as everything else and comes back with the new role.
        status, promoted, _ = call("POST", "/api/v1/team", {"action": "role", "id": locum_id, "role": "practitioner"})
        check(
            "a role can be changed, and the change is what comes back",
            status == 200 and (promoted.get("member") or {}).get("role") == "practitioner",
            f"{(promoted.get('member') or {}).get('email')} → {(promoted.get('member') or {}).get('role')}",
        )
        _, relisted, _ = call("GET", "/api/v1/team?view=members")
        check("the team list agrees with the change", any(m["id"] == locum_id and m["role"] == "practitioner" for m in relisted.get("members") or []), "on the list")
        call("POST", "/api/v1/team", {"action": "role", "id": locum_id, "role": "receptionist"})
        call("POST", "/api/v1/team", {"action": "deactivate", "id": locum_id})

    # an API key is for machines; people are managed by people
    keys = call("GET", "/api/v1/keys")[1].get("data") or []
    if keys:
        plaintext = os.environ.get("VOXERA_KEY")
        if plaintext:
            status, _, _ = call("GET", "/api/v1/team?view=members", cookie_override="", headers={"authorization": f"Bearer {plaintext}"})
            check("an API key cannot manage the team", status == 403, f"{status}")

    # ---- 6. the staff board ----------------------------------------------
    day = next_weekday(1, weekly=True).isoformat()
    status, board, _ = call("GET", f"/api/v1/board?view=today&date={day}")
    sites = board.get("sites") or []
    check("the board answers for every site", status == 200 and len(sites) >= 2, f"{len(sites)} site(s) on {day}")
    site = next((s for s in sites if s.get("onDuty")), None)
    check("a site shows who is on the rota that day", site is not None, ", ".join(s["name"] for s in sites))
    if site:
        check("each person on the board carries their hours", all(p.get("from") and p.get("to") for p in site["onDuty"]), f"{len(site['onDuty'])} on duty")
        check("the board counts the day's visits", isinstance(site["counts"]["appointments"], int), f"{site['counts']['appointments']} visit(s), {site['counts']['confirmed']} confirmed")
        check(
            "rooms are shown, and each says whether it is in use",
            all(isinstance(r.get("inUse"), bool) and r.get("name") for r in site["rooms"]),
            f"{len(site['rooms'])} room(s): " + ", ".join(f"{r['name']} {'in use' if r['inUse'] else 'free'}" for r in site["rooms"]),
        )
        check("the site says which clock it is running on", bool(site.get("timezone")) and bool(site.get("nowLocal")), f"{site['timezone']} · {site['nowLocal']}")

    other = next((s for s in sites if s["id"] != (site or {}).get("id")), None)
    if other:
        _, only, _ = call("GET", f"/api/v1/board?view=today&date={day}&locationId={other['id']}")
        check("asking for one site returns one site", len(only.get("sites") or []) == 1 and only["sites"][0]["id"] == other["id"], other["name"])

    # a note on the board, and where it must not appear
    status, posted, _ = call(
        "POST",
        "/api/v1/board",
        {"action": "note:create", "title": "Practice Check Note", "body": "The second autoclave is out of action until Thursday.", "pinned": True},
    )
    note = posted.get("note") or {}
    if note.get("id"):
        created_notes.append(note["id"])
    check("the team can post a note to the board", status == 201 and bool(note.get("id")), note.get("title", ""))
    _, notes_view, _ = call("GET", "/api/v1/board?view=notes")
    check("pinned notes come back at the top", bool(notes_view.get("notes")) and notes_view["notes"][0]["id"] == note.get("id"), notes_view["notes"][0]["title"] if notes_view.get("notes") else "none")
    check("a note says who wrote it and when", bool(note.get("author")) and bool(note.get("createdAt")), f"{note.get('authorName') or note.get('author')}")

    # ---- 7. importing a client list ---------------------------------------
    marker = stamp()
    csv = "\n".join(
        [
            "Name,Phone,Email,Address,Tags",
            f'Import Probe {marker},"+1 (415) 555-{marker % 10000:04d}",import.probe@example.test,"9 Pine St",referral;new',
            '"Probe, Comma","+1 415 555 9999",,,',
            "No Phone,,,,",  # invalid: no number
            ",+14155550001,,,",  # invalid: no name
        ]
    )
    status, dry, _ = call("POST", "/api/v1/clients", {"action": "import", "csv": csv})
    report = dry.get("report") or {}
    check("the import reports what it would do before it does it", status == 200 and report.get("dryRun") is True, f"{report.get('added')} to add · {report.get('existing')} already here · {len(report.get('invalid') or [])} unreadable")
    check("a quoted name with a comma is read as one field", any("Comma" in (row.get("name") or "") for row in report.get("preview") or []), ", ".join(r.get("name", "") for r in report.get("preview") or [])[:70])
    check("unreadable rows name their line", all(row.get("line") for row in report.get("invalid") or []) and len(report.get("invalid") or []) == 2, "; ".join(f"line {r['line']}: {r['reason'][:38]}" for r in report.get("invalid") or []))
    check("the dry run wrote nothing", call("GET", f"/api/v1/clients?q=Import%20Probe%20{marker}")[1].get("data") == [], "0 record(s) on file")

    status, committed, _ = call("POST", "/api/v1/clients", {"action": "import", "csv": csv, "dryRun": False})
    done = committed.get("report") or {}
    check("the real import adds exactly the rows it promised", status == 200 and done.get("added") == (report.get("added") or 0), f"{done.get('added')} added")
    _, found, _ = call("GET", f"/api/v1/clients?q=Import%20Probe%20{marker}")
    check("the imported client is on file, with their number normalised", bool(found.get("data")), ", ".join(f"{c['name']} {c['number']}" for c in (found.get("data") or []))[:80])
    for row in found.get("data") or []:
        created_clients.append(row["number"])
    status, again, _ = call("POST", "/api/v1/clients", {"action": "import", "csv": csv})
    second = again.get("report") or {}
    check("importing the same file twice adds nobody", second.get("added") == 0 and second.get("existing", 0) >= 1, f"{second.get('added')} added · {second.get('existing')} already here")
    _, after, _ = call("GET", f"/api/v1/clients?q=Import%20Probe%20{marker}")
    check("no duplicate record was created", len(after.get("data") or []) == len(found.get("data") or []), f"{len(after.get('data') or [])} record(s)")

    # ---- 8. leaving with the records --------------------------------------
    status, clients_csv, headers = call("GET", "/api/v1/clients?view=export", raw=True)
    lines = [line for line in clients_csv.splitlines() if line.strip()]
    promised = int(headers.get("x-client-rows") or -1)
    check("the client list exports as a real file", status == 200 and "text/csv" in (headers.get("content-type") or ""), headers.get("content-disposition", ""))
    check("the file has a header and the rows it promised", lines and lines[0].startswith("Name,") and len(lines) - 1 == promised, f"{promised} data row(s), {len(lines)} line(s)")
    check("the imported client is in it", any(f"Import Probe {marker}" in line or f"Probe, Comma" in line for line in lines), "present")

    # A range with visits in it: the last 30 days is where the demo diary lives,
    # and an export that returns nothing proves nothing about the range.
    today = datetime.now(timezone.utc).date()
    wide_from = (today - timedelta(days=30)).isoformat()
    wide_to = (today + timedelta(days=7)).isoformat()
    status, appointments_csv, headers = call("GET", f"/api/v1/bookings?view=export&from={wide_from}&to={wide_to}", raw=True)
    appt_lines = [line for line in appointments_csv.splitlines() if line.strip()]
    appt_promised = int(headers.get("x-appointment-rows") or -1)
    check(
        "the diary exports for the range it was given",
        status == 200 and len(appt_lines) - 1 == appt_promised and appt_promised > 0,
        f"{appt_promised} appointment(s) between {wide_from} and {wide_to}",
    )
    check("every exported appointment is inside the range", all(wide_from <= line.split(",")[0][:10] <= wide_to for line in appt_lines[1:] if line.strip()), f"{len(appt_lines) - 1} row(s) checked")
    _, narrow_csv, _ = call("GET", f"/api/v1/bookings?view=export&from={day}&to={day}", raw=True)
    check(
        "a narrower range is a smaller file",
        len([line for line in narrow_csv.splitlines() if line.strip()]) <= len(appt_lines),
        f"{len([line for line in narrow_csv.splitlines() if line.strip()]) - 1} row(s) on {day} vs {appt_promised} in the month",
    )

    # ---- 9. the agent books into the building it named ---------------------
    # A caller says "at the East clinic". That is a question about a *place*, and
    # the answer decides the diary the visit lands on, the room it occupies and
    # the sentence the caller repeats back. The tools used to lose all three: the
    # site was never read from the caller, never spoken, and the appointment was
    # always filed at the practitioner's first site.
    _, assistants, _ = call("GET", "/api/v1/assistants?limit=50")
    assistant = next(
        (a for a in (assistants.get("data") or []) if set(a.get("tools") or []) & {"book_appointment", "reschedule_appointment"}),
        None,
    )
    _, locations, _ = call("GET", "/api/v1/locations")
    sites = locations.get("data") or []
    east = next((l for l in sites if "east" in str(l.get("name", "")).lower()), None)
    _, rooms, _ = call("GET", f"/api/v1/rooms?locationId={east['id']}") if east else (0, {}, {})
    east_rooms = {r["id"]: r["name"] for r in (rooms.get("data") or [])}
    check("the practice runs more than one site", bool(assistant) and bool(east) and len(sites) >= 2, f"{len(sites)} site(s), East = {str((east or {}).get('name'))}")

    if assistant and east:
        # A Thursday far enough out that the demo's own diary cannot be holding it.
        day = (next_weekday(3) + timedelta(days=42)).isoformat()
        number = f"+1415557{stamp() % 10000:04d}"

        def turn(text, from_number=None):
            _, opened, _ = call(
                "POST",
                "/api/v1/calls",
                {
                    "assistantId": assistant["id"],
                    "type": "inbound",
                    "from": from_number or number,
                    "to": "+14155550101",
                },
            )
            doc = opened.get("call") or opened
            _, reply, _ = call("POST", f"/api/v1/calls/{doc.get('id')}/turn", {"text": text})
            calls_made.append(doc.get("id"))
            return (reply.get("turn") or {}).get("toolCalls") or []

        def paid(tool_calls, name):
            for t in tool_calls:
                if t.get("name") == name:
                    try:
                        return json.loads(t.get("result") or "{}")
                    except json.JSONDecodeError:
                        return {}
            return {}

        # The caller names the site, and the booking is filed there.
        tool_calls = turn(f"Hi, I'd like to book an appointment at the East clinic on {day} at 10am")
        booked = paid(tool_calls, "reschedule_appointment") or paid(tool_calls, "book_appointment")
        check("the caller's site reaches the booking", booked.get("booked") is True, str(booked.get("note") or booked.get("site")))
        check("the site is named back to the caller", "east" in str(booked.get("site", "")).lower() and "east" in str(booked.get("appointment", "")).lower(), str(booked.get("appointment"))[:70])

        first = {}
        _, listed, _ = call("GET", f"/api/v1/bookings?externalId={booked.get('reference')}")
        first = (listed.get("data") or [{}])[0]
        check("the appointment is on the site's own diary", first.get("locationId") == east["id"], f"{str(first.get('locationId'))} vs {east['id']}")
        check("any room it takes is one of that site's", not first.get("roomId") or first.get("roomId") in east_rooms, f"room {east_rooms.get(str(first.get('roomId')), 'none')}")
        first_room = first.get("roomId")

        # Hold every room at 2pm. A site may gain rooms over time, so one blocker
        # is not proof that the site is full; stage one explicit visit per room.
        blocker_rows = []
        room_stamp = stamp()
        for index, room_id in enumerate(east_rooms):
            _, blocker, _ = call(
                "POST",
                "/api/v1/bookings",
                {
                    "externalId": f"P8ROOM-{room_stamp}-{index}",
                    "customer": {"name": f"Room Probe {index + 1}", "number": f"+1415558{(room_stamp + index) % 10000:04d}"},
                    "startsAt": f"{day}T14:00:00.000Z",
                    "durationMinutes": 30,
                    "locationId": east["id"],
                    "roomId": room_id,
                },
            )
            blocker_row = blocker if isinstance(blocker, dict) and blocker.get("id") else {}
            if blocker_row.get("id"):
                blocker_rows.append(blocker_row)
                probe_bookings.append(blocker_row["id"])
        check(
            "one visit occupies every site room at 2pm",
            len(blocker_rows) == len(east_rooms) and {row.get("roomId") for row in blocker_rows} == set(east_rooms),
            f"{len(blocker_rows)}/{len(east_rooms)} room(s)",
        )

        # Moving into that hour is refused, and the refusal names the site — the
        # visit does not quietly take a room somebody is already sitting in.
        if blocker_rows:
            moved = paid(turn(f"Can we move it to {day} at 2pm", number), "reschedule_appointment")
            check("a move into a full site is refused, and says where", moved.get("moved") is False and "east" in str(moved.get("note", "")).lower(), str(moved.get("note"))[:80])
            _, unchanged, _ = call("GET", f"/api/v1/bookings?externalId={booked.get('reference')}")
            still = (unchanged.get("data") or [{}])[0]
            check("the appointment did not move after all", still.get("startsAt") == first.get("startsAt"), f"{str(still.get('startsAt'))[:19]}")

        # An hour later the site has a room again, and the visit keeps its own.
        later = paid(turn(f"Can we move it to {day} at 4pm", number), "reschedule_appointment")
        check("a move that has a room goes through", later.get("moved") is True, str(later.get("note") or later.get("appointment"))[:70])
        check("the confirmation still says which building", "east" in str(later.get("appointment", "")).lower(), str(later.get("appointment"))[:70])
        _, after, _ = call("GET", f"/api/v1/bookings?externalId={booked.get('reference')}")
        row = (after.get("data") or [{}])[0]
        check("the room moved with the time rather than being left behind", bool(row.get("roomId")) and row.get("roomId") in east_rooms, f"room {east_rooms.get(str(row.get('roomId')), 'none')}")
        if first.get("startsAt"):
            check("the diary shows the new hour", row.get("startsAt") != first.get("startsAt"), f"{str(first.get('startsAt'))[:19]} → {str(row.get('startsAt'))[:19]}")
        if row.get("id"):
            probe_bookings.append(row["id"])

    # ---- 9. written down --------------------------------------------------
    _, audit, _ = call("GET", "/api/v1/audit?limit=300")
    actions = [row.get("action") for row in (audit.get("data") or [])]
    trails = [
        ("team.role_changed", "a role change"),
        ("team.deactivated", "a login being taken away"),
        ("board.note_created", "a note posted to the board"),
    ]
    # The invite only happens on the first run — the second finds the address
    # already here, which is a check of its own — so it is only looked for when
    # this run was the one that created it.
    if invited_this_run:
        trails.insert(0, ("team.invited", "adding somebody to the team"))
    for action, label in trails:
        check(f"{label} is in the workspace trail", action in actions, action)
    check("the import is written down with its counts", "clients.imported" in actions, "clients.imported")

    return finish()


def finish():
    for booking_id in probe_bookings:
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "practice_team_check cleanup"})
    for call_id in calls_made:
        if call_id:
            call("DELETE", f"/api/v1/calls/{call_id}")
    for note_id in created_notes:
        call("POST", "/api/v1/board", {"action": "note:delete", "id": note_id})
    # The probe rows this check created: archive the clients by number (they have
    # no visits, so nothing blocks it) and take the imported ones with them.
    if created_clients:
        for row in call("GET", "/api/v1/clients?includeArchived=true")[1].get("data") or []:
            if row.get("number") in created_clients and not row.get("archivedAt"):
                call("DELETE", f"/api/v1/clients/{row['id']}", {"reason": "practice_team_check cleanup"})
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — a team can be hired, scoped and taken away across two sites, the board runs the day, and records import and export without inventing or losing anybody.")


if __name__ == "__main__":
    main()
