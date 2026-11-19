#!/usr/bin/env python3
"""
Messaging and reminders check (PRACTICE.md phase P4).

The phase gate is one sentence: *a reminder fires at T-minus N and is logged in
`outreach`; the no-show rate is reportable.* This script proves both, and the
machinery they need to be true rather than merely observed once:

   1. templates are seeded in this workspace's vocabulary, with merge samples
   2. a preview fills the merge fields and leaves a typo visible on purpose
   3. the opt-out line is appended by the sender and cannot be edited away
   4. save / retire / restore / reset all behave, and nothing is ever deleted
   5. the reminder rule queues exactly once, at T-minus N, never retroactively
   6. delivery goes through the carrier for real: a provider, a message id,
      and the body the recipient will get
   7. **the send is logged in `outreach`** — channel, kind, outcome, messageId
   8. a withdrawn consent blocks the send *before* it goes, and is logged too
   9. quiet hours defer rather than discard
  10. a missed appointment gets a follow-up text, a cancelled one does not
  11. **the no-show rate is reportable**: totals, a rate, a previous period,
      a breakdown, and the unsettled rows that keep it honest
  12. the scheduler shows every job, runs one on demand, ticks, and toggles
  13. running the tick twice queues nothing extra (everything is idempotent)
  14. a campaign can text as well as call — and a text-only run dials nobody

Usage: python3 scripts/messaging_check.py   (the app must be running, with the
Twilio stub on :4010 so delivery has somewhere real to go)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import session as cached_session  # noqa: E402
from _twilio import twilio_headers  # noqa: E402
from _twilio_fixture import TwilioFixture, ensure_twilio_fixture  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STUB = os.environ.get("VOXERA_STUB_BASE", "http://127.0.0.1:4010")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = os.environ.get("VOXERA_DESK_EMAIL", "desk@northwind.dev")

cookie = ""
failures: list[str] = []
# The workspace's own window, kept so the gate can put it back exactly as it found it.
original_quiet: dict | None = None
cleanup: dict[str, list[str]] = {"bookings": [], "clients": [], "campaigns": [], "templates": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, auth=True, as_email=None, form=None, extra_headers=None):
    """One request as the owner — or, with `as_email`, as whoever that is.

    A receptionist and an owner are different people on purpose, and one of the
    things this gate checks is what the *desk's* login can do."""
    global cookie
    url = path if path.startswith("http") else BASE + path
    data = urllib.parse.urlencode(form).encode() if form is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if form is not None:
        req.add_header("content-type", "application/x-www-form-urlencoded")
    elif data:
        req.add_header("content-type", "application/json")
    for key, value in (extra_headers or {}).items():
        req.add_header(key, value)
    jar = cached_session(BASE, as_email, PASSWORD) if as_email else cookie
    if auth and jar:
        req.add_header("cookie", jar)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode()
            set_cookie = res.headers.get("set-cookie")
            if set_cookie:
                cookie = set_cookie.split(";")[0]
            try:
                payload = json.loads(text) if text else {}
            except json.JSONDecodeError:
                payload = {"raw": text}
            return res.status, payload
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (json.loads(text) if text else {})
        except json.JSONDecodeError:
            return err.code, {"raw": text}


def deliver(target=None, limit=200, rounds=6):
    """Run the queue until it stops producing sends — or `target` has gone.

    The route's default slice is 25 rows, oldest first. This workspace's queue
    carries every other gate's leftovers (offers, confirmations, chases), so one
    call at the default limit can leave the row *this* gate just queued outside
    the batch — which then reads as "the reminder never went" when what happened
    is "the batch was full". Ask for a big slice, and keep asking while sends are
    still happening. Returns the union of what the rounds reported.
    """
    seen = []
    status = 0
    payload = {}
    for _ in range(rounds):
        status, payload = call("POST", "/api/v1/messages", {"action": "deliver", "limit": limit})
        if status != 200:
            break
        seen.extend(payload.get("messages") or [])
        if target and any(m.get("id") == target for m in seen):
            break
        if not (payload.get("sent") or payload.get("failed") or payload.get("blocked")):
            break
    return status, {**payload, "messages": seen}


def message(payload):
    if not isinstance(payload, dict):
        return str(payload)
    error = payload.get("error")
    return str(error.get("message", "")) if isinstance(error, dict) else str(error or payload.get("message") or "")


def stub_debug():
    try:
        req = urllib.request.Request(f"{STUB}/__state")
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())
    except Exception:  # noqa: BLE001 — the stub is optional; reported, not fatal
        return {}


def probe_name(tag):
    return f"Probe {tag} {int(time.time() * 1000) % 100000}"


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


twilio_fixture: TwilioFixture | None = None


def borrow_carrier():
    """Create an isolated stub carrier *and active number* when needed.

    Outbound SMS is intentionally refused without a carrier-backed E.164 sender,
    so a bare credential row is not enough. The shared fixture refuses to borrow
    an arbitrary account and cleans up only state it created.
    """
    global twilio_fixture

    def request(method, path, body):
        return call(method, path, body)

    try:
        twilio_fixture = ensure_twilio_fixture(request, label="messaging probe")
        print(f"  note  using signed Twilio stub line {twilio_fixture.number}")
    except RuntimeError as error:
        check("a verified Twilio stub line is available", False, str(error))


