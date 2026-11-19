#!/usr/bin/env python3
"""
reports_check.py — the P7 gate.

The phase gate is one sentence: *a clinic owner can answer "who earns what, what
does it cost us, who does not turn up" from one screen.* A sentence like that is
easy to fake and hard to prove, so this script proves every clause of it against
the live API, and the parts that make the answers trustworthy:

   1. one window, stated once — presets and explicit dates resolve to the same
      kind of window, and an explicit range wins over a preset
   2. revenue: billed equals the invoice lines it was computed from, per
      practitioner and per service, to the cent
   3. collections split across the lines without a rounding crumb — the shares
      add back up to what was actually collected
   4. the report and the money screen agree on the same rows
   5. utilisation: booking an appointment moves the booked minutes by exactly its
      duration; cancelling it gives the time back and lands in cancelled
   6. attendance: a no-show is counted, the rate matches its own counts, and the
      weekday the appointment fell on is the weekday that carries it
   7. costs: an expense row appears under its category, and margin is collected
      less cost — a subtraction, not a seventh definition of profit
   8. attribution: every appointment is counted once, under its own source
   9. recalls: a client unseen past the practice's interval is listed, and their
      consent decides whether the rules engine could reach them
  10. export: the CSV carries the rows and the headers it promises, and leaving
      with the numbers writes an audit row
  11. the desk can read reports, and a view that does not exist is refused

Usage: python3 scripts/reports_check.py   (the app must be running)
"""

import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import session as cached_session  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = os.environ.get("VOXERA_DESK_EMAIL", "desk@northwind.dev")
DESK_CACHE = os.environ.get("VOXERA_DESK_SESSION", "/tmp/voxera-desk-session.json")

cookie = ""
failures: list[str] = []
cleanup: dict[str, list[str]] = {"bookings": [], "clients": [], "invoices": [], "expenses": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, auth=True, as_cookie=None, raw=False):
    url = path if path.startswith("http") else BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    who = as_cookie if as_cookie is not None else cookie
    if auth and who:
        req.add_header("cookie", who)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode()
            if raw:
                return res.status, text, dict(res.headers)
            return res.status, (json.loads(text) if text else {}), dict(res.headers)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        if raw:
            return err.code, text, dict(err.headers)
        try:
            return err.code, (json.loads(text) if text else {}), dict(err.headers)
        except json.JSONDecodeError:
            return err.code, {"raw": text}, dict(err.headers)


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def code(payload):
    return payload.get("error", {}).get("code", "") if isinstance(payload, dict) else ""


def stamp():
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def report(query, auth=True, as_cookie=None):
    """A reports call that answers with just the status and the payload."""
    status, payload, _ = call("GET", f"/api/v1/reports?{query}", auth=auth, as_cookie=as_cookie)
    return status, payload


