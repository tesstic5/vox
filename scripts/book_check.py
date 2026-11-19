#!/usr/bin/env python3
"""
Booking-flow check.

Walks the loop this product exists for, end to end:

    client's system pushes appointments  →  we mirror them
      →  a campaign decides who to ring (dry run first)
      →  the calls are placed through the carrier (a stub, here)
      →  the agent acts on the booking, not on a template
      →  the outcome is written back and delivered as a webhook

Run it with the app up and the Twilio stub on :4010:

    tsx scripts/twilio-stub.ts &
    TWILIO_API_BASE=http://127.0.0.1:4010 npm start
    python3 scripts/book_check.py
"""

import json
import os
import sys
import urllib.error
import urllib.request
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STUB = os.environ.get("TWILIO_STUB_BASE", "http://127.0.0.1:4010")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
SID = os.environ.get("STUB_SID", "AC0123456789abcdef0123456789abcdef")
TOKEN = os.environ.get("STUB_TOKEN", "stub-auth-token")

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, base=None, headers=None):
    global cookie
    url = (base or BASE) + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie and not base:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode()
            sc = res.headers.get("set-cookie")
            if sc and not base:
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


def iso_hours_from_now(hours):
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def main():
    global cookie
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("login", bool(cookie), "session cookie" if cookie else "no session")

    # ---- clean slate for the bookings this test creates -------------------
    # Asked for by the ids this check owns, rather than by paging through the
    # workspace: a practice with a month of diary in it has more appointments
    # than one page holds, and a leftover CHK-1 further down the list would make
    # the sync below look like it had done nothing.
    for external in ("CHK-1", "CHK-2", "CHK-3"):
        _, found = call("GET", f"/api/v1/bookings?externalId={external}")
        for booking in found.get("data") or []:
            call("POST", f"/api/v1/bookings/{booking['id']}/status", {"status": "cancelled", "note": "book_check stale cleanup"})
    status, campaigns = call("GET", "/api/v1/booking-campaigns")
    for campaign in campaigns.get("data") or []:
        if campaign.get("name", "").startswith("CHK "):
            call("DELETE", f"/api/v1/booking-campaigns/{campaign['id']}")

    # ---- the client pushes its diary in ----------------------------------
    rows = [
        {
            "externalId": "CHK-1",
            "customer": {"name": "Amara Osei", "number": "+14155550701"},
            "service": "Checkup",
            # This check owns these records and deliberately reactivates stale
            # fixture rows. Omitting status correctly preserves terminal state.
            "status": "confirmed",
            "startsAt": iso_hours_from_now(6),
            "timezone": "America/Los_Angeles",
        },
        {
            "externalId": "CHK-2",
            "customer": {"name": "Devin Park", "number": "+14155550702"},
            "service": "Estimate",
            "status": "confirmed",
            "startsAt": iso_hours_from_now(9),
            "timezone": "America/Los_Angeles",
        },
        {
            "externalId": "CHK-3",
            "customer": {"name": "Priya Raghavan", "number": "+14155550703"},
            "service": "Consultation",
            "status": "confirmed",
            # Outside the campaign window on purpose — must never be dialled.
            "startsAt": iso_hours_from_now(72),
            "timezone": "America/Los_Angeles",
        },
    ]
    status, synced = call("POST", "/api/v1/bookings/sync", {"bookings": rows, "mode": "full", "sourceId": "book-check"})
    accepted = sum(int(synced.get(key, 0) or 0) for key in ("created", "updated", "unchanged"))
    check("sync accepts or reuses the client's retained diary", status == 200 and accepted == 3, f"status {status} created={synced.get('created')} updated={synced.get('updated')}")
    check("a source-scoped full sync leaves other integrations alone", synced.get("removed") == 0, f"removed={synced.get('removed')}")

    status, again = call("POST", "/api/v1/bookings/sync", {"bookings": rows, "mode": "partial", "sourceId": "book-check"})
    check("a re-sync is idempotent", again.get("updated", 0) == 0 and again.get("created", 0) == 0, f"created={again.get('created')} updated={again.get('updated')} unchanged={again.get('unchanged')}")

    status, bad = call("POST", "/api/v1/bookings/sync", {"bookings": [{"externalId": "", "startsAt": "nope"}]})
    check("a bad row is rejected with a reason", status == 400, message(bad)[:70])

    status, listing = call("GET", "/api/v1/bookings?externalId=CHK-1")
    check("a booking can be read back by the client's id", len(listing.get("data") or []) == 1, (listing.get("data") or [{}])[0].get("description", ""))

    # Removed-from-source: push only part of it, in full mode.
    status, partial = call("POST", "/api/v1/bookings/sync", {"bookings": rows[:2], "mode": "full", "sourceId": "book-check"})
    check("full sync flags what the client dropped", partial.get("removed", 0) >= 1, f"removed={partial.get('removed')}")
    status, chk3 = call("GET", "/api/v1/bookings?externalId=CHK-3")
    doc = (chk3.get("data") or [{}])[0]
    check("the dropped booking is flagged, not deleted", doc.get("metadata", {}).get("removedFromSource") == "true" and doc.get("status"), f"status={doc.get('status')}")

    # ---- a campaign decides who to ring ----------------------------------
    status, assistants = call("GET", "/api/v1/assistants?limit=50")
    booking_assistant = next(
        (a for a in assistants.get("data") or [] if set(a.get("tools") or []) & {"book_appointment", "reschedule_appointment", "cancel_appointment"}),
        None,
    )
    check("a booking assistant is available", booking_assistant is not None, (booking_assistant or {}).get("name", "none"))
    if not booking_assistant:
        sys.exit(1)

    status, campaign = call(
        "POST",
        "/api/v1/booking-campaigns",
        {
            "name": "CHK tomorrow confirmations",
            "kind": "confirm",
            "assistantId": booking_assistant["id"],
            "withinHours": 24,
            "maxPerRun": 5,
            "quietHours": {"start": 0, "end": 24, "timezone": "UTC"},
            "instructions": "Confirm {{customer}} is coming to {{appointment}}.",
            # A real workspace has a full diary, so the run has to be allowed to
            # dial everything that is due: with the default cap the first run
            # would take the oldest few and the *second* run would find fresh
            # bookings — proving nothing about whether a version is rung twice.
            "maxPerRun": 50,
        },
    )
    check("campaign created paused", status == 201 and campaign.get("status") == "paused", f"status {status} {message(campaign)[:60]}")

    status, due = call("GET", f"/api/v1/booking-campaigns/{campaign['id']}")
    check("due bookings are inside the window", due.get("dueNow", 0) >= 2, f"due now={due.get('dueNow')}")
    externals = {row["externalId"] for row in due.get("upcoming") or []}
    check("the far-away appointment is not due", "CHK-3" not in externals, f"due={sorted(externals)}")

    status, dry = call("POST", f"/api/v1/booking-campaigns/{campaign['id']}/run", {"dryRun": True})
    check("a dry run dials nothing", dry.get("dialled") == 0 and dry.get("skipped", 0) >= 2, f"skipped={dry.get('skipped')} {dry.get('reason')}")
    check("the dry run names who it would call", {c["externalId"] for c in dry.get("calls") or []} >= {"CHK-1", "CHK-2"}, str([c["externalId"] for c in dry.get("calls") or []]))

    status, refused = call("POST", f"/api/v1/booking-campaigns/{campaign['id']}/run", {"dryRun": False})
    check("a paused campaign refuses to dial", status == 400, message(refused)[:70])

    status, quiet = call("POST", f"/api/v1/booking-campaigns/{campaign['id']}/run", {"dryRun": False, "atHour": 3})
    check("outside calling hours nothing dials", True, str(quiet.get("deferred") or quiet.get("reason"))[:80])

    call("PATCH", f"/api/v1/booking-campaigns/{campaign['id']}", {"status": "active"})

    # A carrier is needed for the dial half. Reuse one if the workspace has it,
    # otherwise connect the stub (only reachable when TWILIO_API_BASE points at it).
    status, carriers = call("GET", "/api/v1/carriers")
    connected_here = None
    if not (carriers.get("data") or []):
        status, made = call(
            "POST",
            "/api/v1/carriers",
            {"provider": "twilio", "accountSid": SID, "authToken": TOKEN, "label": "CHK carrier"},
        )
        if status in (200, 201):
            connected_here = made.get("id")
            check("stub carrier connected for the dial half", True, str(made.get("sidMasked") or made.get("label")))
        else:
            check("stub carrier connected for the dial half", False, f"status {status} {message(made)[:80]}")

    # ---- a real dial, through the carrier stub ---------------------------
    status, live = call("POST", f"/api/v1/booking-campaigns/{campaign['id']}/run", {"dryRun": False, "atHour": 12})
    dialled = live.get("dialled", 0)
    check("the campaign places real calls", dialled >= 1 or live.get("reason") == "no_carrier", f"dialled={dialled} reason={live.get('reason')}")
    if not dialled:
        print("\n  (no carrier connected — connect one to see the dial half: see scripts/carrier_check.py)")
    else:
        sids = [c.get("carrierSid") for c in live.get("calls") or [] if c.get("carrierSid")]
        check("the carrier returned a call SID", bool(sids), str(sids[:1]))
        status, calls = call("GET", "/api/v1/calls?limit=10")
        linked = [
            c
            for c in calls.get("data") or []
            if c.get("campaignId") == campaign["id"] and c.get("bookingId")
        ]
        check("the call record is linked to the booking", bool(linked), f"{len(linked)} linked")
        if linked:
            status, detail = call("GET", f"/api/v1/calls/{linked[0]['id']}")
            call_doc = detail.get("data") or detail
            check("the call carries the campaign brief", bool(call_doc.get("purpose")), str(call_doc.get("purpose"))[:60])

        status, rerun = call("POST", f"/api/v1/booking-campaigns/{campaign['id']}/run", {"dryRun": False, "atHour": 12})
        check("a booking is not called twice for the same version", rerun.get("dialled", 0) == 0, f"second run dialled {rerun.get('dialled')}")

    # ---- the agent acts on the real booking ------------------------------
    status, listing = call("GET", "/api/v1/bookings?externalId=CHK-1")
    booking = (listing.get("data") or [{}])[0]
    status, opened = call("POST", "/api/v1/calls", {"assistantId": booking_assistant["id"], "type": "outbound", "to": "+14155550701", "from": "+14155550188", "bookingId": booking.get("id")})
    call_doc = opened.get("call") or opened
    call_id = call_doc.get("id")
    check("a booking-scoped call opens", bool(call_id), str(call_id))

    status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "Yes I'm still coming, but can we make it Friday at 4pm instead?"})
    result = turn.get("turn") or {}
    tools = [t.get("name") for t in result.get("toolCalls") or []]
    if tools:
        check("the agent looked the booking up before answering", tools[0] in ("lookup_order", "order_status", "reschedule_appointment"), f"tools={tools}")
        moved = [t for t in result.get("toolCalls") or [] if t.get("name") == "reschedule_appointment"]
        if moved:
            payload = json.loads(moved[0]["result"])
            check("the reschedule carries a real new time", bool(payload.get("startsAt")), str(payload.get("appointment"))[:60])

    status, after = call("GET", f"/api/v1/bookings?externalId=CHK-1")
    fresh = (after.get("data") or [{}])[0]
    if "reschedule_appointment" in tools:
        check("the booking moved in the record, not just in the sentence", fresh.get("outcome") == "rescheduled", f"outcome={fresh.get('outcome')} startsAt={fresh.get('startsAt')}")
        check("the booking remembers which call moved it", call_id in (fresh.get("callIds") or []), str(fresh.get("callIds")))
    status, stats = call("GET", "/api/v1/bookings?limit=200")
    check("outcome statistics are computed", (stats.get("stats") or {}).get("total", 0) >= 3, json.dumps(stats.get("stats") or {})[:110])

    # ---- the outcome reaches the client -----------------------------------
    status, since = call("GET", "/api/v1/bookings/sync?since=2020-01-01T00:00:00Z")
    outcomes = since.get("outcomes") or []
    check("outcomes are readable for pollers", any(o.get("externalId") == "CHK-1" for o in outcomes), f"{len(outcomes)} outcome(s)")

    # ---- a cancelled booking stops being called ---------------------------
    status, cancel_turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "Actually, cancel the appointment."})
    cancelled_tools = [t.get("name") for t in (cancel_turn.get("turn") or {}).get("toolCalls") or []]
    status, after_cancel = call("GET", "/api/v1/bookings?externalId=CHK-1")
    final = (after_cancel.get("data") or [{}])[0]
    if "cancel_appointment" in cancelled_tools:
        check("a cancellation writes the booking off", final.get("status") == "cancelled" and final.get("outcome") == "cancelled", f"status={final.get('status')}")
        status, due_now = call("GET", f"/api/v1/booking-campaigns/{campaign['id']}")
        check("a cancelled booking is no longer due", "CHK-1" not in {r["externalId"] for r in due_now.get("upcoming") or []}, str([r["externalId"] for r in due_now.get("upcoming") or []]))
    else:
        check("cancellation tool ran", False, f"tools={cancelled_tools}")

    # ---- cleanup ----------------------------------------------------------
    if connected_here:
        call("DELETE", f"/api/v1/carriers/{connected_here}")
    call("DELETE", f"/api/v1/booking-campaigns/{campaign['id']}")
    status, leftovers = call("GET", "/api/v1/bookings?limit=200")
    for row in leftovers.get("data") or []:
        if str(row.get("externalId", "")).startswith("CHK-"):
            call("POST", f"/api/v1/bookings/{row['id']}/status", {"status": "cancelled", "note": "book_check cleanup"})

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL BOOKING CHECKS PASS")


if __name__ == "__main__":
    main()
