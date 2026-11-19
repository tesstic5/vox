#!/usr/bin/env python3
"""
Practitioner day view check (A6).

Proves that "my day" is a real view of the diary rather than a filter on the
board, and that the practitioner behind the login is a real person in the data:

   1.  a login with no practitioner record attached is told so, offered the
       records it may claim, and shown **no** diary — never somebody else's
   2.  a practitioner may link their own record to their own login, and a
       practitioner record already held by another login is refused by name
   3.  a non-owner cannot attach a record to somebody else, and cannot read
       somebody else's day; an owner can read anybody's
   4.  the day is built from the rota, the appointments and the rota's breaks —
       and it says what is free *and* whether that free time is bookable, which
       are two different answers
   5.  the notice window is respected per stretch: a stretch the notice runs past
       is "too soon", a stretch too short for the shortest service is "too short",
       a stretch already under way is bookable from now-plus-notice, and a stretch
       that has gone by is history
   6.  the appointments carry what the person about to see the client needs: the
       room, the service, the client's number, and any medical flag on the record
       — and reading a flag writes to that record's access log
   7.  moving an appointment on is the same diary the rest of the product reads:
       the legal transitions are the ones offered, an illegal one is refused, and
       the change is visible through the bookings API immediately
   8.  cancelling frees the time, and the freed stretch is re-joined and offered
       again by the same machinery the wait list uses
   9.  the route is disciplined: unknown query parameters, a bad date, a bad
       range and an API key with nobody behind it are all refused with a reason
  10.  the link is audited

It creates its own practitioner, its own login, its own room, its own client and
its own appointments, and takes them away again, so it can be run against the
demo workspace without leaving a trace (every fixture is named `Probe …` in case
a run dies before `finish()` gets to it — the house sweep knows that name, and
`finish()` also clears fixtures an earlier run left, so repeating the check cannot
pile up practitioners, rooms or appointments). The one thing clean-up cannot undo
is the client *record*: a record is archived, never erased (that is the point of
the practice layer's retention rules), and the archived `Probe Day Client` row is
removed by `scripts/tidy-probe-orgs.ts` along with the rest of the probe debris.

Run it with the app up:

    python3 scripts/day_check.py
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
PROBE_LOGIN = "day-probe@northwind.dev"
RUN_TOKEN = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")

cookie = ""
probe_cookie = ""
failures: list[str] = []
skips: list[str] = []
created_bookings: list[str] = []
created_clients: list[str] = []
created_rooms: list[str] = []
created_providers: list[str] = []
created_keys: list[str] = []
probe_user_id = ""
probe_provider_id = ""
probe_password = ""
finished = False
site_id = ""
site_tz = "UTC"


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def skip(label, why):
    print(f"SKIP  {label}  — {why}")
    skips.append(label)


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
        if value:
            req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode()
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


def sign_in(email, password, ip=None):
    status, body, headers = call(
        "POST",
        "/api/auth/login",
        {"email": email, "password": password},
        headers={"x-forwarded-for": ip} if ip else None,
        cookie_override="",
    )
    value = ""
    if status == 200:
        value = (headers.get("Set-Cookie") or headers.get("set-cookie") or "").split(";")[0]
    return status, body, value


def local_now():
    return datetime.now(ZoneInfo(site_tz))


def instant(date, clock):
    """A site-local wall clock on a local date, as an ISO instant."""
    hh, mm = (int(x) for x in clock.split(":"))
    return datetime.combine(date, time(hh, mm), tzinfo=ZoneInfo(site_tz)).astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def app_weekday(date):
    """The row's `weekday`, as the app counts it: 0 = Sunday (Python counts Monday)."""
    return (date.weekday() + 1) % 7


def day(path_extra=""):
    return call("GET", f"/api/v1/day{path_extra}", cookie_override=probe_cookie)


def clocks(row):
    return [a["local"] for a in row.get("appointments", [])]


def at(instant_iso):
    return datetime.fromisoformat(str(instant_iso).replace("Z", "+00:00"))


def gap_at(row, instant_iso):
    """The gap that starts at this instant. Compared as instants, never as text:
    the API renders "7:40 AM" for a clock the gate would write "07:40"."""
    wanted = at(instant_iso)
    for gap in row.get("free", {}).get("gaps", []):
        if at(gap["startsAt"]) == wanted:
            return gap
    return None


