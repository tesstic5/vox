#!/usr/bin/env python3
"""
Demo story check (PRACTICE.md phase P9 — demo coherence + usability).

The screens are honest, so the *data* behind them is what has to hold up. This
script opens the demo workspace the way a clinic owner would and refuses to
accept a workspace that reads as empty, thin or impossible:

   1.  today is alive: the calendar has visits and their lifecycle agrees with
       the clock — upcoming work stays open, while a finished day may be closed
   2.  both sites are real: there are visits at each, the diary offers both, and
       filtering to one never returns the other
   3.  the rota is the law: a sample of appointments sits inside the hours the
       practitioner actually works at that site — never on a closed day, never
       during the lunch break
   4.  a room holds one visit at a time: no two live appointments overlap in the
       same room
   5.  every working visit names a person and a job — nothing 'Unassigned'
   6.  the money has a rhythm: invoices across the window, most settled, revenue
       attributed to named practitioners
   7.  attendance has a denominator big enough to mean something
   8.  attribution is a comparison, not a single bar
   9.  utilisation is real: the practitioners are busy, but not robots

Run it with the app up:

    python3 scripts/demo_check.py
"""

import json
import os
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
# The demo workspace's public booking page — the address the seeder's clients use.
SLUG = os.environ.get("VOXERA_SLUG", "northwind-labs")

cookie = ""
failures: list[str] = []
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, raw=False):
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


def minutes(clock: str) -> int:
    """'08:30' or '8:30 AM' → minutes past midnight."""
    text = str(clock).strip().lower().replace(".", "")
    ampm = text[-2:] if text[-2:] in ("am", "pm") else ""
    if ampm:
        text = text[:-2].strip()
    parts = text.split(":")
    hours = int(parts[0])
    mins = int(parts[1]) if len(parts) > 1 else 0
    if ampm == "pm" and hours != 12:
        hours += 12
    if ampm == "am" and hours == 12:
        hours = 0
    return hours * 60 + mins


def local_parts(iso: str, tz: str):
    """The wall clock a site sees for an instant, plus that day's weekday."""
    at = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    # Python can only render a named zone through the IANA database; the demo's
    # two zones come back from the API itself, so this needs no extra dependency.
    import zoneinfo

    local = at.astimezone(zoneinfo.ZoneInfo(tz))
    return local.strftime("%H:%M"), WEEKDAYS[local.weekday()], local.date().isoformat()


