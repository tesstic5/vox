#!/usr/bin/env python3
"""
Clients + diary check (PRACTICE.md phase P2).

Proves the desk can run a day and that records behave like records:

   1.  a phone/API booking creates exactly one client record per number
   2.  the calendar range answers for day / 3 days / work week, and filters
   3.  dragging a block (move) is refused when the destination is taken,
       outside working hours, or across a break — and accepted when it is free
   4.  the status lifecycle refuses impossible transitions
   5.  a repeat series books what it can and reports what it skipped
   6.  alerts show on the client *and* on the diary block
   7.  withdrawn SMS consent blocks the agent's confirmation, which says why
   8.  cancelling an appointment surfaces the people on the wait list
   9.  archiving keeps the history and applies only an explicitly configured
       retention policy; a client with upcoming appointments cannot be archived
   10. reading a record is written to that record's own access log
   11. practice records are not mirrored into browser storage

Run it with the app up (expects the Northwind demo workspace):

    python3 scripts/client_check.py
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import session as cached_session  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
ROOT = os.environ.get("VOXERA_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

cookie = ""
failures: list[str] = []
cleanup: dict[str, list[str]] = {"bookings": [], "clients": [], "wait": [], "series": [], "calls": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None):
    global cookie
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode()
            sc = res.headers.get("set-cookie")
            if sc:
                cookie = sc.split(";")[0]
            return res.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, json.loads(text) if text else {}
        except json.JSONDecodeError:
            return err.code, {"raw": text}


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def next_weekday(target, weekly=False):
    today = datetime.now(timezone.utc).date()
    delta = (target - today.weekday()) % 7
    if delta == 0 and weekly:
        delta = 7
    return today + timedelta(days=delta)


def stamp():
    return int(datetime.now().timestamp() * 1000)


def main():
    # A cached cookie keeps back-to-back runs from tripping the login limiter.
    global cookie
    cookie = cached_session(BASE, EMAIL, PASSWORD)
    status, body = call("GET", "/api/v1/clients?limit=1")
    check("sign in", status == 200 and bool(cookie), message(body))
    if status != 200:
        return finish()

    _, providers = call("GET", "/api/v1/providers")
    _, services = call("GET", "/api/v1/services")
    active = [p for p in providers.get("data", []) if p.get("active")]
    # A provider only offers the services on their list, so the gate picks one of
    # theirs — the same rule the booking page applies. Picking "the first 30-minute
    # service" happens to be true for the seed and false the moment a practice
    # changes its price list.
    provider = active[0] if active else {}
    offered = [s for s in services.get("data", []) if not provider.get("serviceIds") or s["id"] in provider.get("serviceIds", [])]
    service = next((s for s in offered if s["durationMinutes"] == 30), offered[0] if offered else None)
    check("practice data is present", bool(active) and bool(service), f"{len(active)} providers, {service['name'] if service else 'no service'}")
    if not active or not service:
        return finish()

    site = provider["locationIds"][0] if provider.get("locationIds") else None
    day = next_weekday(0, weekly=True).isoformat()

    # ---- 1. a booking creates exactly one client ---------------------------
    number = f"+1415555{stamp() % 100000:05d}"
    name = f"Probe Client {stamp() % 10000}"
    slot_params = {"providerId": provider["id"], "serviceId": service["id"], "from": day, "days": 5, "limit": 20}
    if site:
        slot_params["locationId"] = site
    _, slots = call("GET", "/api/v1/availability?" + "&".join(f"{k}={v}" for k, v in slot_params.items()))
    slot = (slots.get("data") or [None])[0]
    check("a slot is available to book", slot is not None, (slots.get("data") or [{}])[0].get("local", {}).get("start", slots.get("reason", "")))
    if not slot:
        return finish()

    status, booked = call(
        "POST",
        "/api/v1/bookings",
        {
            "externalId": f"cc-{stamp()}",
            "customer": {"name": name, "number": number},
            "startsAt": slot["startsAt"],
            "serviceId": service["id"],
            "providerId": provider["id"],
            "locationId": site,
        },
    )
    check("the appointment is booked", status == 201, message(booked))
    booking_id = booked.get("id")
    if booking_id:
        cleanup["bookings"].append(booking_id)
    client_id = booked.get("clientId")
    check("the booking is attached to a client record", bool(client_id), str(client_id))
    if client_id:
        cleanup["clients"].append(client_id)

    _, first_list = call("GET", f"/api/v1/clients?q={number}")
    check("the client is findable by number", len(first_list.get("data", [])) == 1, f"{len(first_list.get('data', []))} match(es)")

    # A second booking from the same number must not create a second person.
    other_slot = next((s for s in slots.get("data", []) if s["startsAt"] != slot["startsAt"]), None)
    if other_slot:
        status, again = call(
            "POST",
            "/api/v1/bookings",
            {
                "externalId": f"cc-again-{stamp()}",
                "customer": {"name": name, "number": number},
                "startsAt": other_slot["startsAt"],
                "serviceId": service["id"],
                "providerId": provider["id"],
            },
        )
        if status == 201:
            cleanup["bookings"].append(again["id"])
        _, second_list = call("GET", f"/api/v1/clients?q={number}")
        check("the same number never becomes a second client", len(second_list.get("data", [])) == 1, f"{len(second_list.get('data', []))} match(es)")

    # ---- 2. the calendar -------------------------------------------------
    status, diary = call("GET", f"/api/v1/diary?view=day&from={day}&providerId={provider['id']}")
    days = diary.get("days", [])
    check("the day view answers", status == 200 and len(days) == 1, f"{len(days)} day(s)")
    mine = [a for a in (days[0]["appointments"] if days else []) if a["id"] == booking_id]
    check("the new appointment is on the grid", bool(mine), f"{len(days[0]['appointments']) if days else 0} block(s) that day")
    if mine:
        block = mine[0]
        check("a block carries what the calendar draws it with", block.get("providerName") and block.get("serviceName") is not None and isinstance(block.get("localStart"), int),
              f"{block.get('providerName')} {block.get('localStart')}→{block.get('localEnd')}")
        check("a block knows its client", block.get("clientId") == client_id and bool(block.get("customer", {}).get("name")), str(block.get("clientName")))

    _, three = call("GET", f"/api/v1/diary?view=3day&from={day}")
    _, workweek = call("GET", f"/api/v1/diary?view=workweek&from={day}")
    _, week = call("GET", f"/api/v1/diary?view=week&from={day}")
    check(
        "3-day, work-week and week views span the right number of days",
        len(three.get("days", [])) == 3 and len(workweek.get("days", [])) == 5 and len(week.get("days", [])) == 7,
        f"{len(three.get('days', []))} / {len(workweek.get('days', []))} / {len(week.get('days', []))}",
    )
    _, profile = call("GET", "/api/v1/practice/profile")
    week_start = (profile.get("profile") or {}).get("weekStart", 1)
    first_day = (workweek.get("days") or [{}])[0].get("date", "")
    # Python counts Monday as 0; the practice counts Sunday as 0.
    expected = 6 if week_start == 0 else week_start - 1
    actual = datetime.fromisoformat(first_day).weekday() if first_day else -1
    check("a work week starts on the practice's configured week start", actual == expected,
          f"starts {first_day} (weekday {actual}, weekStart {week_start})")
    _, filtered = call("GET", f"/api/v1/diary?view=week&from={day}&providerId={provider['id']}")
    leaks = [a["id"] for d in filtered.get("days", []) for a in d["appointments"] if a.get("providerId") and a["providerId"] != provider["id"]]
    check("filtering by provider hides everyone else's diary", not leaks, f"{len(leaks)} leaked block(s)")

    # ---- 3. moving an appointment ----------------------------------------
    if booking_id and mine:
        taken_neighbour = next((a for a in days[0]["appointments"] if a["id"] != booking_id and a["status"] != "cancelled"), None)
        if taken_neighbour:
            status, clash = call("POST", f"/api/v1/bookings/{booking_id}/move", {"startsAt": taken_neighbour["startsAt"]})
            check("moving onto another appointment is refused", status == 409, f"{status} {message(clash)}")
        status, outside = call("POST", f"/api/v1/bookings/{booking_id}/move", {"startsAt": f"{day}T03:00:00Z"})
        check("moving outside working hours is refused", status == 409 and bool(message(outside)), f"{status} {message(outside)}")
        # Lunch is 12:00–13:00 at the site; convert 12:30 *local* on the day
        # under test rather than assuming a fixed UTC hour — 19:30Z is 12:30
        # in PDT but 11:30 (working time) once PST starts on 1 Nov, which is
        # exactly when this check used to go red for a week.
        from zoneinfo import ZoneInfo
        lunch_local = datetime.combine(datetime.fromisoformat(day).date(), datetime.min.time(), ZoneInfo("America/Los_Angeles")).replace(hour=12, minute=30)
        lunch_utc = lunch_local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        status, lunch = call("POST", f"/api/v1/bookings/{booking_id}/move", {"startsAt": lunch_utc})
        check("moving onto the lunch break is refused", status == 409, f"{status} {message(lunch)}")
        # Refetch after both probe bookings. The original availability response is
        # a snapshot and its second slot may now be occupied by `other_slot` on a
        # different day than the one-day diary above.
        _, move_slots = call("GET", "/api/v1/availability?" + "&".join(f"{k}={v}" for k, v in slot_params.items()))
        free_slot = next(iter(move_slots.get("data") or []), None)
        if free_slot:
            status, moved = call("POST", f"/api/v1/bookings/{booking_id}/move", {"startsAt": free_slot["startsAt"]})
            check("moving to a free slot is accepted", status == 200 and moved.get("startsAt") == free_slot["startsAt"], f"{status} {message(moved)}")
            status, resized = call("POST", f"/api/v1/bookings/{booking_id}/move", {"durationMinutes": 60})
            check("resizing is recorded as a change", status == 200 and resized.get("durationMinutes") == 60, f"{resized.get('durationMinutes')}m")

            # ---- 4. the status lifecycle ----------------------------------
            status, arrived = call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "arrived"})
            check("confirmed → arrived is allowed", status == 200, f"{status} {message(arrived)}")
            status, done = call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "completed"})
            check("arrived → completed is allowed", status == 200, f"{status} {message(done)}")
            status, impossible = call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "no_show"})
            check("completed → no-show is refused", status == 409, f"{status} {message(impossible)}")

    # ---- 5. a repeat series ----------------------------------------------
    # Read the diary *now*: the sections above book appointments, so a slot taken
    # from the list fetched at the start of the run may already be gone — and a
    # series cannot start at a time that is taken (the server says so, correctly).
    _, fresh = call(
        "GET",
        "/api/v1/availability?days=14&limit=8"
        + (f"&providerId={provider['id']}" if provider.get("id") else "")
        + (f"&serviceId={service['id']}" if service and service.get("id") else "")
        + (f"&locationId={site}" if site else ""),
    )
    base_slot = (fresh.get("data") or [None])[0]
    if base_slot:
        status, series = call(
            "POST",
            "/api/v1/series",
            {
                "customer": {"name": name, "number": number},
                "startsAt": base_slot["startsAt"],
                "durationMinutes": service["durationMinutes"],
                "serviceId": service["id"],
                "providerId": provider["id"],
                "repeat": {"every": "week", "count": 4},
            },
        )
        check("a weekly series is created", status == 201 and len(series.get("booked", [])) >= 1, f"{status} {len(series.get('booked', []))} booked, {len(series.get('skipped', []))} skipped")
        for row in series.get("booked", []):
            cleanup["bookings"].append(row["id"])
        if series.get("seriesId"):
            cleanup["series"].append(series["seriesId"])
        _, series_rows = call("GET", f"/api/v1/series/{series.get('seriesId')}")
        check("the series is queryable as a group", len(series_rows.get("data", [])) == len(series.get("booked", [])), f"{len(series_rows.get('data', []))} of {len(series.get('booked', []))}")

    # ---- 6. alerts --------------------------------------------------------
    if client_id:
        status, alert = call("POST", f"/api/v1/clients/{client_id}/alerts", {"label": "Probe alert", "detail": "from client_check", "severity": "critical"})
        check("an alert can be added", status == 201 and any(a["label"] == "Probe alert" for a in alert.get("alerts", [])), message(alert))
        _, diary_after = call("GET", f"/api/v1/diary?view=week&from={day}")
        flagged = [a for d in diary_after.get("days", []) for a in d["appointments"] if a.get("clientId") == client_id and a.get("hasAlerts")]
        check("the alert shows on the diary block", bool(flagged), f"{len(flagged)} flagged block(s)")

        # ---- 7. consent blocks the agent ---------------------------------
        status, withdrawn = call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "sms", "granted": False, "source": "caller", "note": "probe"})
        check("SMS consent can be withdrawn", status == 200 and withdrawn.get("consents", {}).get("sms", {}).get("granted") is False, message(withdrawn))

        _, assistants = call("GET", "/api/v1/assistants")

        def tool_names(assistant):
            # The list returns tool names in one shape and objects in another,
            # depending on how much the caller asked for. Read both.
            names = assistant.get("toolNames")
            if names:
                return list(names)
            return [t.get("name") if isinstance(t, dict) else str(t) for t in (assistant.get("tools") or [])]

        desk = next(
            (a for a in assistants.get("data", []) if a.get("status") == "published" and "send_confirmation" in tool_names(a)),
            None,
        )
        check("a published assistant with a confirmation tool is on file", desk is not None,
              ", ".join(f"{a['name']}:{len(tool_names(a))}" for a in assistants.get("data", [])))
        if desk:
            status, call_body = call("POST", "/api/v1/calls", {"assistantId": desk["id"], "type": "web", "customer": {"name": name, "number": number}})
            call_id = call_body.get("id")
            if call_id:
                cleanup["calls"].append(call_id)
            status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "can you text me the confirmation for that please?"})
            tools = (turn.get("turn", {}) or {}).get("toolCalls", []) if status == 200 else []
            if status != 200:
                check("the confirmation turn ran", False, message(turn))
            confirm = next((t for t in tools if "confirmation" in t["name"] or "send_sms" in t["name"]), None)
            if confirm:
                result = json.loads(confirm["result"])
                check("the agent cannot text a client who opted out", result.get("queued") is False and result.get("blocked") is True, json.dumps(result)[:160])
                check("and it is told what to do instead", bool(result.get("reason")) and "read" in str(result.get("note", "")).lower(), str(result.get("reason"))[:80])
            else:
                check("the agent reaches for a confirmation on a confirmation call", False, ", ".join(t["name"] for t in tools) or "no tools ran")
            if call_id:
                call("PATCH", f"/api/v1/calls/{call_id}", {"status": "ended"})

        call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "sms", "granted": True, "source": "staff"})

        # ---- 10. the access log ------------------------------------------
        _, record = call("GET", f"/api/v1/clients/{client_id}")
        actions = [entry["action"] for entry in record.get("access", [])]
        check("reading the record is written to its own log", "view" in actions, ", ".join(sorted(set(actions))))
        check("the alert and the consent change are in that log", "update" in actions and "consent" in actions, ", ".join(sorted(set(actions))))
        check("the log names who did it", all(e.get("actor") for e in record.get("access", [])), str((record.get("access") or [{}])[0].get("actor")))

        # ---- 9. archiving -------------------------------------------------
        # The rule is "not while they are still expected": the client needs an
        # appointment in the future *at the moment of asking*, so the gate books a
        # fresh one rather than trusting whatever the earlier sections left behind
        # (they deliberately complete and cancel appointments).
        def still_expected(rows):
            now = datetime.now(timezone.utc).isoformat()
            return [
                a
                for a in rows
                if str(a.get("startsAt", "")) > now and a.get("status") not in ("cancelled", "completed", "no_show")
            ]

        _, card = call("GET", f"/api/v1/clients/{client_id}")
        upcoming = still_expected(card.get("bookings") or [])
        if not upcoming:
            _, ahead = call("GET", "/api/v1/availability?days=14&limit=8" + (f"&serviceId={service['id']}" if service and service.get("id") else ""))
            free = (ahead.get("data") or [None])[0]
            if free:
                _, held = call(
                    "POST",
                    "/api/v1/bookings",
                    {
                        "customer": {"name": name, "number": number},
                        "startsAt": free["startsAt"],
                        "durationMinutes": (service or {}).get("durationMinutes", 30),
                        "serviceId": (service or {}).get("id"),
                        "providerId": free.get("providerId") or provider.get("id"),
                        "locationId": free.get("locationId") or site,
                        "status": "confirmed",
                        "externalId": f"client-check-upcoming-{stamp()}",
                    },
                )
                if held.get("id"):
                    cleanup["bookings"].append(held["id"])
                    _, card = call("GET", f"/api/v1/clients/{client_id}")
                    upcoming = still_expected(card.get("bookings") or [])
        status, refused = call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "probe"})
        check("a client with upcoming appointments cannot be archived", status == 409, f"{status} {message(refused)} (they had {len(upcoming)} upcoming)")
        for booking in list(cleanup["bookings"]):
            call("POST", f"/api/v1/bookings/{booking}/status", {"status": "cancelled"})
        status, archived = call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "probe cleanup"})
        retention_until = archived.get("retentionUntil")
        retention_source = archived.get("retentionPolicySource")
        check(
            "archiving never invents an unconfigured retention deadline",
            status == 200
            and ((bool(retention_until) and retention_source == "environment")
                 or (not retention_until and not retention_source)),
            f"{status} until={retention_until or 'automatic purge disabled'} · source={retention_source or 'none'}",
        )
        _, hidden = call("GET", f"/api/v1/clients?q={number}")
        _, shown = call("GET", f"/api/v1/clients?q={number}&includeArchived=true")
        check("archived records are hidden by default and visible on request", len(hidden.get("data", [])) == 0 and len(shown.get("data", [])) == 1,
              f"{len(hidden.get('data', []))} default, {len(shown.get('data', []))} with archived")
        status, restored = call("PATCH", f"/api/v1/clients/{client_id}", {"restore": True})
        check("an archived record can be restored", status == 200 and not restored.get("archivedAt"), message(restored))

    # ---- 8. the wait list ------------------------------------------------
    wait_number = f"+1415556{stamp() % 100000:05d}"
    status, entry = call("POST", "/api/v1/wait-list", {"name": "Probe Waiting", "number": wait_number, "from": day, "notes": "probe"})
    check("someone can be put on the wait list", status == 201, message(entry))
    if status == 201:
        cleanup["wait"].append(entry["id"])
        _, waiting = call("GET", "/api/v1/wait-list")
        check("the wait list reads back", any(w["id"] == entry["id"] for w in waiting.get("data", [])), f"{len(waiting.get('data', []))} waiting")
        check("a wait-list entry is also a client", bool(entry.get("clientId")), str(entry.get("clientId")))
        if entry.get("clientId"):
            cleanup["clients"].append(entry["clientId"])

        # Cancel an appointment that matches the waiting window.
        _, soon = call(
            "GET",
            f"/api/v1/availability?from={day}&days=5&limit=1&providerId={provider['id']}"
            + (f"&serviceId={service['id']}" if service else ""),
        )
        candidate = (soon.get("data") or [None])[0]
        if candidate:
            status, held = call(
                "POST",
                "/api/v1/bookings",
                {
                    "externalId": f"cc-hold-{stamp()}",
                    "customer": {"name": "Probe Holder", "number": f"+1415557{stamp() % 100000:05d}"},
                    "startsAt": candidate["startsAt"],
                    "serviceId": service["id"],
                    "providerId": provider["id"],
                },
            )
            if status == 201:
                cleanup["bookings"].append(held["id"])
                status, cancelled = call("POST", f"/api/v1/bookings/{held['id']}/status", {"status": "cancelled"})
                matches = cancelled.get("waitListMatches", []) if status == 200 else []
                check("cancelling surfaces the people waiting for that slot", any(m["id"] == entry["id"] for m in matches), f"{len(matches)} match(es)")

    # ---- 11. the screens call routes that exist ---------------------------
    # A calendar that posts to a path nobody serves fails silently in a browser
    # and loudly here. Every path the practice screens touch — diary, clients,
    # bookings, setup and messaging — is matched against the file tree, so a rename
    # cannot leave the UI pointing at a ghost.
    pairs: set[tuple[str, str]] = set()
    for screen in (
        "app/dashboard/calendar/page.tsx",
        "app/dashboard/clients/page.tsx",
        "app/dashboard/bookings/page.tsx",
        "app/dashboard/practice/page.tsx",
        "app/dashboard/messaging/page.tsx",
    ):
        text = open(os.path.join(ROOT, screen)).read()
        for method, path in re.findall(r"request(?:<[^>]*>)?\(\s*'(GET|POST|PATCH|DELETE)'\s*,\s*[`']([^`']+)", text):
            pairs.add((method, path))
    missing = []
    for method, path in sorted(pairs):
        route = path.split("?")[0]
        route = re.sub(r"\$\{[^}]+\}", "[id]", route)
        relative = route.lstrip("/")
        if not os.path.exists(os.path.join(ROOT, f"app/{relative}/route.ts")):
            missing.append(f"{method} {route}")
    check("every path the practice screens call is a real route", not missing, ", ".join(missing) or f"{len(pairs)} path(s) checked")

    # ---- 12. no practice data in browser storage --------------------------
    scanned = []
    for relative in ["lib/store.tsx", "lib/server-sync.tsx", "app/dashboard/clients/page.tsx", "app/dashboard/calendar/page.tsx", "lib/privacy.ts"]:
        path = os.path.join(ROOT, relative)
        if not os.path.exists(path):
            continue
        scanned.append(relative)
        text = open(path).read()
        offenders = []
        for line in text.splitlines():
            if "localStorage" in line and re.search(r"\b(clients|alerts|consents|notes|dateOfBirth|invoices|payments)\b", line):
                offenders.append(line.strip()[:100])
        if relative.startswith("app/dashboard") and "localStorage" in text:
            offenders.append("screen touches localStorage at all")
        if offenders:
            check(f"{relative} keeps practice data out of browser storage", False, "; ".join(offenders[:2]))
    check("the practice screens were actually scanned", len(scanned) >= 3, ", ".join(scanned))
    check("the rule is written down, not implied", "SERVER_ONLY_COLLECTIONS" in open(os.path.join(ROOT, "lib/privacy.ts")).read() if os.path.exists(os.path.join(ROOT, "lib/privacy.ts")) else False, "lib/privacy.ts")

    return finish()


def finish():
    # Clean up what this run made: its appointments, its series, its wait entries.
    for series_id in cleanup["series"]:
        call("DELETE", f"/api/v1/series/{series_id}")
    for booking_id in dict.fromkeys(cleanup["bookings"]):
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "client_check cleanup"})
    for wait_id in cleanup["wait"]:
        call("DELETE", f"/api/v1/wait-list/{wait_id}")
    # Probe clients are archived, not deleted — deleting a record with a history
    # is exactly what the product refuses to do. `scripts/tidy-probe-orgs.ts`
    # sweeps this kind of debris, which is a test concern, not a product one.
    for client_id in dict.fromkeys(cleanup["clients"]):
        call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "client_check probe", "force": True})

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — clients, the calendar, moves, series, consent and the access log all behave.")


if __name__ == "__main__":
    main()