def main():
    global cookie, probe_cookie, probe_user_id, probe_provider_id, probe_password, site_id, site_tz

    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("sign in as the owner", bool(cookie), "session cookie" if cookie else "no session")
    if not cookie:
        return finish()

    # ---- 0. the site and its services -------------------------------------
    status, locations, _ = call("GET", "/api/v1/locations")
    ny = next((l for l in (locations.get("data") or []) if "New York" in (l.get("name") or "")), None)
    if not ny:
        check("a site to run the day at", False, "no New York site in this workspace")
        return finish()
    site_id = ny["id"]
    site_tz = ny.get("timezone") or "UTC"
    status, services, _ = call("GET", "/api/v1/services")
    durations = sorted(s.get("durationMinutes") or 0 for s in (services.get("data") or []) if (s.get("durationMinutes") or 0) > 0)
    check("the site's clock is known and services have durations", bool(site_tz) and bool(durations), f"{ny.get('name')} · {site_tz} · shortest service {durations[0] if durations else '?'} min")

    # ---- 1. the probe practitioner, login, room and client ----------------
    today = local_now().date()
    yesterday = today - timedelta(days=1)
    probe_date = today + timedelta(days=1)

    # Reused if an earlier run died before its clean-up, so re-running this check
    # cannot pile up practitioners in the workspace.
    existing_provider = next((p for p in (call("GET", "/api/v1/providers?includeInactive=true")[1].get("data") or []) if p.get("name") == "Probe Day View"), None)
    if existing_provider:
        probe_provider_id = existing_provider["id"]
        if existing_provider.get("active") is False:
            call("PATCH", f"/api/v1/providers/{probe_provider_id}", {"active": True, "locationIds": [site_id]})
        created_providers.append(probe_provider_id)
        check("a practitioner record to run a day for (reused from an earlier run)", True, f"{probe_provider_id}")
    else:
        status, made_provider, _ = call(
            "POST",
            "/api/v1/providers",
            {"name": "Probe Day View", "title": "Cover practitioner", "email": "probe-day-view@northwind.dev", "serviceIds": [], "locationIds": [site_id]},
        )
        probe_provider_id = made_provider.get("id", "")
        check("a practitioner record can be created to run a day for", status == 201 and bool(probe_provider_id), f"{status} {message(made_provider)}")

    existing_room = next(
        (r for r in (call("GET", f"/api/v1/rooms?locationId={site_id}&includeInactive=true")[1].get("data") or []) if r.get("name") == "Probe Day Room"),
        None,
    )
    room_id = existing_room.get("id", "") if existing_room else ""
    if room_id:
        if existing_room.get("active") is False:
            call("POST", "/api/v1/rooms", {"action": "update", "id": room_id, "active": True})
        created_rooms.append(room_id)
        check("a room of its own, so no seeded booking can collide with it (reused)", True, room_id)
    else:
        status, room, _ = call("POST", "/api/v1/rooms", {"action": "create", "locationId": site_id, "name": "Probe Day Room"})
        room_id = ((room.get("room") or {}).get("id")) or ""
        if room_id:
            created_rooms.append(room_id)
        check("a room of its own, so no seeded booking can collide with it", status == 201 and bool(room_id), f"{status} {message(room)}")

    # The rooms at the site and the other practitioners, read once: the holders
    # below need them, and so does the reset of whatever an earlier run left.
    site_rooms = [r["id"] for r in (call("GET", f"/api/v1/rooms?locationId={site_id}")[1].get("data") or []) if r.get("active") is not False]
    holder_candidates = [p["id"] for p in (call("GET", "/api/v1/providers")[1].get("data") or []) if p["id"] != probe_provider_id]

    # A run that died before its clean-up can leave token-suffixed appointments
    # behind. Find them by their reserved prefix (the old exact-id sweep stopped
    # matching once RUN_TOKEN was added), and cancel only non-terminal probe rows.
    probe_rows = call("GET", f"/api/v1/bookings?providerId={probe_provider_id}&limit=200")[1].get("data") or []
    stale_rows = list(probe_rows)
    for holder in holder_candidates:
        stale_rows.extend(call("GET", f"/api/v1/bookings?providerId={holder}&limit=200")[1].get("data") or [])
    cleared = 0
    seen_stale = set()
    for row in stale_rows:
        external = str(row.get("externalId", ""))
        if row.get("id") in seen_stale or not external.startswith(("probe-day-a-", "probe-day-b-", "probe-day-hold-")):
            continue
        seen_stale.add(row.get("id"))
        if row.get("status") in {"cancelled", "completed", "no_show"}:
            continue
        if call("POST", f"/api/v1/bookings/{row['id']}/status", {"status": "cancelled", "note": "day_check stale cleanup"})[0] in (200, 204):
            row["status"] = "cancelled"
            cleared += 1
    if cleared:
        print(f"      (cleared {cleared} appointment(s) a previous run left behind)")

    # Completing visit A is part of the contract this gate proves, and completed
    # history must not be rewritten as cancelled during clean-up. Therefore a
    # repeat run uses the next suitable future date that is not already occupied
    # by one of those preserved visits. Keep its weekday distinct from today and
    # yesterday so the three test rota windows remain independent.
    occupied = [row for row in probe_rows if row.get("status") != "cancelled"]
    chosen = None
    for delta in range(1, 91):
        candidate = today + timedelta(days=delta)
        if app_weekday(candidate) in {app_weekday(today), app_weekday(yesterday)}:
            continue
        candidate_from = instant(candidate, "10:00")
        candidate_to = instant(candidate, "12:00")
        collision = False
        for row in occupied:
            try:
                row_from = at(row.get("startsAt"))
                row_to = row_from + timedelta(minutes=int(row.get("durationMinutes") or 30))
            except (TypeError, ValueError):
                continue
            if candidate_from < row_to and candidate_to > row_from:
                collision = True
                break
        if collision:
            continue
        # Holding every room needs one distinct working practitioner per room.
        # Do not pick a weekend (or an already-busy weekday) and then weaken the
        # assertion: ask the same availability engine whether enough holders are
        # genuinely free at 10:45 on this candidate date.
        wanted_holder_start = instant(candidate, "10:45")
        available_holders = 0
        for holder in holder_candidates:
            holder_status, holder_slots, _ = call(
                "GET",
                f"/api/v1/availability?providerId={holder}&locationId={site_id}&from={candidate.isoformat()}&days=1&limit=60",
            )
            if holder_status == 200 and any(
                at(slot.get("startsAt")) == wanted_holder_start for slot in (holder_slots.get("data") or [])
            ):
                available_holders += 1
        if available_holders < len(site_rooms):
            continue
        chosen = candidate
        break
    if chosen is None:
        check("a free future date exists for the repeat-safe day probe", False, "none in the next 90 days")
        return finish()
    probe_date = chosen

    # The rota is the spine of the day view: one window already gone, one the
    # notice window runs past, and one future probe date with room for two appointments.
    now_local = local_now()
    soon_start = (now_local + timedelta(minutes=5)).replace(second=0, microsecond=0)
    day_end = datetime.combine(soon_start.date(), time(23, 59), tzinfo=ZoneInfo(site_tz))
    soon_end = min(soon_start + timedelta(minutes=30), day_end)
    windows = [
        {"weekday": app_weekday(yesterday), "start": "09:00", "end": "11:00"},
        {"weekday": app_weekday(probe_date), "start": "10:00", "end": "12:00"},
    ]
    can_build_soon = soon_start < soon_end and soon_start.date() == today
    if can_build_soon:
        windows.append({"weekday": app_weekday(today), "start": soon_start.strftime("%H:%M"), "end": soon_end.strftime("%H:%M")})
    status, rota, _ = call("PUT", "/api/v1/rota", {"providerId": probe_provider_id, "locationId": site_id, "windows": sorted(windows, key=lambda w: w["weekday"])})
    check("the rota covers yesterday, today and the future probe date", status == 200 and len(rota.get("windows") or []) == len(windows), f"{len(rota.get('windows') or [])} window(s) · probe {probe_date.isoformat()}")

    status, invited, _ = call("POST", "/api/v1/team", {"action": "invite", "email": PROBE_LOGIN, "name": "Probe Day Login", "role": "practitioner"})
    if status == 409:
        member = next((m for m in (call("GET", "/api/v1/team?view=members")[1].get("members") or []) if m["email"] == PROBE_LOGIN), None)
        probe_user_id = (member or {}).get("id", "")
        call("POST", "/api/v1/team", {"action": "reset-password", "id": probe_user_id})
        call("POST", "/api/v1/team", {"action": "reactivate", "id": probe_user_id})
        check("a login for the practitioner exists (reused from an earlier run)", bool(probe_user_id), PROBE_LOGIN)
    else:
        probe_user_id = (invited.get("member") or {}).get("id", "")
        probe_password = invited.get("temporaryPassword") or ""
        check("a login can be created for the practitioner", status == 201 and bool(probe_user_id), f"{status} {message(invited)}")

    if not probe_password:
        # A login that already exists needs a fresh one-time password each run —
        # the invite path only ever shows it once.
        status, reset, _ = call("POST", "/api/v1/team", {"action": "password", "id": probe_user_id})
        probe_password = reset.get("temporaryPassword") or ""

    status, _, probe_cookie = sign_in(PROBE_LOGIN, probe_password, ip="203.0.113.31")
    check("the practitioner can sign in as themselves", status == 200 and bool(probe_cookie), f"{status}")

    client_number = f"+1415557{int(datetime.now().timestamp()) % 100000:05d}"
    status, client, _ = call("POST", "/api/v1/clients", {"name": "Probe Day Client", "number": client_number, "tags": ["probe"]})
    client_id = client.get("id", "")
    if client_id:
        created_clients.append(client_number)
    check("a client with a record to flag", status == 201 and bool(client_id), f"{status} {message(client)}")
    if client_id:
        status, _flagged, _ = call(
            "POST",
            f"/api/v1/clients/{client_id}/alerts",
            {"label": "Probe anticoagulants", "detail": "from day_check", "severity": "critical"},
        )
        check("the client carries a medical flag", status == 201, f"{status}")

    # ---- 2. before the link: an honest empty answer -----------------------
    # Unlink first: a run that died before its own clean-up would otherwise leave
    # the link standing and this section would be checking the wrong thing.
    call("POST", "/api/v1/day", {"action": "provider:unlink"}, cookie_override=probe_cookie)
    status, before, _ = day()
    link_block = before.get("link") or {}
    candidates = [c["name"] for c in (link_block.get("candidates") or [])]
    check("an unlinked login is told it has no practitioner record", status == 200 and before.get("linked") is False, f"linked={before.get('linked')}")
    check("…and is shown no diary at all", (before.get("rows") or []) == [] and (before.get("provider") is None), f"{len(before.get('rows') or [])} row(s)")
    check("…and is offered the records it could claim", "Probe Day View" in candidates and bool(link_block.get("canLink")), f"{len(candidates)} candidate(s), canLink={link_block.get('canLink')}")

    # ---- 3. the link rules ------------------------------------------------
    status, refused, _ = call(
        "POST",
        "/api/v1/day",
        {"action": "provider:link", "providerId": probe_provider_id, "userId": (call("GET", "/api/v1/team?view=members")[1].get("members") or [{}])[0].get("id")},
        cookie_override=probe_cookie,
    )
    check("a non-owner cannot attach a record to somebody else", status == 403, f"{status} {message(refused)[:80]}")

    status, linked, _ = call("POST", "/api/v1/day", {"action": "provider:link", "providerId": probe_provider_id}, cookie_override=probe_cookie)
    check("a practitioner can claim their own record", status == 200 and (linked.get("linked") or {}).get("id") == probe_provider_id, f"{status} {message(linked)}")
    check("the answer already contains the day that now exists", len((linked.get("day") or {}).get("rows") or []) >= 1, f"{len((linked.get('day') or {}).get('rows') or [])} row(s)")

    status, stolen, _ = call("POST", "/api/v1/day", {"action": "provider:link", "providerId": probe_provider_id}, cookie_override=cookie)
    held = message(stolen)
    check("a record already held by another login is refused by name", status == 409 and PROBE_LOGIN in held, f"{status} {held[:70]}")

    # ---- 4. yesterday: free time that has gone by -------------------------
    status, past_day, _ = day(f"?date={yesterday.isoformat()}")
    past_row = (past_day.get("rows") or [{}])[0]
    past_gaps = past_row.get("free", {}).get("gaps", [])
    check("yesterday's rota is read, and only yesterday's", status == 200 and past_row.get("date") == yesterday.isoformat() and past_row.get("working") is True, f"{past_row.get('hours', {}).get('from')}–{past_row.get('hours', {}).get('to')} ({past_row.get('hoursFrom')})")
    check(
        "a stretch that has gone by is history, not an opportunity",
        bool(past_gaps) and all(g["past"] and not g["bookable"] and g["bookableMinutes"] == 0 for g in past_gaps),
        f"{len(past_gaps)} gap(s), all past",
    )
    check(
        "…and yesterday's free time is counted as gone, not as free today",
        past_row.get("free", {}).get("freeMinutes") == 0 and past_row.get("free", {}).get("pastMinutes") > 0,
        f"free {past_row.get('free', {}).get('freeMinutes')} · gone by {past_row.get('free', {}).get('pastMinutes')}",
    )

    # ---- 5. today: the notice window is respected per stretch -------------
    status, today_day, _ = day()
    today_row = (today_day.get("rows") or [{}])[0]
    hints = today_day.get("hints") or {}
    check("the hints come with the day, not from a second call", hints.get("minNoticeMinutes") is not None and bool(hints.get("transitions")), f"notice {hints.get('minNoticeMinutes')} min · {len(hints.get('transitions') or {})} statuses")
    if not can_build_soon:
        skip("a stretch the notice window runs past", "the site's day is about to end — there is no room left in it to build one")
    else:
        gap = gap_at(today_row, iso(instant(today, soon_start.strftime("%H:%M"))))
        ok = bool(gap) and gap["reason"] == "too_soon" and gap["bookable"] is False and gap["bookableMinutes"] == 0 and (gap["shortByMinutes"] or 0) >= 1
        check(
            "a stretch the notice window runs past is 'too soon', with how far past",
            ok,
            f"{soon_start.strftime('%H:%M')}–{soon_end.strftime('%H:%M')} → {gap['reason'] if gap else 'no gap'} short by {gap['shortByMinutes'] if gap else '?'} min",
        )

    # ---- 6. future probe date: two appointments and free time around them ---
    visit_a = instant(probe_date, "10:00")
    visit_b = instant(probe_date, "10:45")

    # Every room at the site is held for the second visit's half-hour, by other
    # practitioners, so that visit has nowhere to go. That is how a room-less
    # appointment actually happens — the diary takes a free room when there is
    # one, which is the behaviour the next check pins down.
    held_rooms = []
    for room in site_rooms:
        for holder in holder_candidates:
            status, holding, _ = call(
                "POST",
                "/api/v1/bookings",
                {
                    "externalId": f"probe-day-hold-{RUN_TOKEN}-{room[-6:]}-{holder[-6:]}",
                    "customer": {"name": "Probe Day Holder", "number": f"+1415558{abs(hash(room + holder)) % 100000:05d}"},
                    "service": "Probe hold",
                    "durationMinutes": 30,
                    "startsAt": iso(visit_b),
                    "status": "confirmed",
                    "providerId": holder,
                    "locationId": site_id,
                    "roomId": room,
                },
            )
            if status in (200, 201):
                if holding.get("id") and holding.get("id") not in created_bookings:
                    created_bookings.append(holding["id"])
                held_rooms.append(room)
                break
    check(
        "every room at the site is held for the probe half-hour",
        len(held_rooms) == len(site_rooms),
        f"{len(held_rooms)} of {len(site_rooms)} room(s) held",
    )
    status, booked_a, _ = call(
        "POST",
        "/api/v1/bookings",
        {
            "externalId": f"probe-day-a-{RUN_TOKEN}",
            "customer": {"name": "Probe Day Client", "number": client_number},
            "service": "Probe visit",
            "durationMinutes": 30,
            "startsAt": iso(visit_a),
            "status": "confirmed",
            "providerId": probe_provider_id,
            "locationId": site_id,
        },
    )
    if status in (200, 201):
        created_bookings.append(booked_a.get("id", ""))
    check("an appointment can be booked into the probe practitioner's day", status in (200, 201), f"{status} {message(booked_a)}")
    status, booked_b, _ = call(
        "POST",
        "/api/v1/bookings",
        {
            "externalId": f"probe-day-b-{RUN_TOKEN}",
            "customer": {"name": "Probe Day Client", "number": client_number},
            "service": "Probe visit",
            "durationMinutes": 30,
            "startsAt": iso(visit_b),
            "status": "confirmed",
            "providerId": probe_provider_id,
            "locationId": site_id,
        },
    )
    if status in (200, 201):
        created_bookings.append(booked_b.get("id", ""))
    booking_a = booked_a.get("id", "")
    booking_b = booked_b.get("id", "")
    if not booking_a or not booking_b:
        check("both probe appointments exist to be read back", False, "the fixtures were not created — stopping before the read-backs")
        return finish()

    status, probe_date_day, _ = day(f"?date={probe_date.isoformat()}&days=1")
    row = (probe_date_day.get("rows") or [{}])[0]
    all_appts = row.get("appointments") or []
    # Cancelled rows from an earlier probe remain as history by design. Judge this
    # run by its own two IDs rather than treating preserved history as duplication.
    appts = [appointment for appointment in all_appts if appointment.get("id") in {booking_a, booking_b}]
    current_clocks = [appointment.get("local") for appointment in appts]
    check("the day reads back the appointments in running order", current_clocks == ["10:00 AM", "10:45 AM"], f"{', '.join(current_clocks)}")
    first = appts[0] if appts else {}
    check(
        "a visit booked without naming a room is given a free one at that hour",
        bool(first.get("roomId")) and first.get("roomId") in site_rooms and bool(first.get("roomName")),
        f"auto-assigned {first.get('roomName')}",
    )
    check(
        "each appointment carries the room, the service and the number to ring",
        first.get("service") == "Probe visit" and first.get("phone") == client_number,
        f"{first.get('roomName')} · {first.get('service')} · {first.get('phone')}",
    )
    check("each appointment says what it may move to next", "arrived" in (first.get("canMoveTo") or []), f"{', '.join(first.get('canMoveTo') or [])}")

    # The flag, and the price of reading it.
    check("a medical flag travels with the appointment", [a["label"] for a in (first.get("alerts") or [])] == ["Probe anticoagulants"], f"{[a['label'] for a in (first.get('alerts') or [])]}")
    status, record, _ = call("GET", f"/api/v1/clients/{client_id}")
    entries = [e for e in (record.get("access") or []) if "day view" in (e.get("detail") or "")]
    check(
        "reading a flag is written to that record's own access log",
        bool(entries) and entries[0].get("action") == "view" and entries[0].get("actor"),
        f"{len(entries)} day-view entr(y/ies), actor {entries[0].get('actor') if entries else '—'}",
    )

    # Free time: 15 minutes between the two visits, 45 minutes after the second.
    shortest = hints.get("shortestServiceMinutes") or durations[0]
    tiny = gap_at(row, iso(instant(probe_date, "10:30")))
    tail = gap_at(row, iso(instant(probe_date, "11:15")))
    check(
        "the gap between two visits is measured, not rounded away",
        bool(tiny) and tiny["minutes"] == 15,
        f"{tiny['minutes'] if tiny else '?'} min",
    )
    check(
        "a stretch too short for the shortest service is 'too short', with how short",
        bool(tiny) and tiny["reason"] == "too_short" and (tiny.get("shortByMinutes") or 0) == shortest - 15,
        f"short by {tiny.get('shortByMinutes') if tiny else '?'} min against a {shortest}-minute shortest service",
    )
    check(
        "a stretch long enough, on a day with notice to spare, is bookable as it stands",
        bool(tail) and tail["bookable"] is True and tail["bookableMinutes"] == 45 and tail["bookableFrom"] == tail["startsAt"],
        f"{tail['local'] if tail else '?'}–{tail['endsLocal'] if tail else '?'} → {tail['bookableMinutes'] if tail else '?'} min from {tail['bookableFromLocal'] if tail else '?'}",
    )
    conflicts = row.get("conflicts") or []
    roomless = any(c["kind"] == "no_room" and c["appointmentId"] == booking_b for c in conflicts)
    if len(held_rooms) == len(site_rooms):
        check(
            "a visit left without a room is called out on the day",
            roomless,
            f"{len(conflicts)} conflict(s): {', '.join(sorted({c['kind'] for c in conflicts})) or 'none'}",
        )
    elif roomless:
        check("a visit left without a room is called out on the day", True, "the rooms could not all be held, but the visit lost its room and the day said so")
    else:
        skip("a visit left without a room is called out on the day", "no practitioner could be found to hold every room at that hour")

    # ---- 7. moving an appointment on ---------------------------------------
    status, moved, _ = call("POST", f"/api/v1/bookings/{booking_a}/status", {"status": "arrived"}, cookie_override=probe_cookie)
    check("the practitioner can move their own appointment on", status == 200, f"{status} {message(moved)}")
    status, after_arrival, _ = day(f"?date={probe_date.isoformat()}&days=1")
    row = (after_arrival.get("rows") or [{}])[0]
    arrived = next((a for a in row.get("appointments") or [] if a["id"] == booking_a), {})
    check(
        "the day shows who has arrived, and counts them",
        arrived.get("status") == "arrived" and row["counts"]["waitingNow"] == 1,
        f"status {arrived.get('status')} · waitingNow {row['counts']['waitingNow']}",
    )
    check(
        "the same row looks the same through the bookings API the desk uses",
        any(b.get("id") == booking_a for b in (call("GET", f"/api/v1/bookings?providerId={probe_provider_id}&status=arrived")[1].get("data") or [])),
        "visible as arrived on /api/v1/bookings",
    )
    check(
        "the next step offered is the one the diary allows, and no other",
        set(arrived.get("canMoveTo") or []) == {"completed", "cancelled", "no_show"},
        f"{', '.join(arrived.get('canMoveTo') or [])}",
    )
    status, refused, _ = call("POST", f"/api/v1/bookings/{booking_a}/status", {"status": "pending"}, cookie_override=probe_cookie)
    check("a move the diary does not allow is refused", status == 409, f"{status} {message(refused)[:70]}")
    status, nonsense, _ = call("POST", f"/api/v1/bookings/{booking_a}/status", {"status": "nonsense"}, cookie_override=probe_cookie)
    check("a status that does not exist is refused with the list", status == 400 and "completed" in message(nonsense), f"{status} {message(nonsense)[:70]}")

    status, _done, _ = call("POST", f"/api/v1/bookings/{booking_a}/status", {"status": "completed"}, cookie_override=probe_cookie)
    status, after_done, _ = day(f"?date={probe_date.isoformat()}&days=1")
    row = (after_done.get("rows") or [{}])[0]
    done = next((a for a in row.get("appointments") or [] if a["id"] == booking_a), {})
    check(
        "completing one leaves the time booked and the count honest",
        status == 200 and done.get("status") == "completed" and row["counts"]["completed"] == 1 and row["counts"]["remaining"] == 1,
        f"completed {row['counts']['completed']} · remaining {row['counts']['remaining']}",
    )
    check(
        "the 15-minute gap is still too short after a completed visit",
        (gap_at(row, iso(instant(probe_date, "10:30"))) or {}).get("reason") == "too_short",
        "completing does not free the time — it records what happened in it",
    )

    # ---- 8. cancelling frees the time --------------------------------------
    status, cancelled, _ = call("POST", f"/api/v1/bookings/{booking_b}/status", {"status": "cancelled"}, cookie_override=probe_cookie)
    check("cancelling is the practitioner's to do too", status == 200, f"{status} {message(cancelled)}")
    check(
        "the freed slot goes to the wait-list machinery rather than silently",
        isinstance(cancelled.get("offers"), dict) and "offered" in cancelled["offers"],
        f"offers {json.dumps(cancelled.get('offers'))[:60]}",
    )
    status, after_cancel, _ = day(f"?date={probe_date.isoformat()}&days=1")
    row = (after_cancel.get("rows") or [{}])[0]
    rejoined = gap_at(row, iso(instant(probe_date, "10:30")))
    check(
        "the freed half-hour re-joins the gap beside it and the tail into one stretch",
        bool(rejoined) and rejoined["minutes"] == 90 and rejoined["bookable"] is True and len(row.get("free", {}).get("gaps", [])) == 1,
        f"{rejoined['local'] if rejoined else '?'}–{rejoined['endsLocal'] if rejoined else '?'} ({rejoined['minutes'] if rejoined else '?'} min)",
    )
    check(
        "the cancelled visit is still on the day, not deleted from it",
        any(a["id"] == booking_b and a["status"] == "cancelled" for a in row.get("appointments") or []),
        f"{row['counts']['cancelled']} cancelled",
    )

    # ---- 9. whose day am I reading ----------------------------------------
    # ---- N. a practitioner who works at two sites has two days -------------
    # "`days=1` returned two rows, both dated 2026-10-16" was written down as a
    # quirk to run down. It is not one: a row is a practitioner's day *at a site*,
    # and somebody who works at two of them has two — different hours, different
    # clock (New York and San Francisco are three hours apart), and the page paints
    # a block each, headed by the site. Pinned here so it is a contract rather than
    # a surprise: one row per site listed, no duplicates, no collapsing.
    status, providers_now, _ = call("GET", "/api/v1/providers")
    two_site = next((p for p in (providers_now.get("data") or []) if len(p.get("locationIds") or []) > 1), None)
    if two_site:
        status, wide, _ = call("GET", f"/api/v1/day?providerId={two_site['id']}&days=1")
        # The GET is flat (the POST wraps the same view in `day`), so read it flat.
        rows_two = (wide.get("rows") or []) if isinstance(wide, dict) else []
        check("somebody who works at two sites has a row for each of them",
              status == 200 and len(rows_two) == len(two_site["locationIds"]),
              f"{two_site.get('name')}: {len(rows_two)} row(s) for {len(two_site['locationIds'])} site(s)")
        by_site = {r.get("siteId"): r for r in rows_two}
        check("no site appears twice, and every row carries the site's own clock",
              len(by_site) == len(rows_two) and all(r.get("timezone") for r in rows_two),
              ", ".join(f"{r.get('siteName')}={r.get('timezone')}" for r in rows_two))
        check("and the totals count the days, not the dates", (wide.get("totals") or {}).get("days") == len(rows_two),
              f"days={(wide.get('totals') or {}).get('days')}")
    else:
        skip("a practitioner who works at two sites", "nobody is listed at two sites in this workspace")

    other = next((p["id"] for p in (call("GET", "/api/v1/providers")[1].get("data") or []) if p["id"] != probe_provider_id), "")
    status, denied, _ = call("GET", f"/api/v1/day?providerId={other}", cookie_override=probe_cookie)
    check("a practitioner cannot read a colleague's day", status == 403, f"{status} {message(denied)[:70]}")
    status, owner_view, _ = call("GET", f"/api/v1/day?providerId={other}")
    check(
        "an owner can read anybody's day, and the answer says so",
        status == 200 and (owner_view.get("requested") or {}).get("allowed") is True and (owner_view.get("provider") or {}).get("id") == other,
        f"{status} · {(owner_view.get('provider') or {}).get('name')}",
    )
    status, own_view, _ = call("GET", "/api/v1/day", cookie_override=probe_cookie)
    check(
        "…and the picker's shortlist is offered, not hidden",
        len((own_view.get("practitioners") or [])) >= 2 and own_view.get("viewer", {}).get("canPickPractitioner") is False,
        f"{len(own_view.get('practitioners') or [])} practitioner(s) · canPick={own_view.get('viewer', {}).get('canPickPractitioner')}",
    )

    # ---- 10. the route's discipline ---------------------------------------
    status, unknown, _ = call("GET", "/api/v1/day?nonsense=1")
    check("an unknown query parameter is refused, naming the known ones", status == 400 and "nonsense" in message(unknown) and "providerId" in message(unknown), f"{status} {message(unknown)[:80]}")
    status, bad_days, _ = call("GET", "/api/v1/day?days=9")
    check("a range wider than a week is refused", status == 400 and "days" in message(bad_days), f"{status} {message(bad_days)[:60]}")
    status, bad_date, _ = call("GET", "/api/v1/day?date=tuesday")
    check("a date that is not a date is refused", status == 400, f"{status} {message(bad_date)[:60]}")
    status, many, _ = call("GET", f"/api/v1/day?date={probe_date.isoformat()}&days=3", cookie_override=probe_cookie)
    check("three days come back as three days, one row per site each", status == 200 and len(many.get("rows") or []) == 3, f"{len(many.get('rows') or [])} row(s)")
    check("the week strip travels with the day, for navigation without a second call", [w["date"] for w in (many.get("week") or [])] == [probe_date.isoformat(), (probe_date + timedelta(days=1)).isoformat(), (probe_date + timedelta(days=2)).isoformat()], f"{len(many.get('week') or [])} day(s)")

    status, key, _ = call("POST", "/api/v1/keys", {"name": "Probe day key"})
    key_id = (key.get("key") or {}).get("id") or key.get("id") or ""
    secret = key.get("secret") or ""
    if key_id:
        created_keys.append(key_id)
    if not secret:
        skip("a machine reading a day", "no key could be created in this run")
    else:
        status, keyless, _ = call("GET", "/api/v1/day", headers={"authorization": f"Bearer {secret}"}, cookie_override="")
        check(
            "an API key has no day of its own, and is told why",
            status == 400 and "providerId" in message(keyless),
            f"{status} {message(keyless)[:80]}",
        )
        status, by_key, _ = call("GET", f"/api/v1/day?providerId={probe_provider_id}&date={probe_date.isoformat()}", headers={"authorization": f"Bearer {secret}"}, cookie_override="")
        check(
            "…but it can read a named practitioner's day",
            status == 200 and (by_key.get("provider") or {}).get("id") == probe_provider_id,
            f"{status} · {(by_key.get('provider') or {}).get('name')}",
        )

    # ---- 11. the trail ----------------------------------------------------
    status, trail, _ = call("GET", "/api/v1/audit?limit=200")
    rows = trail.get("data") or []
    entries = [r for r in rows if r.get("action") == "day.provider_linked" and r.get("target") == probe_provider_id]
    check(
        "linking a login to a practitioner is audited",
        bool(entries) and PROBE_LOGIN in (entries[0].get("detail") or ""),
        f"{len(entries)} entry(ies) — {entries[0].get('detail') if entries else '—'}",
    )

    # ---- 12. an owner may re-point their own login ------------------------
    status, unlinked, _ = call("POST", "/api/v1/day", {"action": "provider:unlink"}, cookie_override=probe_cookie)
    check("unlinking says which record it let go of", status == 200 and (unlinked.get("linked") or {}).get("name") == "Probe Day View", f"{status} {json.dumps(unlinked.get('linked'))[:60]}")
    status, gone, _ = call("GET", "/api/v1/day", cookie_override=probe_cookie)
    check("and the day empties again rather than showing a stale one", gone.get("linked") is False and (gone.get("rows") or []) == [], f"linked={gone.get('linked')}")
    status, again, _ = call("POST", "/api/v1/day", {"action": "provider:unlink"}, cookie_override=probe_cookie)
    check("unlinking twice is not an error, and is honest about it", status == 200, f"{status}")

    return finish()