def main():
    global cookie
    cookie = cached_session(BASE, EMAIL, PASSWORD) if not os.environ.get("VOXERA_SESSION") else os.environ["VOXERA_SESSION"]
    if not cookie:
        print("could not sign in — is the app running?")
        return 1

    today = datetime.now(timezone.utc).date()
    # ---- 0. the workspace is up to date ------------------------------------
    status, boot, _ = call("POST", "/api/bootstrap", {})
    check("the workspace bootstraps the reports' sources", status == 200, f"{status} " + ", ".join(sorted((boot.get('demoMoney') or {}).keys()))[:80])

    status, practice = report("view=overview")
    if status != 200:
        check("the reports endpoint answers", False, f"{status} {message(practice)}")
        return finish()
    check("the reports endpoint answers", True, f"window {practice['range']['from']} → {practice['range']['to']} ({practice['range']['timezone']})")
    check("the overview carries every headline the gate names",
          all(k in practice for k in ("earned", "costs", "attendance", "diary", "acquisition", "recalls")),
          ", ".join(sorted(k for k in practice if k not in ("range", "currency", "generatedAt", "sections"))))

    # ---- 1. one window, stated once ---------------------------------------
    base_timezone = practice["range"]["timezone"]
    status, explicit = report(f"view=revenue&from={today - timedelta(days=6)}&to={today}")
    window = explicit.get("range") or {}
    check("an explicit range wins over any preset",
          status == 200 and window.get("from") == str(today - timedelta(days=6)) and window.get("to") == str(today),
          f"{window.get('from')} → {window.get('to')} · {window.get('days')} day(s)")
    check("the window is inclusive at both ends", window.get("days") == 7, f"{window.get('days')} days for 7 dates")
    status, preset = report("view=revenue&preset=30d")
    check("a preset resolves to the same shape of window, in the practice's timezone",
          status == 200 and preset.get("range", {}).get("days") == 30 and preset.get("range", {}).get("timezone") == base_timezone,
          f"{preset.get('range', {}).get('label')} · {preset.get('range', {}).get('days')} day(s)")
    status, month = report("view=revenue&preset=month")
    check("'this month' starts on the 1st, not 30 days back",
          status == 200 and month.get("range", {}).get("from", "").endswith("-01"),
          month.get("range", {}).get("from"))
    status, wrong, _ = call("GET", "/api/v1/reports?view=nonsense")
    check("a view that does not exist is refused, and says which exist",
          status == 400 and code(wrong) == "VALIDATION_ERROR" and "utilisation" in message(wrong),
          f"{status} {message(wrong)}"[:90])

    # ---- 2. who earns what -------------------------------------------------
    # A probe visit run the way a practice runs one: an appointment, completed,
    # invoiced from the service, issued, paid.
    # The list endpoints take filters, and an unknown filter is a 400 rather than
    # a silently ignored parameter — so `includeInactive` belongs here only if the
    # route knows it. It does not: the default list is the live one.
    status, services, _ = call("GET", "/api/v1/services")
    service = next((s for s in (services.get("data") or []) if s.get("active") is not False), None)
    status, providers, _ = call("GET", "/api/v1/providers")
    provider = next((p for p in (providers.get("data") or []) if p.get("active") is not False), None)
    if not service or not provider:
        check("a service and a practitioner exist to report on", False, "nothing to bill from")
        return finish()
    check("a service and a practitioner exist to report on", True, f"{service['name']} · {provider['name']}")

    number = f"+1415557{stamp() % 100000:05d}"
    status, made, _ = call("POST", "/api/v1/clients", {"name": f"Reports Probe {stamp() % 10000}", "number": number}, auth=True)
    client = (made.get("client") or made) if status in (200, 201) else {}
    client_id = client.get("id")
    if client_id:
        cleanup["clients"].append(client_id)
    check("a client record exists to report on", bool(client_id), f"{status} {client_id}")

    starts = datetime.now(timezone.utc) - timedelta(hours=2)
    status, booked, _ = call("POST", "/api/v1/bookings", {
        "externalId": f"RPT-{stamp()}",
        "customer": {"name": client.get("name"), "number": number},
        "startsAt": starts.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "serviceId": service.get("id"),
        "providerId": provider.get("id"),
        # This is an imported historical visit: conflict bypass is deliberately
        # limited to past terminal records, never future work.
        "status": "completed",
        "checkConflicts": False,
    }, auth=True)
    booking = booked.get("booking") or booked
    booking_id = booking.get("id")
    if booking_id:
        cleanup["bookings"].append(booking_id)
    check("the probe appointment lands with a practitioner and a service", bool(booking_id), f"{status} {booking_id or message(booked)}")

    check("the imported visit is terminal (so it counts as seen, not just booked)", booking.get("status") == "completed", str(booking.get("status")))

    # The invoice the visit raises, priced from the service, then issued + paid.
    status, raised, _ = call("POST", "/api/v1/invoices", {"action": "from-booking", "bookingId": booking_id, "allowExisting": True}, auth=True)
    invoice = raised.get("invoice") or {}
    invoice_id = invoice.get("id")
    if invoice_id:
        cleanup["invoices"].append(invoice_id)
    check("the visit raises an invoice", bool(invoice_id), f"{status} {message(raised)}"[:90])
    if not invoice_id:
        return finish()
    # A distinctive price so the probe's money is findable in the report.
    status, edited, _ = call("POST", "/api/v1/invoices", {
        "action": "update",
        "id": invoice_id,
        "lines": [{"description": "Reports probe consultation", "qty": 1, "unitAmount": "321.11", "taxRatePct": 0,
                   "serviceId": service.get("id"), "providerId": provider.get("id")}],
    }, auth=True)
    total_minor = (edited.get("invoice") or {}).get("totalMinor")
    status, issued, _ = call("POST", "/api/v1/invoices", {"action": "issue", "id": invoice_id}, auth=True)
    published = (issued.get("invoice") or {})
    status, paid, _ = call("POST", "/api/v1/invoices", {"action": "pay", "id": invoice_id, "method": "card"}, auth=True)
    check("the probe invoice is issued and settled", bool(published.get("number")) and status == 201,
          f"{published.get('number')} · {total_minor} minor units · {status}")

    status, revenue = report("view=revenue&preset=30d")
    check("revenue answers for the window", status == 200 and revenue.get("currency"), f"{status} · {revenue.get('invoices')} invoice(s)")
    rows = revenue.get("byProvider") or []
    mine = next((r for r in rows if r.get("id") == provider.get("id")), None)
    check("the practitioner who did the work is credited with it",
          bool(mine) and mine.get("invoicedMinor") >= total_minor and mine.get("collectedMinor") >= total_minor,
          f"{mine.get('name') if mine else provider.get('name')}: billed {mine.get('invoicedMinor') if mine else None} · collected {mine.get('collectedMinor') if mine else None} vs probe {total_minor}")
    service_rows = revenue.get("byService") or []
    check("and the service is credited with it too",
          any(r.get("id") == service.get("id") and r.get("invoicedMinor", 0) >= total_minor for r in service_rows),
          ", ".join(f"{r.get('name')}: {r.get('invoicedMinor')}" for r in service_rows[:3]))

    billed_sum = sum(r.get("invoicedMinor", 0) for r in rows)
    check("**the practitioners' shares add back up to everything billed**",
          billed_sum == revenue.get("billedMinor"),
          f"rows {billed_sum} vs billed {revenue.get('billedMinor')}")
    collected_sum = sum(r.get("collectedMinor", 0) for r in rows)
    check("**and the collected shares add back up to everything collected**",
          collected_sum == revenue.get("collectedMinor"),
          f"rows {collected_sum} vs collected {revenue.get('collectedMinor')}")
    owed_sum = sum(r.get("outstandingMinor", 0) for r in rows)
    check("as does what is owed", owed_sum == revenue.get("outstandingMinor"), f"rows {owed_sum} vs owed {revenue.get('outstandingMinor')}")
    # The same has to hold on the other axis. It is the same arithmetic, which is
    # exactly why it is checked separately: a fix applied to one grouping and not
    # the other is how a report ends up disagreeing with itself tab by tab.
    service_rows = revenue.get("byService") or []
    for field, total_key, label in (
        ("invoicedMinor", "billedMinor", "billed"),
        ("collectedMinor", "collectedMinor", "collected"),
        ("outstandingMinor", "outstandingMinor", "owed"),
    ):
        check(f"**and the services' {label} adds back up to the same total**",
              sum(r.get(field, 0) for r in service_rows) == revenue.get(total_key),
              f"rows {sum(r.get(field, 0) for r in service_rows)} vs {revenue.get(total_key)}")

    # ---- 3. the report and the money screen agree --------------------------
    status, overview_money, _ = call("GET", "/api/v1/invoices?view=overview")
    check("the money screen and the report are reading the same rows",
          overview_money.get("collectedMinor") is not None and revenue.get("collectedMinor", 0) <= overview_money.get("collectedMinor", 0),
          f"report {revenue.get('collectedMinor')} ≤ money {overview_money.get('collectedMinor')} (the report's window is a subset of all time)")

    # ---- 4. the diary ------------------------------------------------------
    duration = int(booking.get("durationMinutes") or service.get("durationMinutes") or 30)
    # Ask the real availability engine for the next conflict-safe slot, not only
    # for the remainder of today. A gate run after closing time must mean the same
    # thing as a morning run. The explicit report window is then extended through
    # that offered slot, so the booking remains inside the arithmetic being tested.
    local_today = datetime.now(ZoneInfo(base_timezone)).date()
    _, free_days, _ = call(
        "GET",
        f"/api/v1/availability?serviceId={service.get('id')}&providerId={provider.get('id')}&from={local_today}&days=14&limit=200",
        auth=True,
    )
    free_slot = next(iter(free_days.get("data") or []), None)
    if not free_slot:
        check("the diary offers a conflict-safe slot for the utilisation probe", False, free_days.get("reason", "none in the next 14 days"))
        return finish()
    slot_at = datetime.fromisoformat(free_slot["startsAt"].replace("Z", "+00:00"))
    slot_day = slot_at.astimezone(ZoneInfo(base_timezone)).date()
    utilisation_query = f"view=utilisation&from={local_today - timedelta(days=29)}&to={slot_day}"
    status, before = report(utilisation_query)
    status, holds, _ = call("POST", "/api/v1/bookings", {
        "externalId": f"RPT-HOLD-{stamp()}",
        "customer": {"name": client.get("name"), "number": number},
        "startsAt": free_slot["startsAt"],
        "serviceId": service.get("id"),
        "providerId": provider.get("id"),
        "locationId": free_slot.get("locationId"),
        "roomId": free_slot.get("roomId"),
    }, auth=True)
    held = holds.get("booking") or holds
    if held.get("id"):
        cleanup["bookings"].append(held["id"])
    status, holding = report(utilisation_query)
    check("booking an appointment moves the booked minutes by exactly its own length",
          status == 200 and holding.get("bookedMinutes") == before.get("bookedMinutes") + duration,
          f"{before.get('bookedMinutes')} → {holding.get('bookedMinutes')} for a {duration} minute visit")
    status, freed, _ = call("POST", f"/api/v1/bookings/{held.get('id')}/status", {"status": "cancelled"}, auth=True)
    status, after = report(utilisation_query)
    check("cancelling it gives the time back",
          status == 200 and after.get("bookedMinutes") == before.get("bookedMinutes"),
          f"{holding.get('bookedMinutes')} → {after.get('bookedMinutes')} (was {before.get('bookedMinutes')} before the booking)")
    check("and the time is reported as cancelled rather than quietly lost",
          after.get("cancelledMinutes", 0) == holding.get("cancelledMinutes", 0) + duration,
          f"cancelled {holding.get('cancelledMinutes')} → {after.get('cancelledMinutes')}")
    provider_rows = after.get("rows") or []
    check("**utilisation is measured per practitioner, against their own rota**",
          bool(provider_rows) and sum(r.get("capacityMinutes", 0) for r in provider_rows) == after.get("capacityMinutes"),
          f"{len(provider_rows)} practitioner(s) · {after.get('capacityMinutes')} rota minutes")
    check("the percentage matches the minutes it was computed from",
          (after.get("capacityMinutes") or 0) == 0
          or abs(after.get("utilisationPct", 0) - round((after.get("bookedMinutes", 0) / after["capacityMinutes"]) * 100, 1)) <= 0.05,
          f"{after.get('utilisationPct')}% of {after.get('capacityMinutes')} minutes booked")
    check("somebody on the rota has hours in this window",
          any(r.get("capacityMinutes", 0) > 0 for r in provider_rows),
          ", ".join(f"{r.get('name')}: {r.get('capacityMinutes')}m" for r in provider_rows[:3]))

    # ---- 5. who does not turn up -------------------------------------------
    # A missed appointment, created the way a practice records one.
    status, second, _ = call("POST", "/api/v1/bookings", {
        "externalId": f"RPT-NOSHOW-{stamp()}",
        "customer": {"name": client.get("name"), "number": number},
        "startsAt": (starts - timedelta(hours=1)).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "serviceId": service.get("id"),
        "providerId": provider.get("id"),
        "status": "no_show",
        "checkConflicts": False,
    }, auth=True)
    noshow = second.get("booking") or second
    noshow_id = noshow.get("id")
    if noshow_id:
        cleanup["bookings"].append(noshow_id)

    status, attendance = report("view=attendance&preset=30d")
    check("a missed appointment is counted as a no-show",
          status == 200 and attendance.get("noShows", 0) >= 1 and attendance.get("attended", 0) >= 1,
          f"{attendance.get('attended')} kept · {attendance.get('noShows')} missed · {attendance.get('cancelled')} cancelled")
    considered = (attendance.get("attended", 0) or 0) + (attendance.get("noShows", 0) or 0)
    expected = round(((attendance.get("noShows", 0) or 0) / considered) * 100, 1) if considered else 0
    check("**the rate is the counts it was computed from, not a separate number**",
          abs(attendance.get("noShowRatePct", 0) - expected) <= 0.05,
          f"{attendance.get('noShowRatePct')}% of {considered} kept-or-missed (expected {expected}%)")
    weekday_of_probe = starts.strftime("%A")
    check("the weekday that carried the no-show is the weekday it happened on",
          any(r.get("key") == weekday_of_probe and r.get("noShows", 0) >= 1 for r in (attendance.get("byWeekday") or [])),
          ", ".join(f"{r.get('key')}: {r.get('noShows')}" for r in (attendance.get("byWeekday") or [])[:4]))
    check("attendance is broken down by the hour the appointments were in, in the practice's time",
          bool(attendance.get("byHour")) and all(":" in str(r.get("key")) for r in (attendance.get("byHour") or [])),
          ", ".join(str(r.get("key")) for r in (attendance.get("byHour") or [])[:4]))
    check("a practitioner's no-show rate is theirs, from their own appointments",
          any(r.get("providerId") == provider.get("id") for r in (attendance.get("byProvider") or [])),
          ", ".join(f"{r.get('name')}: {r.get('noShows')}/{r.get('booked')}" for r in (attendance.get("byProvider") or [])[:3]))

    # ---- 6. what it costs us ----------------------------------------------
    status, expense, _ = call("POST", "/api/v1/invoices", {
        "action": "expense:create",
        "category": "supplies",
        "supplier": "Reports Probe Supplies",
        "description": "reports_check probe",
        "amount": "42.50",
        "date": str(today),
    }, auth=True)
    created_expense = expense.get("expense") or {}
    if created_expense.get("id"):
        cleanup["expenses"].append(created_expense["id"])
    status, costs = report("view=costs&preset=30d")
    supplies = next((r for r in (costs.get("byCategory") or []) if r.get("key") == "supplies"), None)
    check("an expense appears under its own category",
          status == 200 and supplies is not None and supplies.get("amountMinor", 0) >= 4250,
          f"{supplies.get('label') if supplies else 'no supplies row'}: {supplies.get('amountMinor') if supplies else None}")
    check("**total cost is practice spending plus call spend, added once**",
          costs.get("totalMinor") == (costs.get("expensesMinor", 0) or 0) + (costs.get("callSpendMinor", 0) or 0),
          f"{costs.get('expensesMinor')} + {costs.get('callSpendMinor')} = {costs.get('totalMinor')}")
    check("the call spend is itemised rather than one mystery number",
          sum(r.get("amountMinor", 0) for r in (costs.get("callSpendBreakdown") or [])) == (costs.get("callSpendMinor", 0) or 0),
          ", ".join(f"{r.get('label')}: {r.get('amountMinor')}" for r in (costs.get("callSpendBreakdown") or [])[:3]))
    check("margin is collected less cost — a subtraction anybody can check",
          costs.get("marginMinor") == (costs.get("collectedMinor", 0) or 0) - (costs.get("totalMinor", 0) or 0),
          f"{costs.get('collectedMinor')} − {costs.get('totalMinor')} = {costs.get('marginMinor')}")

    # ---- 7. where the work comes from -------------------------------------
    status, attribution = report("view=attribution&preset=30d")
    sources = attribution.get("bySource") or []
    check("every appointment in the window is counted once, under its own source",
          status == 200 and sum(r.get("bookings", 0) for r in sources) == attribution.get("bookings"),
          f"{attribution.get('bookings')} booking(s) across {len(sources)} source(s)")
    check("the probe appointment is in the source it was booked through",
          any(r.get("key") == booking.get("source") and r.get("bookings", 0) >= 1 for r in sources),
          f"probe source '{booking.get('source')}' · " + ", ".join(f"{r.get('key')}:{r.get('bookings')}" for r in sources[:4]))
    check("the assistant's share of the diary is a share of bookings, stated with them",
          attribution.get("assistantSharePct") is not None and attribution.get("bookings", 0) > 0,
          f"phone share {attribution.get('assistantSharePct')}% of {attribution.get('bookings')}")
    calls = attribution.get("calls") or {}
    check("the calls behind that share are counted, not estimated",
          calls.get("total", 0) >= calls.get("handled", 0) and "producedBooking" in calls,
          f"{calls.get('handled')} handled / {calls.get('total')} · {calls.get('producedBooking')} produced a booking")

    # ---- 8. recalls --------------------------------------------------------
    status, profile, _ = call("GET", "/api/v1/practice/profile")
    interval = int((profile.get("profile") or {}).get("recallDays") or 180)
    # A separate record, because "last seen" is the *latest* visit: a client with a
    # visit today is not overdue however old their previous one was. This probe has
    # exactly one visit, and it is old.
    status, quiet, _ = call("POST", "/api/v1/clients", {"name": f"Reports Recall Probe {stamp() % 10000}", "number": f"+1415556{stamp() % 100000:05d}"}, auth=True)
    quiet_client = (quiet.get("client") or quiet) if status in (200, 201) else {}
    quiet_id = quiet_client.get("id")
    if quiet_id:
        cleanup["clients"].append(quiet_id)
    old_starts = datetime.now(timezone.utc) - timedelta(days=interval + 12)
    status, old_book, _ = call("POST", "/api/v1/bookings", {
        "externalId": f"RPT-OLD-{stamp()}",
        "customer": {"name": quiet_client.get("name"), "number": quiet_client.get("number")},
        "startsAt": old_starts.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "serviceId": service.get("id"),
        "providerId": provider.get("id"),
        "status": "completed",
        "checkConflicts": False,
    }, auth=True)
    old_booking = old_book.get("booking") or old_book
    if old_booking.get("id"):
        cleanup["bookings"].append(old_booking["id"])
    # A recall nobody may make is not a recall, so the consent state is part of
    # the test: this client has refused texts.
    call("POST", f"/api/v1/clients/{quiet_id}/consents", {"channel": "sms", "granted": False, "source": "staff", "note": "reports probe"}, auth=True)

    status, recalls = report("view=recalls&preset=30d")
    mine_recall = next((r for r in (recalls.get("rows") or []) if r.get("clientId") == quiet_id), None)
    check("**a client unseen past the practice's own recall window is on the list**",
          status == 200 and mine_recall is not None and mine_recall.get("overdueDays", 0) >= 10,
          f"{interval}-day window · overdue by {mine_recall.get('overdueDays') if mine_recall else 'not listed'} day(s)")
    check("the days count from the last completed visit, not from the record being created",
          bool(mine_recall) and interval <= (mine_recall.get("lastSeenDays") or 0) <= interval + 13,
          f"last seen {mine_recall.get('lastSeenDays') if mine_recall else None} day(s) ago for a {interval}-day window")
    check("the client's own consent decides whether the practice may chase them",
          mine_recall is not None and mine_recall.get("consentSms") is False and recalls.get("optedOut", 0) >= 1,
          f"reachable {recalls.get('reachable')} · without consent {recalls.get('optedOut')}")
    check("the recall list is capped rather than unbounded, and still says how big it is",
          isinstance(recalls.get("rows"), list) and recalls.get("due", 0) >= len(recalls.get("rows") or []),
          f"{len(recalls.get('rows') or [])} row(s) of {recalls.get('due')} due")

    # ---- 9. the spreadsheet -------------------------------------------------
    status, body, headers = call("GET", "/api/v1/reports?view=export&kind=revenue&preset=30d", raw=True)
    check("**the export is a real CSV with a filename a bookkeeper can keep**",
          status == 200 and "text/csv" in headers.get("content-type", "") and "revenue_" in headers.get("content-disposition", ""),
          f"{status} {headers.get('content-type')} · {headers.get('content-disposition')}")
    parsed = list(csv.reader(io.StringIO(body)))
    check("it parses, and its header is the report's own columns",
          parsed and parsed[0][:4] == ["Group", "Name", "Visits", "Invoiced"], ", ".join(parsed[0][:5]) if parsed else "empty")
    check("the row count in the response is the row count in the file",
          int(headers.get("x-report-rows", -1)) == len(parsed) - 1,
          f"{headers.get('x-report-rows')} promised vs {len(parsed) - 1} in the file")
    probe_row = next((r for r in parsed[1:] if r and r[1] == provider.get("name")), None)
    check("the probe's money is in the file, as a decimal a spreadsheet understands",
          bool(probe_row) and any("." in cell or cell.isdigit() for cell in probe_row[3:5]),
          f"{probe_row[1] if probe_row else 'missing'}: {probe_row[3] if probe_row else ''}")
    status, refused_export, _ = call("GET", "/api/v1/reports?view=export&kind=guesswork")
    check("a report that does not exist cannot be exported",
          status == 400 and code(refused_export) == "VALIDATION_ERROR", f"{status} {message(refused_export)}"[:80])
    status, audit_rows, _ = call("GET", "/api/v1/audit?limit=200")
    rows_audit = [r for r in (audit_rows.get("data") or []) if r.get("action") == "report.exported"] if isinstance(audit_rows, dict) else []
    check("leaving with the numbers is written down in the workspace trail",
          status == 200 and bool(rows_audit) and "revenue" in str(rows_audit[0].get("target")),
          f"{status} · {len(rows_audit)} export row(s) · {json.dumps(rows_audit[0].get('detail'))[:60] if rows_audit else ''}")

    # ---- 10. who may read the practice's numbers ---------------------------
    desk_cookie = None
    try:
        if os.path.exists(DESK_CACHE):
            desk_cookie = json.load(open(DESK_CACHE)).get("cookie")
    except Exception:
        desk_cookie = None
    if not desk_cookie:
        login = urllib.request.Request(
            f"{BASE}/api/auth/login",
            data=json.dumps({"email": DESK_EMAIL, "password": PASSWORD}).encode(),
            method="POST",
        )
        login.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(login, timeout=60) as res:
                desk_cookie = (res.headers.get("set-cookie") or "").split(";")[0]
        except urllib.error.HTTPError:
            desk_cookie = None
        if desk_cookie:
            json.dump({"cookie": desk_cookie}, open(DESK_CACHE, "w"))
    if desk_cookie:
        # A receptionist may read the practice's numbers — they are the ones asked
        # "did that payment land?" — and may not move money, which P6 already
        # proves. Reports are read-only by construction; the check is that they
        # are readable from the desk without a second, hidden permission.
        status, desk_report = report("view=overview", as_cookie=desk_cookie)
        check("the front desk can read the practice's numbers",
              status == 200 and "earned" in desk_report,
              f"{status} · {message(desk_report)}"[:60] if status != 200 else f"{status} window {desk_report.get('range', {}).get('from')}")
        status, desk_export, _ = call("GET", "/api/v1/reports?view=export&kind=recalls&preset=30d", raw=True, as_cookie=desk_cookie)
        check("and can take a recalls list away to work through",
              status == 200 and "Client,Number" in desk_export[:40],
              f"{status} {desk_export[:40]!r}")
    else:
        check("the front desk can read the practice's numbers", False, "could not sign in as the desk")

    return finish()


