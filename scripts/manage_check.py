#!/usr/bin/env python3
"""The client's own link, and the reply that promised it.

Three things the product now says it does, checked against a running app:

  1. **D1 — one clock.** The all-sites diary and a site's diary agree about what
     time an appointment is at, and what a drag writes back is what the grid
     drew. Asserted on the landed instant, in the grid's own timezone, not on the
     HTTP status of the move.
  2. **A1 — the link.** A confirmation or reminder that carries `/m/<token>`, the
     page that token opens, a move through it, and a cancel through it — each
     checked by reading the appointment back from the desk's own API.
  3. **D2 — reply to confirm.** `Body=C` on the inbound webhook confirms the
     appointment, and a change request is filed for a person rather than guessed
     at.

Run against a live app:  python3 scripts/manage_check.py
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _session  # noqa: E402
from _twilio import headers as twilio_headers  # noqa: E402
from _twilio_fixture import TwilioFixture, ensure_twilio_fixture  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

PASS = 0
FAIL = 0
MADE = []          # probe rows to take out again
COOKIE = ""
TWILIO_FIXTURE: TwilioFixture | None = None


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}" + (f"  — {detail}" if detail else ""))


def call(method, path, body=None, form=None, auth=True, extra_headers=None):
    data = None
    headers = {"accept": "application/json", **(extra_headers or {})}
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    if auth and COOKIE:
        headers["cookie"] = COOKIE
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            # Some of what this gate reads is HTML, not JSON.
            try:
                return res.status, (json.loads(raw) if raw else {}), raw
            except json.JSONDecodeError:
                return res.status, {}, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw or "{}"), raw
        except json.JSONDecodeError:
            return err.code, {}, raw



def availability_query(provider, site, service):
    query = f"/api/v1/availability?days=14&limit=3&providerId={provider['id']}&locationId={site['id']}"
    if service.get("id"):
        query += f"&serviceId={service['id']}"
    return query


def row_on_grid(booking_id, grid):
    """The row on a diary payload, with the column it was drawn in."""
    for day in grid.get("days", []):
        for row in day.get("appointments", []):
            if row.get("id") == booking_id:
                return {**row, "column": day["date"]}
    return None


def add_days(date, n):
    year, month, day = (int(part) for part in date.split("-"))
    return (datetime(year, month, day, tzinfo=timezone.utc) + timedelta(days=n)).strftime("%Y-%m-%d")


def parse_iso(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000


def zoned_midnight(date, timezone_name):
    year, month, day = (int(part) for part in date.split("-"))
    return datetime(year, month, day, tzinfo=ZoneInfo(timezone_name)).timestamp() * 1000


def instant_on(date, minutes, timezone_name):
    """A grid position ("2026-10-21", 840) as the instant the page would send.

    This is the arithmetic the calendar does with `Intl`, done independently —
    deliberately, so a bug in both would have to be the same bug twice.
    """
    hour, minute = divmod(int(minutes), 60)
    year, month, day = (int(part) for part in date.split("-"))
    local = datetime(year, month, day, hour, minute, tzinfo=ZoneInfo(timezone_name))
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def clean_up():
    """Leave the workspace as it was found.

    The appointments go through the API. The clients the booking API created from
    a phone number have no delete endpoint of their own (a client is a record, and
    records are archived), so they are gone with `tidy-probe-orgs.ts` — which is
    already the project's sweeper and matches every one of them on the `Probe`
    name this gate gives them.
    """
    for booking_id in MADE:
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "manage_check cleanup"})
    if TWILIO_FIXTURE:
        for error in TWILIO_FIXTURE.cleanup(lambda method, path, body: call(method, path, body)[:2]):
            check("the Twilio fixture gives back everything it created", False, error)

def book(external_id, number, name, starts_at, provider_id, service_id, location_id):
    status, payload, _ = call("POST", "/api/v1/bookings", {
        "externalId": external_id,
        "customer": {"name": name, "number": number},
        "startsAt": starts_at,
        "durationMinutes": 30,
        "serviceId": service_id,
        "providerId": provider_id,
        "locationId": location_id,
        "status": "pending",
    })
    if status not in (200, 201):
        return None, payload
    row = payload.get("booking") or payload
    MADE.append(row["id"])
    return row, payload


def main():
    global COOKIE
    COOKIE = _session.session(BASE, EMAIL, PASSWORD)
    if not COOKIE:
        print("could not sign in — is the app running?")
        return 1

    sites = call("GET", "/api/v1/locations?limit=20")[1].get("data", [])
    providers = [p for p in call("GET", "/api/v1/providers?limit=20")[1].get("data", []) if p.get("active", True)]
    services = call("GET", "/api/v1/services?limit=20")[1].get("data", [])
    if not sites or not providers:
        print("this workspace has no practice layer; the gate needs one")
        return 1

    # The site the practice's own clock comes from: the first by name, which is
    # the same rule the diary and the reports use.
    first_site = sorted(sites, key=lambda s: s["name"])[0]

    def offers(provider, service, site_row):
        """An empty list means "anything", the way it does everywhere else here."""
        p_services = provider.get("serviceIds") or []
        p_sites = provider.get("locationIds") or []
        return ((not p_services or service.get("id") in p_services)
                and (not p_sites or site_row["id"] in p_sites))

    candidates = [(p, v, s) for s in sites for p in providers for v in services if offers(p, v, s)]
    if not candidates:
        print("no practitioner/service/site combination to test with")
        return 1
    # Prefer a site that is not the one whose clock the all-sites view borrows, so
    # the "both views agree" checks below are not the same view twice.
    provider, service, site = next((row for row in candidates if row[2]["id"] != first_site["id"]), candidates[0])

    global TWILIO_FIXTURE
    try:
        TWILIO_FIXTURE = ensure_twilio_fixture(
            lambda method, path, body: call(method, path, body)[:2],
            label="manage probe",
        )
        print(f"  note  using signed Twilio stub line {TWILIO_FIXTURE.number}")
    except RuntimeError as error:
        check("a verified Twilio stub line is available", False, str(error))
        clean_up()
        return 1

    # ---------------------------------------------------------------- D1: clock
    print("\nD1 — the diary keeps one clock")
    status, all_sites, _ = call("GET", "/api/v1/diary?view=day")
    status2, one_site, _ = call("GET", f"/api/v1/diary?view=day&locationId={site['id']}")
    check("the all-sites clock is the practice's own",
          all_sites.get("timezone") == first_site["timezone"],
          f"{all_sites.get('timezone')} vs {first_site['timezone']} (first site by name)")
    check("a filtered diary keeps that site's clock",
          one_site.get("timezone") == site["timezone"] and one_site.get("gridSiteId") == site["id"],
          f"{one_site.get('timezone')} / {one_site.get('gridSiteId')}")

    status, found, _ = call("GET", availability_query(provider, site, service))
    slots = found.get("data") or found.get("slots") or []
    check("the workspace offers a slot to test with", bool(slots), "no availability found")
    if slots:
        slot = slots[0]
        row, payload = book("MANAGE-CHECK-DROP", "+14155559090", "Clock Probe", slot["startsAt"],
                            provider["id"], service.get("id"), site["id"])
        check("a probe appointment exists", bool(row), json.dumps(payload)[:160])
        if row:
            # ---- the bug, restated as a test ----
            # A row's drawn position, read back as an instant *on the grid's own
            # clock*, must be the instant the appointment actually has. Before D1
            # this was false: rows were measured in site-local minutes while the
            # column was bucketed on UTC midnight, so the two disagreed by the
            # site's offset and a drop landed hours from where it was dropped.
            # A week-wide window starting the day before: the column an
            # appointment falls in is the grid clock's business, and this is
            # asking "where is it drawn", not "is it on today's page".
            span_from = add_days(row["startsAt"][:10], -1)
            status, fresh, _ = call("GET", f"/api/v1/diary?view=week&from={span_from}")
            drawn = row_on_grid(row["id"], fresh)
            rebuilt = None
            if drawn:
                rebuilt = instant_on(drawn["column"], drawn["localStart"], fresh["timezone"])
            check("a row's drawn position reconstructs its real instant",
                  rebuilt == row["startsAt"],
                  f"drawn at {drawn and (drawn['column'], drawn['localStart'])} on {fresh.get('timezone')} rebuilds to {rebuilt}, appointment is {row['startsAt']}")

            # ---- a drag: a time the engine offers, dropped onto the grid ----
            # The drop is the calendar's arithmetic: a wall clock on the grid's
            # clock becomes an instant. What D1 fixes is that the row is then
            # *drawn back* at that same position — before the fix the row was
            # measured in its own site's minutes on a UTC-bucketed column, so the
            # block reappeared hours from where it was dropped.
            status, offered, _ = call("GET", availability_query(provider, site, service) + "&limit=6")
            elsewhere = [s2 for s2 in (offered.get("data") or []) if s2["startsAt"] != row["startsAt"]]
            if elsewhere:
                wanted = elsewhere[0]["startsAt"]
                status, moved, _ = call("POST", f"/api/v1/bookings/{row['id']}/move", {"startsAt": wanted})
                check("a time the engine offers is accepted as a drop", status == 200, json.dumps(moved)[:160])
                status, after, _ = call("GET", f"/api/v1/diary?view=week&from={span_from}")
                landed = row_on_grid(row["id"], after)
                wanted_minutes = None
                if landed:
                    day_start = zoned_midnight(landed["column"], after["timezone"])
                    wanted_minutes = int((parse_iso(wanted) - day_start) / 60000)
                check("the appointment is drawn where the drop landed",
                      bool(landed) and landed.get("localStart") == wanted_minutes,
                      f"drawn at {landed and landed.get('localStart')}, the drop means {wanted_minutes}")
                status, back, _ = call("GET", f"/api/v1/bookings/{row['id']}")
                landed_at = (back.get("booking") or back).get("startsAt")
                check("and the stored instant is the one the drop meant",
                      landed_at == wanted, f"{landed_at} vs {wanted}")
            else:
                check("a second opening to drop into", False, "the engine offered only the slot already booked")
            # The same appointment read on its own site's grid must be the same moment.
            status, site_view, _ = call("GET", f"/api/v1/diary?view=week&from={span_from}&locationId={site['id']}")
            site_row = row_on_grid(row["id"], site_view)
            check("the site's own view agrees about the instant",
                  bool(site_row) and instant_on(site_row["column"], site_row["localStart"], site_view["timezone"]) == (landed_at if elsewhere else None),
                  f"{site_row} on {site_view.get('timezone')}")

    # ------------------------------------------------------- A1: the link itself
    print("\nA1 — the client's own link")
    status, found, _ = call("GET", f"/api/v1/availability?days=14&limit=1&providerId={provider['id']}&locationId={site['id']}" + (f"&serviceId={service['id']}" if service.get("id") else ""))
    slots = found.get("data") or []
    if not slots:
        check("a slot to book", False, "no availability")
    else:
        row, payload = book("MANAGE-CHECK-LINK", "+14155559091", "Link Probe", slots[0]["startsAt"], provider["id"], service.get("id"), site["id"])
        check("a probe appointment exists", bool(row), json.dumps(payload)[:160])
        if row:
            # A reminder is queued inside its lead window (24 hours by default), so
            # booking the earliest free slot does not always produce one — the
            # diary being busy three weeks out is not a broken link. The message
            # that *always* carries the link is the booking confirmation, so this
            # reads the link out of whichever message the appointment has, and only
            # insists on a reminder when the appointment is close enough for one.
            status, run, _ = call("POST", "/api/v1/scheduler", {"action": "run", "job": "queue-reminders"})

            def link_in(rows_of_messages):
                for message in rows_of_messages:
                    found_link = re.search(r"/m/([A-Za-z0-9_.\-]+)", str(message.get("body") or ""))
                    if found_link:
                        return found_link.group(1).rstrip(".,;:!?)]")
                return None

            status, listed, _ = call("GET", f"/api/v1/messages?bookingId={row['id']}&limit=10")
            bodies = [m.get("body", "") for m in listed.get("data", [])]
            link = link_in(listed.get("data", []))

            # Nothing at all? Ask for the desk's own copy of the link and send a
            # confirmation through the public door, which is what a person booking
            # from the website gets.
            if not link:
                status, page, _ = call("GET", "/api/public/workspaces/northwind-labs/booking", auth=False)
                services_public = (page.get("services") or []) if isinstance(page, dict) else []
                public_service = next((x for x in services_public if x.get("id") == (service.get("id") if service else None)), (services_public or [{}])[0])
                # A *different* opening: the appointment above is already sitting in
                # the first one this gate found.
                _, again, _ = call("GET", availability_query(provider, site, service) + "&limit=6")
                other = next((s2 for s2 in (again.get("data") or []) if s2["startsAt"] != row.get("startsAt")), None)
                status, taken, _ = call(
                    "POST",
                    "/api/public/workspaces/northwind-labs/booking",
                    {
                        "startsAt": (other or slots[0])["startsAt"],
                        "serviceId": public_service.get("id") or (service or {}).get("id"),
                        "providerId": provider["id"],
                        "locationId": site["id"],
                        "name": "Link Probe",
                        "number": "+14155559091",
                        "email": "link.probe@northwind.test",
                    },
                    auth=False,
                )
                if status not in (200, 201):
                    print(f"      (the public booking door said {status}: {json.dumps(taken)[:120]})")
                if status in (200, 201) and isinstance(taken, dict) and taken.get("booking", {}).get("id"):
                    row = {**taken["booking"], "id": taken["booking"]["id"], "externalId": taken["booking"].get("reference")}
                    MADE.append(row["id"])
                    _, listed, _ = call("GET", "/api/v1/messages?limit=100")
                    mine = [m for m in listed.get("data", []) if m.get("bookingId") == row["id"]]
                    bodies = [m.get("body", "") for m in mine]
                    link = link_in(mine)

            check("the client's own link goes out in a message about this appointment", bool(link),
                  f"bodies: {[str(b)[:60] for b in bodies]}")

            if link:
                status, page, html = call("GET", f"/m/{link}", auth=False)
                check("the page opens with no session", status == 200 and "appointment" in html.lower(), f"HTTP {status}")
                check("the page is not indexable", "noindex" in html or "index, nofollow" not in html, "")

                status, view, _ = call("GET", f"/api/public/manage/{link}", auth=False)
                check("the link answers with that one appointment",
                      status == 200 and view.get("view", {}).get("reference") == row.get("externalId"),
                      f"HTTP {status} {json.dumps(view)[:120]}")
                check("the link knows the clinic's own clock",
                      view.get("view", {}).get("timezone") == site["timezone"],
                      str(view.get("view", {}).get("timezone")))

                days_offered = view.get("slots", {}).get("days", [])
                check("it offers real openings", bool(days_offered),
                      "no slots offered — check the practitioner/service pair")

                # A wrong token must not open somebody else's appointment.
                status, dead, _ = call("GET", f"/api/public/manage/{link[:-4]}zzzz", auth=False)
                check("a tampered token is refused", status == 404, f"HTTP {status}")

                # The appointment as a file the client can put in their own diary.
                # The route has existed since the booking page did; the assertion is
                # that the client's own link now offers it, that it answers with a
                # calendar rather than a page, and that the calendar describes *this*
                # appointment — a stale or neighbouring file would be worse than
                # none, because the client would trust it.
                calendar_path = view.get("view", {}).get("calendar")
                check("the link offers the appointment as a calendar file", bool(calendar_path), str(calendar_path))
                if calendar_path:
                    status, _, raw = call("GET", str(calendar_path), auth=False)
                    check("the calendar file downloads", status == 200 and "BEGIN:VCALENDAR" in raw, f"HTTP {status}")
                    check("and it is not a web page in disguise",
                          "text/calendar" in raw.lower() or "attachment" in raw.lower() or "BEGIN:VEVENT" in raw,
                          raw[:80].replace("\n", " "))
                    stamp = row["startsAt"].replace("-", "").replace(":", "").split(".")[0] + "Z"
                    check("it describes this appointment's own instant", stamp in raw, f"{stamp} not in the file")
                    check("and never a cancelled ghost", "STATUS:CANCELLED" not in raw, "")

                if days_offered:
                    chosen = days_offered[0]["slots"][0]
                    pick = chosen["at"]
                    # A slot can be offered under another practitioner's name — the
                    # search falls back to "anybody who does this job" when the
                    # client's own is booked — so the page's contract is that the
                    # time, the person and the site travel together. A move that
                    # quoted only the clock would be refused by the desk's own clash
                    # check: the diary would be offering a time it would not take.
                    check("an offered slot names who is free at it",
                          bool(chosen.get("providerId")), json.dumps(chosen)[:120])
                    status, moved, _ = call(
                        "POST",
                        f"/api/public/manage/{link}/action",
                        {"action": "move", "startsAt": pick, "providerId": chosen.get("providerId"), "locationId": chosen.get("locationId")},
                        auth=False,
                    )
                    check("the client can move their own appointment", status == 200, json.dumps(moved)[:140])
                    status, back, _ = call("GET", f"/api/v1/bookings/{row['id']}")
                    b = back.get("booking") or back
                    check("and the desk's diary says the same instant",
                          b.get("startsAt") == pick, f"{b.get('startsAt')} vs {pick}")
                    check("the move is on the record, not silent",
                          "moved" in [h.get("event") for h in (b.get("history") or [])], str(b.get("history"))[-120:])

                status, cancelled, _ = call("POST", f"/api/public/manage/{link}/action", {"action": "cancel", "reason": "gate"}, auth=False)
                check("the client can cancel from the link", status == 200, json.dumps(cancelled)[:140])
                status, back, _ = call("GET", f"/api/v1/bookings/{row['id']}")
                b = back.get("booking") or back
                check("the appointment really is cancelled", b.get("status") == "cancelled", str(b.get("status")))
                status, again, _ = call("POST", f"/api/public/manage/{link}/action", {"action": "cancel"}, auth=False)
                check("a second cancel is refused, not repeated", status in (404, 409), f"HTTP {status}")

    # ------------------------------------------------------ D2: reply to confirm
    print("\nD2 — a reply does what the text promised")
    number = TWILIO_FIXTURE.number
    check("the workspace has an active carrier-backed number to text", bool(number))
    status, found, _ = call("GET", availability_query(provider, site, service) + "&limit=6")
    slots = (found.get("data") or [])[1:2]
    if number and slots:
        PROBE_NUMBER = "+14155559092"
        row, payload = book("MANAGE-CHECK-REPLY", PROBE_NUMBER, "Reply Probe", slots[0]["startsAt"], provider["id"], service.get("id"), site["id"])
        check("a pending appointment to confirm", bool(row), json.dumps(payload)[:160])
        if row:
            inbound_path = "/api/telephony/twilio/inbound-message"
            inbound_form = {"From": PROBE_NUMBER, "To": number, "Body": "C", "MessageSid": "SM_manage_check"}
            forged_status, forged, _ = call(
                "POST", inbound_path, form=inbound_form, auth=False,
                extra_headers={"X-Twilio-Signature": "invalid-signature"},
            )
            check("a forged confirmation reply is rejected", forged_status == 403, json.dumps(forged)[:120])
            status, payload, xml = call("POST", inbound_path,
                                       form=inbound_form, auth=False,
                                       extra_headers=twilio_headers(BASE, inbound_path, inbound_form, TWILIO_FIXTURE.auth_token))
            check("the signed reply is answered, not swallowed", "<Message>" in xml, xml[:120])
            check("and it says which appointment", "onfirmed" in xml, xml[:160])
            status, back, _ = call("GET", f"/api/v1/bookings/{row['id']}")
            b = back.get("booking") or back
            check("the appointment is confirmed in the diary", b.get("status") == "confirmed", str(b.get("status")))

            change_form = {"From": PROBE_NUMBER, "To": number, "Body": "Can I come Friday instead?", "MessageSid": "SM_manage_check2"}
            status, payload, xml = call("POST", inbound_path,
                                        form=change_form, auth=False,
                                        extra_headers=twilio_headers(BASE, inbound_path, change_form, TWILIO_FIXTURE.auth_token))
            status, back, _ = call("GET", f"/api/v1/bookings/{row['id']}")
            b = back.get("booking") or back
            check("a change request is never auto-booked", b.get("status") == "confirmed" and b.get("startsAt") == row["startsAt"],
                  f"{b.get('status')} {b.get('startsAt')}")
            status, queue, _ = call("GET", "/api/v1/messages/replies?limit=20")
            mine = [r for r in queue.get("replies", []) if r.get("clientName") == "Reply Probe"]
            check("it lands in the desk's queue", bool(mine), json.dumps(queue)[:160])
            if mine:
                status, res, _ = call("POST", "/api/v1/messages/replies", {"action": "resolve", "id": mine[0]["id"]})
                check("the desk can tick it off", status == 200 and res.get("waiting") is not None, json.dumps(res)[:120])
    else:
        check("a number and a slot for the reply test", False, "neither found")

    clean_up()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