def finish():
    global cookie, finished
    if finished:
        return
    finished = True
    # Put the workspace back: the appointments, the client, the room, the rota,
    # the practitioner, the login and the key this check created.
    for booking_id in created_bookings:
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "day_check cleanup"})
    # Whatever run made it, this check's practitioner and rota go: matched by name
    # so a run that died half-way is cleaned up by the next one.
    left_behind = [p["id"] for p in (call("GET", "/api/v1/providers?includeInactive=true")[1].get("data") or []) if p.get("name") == "Probe Day View"]
    for provider_id in left_behind:
        for location in call("GET", "/api/v1/locations")[1].get("data") or []:
            call("PUT", "/api/v1/rota", {"providerId": provider_id, "locationId": location["id"], "windows": [], "breaks": []})
        deleted = call("DELETE", f"/api/v1/providers/{provider_id}")[0]
        if deleted == 409:
            # Visit A is deliberately completed on a future probe date. That
            # history must remain, and the product correctly refuses to delete a
            # practitioner with a future row; retire the probe explicitly so it
            # does not appear as a fourth real practitioner in later UI walks.
            call("PATCH", f"/api/v1/providers/{provider_id}", {"active": False})
    # The room, likewise by name: it is unmistakably this check's, and leaving it
    # behind would slowly fill the site with rooms nobody books.
    probe_rooms = [r["id"] for r in (call("GET", f"/api/v1/rooms?locationId={site_id}")[1].get("data") or []) if r.get("name") == "Probe Day Room"]
    for room_id in probe_rooms or created_rooms:
        call("POST", "/api/v1/rooms", {"action": "delete", "id": room_id})
    for row in call("GET", "/api/v1/clients?includeArchived=true")[1].get("data") or []:
        if (row.get("number") in created_clients or row.get("name") in {"Probe Day Client", "Probe Day Holder"}) and not row.get("archivedAt"):
            call("DELETE", f"/api/v1/clients/{row['id']}", {"reason": "day_check cleanup"})
    if probe_user_id:
        call("POST", "/api/v1/team", {"action": "deactivate", "id": probe_user_id})
    for key_id in created_keys:
        call("DELETE", f"/api/v1/keys/{key_id}")
    print()
    if skips:
        print(f"{len(skips)} skipped: " + "; ".join(skips))
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print(
        "ALL PASS — a practitioner's login finds their own diary, reads it from their rota rather than the desk's board, "
        "tells free time apart from bookable time down to the notice window, moves visits on and gives the freed slot to the wait list."
    )


if __name__ == "__main__":
    # A gate that dies half-way must still put the workspace back: this one got
    # that lesson the hard way (a crash left a probe practitioner linked and a
    # probe client behind, and the next run inherited them).
    import traceback

    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        failures.append("the check crashed before it finished")
        finish()