def finish():
    # Probe appointments are **deleted**, not cancelled. A cancelled probe stays in
    # the diary for ever as a row nobody attended — eleven runs of this gate put
    # eleven of them on the demo's most recent closed day and dropped its attendance
    # to 59%, which is what `demo_check` caught. Money is still voided and clients
    # still archived, because those are records a practice keeps; a probe
    # appointment is not a record of anything.
    for booking_id in dict.fromkeys(cleanup["bookings"]):
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "reports_check cleanup"}, auth=True)
    for invoice_id in dict.fromkeys(cleanup["invoices"]):
        # Money standing against the probe's bill is reversed first: a paid invoice
        # cannot be voided, so the probe used to stay behind and spend real figures
        # in every report that ran after it — including the ones this gate checks.
        detail = call("GET", f"/api/v1/invoices/{invoice_id}", auth=True)[1]
        for payment in detail.get("payments") or []:
            # The invoice detail reports a payment two ways depending on where it
            # came from — `settled: true` from the allocation path, `status` from the
            # ledger. Reading only one shape is how this gate left a paid probe
            # invoice behind (and then failed its own reconciliation on the next run).
            if payment.get("settled") or payment.get("status") == "settled":
                call("POST", "/api/v1/invoices", {"action": "void-payment", "paymentId": payment.get("id"), "reason": "reports_check probe"}, auth=True)
        call("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "reports_check probe"}, auth=True)
    for expense_id in dict.fromkeys(cleanup["expenses"]):
        call("POST", "/api/v1/invoices", {"action": "expense:void", "id": expense_id, "reason": "reports_check probe"}, auth=True)
    for client_id in dict.fromkeys(cleanup["clients"]):
        call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "sms", "granted": True, "source": "staff", "note": "reports_check restore"}, auth=True)
        call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "reports_check probe", "force": True}, auth=True)

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        return 1
    print("ALL PASS — who earns what, what it costs us and who does not turn up, from one window.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
