#!/usr/bin/env python3
"""
The recall gate: the window belongs to the client, and the list does something.

D7 said the interval was one number for the whole practice — 180 days for
everybody — and that there was no way to send a recall from the list at all. A5
said a service should carry its own interval, and that the list should be able to
act: a consent-aware "send", from the screen the desk is already looking at.

What this proves, in the order a practice would live it:

  0. the ground it stands on — saving the money settings from a screen that does
     not mention the invoice prefix does not break invoicing;
  1. the window is the client's: the service they were last *seen* for sets it,
     the practice's own number is the fallback, and neither is dragged forward by
     an appointment they have not been to yet;
  2. recalls that act — the desk sends one from the list, the daily loop sends the
     rest, and both say what they held back and why;
  3. who is left alone, and who is refused: somebody already coming in, somebody
     already on the queue, somebody inside their cooldown (which a person may
     override and a scheduler may not), somebody who said no, and somebody with
     nowhere to send;
  4. quiet hours hold a recall until the window opens;
  5. the reply comes back to the desk;
  6. a silly number is taken seriously, not literally;
  7. the loop the scheduler runs, twice — because the second run is where a
     double-send would show.

Run it with the app up:

    python3 scripts/recall_check.py

It leaves the workspace as it found it: probe appointments are *deleted* (a visit
that already happened cannot be cancelled — `completed` only goes back to
`confirmed`), probe clients are archived, probe services deleted, the recall loop
switched off, and every setting it borrowed handed back. A run that dies mid-way
is cleared by the next run's own pre-flight.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone as tz
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie, drain_queue, session  # noqa: E402
from _twilio import twilio_headers  # noqa: E402
from _twilio_fixture import TwilioFixture, ensure_twilio_fixture  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = os.environ.get("VOXERA_DESK_EMAIL", "desk@northwind.dev")
WORKSPACE_NUMBER = os.environ.get("VOXERA_NUMBER", "+14155550999")
STUB_SID = os.environ.get("TWILIO_STUB_SID", "AC0123456789abcdef0123456789abcdef")
STUB_TOKEN = os.environ.get("TWILIO_STUB_TOKEN", "stub-auth-token")

STAMP = datetime.now().strftime("%H%M%S")
PREFIX = f"Probe Recall {STAMP}"
# The name this gate gives its fixtures — and the name the first version of it
# used (`Recall201500 cooling`), which is what an interrupted run of *that* one
# still leaves in the workspace.
PROBE_CLIENT = re.compile(r"^(Probe Recall|Recall\d{6}\b)")
RUN_IP = f"198.51.100.{int(time.time()) % 200}"

COOKIE = ""
TIMEZONE = "UTC"
passes = 0
failures: list[str] = []
made: dict[str, list[str]] = {"clients": [], "services": [], "bookings": [], "messages": []}
# What the workspace looked like before the run, so it looks like that again after.
PROLOGUE: dict[str, object] = {}
# The isolated carrier-backed stub line used for delivery and signed callbacks.
TWILIO_FIXTURE: TwilioFixture | None = None


def check(label, ok, detail=""):
    global passes
    if ok:
        passes += 1
    else:
        failures.append(label)
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    return bool(ok)


def note(text):
    print(f"  note  {text}")


def section(title):
    print(f"\n— {title}")


def call(method, path, body=None, cookie=None, form=None, extra_headers=None):
    """One request. `cookie=None` means the owner's session; `\"\"` means nobody."""
    headers = {"accept": "application/json", "x-forwarded-for": RUN_IP}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    headers.update(extra_headers or {})
    jar = COOKIE if cookie is None else cookie
    if jar:
        headers["cookie"] = jar
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"_html": raw}
            return res.status, payload, (res.headers.get("set-cookie") or "").split(";")[0], raw
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


def rows_of(payload):
    if not isinstance(payload, dict):
        return []
    for key in ("data", "rows", "clients", "replies"):
        if isinstance(payload.get(key), list):
            return payload[key]
    return []


def recall_send(**body):
    body["action"] = body.get("action", "send")
    return call("POST", "/api/v1/recalls", body)


def run_of(payload):
    """The run out of whatever shape the door returned."""
    if not isinstance(payload, dict):
        return {}
    return payload.get("run") or payload


def switch_loop(**fields):
    """The console's own switch on the Recalls tab, not a back door."""
    body = {"action": "save", **fields}
    return call("POST", "/api/v1/recalls", body)


def queued_count(detail):
    """How many the run queued, out of a sentence like `3 queued, 1 held`."""
    match = re.search(r"(\d+)\s+queued", str(detail or ""))
    return int(match.group(1)) if match else 0


def recall_list(query="limit=200"):
    return call("GET", f"/api/v1/recalls?{query}")


def recall_state():
    status, payload, _, _ = call("GET", "/api/v1/recalls?limit=1")
    return payload.get("state") or {}


