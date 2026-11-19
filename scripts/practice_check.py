#!/usr/bin/env python3
"""
Practice-core check (PRACTICE.md phase P1).

Proves the diary layer is real, not decorative:

    1.  practice data seeds and reads back through the API
    2.  the term pack changes the vocabulary without changing the records
    3.  availability honours the weekly rota — hours and the lunch break
    4.  a closed day is refused with a reason, not an empty success
    5.  a one-off "not working" day closes the diary, and removing it reopens it
    6.  a one-off "extra hours" day opens hours the rota never had
    7.  service duration and buffers keep appointments apart
    8.  each site's timezone is honoured, including across a DST boundary
    9.  a provider is only offered for services they actually do
    10. a clash is refused (409) and a booked slot disappears from availability
    11. the phone agent answers from the same engine — its slot list is the
        diary's, not a canned array

Run it with the app up:

    python3 scripts/practice_check.py

Expects the Northwind demo workspace to exist (jordan@northwind.dev). It creates
its own test booking and one-off days, and removes them again at the end.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

cookie = ""
failures: list[str] = []
created_booking_ids: list[str] = []
created_change_ids: list[str] = []
created_room_ids: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, headers=None):
    global cookie
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
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


def stamp():
    return int(datetime.now().timestamp())


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def minutes(clock):
    """'9:00am' → 540."""
    text = clock.strip().lower()
    suffix = "am" if "am" in text else "pm"
    bare = text.replace("am", "").replace("pm", "").strip()
    hour, _, minute = bare.partition(":")
    value = int(hour) * 60 + int(minute or 0)
    if suffix == "pm" and value // 60 != 12:
        value += 12 * 60
    if suffix == "am" and value // 60 == 12:
        value -= 12 * 60
    return value


def hhmm(value):
    return f"{value // 60:02d}:{value % 60:02d}"


def next_weekday(target, weekly=False):
    """The next `target` weekday (0=Mon). Days are UTC days, as the diary treats them."""
    today = datetime.now(timezone.utc).date()
    delta = (target - today.weekday()) % 7
    if delta == 0 and weekly:
        delta = 7
    return today + timedelta(days=delta)


def availability(params):
    status, body = call("GET", "/api/v1/availability?" + "&".join(f"{k}={v}" for k, v in params.items()))
    if status != 200:
        return None
    return body


def main():
    global cookie
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("sign in to the demo workspace", bool(cookie), "session cookie" if cookie else "no session")
    if not cookie:
        return finish()

    # ---- 1. practice data --------------------------------------------------
    status, seeded = call("POST", "/api/bootstrap", {})
    check("bootstrap reports the practice layer", status in (200, 201) and "practice" in seeded, json.dumps(seeded.get("practice", {})))

    _, providers = call("GET", "/api/v1/providers")
    _, services = call("GET", "/api/v1/services")
    _, locations = call("GET", "/api/v1/locations")
    _, rota = call("GET", "/api/v1/rota")
    check(
        "practice records exist and read back",
        bool(providers.get("data")) and bool(services.get("data")) and len(locations.get("data", [])) >= 2 and bool(rota.get("data")),
        f"{len(providers.get('data', []))} providers, {len(services.get('data', []))} services, {len(locations.get('data', []))} sites, {len(rota.get('data', []))} rotas",
    )
    if not providers.get("data") or not rota.get("data"):
        return finish()

    # ---- 2. term packs ----------------------------------------------------
    _, profile = call("GET", "/api/v1/practice/profile")
    check("profile carries the vocabulary", profile.get("profile", {}).get("termPack") is not None, profile.get("profile", {}).get("termPack"))
    status, clinical = call("PATCH", "/api/v1/practice/profile", {"termPack": "clinical"})
    check(
        "switching to the clinical pack renames the interface, not the data",
        status == 200 and clinical.get("terms", {}).get("provider", {}).get("one") == "practitioner",
        json.dumps(clinical.get("terms", {}).get("provider", {})),
    )
    _, listed_after = call("GET", "/api/v1/providers")
    check(
        "the pack travels with the list the caller reads",
        listed_after.get("terms", {}).get("client", {}).get("many") == "patients",
        json.dumps(listed_after.get("terms", {}).get("client", {})),
    )
    call("PATCH", "/api/v1/practice/profile", {"termPack": "service"})

    _, services = call("GET", "/api/v1/services")
    service_by_name = {s["name"]: s for s in services.get("data", [])}
    install = service_by_name.get("Installation")
    consult = service_by_name.get("Consultation")
    quick = service_by_name.get("Checkup")
    check("the seeded services carry duration and buffers", bool(install and consult and quick) and install["bufferAfterMinutes"] == 15,
          f"install {install['durationMinutes']}m +{install['bufferAfterMinutes']}m" if install else "missing")
    # One name per job. The demo briefly carried both the seed's names ("Quick
    # check") and the diary's ("Checkup"), which is a booking page nobody can
    # choose from — this is the invariant that keeps it fixed.
    names = [s["name"].strip().lower() for s in services.get("data", [])]
    check("no two services share a name", len(names) == len(set(names)),
          f"{len(names) - len(set(names))} duplicate(s) of {len(names)}")
    # And every service is offered by somebody, or the page would refuse it.
    roster = providers.get("data", [])
    offered_by_someone = [s["name"] for s in services.get("data", []) if not any(s["id"] in (p.get("serviceIds") or []) for p in roster)]
    # `roster` — not `active`, which was never a name in this script. The line only
    # ran when a service was *un*rostered, so the typo sat here unseen until one was
    # (a probe service left behind by an interrupted run was enough to find it).
    check("every service on the list is offered by a practitioner",
          not offered_by_someone or all(not (p.get("serviceIds") or []) for p in roster),
          ", ".join(offered_by_someone) if offered_by_someone else f"{len(services.get('data', []))} service(s), all rostered")

    # Dana works weekdays at the first site (site-local hours, weekday index).
    hq = next(l for l in locations["data"] if l["timezone"] == "America/Los_Angeles")
    ny = next(l for l in locations["data"] if l["timezone"] == "America/New_York")
    dana = next(p for p in providers["data"] if p["name"] == "Dana Whitfield")
    marcus = next(p for p in providers["data"] if p["name"] == "Marcus Ito")

    # ---- 3. rota honoured -------------------------------------------------
    monday = next_weekday(0, weekly=True)
    day = monday.isoformat()
    body = availability({"providerId": dana["id"], "locationId": hq["id"], "from": day, "days": 1, "limit": 60})
    slots = body.get("data", []) if body else []
    check("a working day offers slots", len(slots) >= 4, f"{len(slots)} slots on {day}")
    inside = all(minutes(s["local"]["start"]) >= minutes("9:00am") and minutes(s["local"]["end"]) <= minutes("5:00pm") for s in slots)
    check("every slot sits inside the working window", inside and len(slots) > 0,
          ", ".join(f"{s['local']['start']}–{s['local']['end']}" for s in slots[:3]))
    lunch = [s for s in slots if minutes(s["local"]["start"]) < minutes("1:00pm") and minutes(s["local"]["end"]) > minutes("12:00pm")]
    check("the lunch break is not bookable", len(lunch) == 0, f"{len(lunch)} slots overlap 12:00–13:00")
    check("slots name who and where", all(s.get("providerName") and s.get("locationName") for s in slots), slots[0]["providerName"] if slots else "")

    # ---- 4. closed day ----------------------------------------------------
    saturday = next_weekday(5, weekly=True).isoformat()
    closed = availability({"providerId": dana["id"], "from": saturday, "days": 1})
    check(
        "a non-working day is refused with a reason",
        closed is not None and not closed.get("data") and bool(closed.get("reason")),
        (closed or {}).get("reason", "no response"),
    )

    # ---- 5. one-off day off ----------------------------------------------
    # The nearest Tuesday can be fully booked — the seeded month plus every
    # booking gate that has ever run fills Dana Whitfield's early Tuesdays, and then
    # "reopens" has no slot to reopen to. Walk forward a week at a time to a
    # Tuesday with something free and run the whole off/on cycle there.
    tuesday = next_weekday(1, weekly=True)
    for _ in range(5):
        probe = availability({"providerId": dana["id"], "locationId": hq["id"], "from": tuesday.isoformat(), "days": 1})
        if probe and probe.get("data"):
            break
        tuesday += timedelta(days=7)
    status, change = call("POST", "/api/v1/rota-changes", {"providerId": dana["id"], "date": tuesday.isoformat(), "kind": "off", "reason": "practice_check"})
    check("a day off can be added", status == 201, message(change))
    if status == 201:
        created_change_ids.append(change["id"])
    off_day = availability({"providerId": dana["id"], "from": tuesday.isoformat(), "days": 1})
    check("the day off closes that weekday", off_day is not None and not off_day.get("data"), f"{len((off_day or {}).get('data', []))} slots on {tuesday}")
    others = availability({"from": tuesday.isoformat(), "days": 1, "limit": 5})
    check("only that provider's day is affected", bool((others or {}).get("data")), f"{len((others or {}).get('data', []))} slots for everyone else")
    if created_change_ids:
        call("DELETE", f"/api/v1/rota-changes/{created_change_ids.pop()}")
    reopened = availability({"providerId": dana["id"], "from": tuesday.isoformat(), "days": 1})
    check("removing the day off reopens it", bool((reopened or {}).get("data")), f"{len((reopened or {}).get('data', []))} slots")

    # ---- 6. one-off extra hours ------------------------------------------
    status, extra = call(
        "POST",
        "/api/v1/rota-changes",
        {"providerId": dana["id"], "date": saturday, "kind": "extra", "windows": [{"weekday": 6, "start": "10:00", "end": "14:00"}], "reason": "practice_check"},
    )
    check("extra hours can be added on a closed day", status == 201, message(extra))
    if status == 201:
        created_change_ids.append(extra["id"])
    extra_day = availability({"providerId": dana["id"], "from": saturday, "days": 1, "limit": 60})
    extra_slots = (extra_day or {}).get("data", [])
    within = all(minutes(s["local"]["start"]) >= minutes("10:00am") and minutes(s["local"]["end"]) <= minutes("2:00pm") for s in extra_slots)
    check("the extra window is what gets offered", bool(extra_slots) and within, f"{len(extra_slots)} slots, first {extra_slots[0]['local']['start'] if extra_slots else '—'}")
    if created_change_ids:
        call("DELETE", f"/api/v1/rota-changes/{created_change_ids.pop()}")
    closed_again = availability({"providerId": dana["id"], "from": saturday, "days": 1})
    check("removing the extra hours closes the day again", not (closed_again or {}).get("data"))

    # ---- 8. timezones, including DST --------------------------------------
    dana_day = availability({"providerId": dana["id"], "locationId": hq["id"], "from": day, "days": 1, "limit": 5})
    first_slot = ((dana_day or {}).get("data") or [None])[0]
    if first_slot:
        utc_hour = datetime.fromisoformat(first_slot["startsAt"].replace("Z", "+00:00")).hour
        check("a Los Angeles 9am is not 9am UTC", utc_hour != minutes(first_slot["local"]["start"]) // 60,
              f"local {first_slot['local']['start']} = {utc_hour:02d}:00Z")
        check("the site's timezone is echoed", (dana_day or {}).get("timezone") == hq["timezone"], (dana_day or {}).get("timezone", ""))

        # DST boundary: the same wall clock has to become a different instant.
        # The next three weeks cross every US transition once a year, so when
        # they do not, this probe is honestly skipped rather than faked.
        probes = []
        for probe_date in (next_weekday(0, weekly=True), next_weekday(0, weekly=True) + timedelta(days=21)):
            got = availability({"providerId": dana["id"], "locationId": hq["id"], "from": probe_date.isoformat(), "days": 1, "limit": 1})
            slot = ((got or {}).get("data") or [None])[0]
            if slot:
                # The site's own offset, not the first slot's clock: the first slot
                # of a day moves as soon as somebody books it, and comparing two
                # such clocks measures the diary rather than the timezone.
                starts = datetime.fromisoformat(slot["startsAt"].replace("Z", "+00:00"))
                offset = (starts.hour * 60 + starts.minute - minutes(slot["local"]["start"])) % 1440
                probes.append((probe_date, slot["local"]["start"], offset))
        if len(probes) == 2 and probes[0][2] != probes[1][2]:
            check(
                "the clock survives the DST change (the site's offset shifts by an hour)",
                abs(probes[1][2] - probes[0][2]) == 60,
                f"{probes[0][1]} on {probes[0][0]} is {probes[0][2] // 60}h behind UTC, {probes[1][2] // 60}h on {probes[1][0]}",
            )
        else:
            print(f"SKIP  DST boundary — this three-week window does not cross a transition ({probes})")

    ny_params = {"locationId": ny["id"], "from": day, "days": 1, "limit": 60}
    if quick:
        ny_params["serviceId"] = quick["id"]
    ny_day = availability(ny_params)
    ny_slots = (ny_day or {}).get("data", [])
    ny_within = all(minutes(s["local"]["start"]) >= minutes("8:00am") and minutes(s["local"]["end"]) <= minutes("6:00pm") for s in ny_slots)
    check("the New York site runs on its own hours", bool(ny_slots) and ny_within, f"{len(ny_slots)} slots, first {ny_slots[0]['local']['start'] if ny_slots else '—'} NY")
    check("site filtering never leaks the other site", all(s["locationId"] == ny["id"] for s in ny_slots), f"{len(ny_slots)} slots")

    # ---- 7. duration and buffers -----------------------------------------
    monday_slots = availability({"providerId": dana["id"], "locationId": hq["id"], "serviceId": install["id"], "from": day, "days": 1, "limit": 60})
    slot_list = (monday_slots or {}).get("data", [])
    lengths = {minutes(s["local"]["end"]) - minutes(s["local"]["start"]) for s in slot_list}
    check("the service duration sets the appointment length", lengths == {install["durationMinutes"]}, f"lengths seen: {sorted(lengths)}")

    if slot_list:
        first = slot_list[0]
        status, booked = call(
            "POST",
            "/api/v1/bookings",
            {
                "externalId": f"practice-check-{int(datetime.now().timestamp())}",
                "customer": {"name": "Practice Check", "number": "+14155550199"},
                "startsAt": first["startsAt"],
                "serviceId": install["id"],
                "providerId": dana["id"],
                "locationId": hq["id"],
            },
        )
        check("a slot can be booked from the diary", status == 201, message(booked))
        if status == 201:
            created_booking_ids.append(booked["id"])
            check("the booking inherits the service's price and duration", booked.get("value") == install.get("price") and booked.get("durationMinutes") == install["durationMinutes"],
                  f"value {booked.get('value')}, {booked.get('durationMinutes')}m")
            # ---- 9. the clash -------------------------------------------------
            clash_status, clash = call(
                "POST",
                "/api/v1/bookings",
                {
                    "externalId": f"practice-clash-{int(datetime.now().timestamp())}",
                    "customer": {"name": "Double Booked", "number": "+14155550198"},
                    "startsAt": first["startsAt"],
                    "serviceId": install["id"],
                    "providerId": dana["id"],
                },
            )
            check("a double booking is refused", clash_status == 409, f"{clash_status} {message(clash)}")

            after = availability({"providerId": dana["id"], "locationId": hq["id"], "serviceId": install["id"], "from": day, "days": 1, "limit": 60})
            remaining = [s["startsAt"] for s in (after or {}).get("data", [])]
            check("the booked slot disappears from availability", first["startsAt"] not in remaining, f"{len(remaining)} left of {len(slot_list)}")

            gap = [
                minutes(s["local"]["start"]) - minutes(first["local"]["end"])
                for s in (after or {}).get("data", [])
                if minutes(s["local"]["start"]) > minutes(first["local"]["start"])
            ]
            blocking = min(gap) if gap else None
            check(
                "the after-buffer keeps the next appointment clear",
                blocking is None or blocking >= install["bufferAfterMinutes"],
                f"closest next start is {blocking} min after (buffer {install['bufferAfterMinutes']})",
            )

            with_taken = availability({"providerId": dana["id"], "locationId": hq["id"], "serviceId": install["id"], "from": day, "days": 1, "limit": 60, "includeTaken": "true"})
            check(
                "the diary view can still show what is taken",
                any(s.get("taken") for s in (with_taken or {}).get("data", [])),
                f"{sum(1 for s in (with_taken or {}).get('data', []) if s.get('taken'))} taken slot(s)",
            )

    # ---- 9. provider ↔ service matching ----------------------------------
    quick_day = availability({"serviceId": quick["id"], "from": day, "days": 5, "limit": 60})
    quick_providers = {s["providerName"] for s in (quick_day or {}).get("data", [])}
    check(
        "only providers who do the service are offered",
        {p["name"] for p in providers["data"] if quick["id"] in p["serviceIds"]} == quick_providers and bool(quick_providers),
        ", ".join(sorted(quick_providers)),
    )
    install_day = availability({"serviceId": install["id"], "providerId": marcus["id"], "from": day, "days": 5, "limit": 60})
    check("Marcus, who does installations, is offered", bool((install_day or {}).get("data")), f"{len((install_day or {}).get('data', []))} slots")
    consult_only = availability({"serviceId": consult["id"], "providerId": marcus["id"], "from": day, "days": 5, "limit": 10})
    check(
        "a provider who cannot do the service has no slots",
        not (consult_only or {}).get("data"),
        (consult_only or {}).get("reason", "no slots"),
    )

    # ---- 10b. rooms are records, not labels -------------------------------
    # A room is what an appointment occupies. Its id has to survive a rename,
    # or every appointment already booked into it loses its room; and a room
    # with appointments still to come cannot be deleted out from under them.
    # A room referenced by historical appointments is intentionally retained when
    # retired. Reuse that retained probe record on the next run instead of trying
    # to hard-delete history and then colliding with its still-reserved name.
    _, existing_bookings = call("GET", "/api/v1/bookings?limit=200")
    for row in existing_bookings.get("data", []):
        if (row.get("customer") or {}).get("name") == "Practice Room Probe" and row.get("status") not in {"cancelled", "completed", "no_show"}:
            call("POST", f"/api/v1/bookings/{row['id']}/status", {"status": "cancelled", "note": "practice_check stale cleanup"})
    _, leftovers = call("GET", "/api/v1/rooms?includeInactive=true")
    reusable = sorted(
        [
            row for row in leftovers.get("data", [])
            if row.get("locationId") == hq["id"] and str(row.get("name", "")).startswith("Practice Check Room")
        ],
        key=lambda row: (str(row.get("createdAt", "")), row.get("id", "")),
    )
    if reusable:
        picked = reusable[0]
        probe_room_name = f"Practice Check Room {picked['id'][-6:]}"
        status, added = call("POST", "/api/v1/rooms", {
            "action": "update", "id": picked["id"], "name": probe_room_name, "active": True,
        })
    else:
        probe_room_name = "Practice Check Room Probe"
        status, added = call("POST", "/api/v1/rooms", {
            "action": "create", "locationId": hq["id"], "name": probe_room_name,
        })
    room = added.get("room") or {}
    if room.get("id"):
        created_room_ids.append(room["id"])
    check("a room record can be prepared at the site", status in (200, 201) and bool(room.get("id")), f"{room.get('name')} at {hq['name']}" if room.get("id") else f"{status} {message(added)}")
    check("the same name twice at one site is refused",
          call("POST", "/api/v1/rooms", {"action": "create", "locationId": hq["id"], "name": probe_room_name})[0] == 400,
          "400")
    # Keep this defined even if room preparation fails, so the later independent
    # diary assertions report their own result rather than crashing the gate.
    _, sites_after = call("GET", "/api/v1/locations")
    if room.get("id"):
        # The site's mirror is what availability reads, so it must move with the record.
        mirror = next((l["rooms"] for l in sites_after.get("data", []) if l["id"] == hq["id"]), [])
        check("the site's room list follows the record", any(r["id"] == room["id"] for r in mirror),
              ", ".join(r["name"] for r in mirror))

        free = availability({"serviceId": install["id"], "providerId": dana["id"], "locationId": hq["id"], "from": day, "days": 3, "limit": 1})
        free_slot = next((s for s in (free or {}).get("data", [])), None)
        # `POST /api/v1/bookings` answers with the booking document itself.
        room_status, room_payload = call("POST", "/api/v1/bookings", {
            "externalId": f"practice-room-{stamp()}",
            "customer": {"name": "Practice Room Probe", "number": f"+1415557{stamp() % 100000:05d}"},
            "startsAt": (free_slot or {}).get("startsAt"),
            "serviceId": install["id"],
            "providerId": dana["id"],
            "locationId": hq["id"],
            "roomId": room["id"],
            "status": "confirmed",
        }) if free_slot else (0, {})
        room_booking = room_payload if room_status == 201 else {}
        if room_booking.get("id"):
            created_booking_ids.append(room_booking["id"])
        renamed_name = f"{probe_room_name} Renamed"
        status, renamed = call("POST", "/api/v1/rooms", {"action": "update", "id": room["id"], "name": renamed_name})
        # By external id, not by scanning a page: the list endpoint caps its page
        # size, and a workspace with a month of history pushed the probe off it.
        _, after = call("GET", f"/api/v1/bookings?externalId={room_booking.get('externalId')}")
        still = next((b for b in after.get("data", []) if b.get("id") == room_booking.get("id")), {})
        check("renaming a room keeps the id its appointments point at",
              (renamed.get("room") or {}).get("id") == room["id"] and still.get("roomId") == room["id"],
              f"{room['id']} → {(renamed.get('room') or {}).get('name')}")

        status, refused = call("POST", "/api/v1/rooms", {"action": "delete", "id": room["id"]})
        check("a room with appointments to come cannot be deleted", status == 409 and "Retire" in message(refused),
              f"{status} {message(refused)}")

        status, retired = call("POST", "/api/v1/rooms", {"action": "update", "id": room["id"], "active": False})
        _, sites_after = call("GET", "/api/v1/locations")
        mirror = next((l["rooms"] for l in sites_after.get("data", []) if l["id"] == hq["id"]), [])
        check("a retired room stops being offered", status == 200 and not any(r["id"] == room["id"] for r in mirror),
              ", ".join(r["name"] for r in mirror) or "no rooms offered")
        call("POST", "/api/v1/rooms", {"action": "update", "id": room["id"], "active": True})
        if room_booking.get("id"):
            call("POST", f"/api/v1/bookings/{room_booking['id']}/status", {"status": "cancelled", "note": "practice_check room cleanup"})
            created_booking_ids[:] = [b for b in created_booking_ids if b != room_booking["id"]]
        delete_status, deleted_room = call("POST", "/api/v1/rooms", {"action": "delete", "id": room["id"]})
        _, kept_rooms = call("GET", "/api/v1/rooms?includeInactive=true")
        kept_room = next((candidate for candidate in kept_rooms.get("data", []) if candidate.get("id") == room["id"]), None)
        check("with no future booking, the room retires without erasing historical labels",
              delete_status == 200 and deleted_room.get("retained") is True and kept_room and kept_room.get("active") is False,
              f"{delete_status} · retained={deleted_room.get('retained')} · references={deleted_room.get('historicalReferences')}")
        created_room_ids[:] = [r for r in created_room_ids if r != room["id"]]

    # ---- 10c. the appointment remembers where it is ----------------------
    offered = availability({"serviceId": install["id"], "providerId": dana["id"], "locationId": hq["id"], "from": day, "days": 5, "limit": 1})
    first = next((s for s in (offered or {}).get("data", [])), None)
    check("a slot says which room it is in", bool(first and first.get("roomId")), (first or {}).get("roomName", "no room"))
    if first:
        booked_status, booked = call("POST", "/api/v1/bookings", {
            "externalId": f"practice-room-keep-{stamp()}",
            "customer": {"name": "Practice Room Probe", "number": f"+1415557{(stamp() + 7) % 100000:05d}"},
            "startsAt": first["startsAt"],
            "serviceId": install["id"],
            "providerId": dana["id"],
            "locationId": hq["id"],
            "status": "confirmed",
        })
        booked = booked if booked_status == 201 else {}
        if booked.get("id"):
            created_booking_ids.append(booked["id"])
        check("the room the diary offered is the room it records", booked.get("roomId") == first.get("roomId"),
              f"{first.get('roomName')} → {booked.get('roomId')}")

        # What the screen can actually draw. A room id is no use to a
        # receptionist: the diary has to name the room, name the site it is in,
        # and offer the sites it covers.
        booked_day = str(booked.get("startsAt", ""))[:10]
        if booked.get("id") and booked_day:
            span_from = (datetime.fromisoformat(booked_day) - timedelta(days=1)).date().isoformat()
            _, diary = call("GET", f"/api/v1/diary?view=3day&from={span_from}")
            rows = [a for day in diary.get("days", []) for a in day.get("appointments", []) if a.get("id") == booked["id"]]
            row = rows[0] if rows else {}
            check("the diary names the room", bool(row) and row.get("roomName") == first.get("roomName"), f"{row.get('roomName')}")
            check("the diary names the site", row.get("locationName") == hq["name"], f"{row.get('locationName')}")
            check(
                "the diary offers every site it covers",
                {s2["id"] for s2 in (diary.get("sites") or [])} == {s2["id"] for s2 in (sites_after.get("data") or []) if s2.get("active") is not False},
                ", ".join(s2["name"] for s2 in (diary.get("sites") or [])),
            )

    # ---- 11. the agent answers from the same engine -----------------------
    _, assistants = call("GET", "/api/v1/assistants")
    desk = next((a for a in assistants.get("data", []) if "appointment" in a["name"].lower()), None)
    check("the appointment assistant is available", desk is not None, desk["name"] if desk else "not found")
    if desk:
        status, live = call("POST", "/api/v1/calls", {"assistantId": desk["id"], "type": "web", "customer": {"number": "+14155550111"}})
        check("a test call can be started", status in (200, 201), message(live))
        call_id = (live.get("id") or live.get("call", {}).get("id")) if status in (200, 201) else None
        if call_id:
            status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "I'd like to book an appointment next thursday afternoon please"})
            tool_calls = (turn.get("turn", {}) or {}).get("toolCalls", []) if status == 200 else []
            avail_call = next((t for t in tool_calls if "availability" in t["name"]), None)
            check("the agent reaches for availability", avail_call is not None, ", ".join(t["name"] for t in tool_calls))
            if avail_call:
                result = json.loads(avail_call["result"])
                agent_slots = result.get("slots", [])
                expected = next_weekday(3, weekly=True).isoformat()
                check("the agent's day is the next Thursday", result.get("date") == expected, f"{result.get('date')} (expected {expected})")
                in_hours = all(minutes(s) >= minutes("9:00am") and minutes(s) < minutes("5:00pm") for s in agent_slots)
                in_lunch = [s for s in agent_slots if minutes("12:00pm") <= minutes(s) < minutes("1:00pm")]
                check("the agent's slots come from the diary, not a fixed list", bool(agent_slots) and in_hours and not in_lunch and "9:15am" not in agent_slots[:1],
                      ", ".join(agent_slots[:4]))
                check("the agent can say who it is booking with", bool(result.get("providers")), ", ".join(result.get("providers", [])))
                turn_body = turn.get("turn", {}) or {}
                reply = str(turn_body.get("assistantText") or turn_body.get("text") or turn_body.get("reply") or "")
                squeezed = reply.replace(" ", "").lower()
                quoted = [s for s in agent_slots if s.replace(" ", "").lower() in squeezed]
                check("the spoken answer quotes a real slot", bool(reply) and bool(quoted), reply[:140])
            call("PATCH", f"/api/v1/calls/{call_id}", {"status": "ended"})

    return finish()


def finish():
    # Clean up after ourselves: the test booking and any one-off days.
    for booking_id in created_booking_ids:
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "practice_check cleanup"})
    for change_id in created_change_ids:
        call("DELETE", f"/api/v1/rota-changes/{change_id}")
    for room_id in created_room_ids:
        call("POST", "/api/v1/rooms", {"action": "delete", "id": room_id})

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — the diary honours rotas, one-off changes, buffers, timezones and clashes, and the agent answers from it.")


if __name__ == "__main__":
    main()