def main():
    global cookie
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("sign in as the owner", bool(cookie), "session cookie" if cookie else "no session")
    if not cookie:
        return finish()

    today = datetime.now(timezone.utc).date()
    _, locations, _ = call("GET", "/api/v1/locations")
    sites = {loc["id"]: loc for loc in (locations.get("data") or [])}
    check("the workspace is a two-site practice", len(sites) == 2, ", ".join(s["name"] for s in sites.values()))

    # ---- 1. today is alive ---------------------------------------------------
    status, diary, _ = call("GET", "/api/v1/diary?view=day")
    today_row = (diary.get("days") or [{}])[0]
    todays = today_row.get("appointments") or []
    statuses = {a.get("status") for a in todays}
    check("today's diary has a day in it", status == 200 and len(todays) >= 5, f"{len(todays)} visit(s) on {today_row.get('date')}")
    now = datetime.now(timezone.utc)
    open_statuses = {"confirmed", "pending", "arrived"}
    closed_statuses = {"completed", "no_show", "cancelled"}
    remaining = []
    for appointment in todays:
        try:
            starts_at = datetime.fromisoformat(str(appointment.get("startsAt", "")).replace("Z", "+00:00"))
            ends_at = starts_at + timedelta(minutes=int(appointment.get("durationMinutes") or 30))
        except (TypeError, ValueError):
            continue
        if appointment.get("status") != "cancelled" and ends_at > now:
            remaining.append(appointment)
    lifecycle_ok = (
        any(appointment.get("status") in open_statuses for appointment in remaining)
        if remaining
        else bool(statuses) and statuses <= closed_statuses and "completed" in statuses
    )
    check(
        "today's visit lifecycle agrees with the clock",
        lifecycle_ok,
        f"{len(remaining)} still due · " + (", ".join(sorted(statuses)) or "nothing scheduled"),
    )
    # The demo's sites are on US clocks, so "today" there may legitimately still be
    # before opening time. What has to be true either way is that a *finished* day
    # exists with a real shape: visits that happened and a few that did not.
    finished_day = None
    # A month back, not five days: the seeded month ages in real time and the
    # suite writes cancellations all over its recent days, so the nearest day
    # with three closed visits can be a day the gates emptied (33 cancelled,
    # none completed) while a genuinely finished seeded day sits a week
    # further back. The month check below already reads it this way.
    for offset in range(1, 32):
        date = (today - timedelta(days=offset)).isoformat()
        _, past, _ = call("GET", f"/api/v1/diary?view=day&from={date}")
        row = (past.get("days") or [{}])[0]
        visits = row.get("appointments") or []
        closed = [a for a in visits if a.get("status") in ("completed", "no_show", "cancelled")]
        # A finished day means visits *happened*: three closures that are all
        # cancellations is a day the suite emptied, not a day that occurred.
        if len(closed) >= 3 and any(a.get("status") == "completed" for a in closed):
            finished_day = (date, visits, closed)
            break
    check(
        "the most recent finished day reads like a day that happened",
        bool(finished_day) and any(a.get("status") == "completed" for a in finished_day[2]),
        f"{len(finished_day[2])} closed visit(s) on {finished_day[0]}" if finished_day else "no finished day found in the last five",
    )
    # ---- and the month behind it reads like a month that happened -----------
    #
    # This is measured over the *seeded history*, not over the most recent day.
    # The last day or two belong to whoever last ran the suite: the gates book,
    # move, cancel and settle real rows on today and tomorrow, so a single run
    # leaves a day carrying a hundred settled probes, most of them cancellations.
    # Judging the workspace on that day reads as "nobody turned up" when what
    # happened is "the checks were here". The demo's claim — a practice that has
    # been running for a month, and most people turn up — is a claim about the
    # month, so take the last thirty finished days and skip the two the suite can
    # write to.
    seeded_closed = []
    for offset in range(3, 31):
        date = (today - timedelta(days=offset)).isoformat()
        _, past, _ = call("GET", f"/api/v1/diary?view=day&from={date}")
        for row in past.get("days") or []:
            for visit in row.get("appointments") or []:
                # Verification gates also create historical rows, then cancel
                # them during cleanup. Judge the demo on rows the demo seeder
                # owns, not on probe history that happens to share its dates.
                metadata = visit.get("metadata") or {}
                demo_owned = metadata.get("demoDiary") == "demo-diary-v1" or visit.get("source") == "seed"
                if demo_owned and visit.get("status") in ("completed", "no_show", "cancelled"):
                    seeded_closed.append(visit)
    attended_all = [a for a in seeded_closed if a.get("status") == "completed"]
    check(
        "the month behind the diary reads like a month that happened",
        len(seeded_closed) >= 40,
        f"{len(seeded_closed)} settled visit(s) in the last thirty finished days",
    )
    if seeded_closed:
        share = len(attended_all) / len(seeded_closed)
        check(
            "and most of it turned up",
            share >= 0.6,
            f"{len(attended_all)} of {len(seeded_closed)} attended ({share * 100:.0f}%) over the seeded month",
        )

    # ---- 2. both sites are real ---------------------------------------------
    _, all_bookings, _ = call("GET", "/api/v1/bookings?limit=500")
    rows = all_bookings.get("data") or []
    check("the bookings API returns the workspace's diary", len(rows) >= 100, f"{len(rows)} appointment(s)")
    by_site = defaultdict(int)
    for row in rows:
        by_site[row.get("locationId")] += 1
    check(
        "both sites have appointments",
        all(by_site.get(sid, 0) >= 20 for sid in sites),
        " · ".join(f"{sites[sid]['name']}: {by_site.get(sid, 0)}" for sid in sites),
    )
    _, diary_week, _ = call("GET", "/api/v1/diary?view=workweek")
    offered = {s["id"] for s in (diary_week.get("sites") or [])}
    check("the diary offers both sites", offered == set(sites), ", ".join(s["name"] for s in (diary_week.get("sites") or [])))
    for sid, site in sites.items():
        _, only, _ = call("GET", f"/api/v1/diary?view=workweek&locationId={sid}")
        leaked = [a for day in (only.get("days") or []) for a in (day.get("appointments") or []) if a.get("locationId") != sid]
        check(f"filtering to {site['name']} returns only that site", not leaked, f"{len(leaked)} leak(s)")

    # ---- 3. the rota is the law ---------------------------------------------
    rotas = {}
    for provider_id in {(r.get("providerId") or "") for r in rows} - {""}:
        _, rota, _ = call("GET", f"/api/v1/rota?providerId={provider_id}")
        rotas[provider_id] = rota.get("data") or rota.get("rotas") or []
    _, changes, _ = call("GET", "/api/v1/rota-changes")
    closed_days = {
        (c.get("providerId"), c.get("date")) for c in (changes.get("data") or []) if c.get("kind") == "off"
    }

    sample = [r for r in rows if r.get("locationId") and r.get("providerId") and r.get("status") != "cancelled"]
    sample = sample[:: max(1, len(sample) // 40)][:40]
    outside, on_break, off_day = [], [], []
    for row in sample:
        site = sites.get(row["locationId"])
        clock, weekday, _ = local_parts(str(row["startsAt"]), site["timezone"])
        rows_for = rotas.get(row["providerId"]) or []
        windows = [w for r in rows_for if r.get("locationId") == row["locationId"] for w in (r.get("windows") or [])]
        breaks = [b for r in rows_for if r.get("locationId") == row["locationId"] for b in (r.get("breaks") or [])]
        index = WEEKDAYS.index(weekday) + 1
        day_windows = [w for w in windows if int(w.get("weekday", 0)) == index]
        at = minutes(clock)
        if (row["providerId"], datetime.fromisoformat(str(row["startsAt"]).replace("Z", "+00:00")).date().isoformat()) in closed_days:
            off_day.append(f"{clock} {weekday}")
            continue
        if not day_windows:
            off_day.append(f"{clock} {weekday}")
            continue
        if not any(minutes(w["start"]) <= at < minutes(w["end"]) for w in day_windows):
            outside.append(f"{clock} {weekday} ({site['name'].split('—')[0].strip()})")
        elif any(minutes(b["start"]) <= at < minutes(b["end"]) for b in breaks):
            on_break.append(f"{clock} {weekday}")
    check("every sampled visit is inside the practitioner's hours", not outside and not off_day, "; ".join((outside + off_day)[:3]) or f"{len(sample)} checked")
    check("nobody is booked during their lunch break", not on_break, "; ".join(on_break[:3]) or f"{len(sample)} checked")

    # ---- 4. a room holds one visit at a time --------------------------------
    overlaps = []
    by_room = defaultdict(list)
    for row in rows:
        if row.get("roomId") and row.get("status") not in ("cancelled",):
            by_room[row["roomId"]].append(row)
    for room_id, booked in by_room.items():
        ordered = sorted(booked, key=lambda b: str(b["startsAt"]))
        for i in range(1, len(ordered)):
            prev, now = ordered[i - 1], ordered[i]
            prev_end = datetime.fromisoformat(str(prev["startsAt"]).replace("Z", "+00:00")) + timedelta(
                minutes=int(prev.get("durationMinutes") or 30)
            )
            if datetime.fromisoformat(str(now["startsAt"]).replace("Z", "+00:00")) < prev_end:
                overlaps.append(f"{room_id} {str(now['startsAt'])[:16]}")
    check("no room holds two visits at once", not overlaps, "; ".join(overlaps[:3]) or f"{len(by_room)} room(s) checked")
    # Judge the seeded practice story, not old conflict/report fixtures that the
    # verification suite intentionally keeps as cancelled or imported history.
    # Those client-API mirrors may legitimately predate room setup; the demo rows
    # are explicitly marked by the seeder and are the claim this gate is making.
    story_rows = [
        row for row in rows
        if (row.get("metadata") or {}).get("demoDiary") == "demo-diary-v1" or row.get("source") == "seed"
    ]
    roomed = sum(1 for row in story_rows if row.get("roomId"))
    check("most seeded visits know which room they are in", bool(story_rows) and roomed >= len(story_rows) * 0.8, f"{roomed} of {len(story_rows)} seeded visits")

    # ---- 5. every visit names a person and a job ----------------------------
    window_from = (today - timedelta(days=30)).isoformat()
    recent = [
        r
        for r in rows
        if window_from <= str(r.get("startsAt"))[:10] <= today.isoformat()
    ]
    unnamed = [r for r in recent if not r.get("providerId") or not r.get("serviceId")]
    check(
        "every appointment in the last 30 days names a practitioner and a service",
        not unnamed,
        f"{len(unnamed)} of {len(recent)} unattributed",
    )

    # ---- 6. the money has a rhythm ------------------------------------------
    _, revenue, _ = call("GET", "/api/v1/reports?view=revenue&preset=30d")
    provider_rows = revenue.get("byProvider") or []
    collected = sum(int(r.get("collectedMinor") or 0) for r in provider_rows)
    invoiced = sum(int(r.get("invoicedMinor") or 0) for r in provider_rows)
    check("the practice has billed work in the last 30 days", invoiced > 0, f"{invoiced / 100:,.2f}")
    check("and collected most of it", 0 < collected <= invoiced and collected >= invoiced * 0.4, f"{collected / 100:,.2f} of {invoiced / 100:,.2f}")
    named = [r for r in provider_rows if str(r.get("name", "")).lower() not in ("unassigned", "unknown", "")]
    unknown = [r for r in provider_rows if str(r.get("name", "")).lower() in ("unassigned", "unknown", "")]
    unknown_share = (
        sum(int(r.get("invoicedMinor") or 0) for r in unknown) / invoiced * 100 if invoiced else 0
    )
    check("revenue is attributed to named practitioners", len(named) >= 2, ", ".join(f"{r.get('name')}" for r in named) or "nobody")
    check(
        "nothing is filed under Unassigned except a sprinkle",
        unknown_share <= 2,
        f"{unknown_share:.2f}% unassigned" if unknown_share else "nothing unassigned",
    )
    # Named practitioners only: the Unassigned row can pick up money from a
    # probe invoice the other checks leave behind, and that is not this
    # workspace's story to tell. Its size is bounded by the check above.
    check(
        "and every named practitioner's row counts their appointments",
        all(int(r.get("appointments") or 0) > 0 for r in named if int(r.get("invoicedMinor") or 0) > 0),
        ", ".join(f"{r.get('name')} {r.get('appointments')}" for r in named) or "no rows",
    )

    # ---- 7. attendance means something --------------------------------------
    _, attendance, _ = call("GET", "/api/v1/reports?view=attendance&preset=30d")
    considered = len(attendance.get("considered") or []) if isinstance(attendance.get("considered"), list) else int(attendance.get("considered") or 0)
    rate = float(attendance.get("noShowRatePct") or 0)
    check("attendance has a denominator worth reading", considered >= 40, f"{considered} kept-or-missed")
    check("the no-show rate is plausible", 0 <= rate <= 40, f"{rate}% of {considered}")

    # ---- 8. attribution is a comparison -------------------------------------
    _, attribution, _ = call("GET", "/api/v1/reports?view=attribution&preset=30d")
    sources = [r for r in (attribution.get("bySource") or []) if int(r.get("bookings") or 0) > 0]
    check("bookings arrive from more than one place", len(sources) >= 3, ", ".join(f"{r.get('label')} {r.get('bookings')}" for r in sources))

    # ---- 9. the guidance tells the truth ------------------------------------
    # The dashboard's practice checklist (and the calendar's empty state) are the
    # first thing a clinic sees. A step that says "done" has to be backed by a row
    # that exists, and every step has to say where to go and what the button does
    # — otherwise the guidance is decoration.
    status, onboarding, _ = call("GET", "/api/v1/onboarding")
    practice = onboarding.get("practice") or {}
    steps = {step["id"]: step for step in (practice.get("steps") or [])}
    check("the practice checklist is there for a new owner", status == 200 and len(steps) >= 5, f"{len(steps)} step(s), {practice.get('done')}/{practice.get('total')} done")
    check(
        "every step says what to do, why, and where",
        all(step.get("title") and step.get("why") and step.get("action") and str(step.get("href", "")).startswith("/dashboard") for step in steps.values()),
        ", ".join(sorted(steps)),
    )
    _, services_now, _ = call("GET", "/api/v1/services")
    _, providers_now, _ = call("GET", "/api/v1/providers")
    _, rota_now, _ = call("GET", "/api/v1/rota")
    _, rooms_now, _ = call("GET", "/api/v1/rooms")
    _, team_now, _ = call("GET", "/api/v1/team?view=members")
    truth = {
        "services": len(services_now.get("data") or []) > 0,
        "people": len(providers_now.get("data") or []) > 0,
        "hours": len(rota_now.get("data") or []) > 0,
        "rooms": len(rooms_now.get("data") or []) > 0,
        "desk": len(team_now.get("members") or []) > 1,
        "first-visit": len(rows) > 0,
    }
    disagree = [key for key, real in truth.items() if key in steps and bool(steps[key].get("done")) != real]
    check(
        "the checklist ticks only what the workspace really has",
        not disagree,
        "every step agrees with its own records" if not disagree else ", ".join(f"{key} says {steps[key].get('done')} but the record says {truth[key]}" for key in disagree),
    )

    # ---- 10. the classes are on the diary, not just in the code --------------
    #
    # A8 shipped classes and the demo did not run a single one: the public page
    # had no class card, the desk's class list was empty, and the utilisation
    # figure was computed as though a group session were eight separate hours of
    # one practitioner's day. The seeder now puts two standing classes a week on
    # and seats real clients in them, so this section holds it to that.
    _, classes, _ = call("GET", "/api/v1/classes")
    sessions = classes.get("sessions") or []
    upcoming = [s for s in sessions if s.get("status") == "scheduled"]
    check("the demo practice runs classes", len(upcoming) >= 2, f"{len(upcoming)} upcoming session(s) of {len(sessions)}")
    seated = [s for s in upcoming if int(s.get("seats") or 0) > 0]
    check("and people are in them", len(seated) >= 1, ", ".join(f"{s['serviceName']} {s['local']['start']} {s['seats']}/{s['capacity']}" for s in seated[:3]))
    check(
        "every session names its instructor, its site and a room",
        all(s.get("providerName") and s.get("locationName") and s.get("roomName") for s in upcoming),
        ", ".join(str(s.get("roomName")) for s in upcoming[:3]),
    )

    # The register's numbers, on the demo's own class: places held and places free
    # must agree with the session, and nobody is marked as having arrived before
    # the class has happened.
    _, detail, _ = call("GET", f"/api/v1/classes/{upcoming[0]['id']}")
    att = detail.get("attendance") or {}
    check(
        "the roster counts the demo class's places, and nobody is here before the day",
        att.get("seats") == upcoming[0]["seats"] and att.get("free") == upcoming[0]["seatsLeft"] and att.get("attended") == 0,
        json.dumps(att),
    )

    _, page, _ = call("GET", f"/api/public/workspaces/{SLUG}/booking")
    # The queue, in the demo a visitor actually opens: a class that is full with
    # somebody in line behind it, shown as a queue on the public page and readable
    # on the desk's roster — positions and names, not just a number.
    full = [s for s in upcoming if int(s.get("waiting") or 0) > 0]
    check(
        "the demo has a full class with somebody in line",
        bool(full),
        ", ".join(f"{s['serviceName']} {s['local']['start']} {s['seats']}/{s['capacity']} · {s.get('waiting')} waiting" for s in full[:2]) or "no class has a queue",
    )
    if full:
        _, queue_detail, _ = call("GET", f"/api/v1/classes/{full[0]['id']}")
        wait_list = queue_detail.get("waitList") or {}
        waiting_rows = wait_list.get("waiting") or []
        check(
            "and the line is names in an order, not a count",
            wait_list.get("count") == len(waiting_rows) and bool(waiting_rows) and waiting_rows[0].get("position") == 1 and bool(waiting_rows[0].get("name")),
            f"{wait_list.get('count')} in line: {[w.get('name') for w in waiting_rows][:3]}",
        )

    check("the public page sells places in them", len(page.get("classes") or []) >= 1, f"{len(page.get('classes') or [])} class(es) offered")
    offered = (page.get("classes") or [None])[0]
    full_ids = {s["id"] for s in full}
    queued_public = [c for c in (page.get("classes") or []) if c.get("sessionId") in full_ids]
    check(
        "and a full class is offered as a queue rather than hidden",
        bool(queued_public) and all(c.get("seatsLeft") == 0 and c.get("full") is True for c in queued_public),
        f"{[(c.get('serviceName'), c.get('seatsLeft'), c.get('full')) for c in queued_public]}",
    )
    if offered:
        check(
            "with the places left said out loud",
            isinstance(offered.get("seatsLeft"), int) and "roster" not in json.dumps(offered),
            f"{offered.get('serviceName')} — {offered.get('seatsLeft')} left, no names of who is in it",
        )

    # The day view's arithmetic has to agree: a seat is a person, not an hour.
    # Walked day by day (the endpoint takes `date` plus `days=1`), on the days the
    # classes actually fall, and asserted as an equality — a class row whose
    # minutes include its seats is wrong by exactly the seats' minutes.
    class_days = sorted({s["local"]["date"] for s in upcoming})
    with_seats: list[tuple[str, str, int, int]] = []
    mismatched: list[str] = []
    for date in class_days[:2]:
        for session in [s for s in upcoming if s["local"]["date"] == date][:1]:
            _, day, _ = call("GET", f"/api/v1/day?date={date}&days=1&providerId={session['providerId']}")
            for row in day.get("rows") or []:
                appointments = row.get("appointments") or []
                seats = [a for a in appointments if a.get("sessionId")]
                if not seats:
                    continue
                expected = sum(a["durationMinutes"] for a in appointments if a.get("status") != "cancelled" and not a.get("sessionId"))
                with_seats.append((date, str(row.get("siteName")), len(seats), int(row.get("bookedMinutes") or 0)))
                if int(row.get("bookedMinutes") or 0) != expected:
                    mismatched.append(f"{date} {row.get('siteName')}: booked {row.get('bookedMinutes')} vs {expected} without the seats")
    check("a class day is on the practitioner's day view at all", bool(with_seats), f"checked {len(class_days)} class day(s)")
    check(
        "a class seat is not counted as an hour of the practitioner's day",
        bool(with_seats) and not mismatched,
        "; ".join(mismatched) if mismatched else ", ".join(f"{d} {site}: {n} seat(s), {m} booked minute(s)" for d, site, n, m in with_seats[:3]),
    )

    # ---- 11. utilisation is real --------------------------------------------
    _, utilisation, _ = call("GET", "/api/v1/reports?view=utilisation&preset=30d")
    ratios = []
    for row in utilisation.get("rows") or []:
        # A per-practitioner share of the whole window, not of their own rota:
        # they work five days in seven, so a "60% utilised" day staff reads as 43%
        # here. What matters is that the number is real and not a flat zero.
        share = float(row.get("utilisationPct") or 0)
        if int(row.get("capacityMinutes") or 0):
            ratios.append(share)
    check("every practitioner has rota hours in the window", len(ratios) >= 2, f"{len(ratios)} with capacity")
    check("the diary is busy but not full", ratios and all(10 <= r <= 90 for r in ratios), ", ".join(f"{r}%" for r in ratios))

    return finish()


def finish():
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — the demo reads as a practice that has been running for a month: two sites, a live diary, legal hours, single-occupancy rooms, and books with money in them.")


if __name__ == "__main__":
    main()