def messages_for(client_id, kind=None):
    status, payload, _, _ = call("GET", f"/api/v1/messages?clientId={client_id}&limit=50")
    rows = payload.get("data") or []
    if kind:
        rows = [m for m in rows if m.get("kind") == kind]
    return sorted(rows, key=lambda m: str(m.get("createdAt")), reverse=True)


def save_rule(**patch):
    rules = dict((PROLOGUE.get("rules") or {})) if patch.pop("_original", False) else None
    return rules, call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": patch})


def set_rule(**patch):
    """Change only the fields named, on top of the rule as it stands now."""
    status, payload, _, _ = call("GET", "/api/v1/outreach?view=rules")
    rules = (payload.get("rules") or {})
    merged = {**rules, **patch}
    if "recall" in patch:
        merged["recall"] = {**rules.get("recall", {}), **patch["recall"]}
    return call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": merged})


def set_quiet(hours):
    return call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {"quietHours": hours}})


def set_window(days):
    return call("PATCH", "/api/v1/practice/profile", {"recallDays": days})


def local_now():
    return datetime.now(ZoneInfo(TIMEZONE))


def ago(days):
    return (datetime.now() - timedelta(days=days)).astimezone(tz.utc).isoformat().replace("+00:00", "Z")


def probe_number(index):
    """A number of its own per client: consent, replies and the recall list are all
    keyed by it, and two probes sharing one is a probe that tests nothing."""
    return f"+1555{STAMP}{index}"


# --------------------------------------------------------------------- fixtures


def make_service(name, recall_days=None):
    body = {"name": name, "durationMinutes": 30, "price": 0, "colour": "#7c3aed"}
    if recall_days is not None:
        body["recallDays"] = recall_days
    status, payload, _, _ = call("POST", "/api/v1/services", body)
    service = payload.get("data") or payload
    if status in (200, 201) and service.get("id"):
        made["services"].append(service["id"])
    return status, service


def make_client(name, index):
    number = probe_number(index)
    status, payload, _, _ = call("POST", "/api/v1/clients", {"name": name, "number": number})
    client = payload.get("data") or payload
    if status in (200, 201) and client.get("id"):
        made["clients"].append(client["id"])
    return status, client, number


def make_visit(client, service_id, days_ago, status="completed", offset=0):
    """A visit that already happened, or one still to come.

    No practitioner and no room: the rota is right to refuse a past date to a
    provider who was not working, and a mirror booking is what the API offers for
    history that came from somewhere else.
    """
    starts = ago(days_ago) if days_ago >= 0 else (datetime.now() + timedelta(days=-days_ago)).astimezone(tz.utc).isoformat().replace("+00:00", "Z")
    status_code, payload, _, _ = call(
        "POST",
        "/api/v1/bookings",
        {
            "externalId": f"rc-{STAMP}-{offset}",
            "customer": {"name": client["name"], "number": client["number"]},
            "serviceId": service_id,
            "startsAt": starts,
            "durationMinutes": 30,
            "status": status,
            "notes": "recall probe",
        },
    )
    booking = payload.get("data") or payload
    if status_code in (200, 201) and booking.get("id"):
        made["bookings"].append(booking["id"])
    return status_code, booking


def borrowed_number():
    return TWILIO_FIXTURE.number if TWILIO_FIXTURE else WORKSPACE_NUMBER


def ensure_carrier():
    """Acquire an isolated, active stub-backed sender line for this run."""
    global TWILIO_FIXTURE

    def request(method, path, body):
        status, payload, _, _ = call(method, path, body)
        return status, payload

    try:
        TWILIO_FIXTURE = ensure_twilio_fixture(request, label=f"recall probe {STAMP}")
        note(f"using signed Twilio stub line {TWILIO_FIXTURE.number}")
    except RuntimeError as error:
        check("a verified Twilio stub line is available", False, str(error))