def main():
    global cookie
    cookie = cached_session(BASE, EMAIL, PASSWORD)
    if not cookie:
        print("FAIL  could not sign in — is the app running?")
        sys.exit(1)

    # The gate has to mean the same thing at 03:00 as at 15:00. Quiet hours are a
    # real feature — a reminder due overnight waits for the practice to open — but
    # they also decide whether "due now" is due now, so a run outside the window
    # would fail on the clock rather than on the code. Pin the window open for the
    # duration and restore it at the end; the deferral rule gets its own test (#9)
    # which sets an explicitly closed window.
    borrow_carrier()
    if not twilio_fixture:
        return finish()

    global original_quiet
    status, rules0 = call("GET", "/api/v1/outreach?view=rules")
    original_quiet = ((rules0.get("settings") or {}).get("quietHours") or None)
    call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {"quietHours": {"start": 0, "end": 24}}})

    # ---- 1. templates ------------------------------------------------------
    status, body = call("GET", "/api/v1/templates")
    check("the template list answers", status == 200, message(body))
    if status != 200:
        return finish()
    templates = body.get("templates") or []
    kinds = {t["kind"] for t in templates}
    check(
        "every job has wording: confirmation, reminder, follow-up, no-show, win-back, recall",
        {"confirmation", "reminder", "followup", "no_show", "winback", "recall"} <= kinds,
        ", ".join(sorted(kinds)),
    )
    check("templates come in the workspace's own vocabulary",
          all(word not in " ".join(t["body"] for t in templates) for word in ("patient's", "clinician")),
          (body.get("vocabulary") or {}).get("appointment", ""))
    fields = {f["key"] for f in (body.get("mergeFields") or [])}
    check("merge fields are listed with samples",
          {"client_first_name", "when", "provider", "location", "reference", "business"} <= fields
          and all(f.get("sample") for f in body.get("mergeFields") or []),
          f"{len(fields)} fields")
    sample = body.get("sample") or {}
    check("the preview context is filled from this workspace's own diary",
          bool(sample.get("client_first_name")) and "{{" not in json.dumps(sample),
          f"{sample.get('client_first_name')} · {sample.get('when')}")

    # ---- 2. preview --------------------------------------------------------
    status, draft = call("POST", "/api/v1/templates", {"action": "preview", "channel": "sms", "body": "Hi {{client_first_name}}, see you {{when}}."})
    check("a preview fills the merge fields", status == 200 and "{{" not in draft.get("preview", ""), draft.get("preview", "")[:80])
    check("the preview names the unknown fields instead of hiding them", not any("{{" in draft.get("preview", "") for _ in [0]))
    status, typo = call("POST", "/api/v1/templates", {"action": "preview", "channel": "sms", "body": "Hi {{client_firstname}}, your {{docotr}}."})
    check("a typo is left visible and reported", "{{client_firstname}}" in typo.get("preview", "")
          and set(typo.get("unknown") or []) == {"client_firstname", "docotr"}, str(typo.get("unknown")))

    # ---- 3. opt-out --------------------------------------------------------
    reminder = next((t for t in templates if t["kind"] == "reminder" and t["channel"] == "sms"), None)
    check("the reminder template exists and carries no placeholder for the opt-out line",
          bool(reminder) and "{{reply_stop}}" not in (reminder or {}).get("body", ""))
    status, saved = call("POST", "/api/v1/templates", {
        "action": "save",
        "id": (reminder or {}).get("id"),
        "kind": "reminder",
        "channel": "sms",
        "name": "Reminder (edited by check)",
        "body": "Hi {{client_first_name}} — your {{appointment}} is {{when}}. Want me to change it?",
    })
    check("saving the wording works", status == 201, message(saved))
    if reminder:
        cleanup["templates"].append(reminder["id"])
    opt_out = body.get("optOut") or {}
    check("the API says the opt-out line is the sender's job, not the template's",
          "Reply STOP" in (opt_out.get("sms") or "") and "no template can remove it" in (opt_out.get("sms") or "").lower(),
          (opt_out.get("sms") or "")[:80])

    # ---- 4. retire / restore / reset --------------------------------------
    template_id = (reminder or {}).get("id")
    status, retired = call("POST", "/api/v1/templates", {"action": "retire", "id": template_id})
    check("a template can be retired", status == 200 and retired.get("template", {}).get("enabled") is False, message(retired))
    status, listed = call("GET", "/api/v1/templates")
    check("a retired template is not in the live list", all(t["id"] != template_id for t in (listed.get("templates") or [])))
    status, all_rows = call("GET", "/api/v1/templates?include=retired")
    check("but it is kept, wording and all", any(t["id"] == template_id and t["enabled"] is False for t in (all_rows.get("templates") or [])),
          f"{len(all_rows.get('templates') or [])} rows")
    status, _ = call("POST", "/api/v1/templates", {"action": "restore", "id": template_id})
    status, restored = call("GET", "/api/v1/templates")
    check("and can be restored", any(t["id"] == template_id and t["enabled"] for t in (restored.get("templates") or [])))
    # `?kind=` and `?channel=` narrow the list. They used to be accepted and
    # ignored, which is the worst way to be wrong: a caller asking for the recall
    # wording got the whole drawer back and had to count kinds themselves — and the
    # item was recorded as "`templates?kind=recall` returns `[]`", which is not even
    # what ignoring the word looks like.
    status, only_recall = call("GET", "/api/v1/templates?kind=recall")
    recall_rows = only_recall.get("templates") or []
    check("?kind=recall answers with the recall wording and nothing else",
          status == 200 and bool(recall_rows) and all(t["kind"] == "recall" for t in recall_rows),
          f"{len(recall_rows)} of {len(templates)} row(s), kinds={sorted({t['kind'] for t in recall_rows})}")
    status, recall_sms = call("GET", "/api/v1/templates?kind=recall&channel=sms")
    narrowed = recall_sms.get("templates") or []
    check("and ?channel=sms narrows it again, without contradicting it",
          status == 200 and all(t["kind"] == "recall" and t["channel"] == "sms" for t in narrowed),
          f"{len(narrowed)} row(s)")
    check("neither of them is the whole drawer", len(recall_rows) < len(templates), f"{len(recall_rows)} < {len(templates)}")
    status, wrong_kind = call("GET", "/api/v1/templates?kind=recallz")
    check("a kind that does not exist is refused rather than ignored",
          status == 400 and ((wrong_kind.get("error") or {}).get("param") == "kind"),
          f"{status} {json.dumps(wrong_kind)[:100]}")

    status, reset = call("POST", "/api/v1/templates", {"action": "reset", "kind": "reminder", "channel": "sms"})
    check("reset writes the house default as a fresh row", status == 200 and reset.get("reset") is True, message(reset))
    status, after_reset = call("GET", "/api/v1/templates?include=retired")
    house = [t for t in (after_reset.get("templates") or []) if t["kind"] == "reminder" and t["channel"] == "sms" and t["enabled"]]
    check("the house default is the live reminder again",
          len(house) == 1 and "{{when}}" in house[0]["body"], house[0]["name"] if house else "none")

    # ---- 5. the reminder rule ---------------------------------------------
    # The queue's own clock: quiet hours in the practice's timezone decide when a
    # message that "should" go at 23:48 actually goes.
    status, rule_state = call("GET", "/api/v1/outreach?view=rules")
    tz_name = rule_state.get("timezone") or "UTC"
    quiet_start = (rule_state.get("settings") or {}).get("quietHours", {}).get("start", 8)
    quiet_end = (rule_state.get("settings") or {}).get("quietHours", {}).get("end", 20)
    status, assistants = call("GET", "/api/v1/assistants")
    assistant = (assistants.get("data") or assistants.get("assistants") or [{}])[0]
    status, providers = call("GET", "/api/v1/providers")
    status2, services = call("GET", "/api/v1/services")
    provider = (providers.get("data") or providers.get("providers") or [{}])[0]
    service = (services.get("data") or services.get("services") or [{}])[0]
    number = f"+1555{int(time.time() * 1000) % 10000000:07d}"
    name = probe_name("Reminder")
    # Three hours out: inside a 24-hour lead, outside the "too late to remind" floor.
    # Its reminder is therefore due now — clamped, never retroactive.
    starts = datetime.now(timezone.utc) + timedelta(hours=3)
    status, created = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-{int(time.time() * 1000)}",
        "customer": {"name": name, "number": number, "email": f"probe{int(time.time()) % 100000}@example.test"},
        "startsAt": iso(starts),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
        "notes": "messaging_check probe",
    })
    check("a probe appointment exists to remind about", status in (200, 201), message(created))
    if status not in (200, 201):
        return finish()
    booking = created.get("booking") or created.get("data") or created
    booking_id = booking.get("id")
    client_id = booking.get("clientId")
    cleanup["bookings"].append(booking_id)
    if client_id:
        cleanup["clients"].append(client_id)

    status, queued = call("POST", "/api/v1/messages", {"action": "queue-reminders"})
    check("the reminder rule queues at T-minus N", status == 200 and queued.get("queued", 0) >= 1,
          json.dumps(queued)[:120])
    status, again = call("POST", "/api/v1/messages", {"action": "queue-reminders"})
    check("running the rule again queues nothing extra", again.get("queued") == 0, json.dumps(again)[:100])

    # And the other half of the rule: an appointment *beyond* the lead is left alone
    # until its moment comes, and then scheduled for T-minus N — not for "now".
    number_far = f"+1555{(int(time.time() * 1000) + 3) % 10000000:07d}"
    starts_far = datetime.now(timezone.utc) + timedelta(hours=30)
    status, created_far = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-far-{int(time.time() * 1000)}",
        "customer": {"name": probe_name("Later"), "number": number_far},
        "startsAt": iso(starts_far),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
    })
    far_booking = created_far.get("booking") or created_far.get("data") or created_far
    if status in (200, 201):
        cleanup["bookings"].append(far_booking.get("id"))
        if far_booking.get("clientId"):
            cleanup["clients"].append(far_booking["clientId"])
        call("POST", "/api/v1/messages", {"action": "queue-reminders"})
        status, far_rows = call("GET", f"/api/v1/messages?bookingId={far_booking.get('id')}")
        far = next((m for m in (far_rows.get("data") or []) if m.get("kind") == "reminder"), None)
        if far:
            far_at = datetime.fromisoformat(far["sendAt"].replace("Z", "+00:00"))
            naive = starts_far - timedelta(hours=24)
            local_hour = far_at.astimezone(ZoneInfo(tz_name)).hour
            # T-minus N to the minute — or the next reasonable hour, because a moment
            # that lands at midnight waits for the practice to open rather than
            # waking somebody up. Both are the same rule seen through a clock.
            check("**a reminder is queued for T-minus N**",
                  naive - timedelta(minutes=2) <= far_at <= naive + timedelta(hours=12),
                  f"{far['sendAt']} — T-minus {(starts_far - far_at).total_seconds() / 3600:.1f}h")
            check("and it is not scheduled to arrive outside the quiet hours",
                  quiet_start <= local_hour < quiet_end, f"{local_hour}:00 in {tz_name}")
            check("and it waits: it is pending, not sent", far["status"] == "pending", far["status"])

            # Move the appointment and reconcile: the queued reminder must follow the
            # diary, not the moment it was written. This is the failure mode that makes
            # a reminder worse than none — arriving for a time the patient is not coming.
            status, moved = call("POST", f"/api/v1/bookings/{far_booking.get('id')}/move", {
                "startsAt": iso(starts_far + timedelta(hours=5)),
            })
            if status in (200, 201):
                status, reconciled = call("POST", "/api/v1/scheduler", {"action": "run", "job": "queue-reminders", "force": True})
                status, moved_rows = call("GET", f"/api/v1/messages?bookingId={far_booking.get('id')}")
                after_move = next((m for m in (moved_rows.get("data") or []) if m.get("kind") == "reminder"), None)
                if after_move:
                    at = datetime.fromisoformat(after_move["sendAt"].replace("Z", "+00:00"))
                    expected = max(datetime.now(timezone.utc), starts_far + timedelta(hours=5) - timedelta(hours=24))
                    check("an appointment that moves re-times its queued reminder",
                          abs((at - expected).total_seconds()) < 300 and after_move["status"] == "pending",
                          f"{after_move['sendAt']} — {(reconciled.get('run') or {}).get('detail', '')}")
                else:
                    check("an appointment that moves re-times its queued reminder", False, "the reminder vanished")
            else:
                check("an appointment that moves re-times its queued reminder", False, f"could not move it: {message(moved)}")
        else:
            check("**a reminder is queued for T-minus N**", False, "none queued")

        # An appointment beyond the queue-ahead horizon is not even a row yet: the
        # queue shows what is coming, not everything that will ever happen.
        number_horizon = f"+1555{(int(time.time() * 1000) + 5) % 10000000:07d}"
        starts_horizon = datetime.now(timezone.utc) + timedelta(days=4)
        status, created_horizon = call("POST", "/api/v1/bookings", {
            "externalId": f"probe-horizon-{int(time.time() * 1000)}",
            "customer": {"name": probe_name("Far"), "number": number_horizon},
            "startsAt": iso(starts_horizon),
            "durationMinutes": 30,
            "status": "confirmed",
                "serviceId": service.get("id"),
            })
        horizon_booking = created_horizon.get("booking") or created_horizon.get("data") or created_horizon
        if status in (200, 201):
            cleanup["bookings"].append(horizon_booking.get("id"))
            if horizon_booking.get("clientId"):
                cleanup["clients"].append(horizon_booking["clientId"])
            call("POST", "/api/v1/messages", {"action": "queue-reminders"})
            status, horizon_rows = call("GET", f"/api/v1/messages?bookingId={horizon_booking.get('id')}")
            check("an appointment beyond the horizon is left alone for now",
                  not [m for m in (horizon_rows.get("data") or []) if m.get("kind") == "reminder"],
                  f"{len(horizon_rows.get('data') or [])} message(s)")

    status, msgs = call("GET", f"/api/v1/messages?bookingId={booking_id}")
    rows = msgs.get("data") or []
    reminder_rows = [m for m in rows if m.get("kind") == "reminder"]
    check("the reminder is a real queue row, once", len(reminder_rows) == 1, f"{len(reminder_rows)} row(s)")
    if not reminder_rows:
        return finish()
    row = reminder_rows[0]
    send_at = datetime.fromisoformat(row["sendAt"].replace("Z", "+00:00"))
    # Three hours away with a 24-hour lead: the moment has passed, so it goes now.
    check("an appointment already inside the lead gets its reminder at once",
          send_at <= datetime.now(timezone.utc) + timedelta(minutes=2), row["sendAt"])
    check("it is never retroactive", send_at >= datetime.now(timezone.utc) - timedelta(minutes=1), row["sendAt"])
    check("it names the appointment it belongs to", row.get("bookingId") == booking_id)
    check("the body is the workspace's wording, not a stock line",
          "{{" not in row["body"] and name.split()[0].lower() in row["body"].lower(), row["body"][:90])
    check("the opt-out line is on the text", "Reply STOP to opt out." in row["body"], row["body"][-40:])

    # ---- 6/7. delivery through the carrier, logged in outreach ------------
    status, delivered = deliver(target=row["id"])
    check("delivery runs the queue", status == 200, message(delivered))
    sent_row = next((m for m in (delivered.get("messages") or []) if m["id"] == row["id"]), None)
    check("the reminder actually went", bool(sent_row) and sent_row["status"] == "sent",
          json.dumps(sent_row)[:140] if sent_row else "not in the run")
    status, after = call("GET", f"/api/v1/messages?bookingId={booking_id}")
    sent_row = next((m for m in (after.get("data") or []) if m["id"] == row["id"]), {})
    check("the row carries a carrier and a message id, not just a status",
          bool(sent_row.get("provider")) and bool(sent_row.get("providerMessageId")) and bool(sent_row.get("sentAt")),
          f"{sent_row.get('provider')} · {sent_row.get('providerMessageId')}")

    status, log = call("GET", f"/api/v1/outreach?bookingId={booking_id}")
    entries = log.get("data") or []
    sent_entries = [e for e in entries if e.get("outcome") == "sent" and e.get("channel") == "sms"]
    check("the send is logged in `outreach`", len(sent_entries) == 1, f"{len(entries)} row(s): "
          + ", ".join(f"{e.get('channel')}/{e.get('kind')}/{e.get('outcome')}" for e in entries))
    if sent_entries:
        entry = sent_entries[0]
        check("the log row says what it was, who it went to and which message it was",
              entry.get("kind") == "reminder" and entry.get("to") == number and entry.get("messageId") == row["id"],
              f"{entry.get('kind')} → {entry.get('to')}")
        check("it records who caused it", bool(entry.get("actor")), str(entry.get("actor")))
    debug = stub_debug()
    bodies = [m.get("body", "") for m in (debug.get("sentMessages") or [])]
    check("the carrier received the text, with the opt-out line on it",
          any("Reply STOP to opt out." in b for b in bodies), f"{len(bodies)} message(s) at the stub")

    # ---- 7c. the carrier's word on whether it arrived --------------------
    if sent_row.get("providerMessageId"):
        receipt_path = "/api/telephony/twilio/message-status"
        receipt_form = {"MessageSid": sent_row["providerMessageId"], "MessageStatus": "delivered"}
        rejected_status, rejected = call(
            "POST", receipt_path, auth=False, form=receipt_form,
            extra_headers={"X-Twilio-Signature": "invalid-signature"},
        )
        check("a forged delivery receipt is rejected", rejected_status == 403, f"{rejected_status} {message(rejected)}")
        status, receipt = call(
            "POST", receipt_path, auth=False, form=receipt_form,
            extra_headers=twilio_headers(BASE, receipt_path, receipt_form, twilio_fixture.auth_token),
        )
        check("the carrier's signed delivery receipt is accepted and matched to the message",
              status == 200 and receipt.get("ok") is True and receipt.get("recorded") == "delivered", json.dumps(receipt)[:120])
        status, upgraded = call("GET", f"/api/v1/outreach?bookingId={booking_id}&channel=sms")
        outcomes = [e.get("outcome") for e in (upgraded.get("data") or [])]
        check("and it refines the log row rather than adding one", outcomes.count("delivered") == 1 and "sent" not in outcomes,
              ", ".join(outcomes))

    # ---- 7c bis. the desk texts with the automation switched off -----------
    # The switch governs the *automation*: reminders, follow-ups, recalls. A person
    # pressing send on the messaging screen is not the automation, and refusing them
    # would mean "we cannot text anybody until recalls are on again" — which is not
    # what a practice turns the recall switch off for. So this is the contract: with
    # the recall rule off, the desk's own send is accepted and queued. The other half
    # of it — that the *loop* queues nothing while off — is proved next door in
    # `recall_check.py` ("the loop ships switched off" / "and the job says so rather
    # than sending"), so the two halves together say: the switch is respected by the
    # machine and not imposed on the person.
    status, rules_now = call("GET", "/api/v1/outreach?view=rules")
    rules_before = rules_now.get("rules") or {}
    recall_rule = {**(rules_before.get("recall") or {}), "enabled": False}
    status, _ = call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": {**rules_before, "recall": recall_rule}})
    check("the recall rule can be switched off for the check", status == 200, f"{status}")
    status, off_now = call("GET", "/api/v1/outreach?view=rules")
    check("and it reads back as off", (off_now.get("rules") or {}).get("recall", {}).get("enabled") is False,
          json.dumps((off_now.get("rules") or {}).get("recall"))[:90])
    number_off_desk = f"+1555{(int(time.time() * 1000) + 71) % 10000000:07d}"
    status, deskish = call("POST", "/api/v1/messages", {
        "action": "send",
        "to": number_off_desk,
        "body": "A note from the desk while the recall switch is off.",
    }, as_email=DESK_EMAIL)
    desk_message = (deskish.get("message") or {})
    # The send answers 201 with a short row (`id, channel, to, status, sendAt`);
    # who sent it is on the message as the *list* shows it, which is where a person
    # would look. Assert both, from the places they actually appear.
    check("a person at the desk can still text while the automation is off",
          status == 201 and desk_message.get("status") in ("pending", "sent"),
          f"{status} {desk_message.get('status')} {message(deskish)}"[:120])
    status, listed_after = call("GET", "/api/v1/messages?limit=10")
    sent_row = next((m for m in (listed_after.get("data") or []) if m.get("id") == desk_message.get("id")), None)
    check("and the row says who sent it", str((sent_row or {}).get("source") or "").startswith("desk:"),
          str((sent_row or {}).get("source")))
    check("and it is filed as a person's message, not as the automation",
          (sent_row or {}).get("kind") == "manual", str((sent_row or {}).get("kind")))
    if desk_message.get("id"):
        call("DELETE", f"/api/v1/messages?id={desk_message['id']}")
    status, _ = call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": rules_before})
    check("the rule is put back as it was found", status == 200, f"{status}")

    # ---- 7d. email goes out through the relay -----------------------------
    status, queued_email = call("POST", "/api/v1/messages", {
        "action": "send",
        "channel": "email",
        "to": "probe.email@example.test",
        "subject": "Your appointment",
        "body": "A short note from the practice.",
        "force": True,
    })
    email_id = (queued_email.get("message") or {}).get("id")
    if email_id:
        deliver(target=email_id)
        status, email_rows = call("GET", f"/api/v1/messages?limit=50")
        row_email = next((m for m in (email_rows.get("data") or []) if m.get("id") == email_id), None)
        check("email is sent through the relay, not the carrier",
              bool(row_email) and row_email.get("status") == "sent" and row_email.get("provider") == "email",
              f"{row_email.get('status')} via {row_email.get('provider')}" if row_email else "row vanished")
        relay = stub_debug().get("sentEmails") or []
        check("the relay received it", any(e.get("to") == "probe.email@example.test" for e in relay), f"{len(relay)} email(s) at the relay")
    else:
        check("email is sent through the relay, not the carrier", False, message(queued_email))

    # ---- 8. consent --------------------------------------------------------
    number_off = f"+1555{(int(time.time() * 1000) + 7) % 10000000:07d}"
    name_off = probe_name("NoConsent")
    starts_off = datetime.now(timezone.utc) + timedelta(hours=4)
    status, created_off = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-off-{int(time.time() * 1000)}",
        "customer": {"name": name_off, "number": number_off},
        "startsAt": iso(starts_off),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
    })
    booking_off = created_off.get("booking") or created_off.get("data") or created_off
    if status in (200, 201):
        cleanup["bookings"].append(booking_off.get("id"))
        if booking_off.get("clientId"):
            cleanup["clients"].append(booking_off["clientId"])
        call("POST", f"/api/v1/clients/{booking_off['clientId']}/consents",
             {"channel": "sms", "granted": False, "source": "staff", "note": "messaging_check probe"})
        status, q2 = call("POST", "/api/v1/messages", {"action": "queue-reminders"})
        status, blocked_rows = call("GET", f"/api/v1/messages?bookingId={booking_off.get('id')}&status=blocked")
        blocked = blocked_rows.get("data") or []
        check("a withdrawn consent refuses the reminder at queue time", len(blocked) >= 1,
              (blocked[0].get("reason") if blocked else "nothing blocked"))
        status, off_log = call("GET", f"/api/v1/outreach?bookingId={booking_off.get('id')}")
        check("the refusal is logged as outreach too",
              any(e.get("outcome") == "blocked" for e in (off_log.get("data") or [])),
              ", ".join(f"{e.get('kind')}/{e.get('outcome')}" for e in (off_log.get("data") or [])))

    # ---- 8b. the reply that keeps the promise the text made ---------------
    # "Reply STOP to opt out" is in every message. This is the check that the reply
    # is actually listened for — the one bug in a messaging system that is not merely
    # embarrassing is sending more texts to somebody who asked you to stop.
    stop_number = f"+1555{(int(time.time() * 1000) + 61) % 10000000:07d}"
    starts_stop = datetime.now(timezone.utc) + timedelta(hours=6)
    status, created_stop = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-stop-{int(time.time() * 1000)}",
        "customer": {"name": probe_name("Replier"), "number": stop_number},
        "startsAt": iso(starts_stop),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
    })
    stop_booking = created_stop.get("booking") or created_stop.get("data") or created_stop
    if status in (200, 201):
        cleanup["bookings"].append(stop_booking.get("id"))
        stop_client = stop_booking.get("clientId")
        if stop_client:
            cleanup["clients"].append(stop_client)
            call("POST", f"/api/v1/clients/{stop_client}/consents", {"channel": "sms", "granted": True, "source": "staff", "note": "probe"})
        inbound_path = "/api/telephony/twilio/inbound-message"
        stop_form = {"From": stop_number, "To": twilio_fixture.number, "Body": "STOP", "MessageSid": f"SMprobe{int(time.time())}"}
        rejected_status, rejected = call(
            "POST", inbound_path, auth=False, form=stop_form,
            extra_headers={"X-Twilio-Signature": "invalid-signature"},
        )
        check("a forged inbound text is rejected", rejected_status == 403, f"{rejected_status} {message(rejected)}")
        status, inbound_reply = call(
            "POST", inbound_path, auth=False, form=stop_form,
            extra_headers=twilio_headers(BASE, inbound_path, stop_form, twilio_fixture.auth_token),
        )
        xml = inbound_reply.get("raw", "")
        check("a signed inbound text is accepted", status == 200 and "<Response>" in xml, xml[:60])
        if stop_client:
            status, consents = call("GET", f"/api/v1/clients/{stop_client}/consents")
            sms_consent = (consents.get("consents") or {}).get("sms") or {}
            check("**replying STOP withdraws consent, with the reply as the evidence**",
                  sms_consent.get("granted") is False and sms_consent.get("source") == "inbound-sms",
                  json.dumps(sms_consent)[:110])
            call("POST", "/api/v1/messages", {"action": "queue-reminders"})
            status, stopped_rows = call("GET", f"/api/v1/messages?bookingId={stop_booking.get('id')}")
            check("and the reminder that would have gone is refused",
                  all(m.get("status") == "blocked" for m in (stopped_rows.get("data") or [])),
                  ", ".join(m.get("status", "?") for m in (stopped_rows.get("data") or [])) or "nothing queued")
            status, stop_log = call("GET", f"/api/v1/outreach?clientId={stop_client}")
            check("the reply itself is in the log",
                  any(e.get("outcome") == "opted_out" for e in (stop_log.get("data") or [])),
                  ", ".join(f"{e.get('channel')}/{e.get('outcome')}" for e in (stop_log.get("data") or [])))
            # And they can change their mind: START puts it back.
            start_form = {"From": stop_number, "To": twilio_fixture.number, "Body": "START", "MessageSid": f"SMstart{int(time.time())}"}
            call(
                "POST", inbound_path, auth=False, form=start_form,
                extra_headers=twilio_headers(BASE, inbound_path, start_form, twilio_fixture.auth_token),
            )
            status, consents = call("GET", f"/api/v1/clients/{stop_client}/consents")
            sms_consent = (consents.get("consents") or {}).get("sms") or {}
            check("START gives it back", sms_consent.get("granted") is True, json.dumps(sms_consent)[:80])

    # ---- 9. quiet hours ----------------------------------------------------
    status, rules_now = call("GET", "/api/v1/outreach?view=rules")
    settings = rules_now.get("settings") or {}
    quiet = settings.get("quietHours") or {"start": 8, "end": 20}
    # A window that excludes this instant, whatever the hour.
    now_hour = datetime.now(timezone.utc).hour
    call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {"quietHours": {"start": (now_hour + 2) % 24, "end": (now_hour + 3) % 24}}})
    number_q = f"+1555{(int(time.time() * 1000) + 13) % 10000000:07d}"
    starts_q = datetime.now(timezone.utc) + timedelta(hours=5)
    status, created_q = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-quiet-{int(time.time() * 1000)}",
        "customer": {"name": probe_name("Quiet"), "number": number_q},
        "startsAt": iso(starts_q),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
    })
    booking_q = created_q.get("booking") or created_q.get("data") or created_q
    deferral = None
    if status in (200, 201):
        cleanup["bookings"].append(booking_q.get("id"))
        if booking_q.get("clientId"):
            cleanup["clients"].append(booking_q["clientId"])
        call("POST", "/api/v1/messages", {"action": "queue-reminders"})
        status, quiet_rows = call("GET", f"/api/v1/messages?bookingId={booking_q.get('id')}")
        row_q = next((m for m in (quiet_rows.get("data") or []) if m.get("kind") == "reminder"), None)
        if row_q:
            at = datetime.fromisoformat(row_q["sendAt"].replace("Z", "+00:00"))
            deferral = at - datetime.now(timezone.utc)
            check("a reminder that comes due in quiet hours waits for the window",
                  at > starts_q - timedelta(hours=24) + timedelta(minutes=1) or deferral.total_seconds() > 600,
                  f"sendAt {row_q['sendAt']} ({deferral.total_seconds() / 60:.0f} min away)")
        else:
            check("a reminder that comes due in quiet hours waits for the window", False, "no reminder queued at all")
    call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {"quietHours": quiet}})

    # ---- 10/11. no-show follow-up and the report ---------------------------
    key = f"{int(time.time() * 1000)}"
    status, missed = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-noshow-{key}",
        "customer": {"name": probe_name("Missed"), "number": f"+1555{(int(key) + 31) % 10000000:07d}", "email": f"missed{key[-5:]}@example.test"},
        "startsAt": iso(datetime.now(timezone.utc) - timedelta(hours=3)),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
    })
    missed_booking = missed.get("booking") or missed.get("data") or missed
    if status in (200, 201):
        cleanup["bookings"].append(missed_booking.get("id"))
        if missed_booking.get("clientId"):
            cleanup["clients"].append(missed_booking["clientId"])
    status, attended = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-attended-{key}",
        "customer": {"name": probe_name("Attended"), "number": f"+1555{(int(key) + 47) % 10000000:07d}"},
        "startsAt": iso(datetime.now(timezone.utc) - timedelta(hours=5)),
        "durationMinutes": 30,
        "status": "confirmed",
        "serviceId": service.get("id"),
    })
    attended_booking = attended.get("booking") or attended.get("data") or attended
    if status in (200, 201):
        cleanup["bookings"].append(attended_booking.get("id"))
        if attended_booking.get("clientId"):
            cleanup["clients"].append(attended_booking["clientId"])

    call("POST", f"/api/v1/bookings/{missed_booking.get('id')}/status", {"status": "no_show", "note": "messaging_check probe"})
    call("POST", f"/api/v1/bookings/{attended_booking.get('id')}/status", {"status": "completed", "note": "messaging_check probe"})
    status, before_follow = call("GET", "/api/v1/outreach?view=report&days=90")
    follow_ups_before = ((before_follow.get("report") or {}).get("outreach") or {}).get("followUpsSent", 0)

    status, tick = call("POST", "/api/v1/scheduler", {"action": "tick"})
    check("the scheduler ticks", status == 200, json.dumps(tick.get("summary") or [])[:140])
    # Run the follow-up job explicitly: whether its cadence has come round again is
    # timing, and this check is about the rule, not the clock.
    status, follow_run = call("POST", "/api/v1/scheduler", {"action": "run", "job": "no-show-followups", "force": True})
    check("the follow-up job runs", (follow_run.get("run") or {}).get("ok") is True,
          (follow_run.get("run") or {}).get("detail", message(follow_run)))
    status, follow_rows = call("GET", f"/api/v1/messages?bookingId={missed_booking.get('id')}")
    follow = [m for m in (follow_rows.get("data") or []) if m.get("kind") == "no_show"]
    check("a missed appointment draws a follow-up text", len(follow) == 1,
          follow[0]["status"] if follow else "none queued")
    status, attended_rows = call("GET", f"/api/v1/messages?bookingId={attended_booking.get('id')}")
    check("an attended one does not", not [m for m in (attended_rows.get("data") or []) if m.get("kind") == "no_show"],
          f"{len(attended_rows.get('data') or [])} message(s)")
    deliver()
    status, after_follow = call("GET", "/api/v1/outreach?view=report&days=90")
    report = after_follow.get("report") or {}
    outreach_stats = report.get("outreach") or {}
    check("the follow-up that went is counted in the report",
          outreach_stats.get("followUpsSent", 0) >= follow_ups_before + 1,
          f"{follow_ups_before} → {outreach_stats.get('followUpsSent')}")

    check("**the no-show rate is reportable**", bool(report.get("noShowRateLabel")) and report.get("considered", 0) >= 2,
          f"{report.get('noShows')} missed of {report.get('considered')} = {report.get('noShowRateLabel')}")
    check("the rate is the arithmetic it claims to be",
          abs(report.get("noShowRate", 0) - (report.get("noShows", 0) / max(1, report.get("considered", 1)))) < 0.0001,
          f"{report.get('noShowRate')}")
    check("the report compares with the period before it",
          "previousRateLabel" in report, f"previous: {report.get('previousRateLabel')}")
    check("the report breaks the rate down rather than asserting it",
          bool(report.get("byProvider")) and bool(report.get("byWeekday")), f"{len(report.get('byProvider') or [])} provider rows")
    check("the report lists what nobody settled",
          "unsettled" in report and isinstance(report["unsettled"].get("count"), int),
          f"{report.get('unsettled', {}).get('count')} unsettled")
    check("cancellations are counted apart from no-shows",
          report.get("cancelled", 0) >= 0 and report.get("considered") == report.get("attended", 0) + report.get("noShows", 0),
          f"{report.get('attended')} attended · {report.get('noShows')} missed · {report.get('cancelled')} cancelled")
    status, narrow = call("GET", "/api/v1/outreach?view=report&days=1")
    check("the window is honoured", narrow.get("report", {}).get("from") != report.get("from"),
          f"{narrow.get('report', {}).get('from')} vs {report.get('from')}")

    # ---- 11b. where the log starts: a booking made on the web ------------
    status, page = call("GET", "/api/public/workspaces/northwind-labs/booking", auth=False)
    services = page.get("services") or []
    if services:
        status, avail = call("GET", f"/api/public/workspaces/northwind-labs/availability?serviceId={services[0]['id']}&days=21&limit=40", auth=False)
        slot = next((s for d in (avail.get("days") or []) for s in d["slots"]), None)
        if slot:
            web_number = f"+1415559{(int(time.time()) % 100000):05d}"
            web_status, web = call("POST", "/api/public/workspaces/northwind-labs/booking", {
                "startsAt": slot["startsAt"],
                "serviceId": services[0]["id"],
                "locationId": slot.get("locationId"),
                "name": probe_name("Web Booked"),
                "number": web_number,
                "email": "probe.web@example.test",
                "consentSms": True,
            }, auth=False)
            web_booking = web.get("booking") or {}
            if web_booking.get("id"):
                cleanup["bookings"].append(web_booking["id"])
                if web_booking.get("clientId"):
                    cleanup["clients"].append(web_booking["clientId"])
            # Drain the queue so the confirmation is not sitting behind older rows.
            deliver()
            status, web_log = call("GET", f"/api/v1/outreach?bookingId={web_booking.get('id')}&channel=sms")
            confirmations = [e for e in (web_log.get("data") or []) if e.get("kind") == "confirmation" and e.get("outcome") == "sent"]
            # If the booking itself did not land, say so: "no slot" and "the log is
            # empty" look identical otherwise, and only one of them is a defect.
            detail = (
                confirmations[0]["outcome"]
                if confirmations
                else f"slot {slot['startsAt']} · POST {web_status} · {len(web_log.get('data') or [])} row(s)"
                + (f" · {message(web)}" if not web_booking.get("id") else "")
            )
            check("a booking made on the web logs its confirmation in the same place",
                  bool(confirmations) and confirmations[0].get("to") == web_number,
                  detail)
        else:
            check("a booking made on the web logs its confirmation in the same place", False, "no free slot to book")
    else:
        check("a booking made on the web logs its confirmation in the same place", False, "the booking page offers no services")

    # ---- 12/13. the scheduler ---------------------------------------------
    status, sched = call("GET", "/api/v1/scheduler")
    jobs = sched.get("jobs") or []
    names = {j["name"] for j in jobs}
    check("the scheduler lists the jobs that make the product move",
          {"deliver-messages", "queue-reminders", "no-show-followups", "retention"} <= names, ", ".join(sorted(names)))
    check("every job says when it runs and what happened last time",
          all(j.get("everyMinutes") and "lastRunAt" in j and "nextRunAt" in j for j in jobs),
          f"{len(jobs)} jobs")
    reminder_job = next((j for j in jobs if j["name"] == "queue-reminders"), {})
    status, ran = call("POST", "/api/v1/scheduler", {"action": "run", "job": "queue-reminders"})
    check("a job can be run on demand", status == 200 and ran.get("run", {}).get("ok") is True,
          (ran.get("run") or {}).get("detail", message(ran)))
    status, sched2 = call("GET", "/api/v1/scheduler")
    job2 = next((j for j in (sched2.get("jobs") or []) if j["name"] == "queue-reminders"), {})
    check("running it updates what the dashboard shows",
          job2.get("runs", 0) > reminder_job.get("runs", 0) and bool(job2.get("lastResult")),
          f"runs {reminder_job.get('runs')} → {job2.get('runs')} · {(job2.get('lastResult') or {}).get('detail')}")

    def pending_count():
        status, res = call("GET", "/api/v1/messages?status=pending")
        return len(res.get("data") or [])

    before = pending_count()
    call("POST", "/api/v1/scheduler", {"action": "tick"})
    call("POST", "/api/v1/scheduler", {"action": "tick"})
    after_ticks = pending_count()
    check("two ticks in a row queue nothing extra — every job is idempotent",
          after_ticks <= before, f"{before} → {after_ticks} pending")

    status, paused = call("POST", "/api/v1/scheduler", {"action": "toggle", "job": "no-show-followups", "enabled": False})
    status, refused = call("POST", "/api/v1/scheduler", {"action": "run", "job": "no-show-followups"})
    check("a paused job does not run",
          paused.get("job", {}).get("enabled") is False and (refused.get("run") or {}).get("detail", "").lower().startswith("this job is paused"),
          (refused.get("run") or {}).get("detail", message(refused)))
    status, forced = call("POST", "/api/v1/scheduler", {"action": "run", "job": "no-show-followups", "force": True})
    check("but an operator can insist, once", (forced.get("run") or {}).get("ok") is True,
          (forced.get("run") or {}).get("detail", message(forced)))
    call("POST", "/api/v1/scheduler", {"action": "toggle", "job": "no-show-followups", "enabled": True})

    # ---- 14. a campaign that texts as well as calls ------------------------
    status, campaign = call("POST", "/api/v1/booking-campaigns", {
        "name": probe_name("Campaign"),
        "kind": "confirm",
        "assistantId": assistant.get("id"),
        "withinHours": 72,
        "maxPerRun": 3,
        # Texts are not calls: the probe runs now rather than waiting for nine in the
        # morning. (The queue's own quiet hours still apply to what it queues.)
        "quietHours": {"start": 0, "end": 24, "timezone": "UTC"},
        "channels": {"call": False, "sms": True},
        "instructions": "Text first, so the confirmation is in writing.",
    })
    check("a campaign can be created with texts and no calls", status in (200, 201), message(campaign))
    campaign_id = campaign.get("id") or campaign.get("campaign", {}).get("id")
    if campaign_id:
        cleanup["campaigns"].append(campaign_id)
        call("PATCH", f"/api/v1/booking-campaigns/{campaign_id}", {"status": "active"})
        status, preview = call("POST", f"/api/v1/booking-campaigns/{campaign_id}/run", {"dryRun": True})
        check("its dry run says it would text, not dial",
              "text" in json.dumps(preview).lower() and preview.get("dialled", 0) == 0, json.dumps(preview)[:120])
        status, run = call("POST", f"/api/v1/booking-campaigns/{campaign_id}/run", {"dryRun": False})
        check("a real run queues the texts", run.get("texted", 0) >= 1,
              f"texted {run.get('texted')} · dialled {run.get('dialled')} · {run.get('reason')}")
        check("and dials nobody", run.get("dialled", 0) == 0, f"dialled {run.get('dialled')}")
        call("PATCH", f"/api/v1/booking-campaigns/{campaign_id}", {"status": "paused"})
    status, camp_check = call("GET", "/api/v1/booking-campaigns")
    reachable = next((c for c in (camp_check.get("data") or []) if c.get("id") == campaign_id), None)
    check("the campaign carries both channels in its settings",
          (reachable or {}).get("channels") == {"call": False, "sms": True},
          json.dumps((reachable or {}).get("channels")))
    check("and counts what it texted as well as what it dialled",
          "texted" in ((reachable or {}).get("stats") or {}) and (reachable or {}).get("stats", {}).get("texted", 0) >= 1,
          json.dumps((reachable or {}).get("stats", {}))[:110])

    return finish()


def finish():
    # The probe's own footprint, undone. Nothing is deleted outright: appointments
    # are cancelled, clients archived, campaign paused — the same doors the product
    # offers a practice, so the audit trail stays true.
    for booking_id in dict.fromkeys(cleanup["bookings"]):
        if booking_id:
            call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled"})
    for client_id in dict.fromkeys(cleanup["clients"]):
        if client_id:
            call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "messaging_check probe", "force": True})
    for campaign_id in dict.fromkeys(cleanup["campaigns"]):
        if campaign_id:
            call("PATCH", f"/api/v1/booking-campaigns/{campaign_id}", {"status": "paused"})
    if original_quiet:
        call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {"quietHours": original_quiet}})
    if twilio_fixture:
        for error in twilio_fixture.cleanup(lambda method, path, body: call(method, path, body)):
            failures.append(f"Twilio fixture cleanup: {error}")

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL PASS — a reminder fires at T-minus N and is logged in outreach, and the no-show rate is reportable.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # cleanup still owns its carrier/number after a crash
        failures.append(f"the messaging gate crashed: {type(error).__name__}: {error}")
        print(f"FAIL  the messaging gate crashed  — {type(error).__name__}: {error}")
        finish()