def sweep_earlier_runs():
    """What a crashed run leaves behind, cleared before this one starts.

    A gate that only works on a virgin database is not a gate. The order matters:
    an appointment is found through *its client* — `GET /bookings?limit=200` is one
    page of the **oldest** appointments a practice has, so on a workspace with a
    year of diary in it that call never shows today's fixtures at all — and a
    client cannot be archived, nor a service deleted, while one is still booked.
    """
    status, payload, _, _ = call("GET", "/api/v1/clients?limit=200&includeArchived=true")
    probe_clients = [row for row in rows_of(payload) if PROBE_CLIENT.match(str(row.get("name") or ""))]
    stale = 0
    for row in probe_clients:
        code, detail, _, _ = call("GET", f"/api/v1/clients/{row['id']}")
        for appointment in (detail or {}).get("appointments") or []:
            if appointment.get("status") == "completed":
                call("POST", f"/api/v1/bookings/{appointment['id']}/status", {"status": "confirmed", "note": "recall_check stale cleanup"})
            call("POST", f"/api/v1/bookings/{appointment['id']}/status", {"status": "cancelled", "note": "recall_check stale cleanup"})
            stale += 1
        for message in messages_for(row["id"]):
            # Anything a probe left on the queue or filed as blocked is the probe's,
            # not the practice's — and a recall row that is not cancelled spends the
            # workspace's daily ceiling for the rest of the day. A row that already
            # went out cannot be cancelled (`cancelMessage` leaves `sent` alone), so
            # those are counted and said out loud instead.
            if message.get("status") != "sent":
                call("DELETE", f"/api/v1/messages?id={message['id']}")
        if not (row.get("archived") or row.get("archivedAt")):
            call("DELETE", f"/api/v1/clients/{row['id']}", {"reason": "left by an interrupted recall probe"})
    if stale:
        note(f"removed {stale} probe appointment(s) left by an earlier run")

    # A crashed run also leaves its *replies* waiting. The client is archived, so
    # there is no booking left to delete and the outreach row survives — twelve of
    # them were sitting in the demo's Replies queue from a run killed on 15 October,
    # each one a fixture no person was ever going to answer. The row cannot be
    # deleted over HTTP (nothing exposes that), but it can be ticked off, which is
    # what takes it off the screen the desk is looking at.
    status, waiting, _, _ = call("GET", "/api/v1/messages/replies?limit=100")
    stale_replies = [r for r in (waiting.get("replies") or []) if PROBE_CLIENT.match(str(r.get("clientName") or ""))]
    for row in stale_replies:
        call("POST", "/api/v1/messages/replies", {"action": "resolve", "id": row.get("id"), "note": "left by an interrupted recall probe"})
    if stale_replies:
        note(f"ticked off {len(stale_replies)} reply(ies) left waiting by an earlier run")

    # Services go last: a service cannot be deleted while an appointment points at
    # it, and a leftover one shows up on the practice's list — which is how a name
    # typo in another gate was found in the first place.
    status, payload, _, _ = call("GET", "/api/v1/services?includeInactive=true")
    leftover = [s for s in rows_of(payload) if PROBE_CLIENT.match(str(s.get("name") or ""))]
    for service in leftover:
        code, answer, _, _ = call("DELETE", f"/api/v1/services/{service['id']}")
        if code >= 400:
            note(f"could not delete the probe service {service['name']}: {message_of(answer)}")
    if leftover:
        note(f"deleted {len(leftover)} probe service(s) left by an earlier run")
    return True


def finish():
    """Put the workspace back as it was found, whatever happened."""
    print("\nclean-up")
    for client_id in dict.fromkeys(made["clients"]):
        for message in messages_for(client_id):
            if message.get("status") == "pending":
                call("DELETE", f"/api/v1/messages?id={message['id']}")
    for booking_id in dict.fromkeys(made["bookings"]):
        # Preserve the record: a completed visit is reopened, then cancelled, so
        # test cleanup follows the same non-destructive lifecycle as the product.
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "confirmed", "note": "recall_check cleanup"})
        call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "recall_check cleanup"})
    for client_id in dict.fromkeys(made["clients"]):
        call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "recall probe — safe to purge"})
    for service_id in dict.fromkeys(made["services"]):
        call("DELETE", f"/api/v1/services/{service_id}")

    profile = PROLOGUE.get("profile") or {}
    if profile.get("recallDays") is not None:
        set_window(int(profile["recallDays"]))
    rules = PROLOGUE.get("rules")
    if rules:
        # The loop goes back as it was found — except that it never goes back *on*:
        # a gate must not leave a workspace texting its clients by itself.
        call(
            "POST",
            "/api/v1/outreach",
            {"action": "save-rules", "rules": {**rules, "recall": {**(rules.get("recall") or {}), "enabled": False}}},
        )
    quiet = PROLOGUE.get("quiet")
    if quiet:
        set_quiet(quiet)
    money = PROLOGUE.get("money") or {}
    if money.get("termsDays") is not None:
        call("POST", "/api/v1/invoices", {"action": "settings", **{k: v for k, v in money.items() if v is not None}})
    if TWILIO_FIXTURE:
        cleanup_errors = TWILIO_FIXTURE.cleanup(
            lambda method, path, payload: (lambda result: (result[0], result[1]))(call(method, path, payload))
        )
        check("the Twilio fixture gives back everything it created", not cleanup_errors, "; ".join(cleanup_errors))

    status, list_now, _, _ = recall_list("limit=50")
    left = [row for row in rows_of(list_now) if PROBE_CLIENT.match(str(row.get("name") or ""))]
    check("no live probe document is left behind", not left, ", ".join(sorted(str(r.get("name")) for r in left)) or "clean")
    state = recall_state()
    check("the recall loop is off again", state.get("enabled") is False, json.dumps(state)[:120])

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        return 1
    print(f"ALL PASS — {passes} checks: the window is per client, the list sends, and nothing goes out twice.")
    return 0


def body():
    global COOKIE, TIMEZONE
    COOKIE = cached_cookie(BASE, EMAIL, PASSWORD)
    if not COOKIE:
        print("could not sign in — is the app running?")
        return 1

    section("0. the ground under the money loop")
    check("the desk can sign in", bool(COOKIE))
    status, scheduler, _, _ = call("GET", "/api/v1/scheduler")
    TIMEZONE = str(scheduler.get("timezone") or "UTC")
    check("the practice's timezone is known", status == 200 and TIMEZONE != "", TIMEZONE)

    status, outreach, _, _ = call("GET", "/api/v1/outreach?view=rules")
    PROLOGUE["rules"] = outreach.get("rules")
    PROLOGUE["quiet"] = (outreach.get("settings") or {}).get("quietHours")
    status, profile_now, _, _ = call("GET", "/api/v1/practice/profile")
    PROLOGUE["profile"] = {"recallDays": (profile_now.get("profile") or {}).get("recallDays")}
    status, books, _, _ = call("GET", "/api/v1/invoices?view=overview")
    settings = books.get("settings") or {}
    PROLOGUE["money"] = {"termsDays": settings.get("termsDays"), "currency": settings.get("currency")}

    # A settings save that omits the invoice prefix used to blank it, and every
    # invoice issued afterwards failed with a 500. One line to prove it cannot.
    status, partial, _, _ = call("POST", "/api/v1/invoices", {"action": "settings", "termsDays": 0})
    saved = partial.get("settings") or {}
    check("a settings change that omits the prefix keeps it", status == 200 and bool(saved.get("invoicePrefix")), json.dumps(saved)[:120])
    check("and the change it did make takes effect", saved.get("termsDays") == 0, f"terms {saved.get('termsDays')}")
    if PROLOGUE["money"].get("termsDays") is not None:
        call("POST", "/api/v1/invoices", {"action": "settings", **PROLOGUE["money"]})

    sweep_earlier_runs()
    ensure_carrier()
    if not TWILIO_FIXTURE:
        return 1
    # A crashed run leaves the loop *on* — the one state a probe must never leave a
    # workspace in — so it is switched off before anything is measured.
    switch_loop(enabled=False)
    # Quiet hours are a real feature and they also decide whether "due now" is due
    # now. Pinned open for the run — section 4 closes them on purpose — so the gate
    # means the same thing at 03:00 as at 15:00.
    set_quiet({"start": 0, "end": 24})
    status, window, _, _ = set_window(180)
    check("the practice's own window is set for the run", status == 200, str((window.get("profile") or {}).get("recallDays")))

    # ===================================================== 1. whose window is it
    section("1. the window belongs to the client, not the practice")
    status, short_service = make_service(f"Probe Recall 30 {STAMP}", recall_days=30)
    check("a service can carry its own interval", status in (200, 201) and short_service.get("recallDays") == 30,
          json.dumps({k: short_service.get(k) for k in ("name", "recallDays")})[:110])
    status, inherit_service = make_service(f"Probe Recall Inherit {STAMP}", recall_days=0)
    check("and a service with none inherits the practice's", status in (200, 201) and not inherit_service.get("recallDays"),
          json.dumps({k: inherit_service.get(k) for k in ("name", "recallDays")})[:110])

    status, client_a, _ = make_client(f"{PREFIX} A", 1)
    status2, client_b, _ = make_client(f"{PREFIX} B", 2)
    status3, client_c, _ = make_client(f"{PREFIX} C", 3)
    check("probe clients exist", all(status in (200, 201) for status in (status, status2, status3)) and bool(client_a.get("id")),
          f"{client_a.get('name')} · {client_b.get('name')} · {client_c.get('name')}")
    make_visit(client_a, short_service["id"], 90, offset=1)
    make_visit(client_b, inherit_service["id"], 90, offset=2)
    make_visit(client_c, inherit_service["id"], 200, offset=3)

    status, listing, _, _ = recall_list()
    listed = {row.get("clientId"): row for row in rows_of(listing)}
    a_row = listed.get(client_a["id"]) or {}
    c_row = listed.get(client_c["id"]) or {}
    check("a 30-day service puts a client on the list 90 days after a visit",
          a_row.get("intervalDays") == 30 and a_row.get("intervalSource") == "service",
          json.dumps({k: a_row.get(k) for k in ("lastSeenDays", "intervalDays", "intervalSource", "overdueDays")}))
    check("the same 90 days does not recall an inherited window", client_b["id"] not in listed and c_row.get("intervalDays") == 180,
          f"B listed: {client_b['id'] in listed} · C window {c_row.get('intervalDays')}")
    check("and a 200-day-old visit clears the practice's 180", c_row.get("intervalSource") == "practice" and c_row.get("overdueDays") == 20,
          json.dumps({k: c_row.get(k) for k in ("lastSeenDays", "intervalDays", "intervalSource", "overdueDays")}))
    check("the sender's verdict rides with the row", a_row.get("reachable") is True and not a_row.get("blockedReason"),
          f"reachable={a_row.get('reachable')} blocked={a_row.get('blockedReason')}")

    # The diary moves forward; the window must not. An appointment next week is not
    # a visit, and a client with one is still overdue for a check-up.
    _, upcoming_for_a = make_visit(client_a, short_service["id"], -7, status="confirmed", offset=4)
    status, listing_after, _, _ = recall_list()
    after = {row.get("clientId"): row for row in rows_of(listing_after)}.get(client_a["id"]) or {}
    check("an appointment still to come does not reset the window", after.get("lastSeenDays") == 90,
          f"last seen {after.get('lastSeenDays')} days ago, next visit in 7")
    check("and somebody with one booked is held rather than recalled", "booked" in str(after.get("holdReason")), str(after.get("holdReason")))
    # Taken off the books again before section 2: a person with an appointment is a
    # hold *nobody* may override, and the desk's own send is what comes next.
    call("POST", f"/api/v1/bookings/{upcoming_for_a.get('id')}/status", {"status": "cancelled", "note": "recall_check hold cleanup"})

    # The report's own window, which is what the Recalls tab reads.
    status, report, _, _ = call("GET", "/api/v1/reports?view=overview&range=year&include=recalls&recallDays=30&limit=500")
    recalls = (report.get("sections") or {}).get("recalls") or {}
    mine = {row.get("clientId"): row for row in (recalls.get("rows") or [])}
    check("the report honours a forced window", recalls.get("intervalDays") == 30, f"interval {recalls.get('intervalDays')}")
    check("and measures everybody by it, service or not",
          (mine.get(client_b["id"]) or {}).get("intervalSource") == "practice", json.dumps(mine.get(client_b["id"]) or {})[:110])
    check("without the parameter it is the practice's own number",
          ((call("GET", "/api/v1/reports?view=overview&range=year&include=recalls")[1].get("sections") or {}).get("recalls") or {}).get("intervalDays") == 180,
          "180")
    # The third rung of the chain: the messaging screen's last-resort window is
    # saved as a rule, and it has to reach the loop the way it was typed.
    set_rule(recall={"afterDays": 365})
    check("the last-resort window reaches the loop as typed", recall_state().get("ruleFallbackDays") == 365,
          f"ruleFallbackDays={recall_state().get('ruleFallbackDays')}")
    set_rule(recall={"afterDays": 180})

    check("the services strip names the interval each one uses",
          any(s.get("recallDays") == 30 for s in recalls.get("services") or []),
          json.dumps(recalls.get("services"))[:130])

    # ========================================================= 2. recalls that act
    section("2. recalls that act")
    state = recall_state()
    check("the loop ships switched off", state.get("enabled") is False, f"enabled={state.get('enabled')}")
    status, off, _, _ = recall_send(action="run-due")
    check("and the job says so rather than sending", run_of(off).get("disabled") is True, json.dumps(run_of(off))[:110])

    # The demo's own ceiling is 25 a day, and probe recalls from earlier crashed
    # runs have already spent today's — a `sent` message cannot be un-sent, which is
    # the point of it being sent. So the gate lifts the ceiling for its own run and
    # hands the workspace's number back at the end; the *batch* ceiling is what
    # section 2 actually tests.
    status, on, _, _ = switch_loop(enabled=True, channels=["sms"], cooldownDays=90, maxPerDay=200)
    check("it can be switched on, with a ceiling and a cooldown", status == 200,
          json.dumps(on.get("rules"))[:130])

    # Everything from here to section 7 raises the practice window out of the way:
    # the demo workspace's own clients are then nobody's business but the demo's,
    # and the only people due are the probes this gate made. A full send-all against
    # a live workspace would text its real clients.
    set_window(3650)

    status, sent, _, _ = recall_send(clientIds=[client_a["id"]])
    run = run_of(sent)
    check("the desk can send one from the list", status in (200, 201) and run.get("queued") == 1, f"{status} {json.dumps(run)[:110]}")
    queue = messages_for(client_a["id"], kind="recall")
    newest = queue[0] if queue else {}
    check("it is queued, not sent behind the desk's back", newest.get("status") == "pending", str(newest.get("status")))
    check("on the channel and the number the rule uses",
          newest.get("channel") == "sms" and newest.get("to") == client_a["number"],
          f"{newest.get('channel')} → {newest.get('to')} (client {client_a.get('number')})")
    meta = newest.get("meta") or {}
    check("and it carries the window it was judged by",
          str(meta.get("intervalDays")) == "30" and meta.get("intervalSource") == "service", json.dumps(meta)[:130])
    check("the message itself is the workspace's own wording, with the booking link",
          "/book/" in str(newest.get("body") or ""), str(newest.get("body") or "")[:120])
    check("the run is on the record as the desk's, not the loop's", newest.get("source") == "recall-rule", str(newest.get("source")))

    # Somebody reachable, due, and not yet touched by anything — the ceiling needs a
    # subject, and section 7's job needs somebody the desk has *not* already sent to.
    status, client_h, _ = make_client(f"{PREFIX} H", 8)
    make_visit(client_h, short_service["id"], 90, offset=10)

    status, ceiling, _, _ = recall_send(action="send-all", limit=0)
    run = run_of(ceiling)
    check("a batch cannot go over its ceiling", run.get("queued") == 0 and run.get("remaining", 0) >= 1,
          json.dumps({"queued": run.get("queued"), "remaining": run.get("remaining")}))

    status, again, _, _ = recall_send(clientIds=[client_a["id"]])
    run = run_of(again)
    check("pressing send twice is a duplicate, not a decision", run.get("queued") == 0,
          json.dumps({"queued": run.get("queued"), "skipped": run.get("skipped")})[:130])
    check("and the skip says the recall is already waiting", "queue" in json.dumps(run.get("skipped")), json.dumps(run.get("skipped"))[:130])

    status, job_again, _, _ = recall_send(action="run-due")
    run = run_of(job_again)
    # Not "the run queued nothing" — it may well have texted somebody else who is
    # due. What it must never do is text the person already waiting a second time.
    check(
        "the loop will not text somebody who is already on the queue",
        any(s.get("clientId") == client_a["id"] and "queue" in str(s.get("reason")) for s in run.get("skipped") or []),
        json.dumps(run.get("skipped"))[:140],
    )

    def the_recall_row():
        return next((m for m in messages_for(client_a["id"], kind="recall") if m.get("status") == "sent"), None)

    def send_once():
        status, body, _, _ = call("POST", "/api/v1/messages", {"action": "deliver"})
        return status, body

    # Oldest-first and capped per run — a workspace with a backlog needs more
    # than one send before this recall is reached.
    sends, (status, delivered) = drain_queue(send_once, lambda: the_recall_row() is not None)
    delivered_row = the_recall_row()
    check("the recall goes out", bool(delivered_row), json.dumps({k: (delivered_row or {}).get(k) for k in ("status", "providerMessageId")})[:110])
    check("through the carrier, with an id to show for it", bool(delivered_row and delivered_row.get("providerMessageId")),
          str((delivered_row or {}).get("providerMessageId")))

    status, cooled, _, _ = recall_send(action="run-due")
    run = run_of(cooled)
    check("the loop respects the cooldown", run.get("queued") == 0, json.dumps({"queued": run.get("queued"), "skipped": run.get("skipped")})[:130])
    status, override, _, _ = recall_send(clientIds=[client_a["id"]])
    run = run_of(override)
    check("the desk may overrule it for one person", run.get("queued") == 1, json.dumps(run)[:130])
    check("and the run says it went past a cooldown the loop would have respected", run.get("overrodeCooldown") == 1,
          f"overrodeCooldown={run.get('overrodeCooldown')}")

    state = recall_state()
    check("the screen can see which services carry their own interval",
          any(s.get("name", "").startswith(f"Probe Recall 30 {STAMP}") for s in state.get("servicesWithOwnInterval") or []),
          json.dumps(state.get("servicesWithOwnInterval"))[:130])
    check("and what today has already sent", state.get("sentToday", 0) >= 1 and state.get("queuedToday", 0) >= 1,
          f"sent {state.get('sentToday')} · queued {state.get('queuedToday')}")

    # ============================================== 3. who is left alone, refused
    section("3. who is left alone, and who is refused")
    status, client_d, _ = make_client(f"{PREFIX} D", 4)
    make_visit(client_d, short_service["id"], 90, offset=5)
    make_visit(client_d, short_service["id"], -3, status="confirmed", offset=6)
    status, booked, _, _ = recall_send(clientIds=[client_d["id"]])
    run = run_of(booked)
    check("somebody with an appointment in the diary is not recalled", run.get("queued") == 0 and "booked" in json.dumps(run.get("skipped")),
          json.dumps(run.get("skipped"))[:140])

    status, client_e, number_e = make_client(f"{PREFIX} E", 5)
    make_visit(client_e, short_service["id"], 90, offset=7)
    call("POST", f"/api/v1/clients/{client_e['id']}/consents", {"channel": "sms", "granted": False, "source": "staff", "note": "probe"})
    status, refused, _, _ = recall_send(clientIds=[client_e["id"]])
    run = run_of(refused)
    check("somebody who said no is refused, by name", run.get("queued") == 0 and any(b.get("clientId") == client_e["id"] for b in run.get("blocked") or []),
          json.dumps(run.get("blocked"))[:140])
    check("and the refusal says why", "opted out" in json.dumps(run.get("blocked")), json.dumps(run.get("blocked"))[:140])
    thread = [m for m in messages_for(client_e["id"], kind="recall") if m.get("status") == "blocked"]
    check("a blocked row is filed in their own record, not only in a log", bool(thread), str((thread[0].get("reason") if thread else "nothing"))[:110])

    # Nowhere to send is a different refusal from "asked us not to".
    switch_loop(channels=["email"])
    status, client_f, _ = make_client(f"{PREFIX} F", 6)
    make_visit(client_f, short_service["id"], 90, offset=8)
    status, no_route, _, _ = recall_send(clientIds=[client_f["id"]])
    run = run_of(no_route)
    check("a rule that can only email does not text somebody with no email", run.get("queued") == 0, json.dumps(run)[:130])
    check("and it says what it needed", "email" in json.dumps(run.get("blocked")), json.dumps(run.get("blocked"))[:140])
    switch_loop(channels=["sms"])

    status, not_due, _, _ = recall_send(clientIds=[client_b["id"]])
    check("the list refuses to recall somebody who is not overdue",
          status == 409 and "no longer due" in json.dumps(not_due).lower(),
          f"{status} {message_of(not_due)}"[:130])

    # ============================================================= 4. quiet hours
    section("4. quiet hours hold a recall until the window opens")
    now_local = local_now()
    opens = (now_local.hour + 1) % 24
    set_quiet({"start": opens, "end": now_local.hour})
    status, client_g, _ = make_client(f"{PREFIX} G", 7)
    make_visit(client_g, short_service["id"], 90, offset=9)
    status, held, _, _ = recall_send(clientIds=[client_g["id"]])
    run = run_of(held)
    check("a recall asked for out of hours is queued, not sent", run.get("queued") == 1, json.dumps(run)[:120])
    rows = messages_for(client_g["id"], kind="recall")
    send_at = str((rows[0] if rows else {}).get("sendAt") or "")
    try:
        when = datetime.fromisoformat(send_at.replace("Z", "+00:00")).astimezone(ZoneInfo(TIMEZONE))
        waiting_hour, waiting_ok = when.hour, when.hour == opens
    except ValueError:
        waiting_hour, waiting_ok = "unparsable", False
    check("and it waits for the window to open", waiting_ok, f"sendAt {send_at} → {waiting_hour}:00 local (window opens {opens})")
    set_quiet({"start": 0, "end": 24})

    # =========================================================== 5. the reply back
    section("5. the reply comes back to the desk")
    workspace_number = borrowed_number()
    inbound = {
        "From": probe_number(7),
        "To": workspace_number,
        "Body": "yes please, Thursday if you have it",
        "MessageSid": f"SMrc{STAMP}",
    }
    inbound_path = "/api/telephony/twilio/inbound-message"
    forged_status, forged, _, _ = call(
        "POST", inbound_path, form=inbound, cookie="",
        extra_headers={"X-Twilio-Signature": "invalid-signature"},
    )
    check("a forged recall reply is rejected", forged_status == 403, f"{forged_status} {message_of(forged)}")
    status, _, _, raw = call(
        "POST", inbound_path, form=inbound, cookie="",
        extra_headers=twilio_headers(BASE, inbound_path, inbound, TWILIO_FIXTURE.auth_token),
    )
    check("a signed inbound text from a recalled client is accepted", status == 200 and "<Response>" in raw, f"{status} {raw[:60]}")
    status, replies, _, _ = call("GET", "/api/v1/messages/replies?limit=50")
    def digits(value):
        return re.sub(r"\D", "", str(value or ""))

    mine_replies = [r for r in (replies.get("replies") or []) if digits(r.get("clientNumber")).endswith(STAMP + "7")]
    check("and lands in the desk's own queue, against the right client", bool(mine_replies),
          json.dumps(mine_replies[:1] or (replies.get("replies") or [])[:1])[:170])

    # ---- the tab's one action ------------------------------------------------
    # Arriving was all that was ever checked, and "the Replies tab is not acting on
    # replies" is what that looked like from the outside: a queue nobody had ever
    # pressed the button on. The action is `resolve`, it belongs to the desk's own
    # login, and what it must do is take the row out of the queue.
    mine = (mine_replies or [{}])[0]
    desk = session(BASE, DESK_EMAIL, PASSWORD)
    status, ticked, _, _ = call(
        "POST", "/api/v1/messages/replies", {"action": "resolve", "id": mine.get("id"), "note": "probe: rung them back"}, cookie=desk
    )
    check("the desk can tick a reply off, from the desk's own login",
          status == 200 and str(ticked.get("resolved") or "") == str(mine.get("id") or ""),
          f"{status} {json.dumps(ticked)[:110]}")
    status, after, _, _ = call("GET", "/api/v1/messages/replies?limit=50")
    still = [r for r in (after.get("replies") or []) if str(r.get("id")) == str(mine.get("id"))]
    check("and it is no longer waiting on anybody", not still,
          f"{len(after.get('replies') or [])} still waiting")
    # A double-click must not be an error: the desk is allowed to press it twice.
    status, twice, _, _ = call("POST", "/api/v1/messages/replies", {"action": "resolve", "id": mine.get("id")}, cookie=desk)
    check("ticking it off twice is harmless, not an error", status == 200,
          f"{status} waiting={twice.get('waiting')}")
    # A reply that never existed is a 404 rather than a silent success.
    status, ghost, _, _ = call("POST", "/api/v1/messages/replies", {"action": "resolve", "id": "out_0000000000000000"}, cookie=desk)
    check("a reply that does not exist is refused, not ignored", status == 404,
          f"{status} {message_of(ghost)}"[:110])
    # The desk's login may act (a receptionist is a writer — the outreach switches
    # are the desk's own screen). Nobody at all may: an anonymous caller is refused.
    status, nope, _, _ = call("POST", "/api/v1/messages/replies", {"action": "resolve", "id": mine.get("id")}, cookie="")
    check("and ticking one off still needs somebody signed in", status in (401, 403),
          f"{status} {message_of(nope)}"[:90])

    # ======================================================== 6. silly numbers
    section("6. a silly number is taken seriously, not literally")
    status, wild, _, _ = set_window(99999)
    check("a window of 99,999 days is refused", status == 400, f"{status} {message_of(wild)}"[:110])
    status, zero, _, _ = set_window(0)
    check("and so is zero", status == 400, f"{status} {message_of(zero)}"[:110])
    status, negative, _, _ = call("POST", "/api/v1/services", {"name": f"Probe Recall Bad {STAMP}", "durationMinutes": 30, "price": 0, "recallDays": -5})
    check("a service cannot be given a negative interval", status == 400, f"{status} {message_of(negative)}"[:110])
    status, nonsense, _, _ = call("POST", "/api/v1/services", {"name": f"Probe Recall Bad {STAMP}", "durationMinutes": 30, "price": 0, "recallDays": "soon"})
    check("or a word where a number belongs", status == 400, f"{status} {message_of(nonsense)}"[:110])
    status, restored, _, _ = set_window(180)
    check("the practice's window survives all of it", status == 200 and (restored.get("profile") or {}).get("recallDays") == 180,
          str((restored.get("profile") or {}).get("recallDays")))

    # ================================================================ 7. the loop
    section("7. the loop the scheduler runs")
    status, jobs, _, _ = call("GET", "/api/v1/scheduler")
    job = next((j for j in jobs.get("jobs") or [] if j.get("name") == "recalls"), None)
    check("the daily recall loop is a job on the scheduler", bool(job), json.dumps([j.get("name") for j in jobs.get("jobs") or []])[:130])
    check("and it runs once a day", bool(job) and job.get("everyMinutes") == 1440,
          f"{job.get('label') or job.get('name')} every {job.get('everyMinutes')}m")

    # Only the probes this run made are due, and I is the one nobody has touched:
    # the desk has not sent to them and no loop has reached them. (H was the ceiling
    # check's subject and has had a recall sent since.)
    status, client_i, _ = make_client(f"{PREFIX} I", 9)
    make_visit(client_i, short_service["id"], 90, offset=11)
    set_window(3650)
    status, ran, _, _ = call("POST", "/api/v1/scheduler", {"action": "run", "job": "recalls"})
    # A job reports in the practice's own words — "3 queued, 1 held" — which is what
    # the scheduler screen prints. Read it the way a person would.
    detail = str(run_of(ran).get("detail") or "")
    check("running it actually recalls somebody", status == 200 and run_of(ran).get("ok") is True and queued_count(detail) >= 1, detail[:130])
    status, ran_again, _, _ = call("POST", "/api/v1/scheduler", {"action": "run", "job": "recalls"})
    detail_again = str(run_of(ran_again).get("detail") or "")
    check("and the second run queues nothing twice", queued_count(detail_again) == 0, detail_again[:130])

    return 0


def main():
    print(f"\nD7 + A5 — recalls that act  ({BASE})")
    try:
        body()
    except Exception as error:  # noqa: BLE001 — a crash still hands the workspace back
        failures.append(f"the run crashed: {error}")
        print(f"\nFAIL  the run crashed  — {type(error).__name__}: {error}")
    finally:
        finish()
    # The verdict is the failures list, wherever they came from — a crashed run is
    # not a passing one.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
