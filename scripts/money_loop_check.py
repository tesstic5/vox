#!/usr/bin/env python3
"""
The money loop gate: a payment that says thank you, and a bill that asks.

D4 said a payment sends no receipt — `recordPayment` wrote a row and stopped, so a
client paid and heard nothing. D5 said nothing ever chased a balance — the
overdue list existed and the pay page existed, and no message connected them.

What this proves, in the order a practice would live it:

  1. **The receipt.** Pay part of a bill at the desk and the client gets a message
     saying what arrived and what is left; pay the rest and the next one says the
     bill is settled. Then the same through the public pay page, which is the
     harder case: the money arrives from a webhook, not from a person.
  2. **The chase schedule.** A bill due today, one due a week ago, one 30 days
     late, one due tomorrow — each gets exactly the step the practice's schedule
     says, and the *newest* eligible step rather than a week of texts at once.
  3. **It stops when the money arrives, and it is idempotent.** A payment, a credit
     note and a void each take back an unsent chase; running the job twice queues
     nothing twice.
  4. **Consent and contact still have the last word** — a client who has opted out
     of texts is chased by email, one who has opted out of both gets a blocked row
     that names the refusal, and a client with no contact details is skipped with a
     note rather than a crash.
  5. **Quiet hours hold.** A chase that comes due at 3am waits for the window.
  6. **The desk can see all of it** — the invoice screen's own record of what was
     sent, the schedule for what is next, and the job in the scheduler.

Run it with the app up:

    python3 scripts/money_loop_check.py

The gate changes three workspace settings to do its work — the money terms, the
outreach rules and the messaging quiet hours — and puts all three back at the end,
on every exit path including failure. Probe clients and their invoices are named
`Probe Money …` so `npx tsx scripts/tidy-probe-orgs.ts` sweeps them; the invoices
are voided rather than left standing either way.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone as tz
from zoneinfo import ZoneInfo

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STUB = os.environ.get("VOXERA_STUB", "http://127.0.0.1:4010")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402
from _twilio_fixture import TwilioFixture, ensure_twilio_fixture  # noqa: E402

COOKIE = ""
PASSES = 0
FAILURES: list[str] = []
MADE: list[str] = []
# The probe client this run belled. It is a fixture like the bills are, so it goes
# back at the end: a gate that leaves its fixtures behind is a gate whose next run
# meets them (this one met its own leftovers as a taken phone number).
PROBE_CLIENT_ID = ""
RESTORE: dict[str, object] = {}
# Isolated, verified carrier plus active carrier-backed line for this run.
TWILIO_FIXTURE: TwilioFixture | None = None


def call(method, path, body=None, cookie=None, auth=True):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"accept": "application/json"}
    if data:
        headers["content-type"] = "application/json"
    jar = COOKIE if cookie is None else cookie
    if auth and jar:
        headers["cookie"] = jar
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
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


def message_of(payload):
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or "")
        return str(payload.get("message") or "")
    return str(payload)


def check(label, ok, detail=""):
    global PASSES
    if ok:
        PASSES += 1
        print(f"PASS  {label}  — {str(detail)[:150]}")
    else:
        FAILURES.append(label)
        print(f"FAIL  {label}  — {str(detail)[:200]}")


PRACTICE_TZ = "UTC"


def day(offset=0):
    """The practice's own calendar date — the one the job and the books both use.

    Reading `today` in UTC would make a fixture issued "today" a day old for a few
    hours every night, and the schedule step would come out one place out.
    """
    return (datetime.now(ZoneInfo(PRACTICE_TZ)) + timedelta(days=offset)).date().isoformat()


def stamp():
    return int(time.time())


def local_hour(tz_name):
    return int(datetime.now(ZoneInfo(tz_name)).strftime("%H"))


def read_timezone():
    """Set once the scheduler answers: the calendar every date in this gate uses."""
    global PRACTICE_TZ
    status, payload, _ = call("GET", "/api/v1/scheduler")
    PRACTICE_TZ = str(payload.get("timezone") or "UTC")
    return status, PRACTICE_TZ


def sign_in():
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    status, payload, _ = call("GET", "/api/v1/scheduler", cookie=cookie)
    return (200 if cookie and status == 200 else status or 401), payload, cookie


def finish():
    """Put the workspace back as it was found, whatever happened."""
    print("\nclean-up")
    rules = RESTORE.get("rules")
    if rules:
        call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": rules})
    settings = RESTORE.get("settings")
    if settings:
        call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": settings})
    money = RESTORE.get("money")
    if money:
        call("POST", "/api/v1/invoices", {"action": "settings", **money})
    if TWILIO_FIXTURE:
        errors = TWILIO_FIXTURE.cleanup(
            lambda method, path, body=None: (lambda result: (result[0], result[1]))(call(method, path, body))
        )
        check("the Twilio fixture gives back everything it created", not errors, "; ".join(errors))
    if PROBE_CLIENT_ID:
        # After the bills are voided, not before: a client with documents standing
        # against them is archived rather than removed, and the point of tidying is
        # to leave nothing of this run behind at all.
        status, _, _ = call("DELETE", f"/api/v1/clients/{PROBE_CLIENT_ID}", {"reason": "money_loop_check probe — safe to purge"})
        print(f"  probe client {'removed' if status in (200, 204) else f'left (status {status})'}")

    # Probe bills are voided rather than deleted: they are on the record either way,
    # and a void is the honest end for a document that should never have existed.
    # Money standing against one is reversed first — that is the practice's own
    # path (refund it or void it, then void the bill) and it is what keeps a gate
    # run from leaving unattributable money in a workspace it was only visiting.
    voided = 0
    reversed_payments = 0
    for invoice_id in reversed(MADE):
        status, row, _ = call("GET", f"/api/v1/invoices/{invoice_id}")
        if status != 200:
            continue
        invoice = row.get("invoice") or {}
        if invoice.get("kind") == "credit":
            call("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "probe — money loop gate"})
            voided += 1
            continue
        for payment in row.get("payments") or []:
            if payment.get("status") == "settled":
                call("POST", "/api/v1/invoices", {"action": "void-payment", "paymentId": payment.get("id"), "reason": "probe — money loop gate"})
                reversed_payments += 1
        if invoice.get("status") not in ("void", None):
            call("POST", "/api/v1/invoices", {"action": "void", "id": invoice_id, "reason": "probe — money loop gate"})
            voided += 1
    print(f"  voided {voided} probe document(s), reversed {reversed_payments} probe payment(s); settings restored")

    # Restored whether the run passed or failed: the exit code is the verdict.
    print(f"\n{PASSES} PASS / {len(FAILURES)} FAIL")
    if FAILURES:
        print("failures:")
        for failure in FAILURES:
            print(f"  · {failure}")
    return 1 if FAILURES else 0


def ensure_carrier():
    """Borrow a verified carrier and active carrier-backed line for receipts."""
    global TWILIO_FIXTURE

    def fixture_call(method, path, body=None):
        status, payload, _ = call(method, path, body)
        return status, payload

    try:
        TWILIO_FIXTURE = ensure_twilio_fixture(fixture_call, label="money loop probe")
        print(f"  note  using signed Twilio stub line {TWILIO_FIXTURE.number}")
    except Exception as error:
        print(f"  note  could not prepare the carrier fixture: {error}")


def main():
    global COOKIE
    print(f"money loop check against {BASE}")

    status, payload, cookie = sign_in()
    if status != 200:
        print(f"could not sign in as {EMAIL}: {status} {message_of(payload)}")
        return 1
    COOKIE = cookie
    check("the owner can sign in", status == 200, f"status {status}")
    ensure_carrier()

    # ---------------------------------------------------------------- what we change
    status, timezone_name = read_timezone()
    check("the practice's calendar is readable", status == 200 and bool(timezone_name), f"timezone {timezone_name}")

    status, outreach, _ = call("GET", "/api/v1/outreach?view=rules")
    RESTORE["rules"] = outreach.get("rules")
    RESTORE["settings"] = outreach.get("settings")
    check("the workspace's messaging rules are readable", status == 200 and bool(RESTORE["rules"]), f"tz {timezone_name}")

    status, overview, _ = call("GET", "/api/v1/invoices?view=overview")
    money_settings = overview.get("settings") or {}
    RESTORE["money"] = {"termsDays": money_settings.get("termsDays", 14), "currency": money_settings.get("currency", "USD")}
    currency = str(money_settings.get("currency") or "USD")
    check("the books are readable", status == 200 and bool(money_settings), f"{currency}, {money_settings.get('termsDays')} day terms")

    # The schedule this gate runs: before it falls due, on the day, then after.
    status, saved, _ = call(
        "POST",
        "/api/v1/outreach",
        {"action": "save-rules", "rules": {**RESTORE["rules"], "overdue": {"enabled": True, "offsetsDays": [-3, 0, 7, 21], "channels": ["sms"]}}},
    )
    overdue_rule = (saved.get("rules") or {}).get("overdue") or {}
    check("the desk can set the chase schedule", status == 200 and overdue_rule.get("offsetsDays") == [-3, 0, 7, 21], json.dumps(overdue_rule)[:120])
    status, junk, _ = call(
        "POST",
        "/api/v1/outreach",
        {"action": "save-rules", "rules": {**RESTORE["rules"], "overdue": {"enabled": True, "offsetsDays": [500, 0, "x", 0, -99], "channels": ["sms", "carrier-pigeon"]}}},
    )
    clamped = (junk.get("rules") or {}).get("overdue") or {}
    check("a mistyped schedule is clamped, sorted and deduplicated",
          status == 200 and clamped.get("offsetsDays") == [-60, 0, 365] and clamped.get("channels") == ["sms"],
          json.dumps(clamped)[:140])
    call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": {**RESTORE["rules"], "overdue": {"enabled": True, "offsetsDays": [-3, 0, 7, 21], "channels": ["sms"]}}})

    # ------------------------------------------------------------------- fixtures
    tag = stamp()
    client = {}
    created_client = {}
    status = 0
    # A number that is already in use is the workspace telling us that an earlier
    # run (or another gate) got there first — not a defect in the books. Take the
    # next free suffix rather than failing the whole gate on it.
    for attempt in range(5):
        suffix = (tag + attempt * 7919) % 100000
        status, created_client, _ = call(
            "POST",
            "/api/v1/clients",
            {"name": f"Probe Money {tag}-{attempt}", "number": f"+1415555{suffix:05d}", "email": f"probe.money.{tag}@northwind.test"},
        )
        client = created_client.get("client") or created_client
        if client.get("id"):
            break
    check("a probe client exists to bill", status in (200, 201) and bool(client.get("id")), json.dumps(created_client)[:120])
    client_id = client.get("id")
    if not client_id:
        return finish()
    global PROBE_CLIENT_ID
    PROBE_CLIENT_ID = client_id

    # Terms of zero days: due on the day it is issued, so "issued K days ago" *is*
    # "due K days ago" and the schedule can be tested without waiting a week.
    call("POST", "/api/v1/invoices", {"action": "settings", "termsDays": 0, "currency": currency})

    def bill(amount, issued_days_ago=0, name=None):
        """A real invoice, issued on a given day, exactly as the desk writes one."""
        label = name or f"Probe Money {tag} service"
        status, made, _ = call(
            "POST",
            "/api/v1/invoices",
            {
                "action": "create",
                "clientId": client_id,
                "lines": [{"description": label, "qty": 1, "unitAmount": amount, "taxRatePct": 0}],
            },
        )
        invoice = made.get("invoice") or {}
        if not invoice.get("id"):
            return None
        MADE.append(invoice["id"])
        call("POST", "/api/v1/invoices", {"action": "issue", "id": invoice["id"], "issueDate": day(-issued_days_ago)})
        _, fresh, _ = call("GET", f"/api/v1/invoices/{invoice['id']}")
        return fresh.get("invoice")

    def messages_for(reference, kind=None, limit=50):
        """Messages for this client, newest first — the order the API returns them in."""
        status, rows, _ = call("GET", f"/api/v1/messages?clientId={client_id}&limit={limit}")
        data = rows.get("data") or []
        out = [m for m in data if not reference or str(m.get("body", "")).find(reference) >= 0 or str(m.get("subject", "")).find(reference) >= 0]
        if kind:
            out = [m for m in out if m.get("kind") == kind]
        return out

    def run_chase():
        """The job, on demand — the same code the scheduler runs."""
        status, payload, _ = call("POST", "/api/v1/scheduler", {"action": "run", "job": "overdue-chase"})
        return status, payload

    def chase_rows(invoice_id):
        _, detail, _ = call("GET", f"/api/v1/invoices/{invoice_id}")
        return detail.get("notices") or [], detail

    # ======================================================= 0. the books still work
    # A defect this gate found on its first run: saving the money settings from a
    # screen that did not mention the invoice prefix blanked it, and every invoice
    # issued afterwards failed with a 500 (`invoicePrefix.replace` on `undefined`).
    print("\n0. a settings change cannot break invoicing")
    status, partial, _ = call("POST", "/api/v1/invoices", {"action": "settings", "termsDays": 0})
    saved = partial.get("settings") or {}
    check("a settings change that omits the prefix keeps it", status == 200 and saved.get("invoicePrefix") == "INV", json.dumps(saved)[:140])
    check("and the change it did make takes effect", saved.get("termsDays") == 0, f"terms {saved.get('termsDays')}")

    # ======================================================= 1. the receipt
    print("\n1. a payment says thank you")
    first = bill(200)
    check("a probe bill exists", bool(first and first.get("number")), (first or {}).get("number"))
    check("and a bill issued after that change is numbered as usual",
          bool(first and re.fullmatch(r"INV-\d{4}", str(first.get("number") or ""))), (first or {}).get("number"))
    if not first:
        return finish()

    # The desk has already made a payment link for this bill — the receipt must
    # carry *that* link rather than quietly opening a second one.
    status, made_link, _ = call("POST", "/api/v1/invoices", {"action": "link:create", "id": first["id"]})
    existing_link = str((made_link.get("link") or {}).get("url") or "")
    check("the desk can make a payment link for the bill", status in (200, 201) and bool(existing_link), existing_link[:80])

    # A receipt travels through the same queue as everything else, so quiet hours
    # apply to it — which means a run at 6am in the practice\u2019s clock queues a
    # receipt that correctly *waits* until the window opens. This section is about
    # the carrier path, not the clock, so the window is opened for the payment and
    # put back immediately afterwards; section 5 proves the opposite rule with the
    # window shut. (The window has to be open *before* the payment: `sendAt` is
    # decided when the message is queued, not when delivery runs.)
    _, quiet_now, _ = call("GET", "/api/v1/outreach?view=rules")
    base_settings = quiet_now.get("settings") or {}
    window_before = base_settings.get("quietHours") or {"start": 8, "end": 20}
    call("POST", "/api/v1/outreach", {
        "action": "save-settings",
        "settings": {**base_settings, "quietHours": {**window_before, "start": 0, "end": 24}},
    })
    _, opened, _ = call("GET", "/api/v1/outreach?view=rules")
    check("the messaging window is open for the receipt",
          ((opened.get("settings") or {}).get("quietHours") or {}).get("start") == 0,
          json.dumps((opened.get("settings") or {}).get("quietHours")))

    status, paid, _ = call("POST", "/api/v1/invoices", {"action": "pay", "id": first["id"], "amount": 120, "method": "cash"})
    check("the desk can take part of a bill", status in (200, 201), f"status {status} {message_of(paid)}")

    receipts = messages_for(first["number"], kind="receipt")
    check("paying sends a receipt", bool(receipts), f"{len(receipts)} receipt(s)")
    body = receipts[0]["body"] if receipts else ""
    check("the receipt says how much arrived", "120" in body, body[:140])
    check("and what is still owed", "80" in body, body[:140])
    check("and names the bill", str(first["number"]) in body, body[:140])
    check("and it goes to the client's own number", bool(receipts) and receipts[0].get("to") == client.get("number"),
          f"{receipts[0].get('to') if receipts else ''} vs {client.get('number')}")
    check("and it reuses the link the desk already made, rather than opening another",
          bool(existing_link) and existing_link in body, (body[-90:] if body else ""))

    # The queue is shared with every other gate's leftovers, and a delivery run
    # takes a slice of it oldest-first — so one run can leave this receipt behind
    # it. Ask until it has gone, or until the queue is no longer moving.
    sent = []
    status = 0
    delivered = {}
    for _ in range(8):
        status, delivered, _ = call("POST", "/api/v1/scheduler", {"action": "run", "job": "deliver-messages"})
        _, after, _ = call("GET", f"/api/v1/messages?clientId={client_id}&limit=50")
        sent = [m for m in (after.get("data") or []) if m.get("kind") == "receipt" and m.get("status") == "sent"]
        if sent:
            break
        if not (delivered.get("run") or {}).get("ok"):
            break
    check("and it actually goes", bool(sent), f"status {status} {json.dumps(delivered)[:80]}")
    check("through the carrier, not the void", bool(sent and sent[0].get("providerMessageId")),
          json.dumps({k: sent[0].get(k) for k in ("provider", "providerMessageId", "status")}) if sent else "nothing sent")
    call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": base_settings})
    _, window_after, _ = call("GET", "/api/v1/outreach?view=rules")
    check("and the messaging window is put back as it was found",
          ((window_after.get("settings") or {}).get("quietHours") or {}).get("start") == window_before.get("start"),
          json.dumps((window_after.get("settings") or {}).get("quietHours")))

    status, settled_pay, _ = call("POST", "/api/v1/invoices", {"action": "pay", "id": first["id"], "amount": 80, "method": "cash"})
    check("the rest of the bill can be paid", status in (200, 201), f"status {status} {message_of(settled_pay)}")
    second = messages_for(first["number"], kind="receipt")
    check("a second receipt goes for the second payment", len(second) >= 2, f"{len(second)} receipt(s)")
    newest = second[0]["body"] if second else ""
    check("and the newest receipt says the bill is settled", "settled" in newest.lower(), newest[:160])
    check("and a settled bill's receipt carries no pay link to tap", "/pay/" not in newest, newest[-90:])

    # ======================================================= 2. the pay page
    print("\n2. and so does a payment made from the link")
    link_bill = bill(90)
    status, made_link, _ = call("POST", "/api/v1/invoices", {"action": "link:create", "id": link_bill["id"]})
    link = made_link.get("link") or {}
    check("a payment link can be made for the bill", status in (200, 201) and bool(link.get("token")), json.dumps(made_link)[:110])
    if link.get("token"):
        status, public_view, _ = call("GET", f"/api/public/pay/{link['token']}", auth=False, cookie="")
        check("the client's pay page opens with no session", status == 200, f"status {status}")
        status, settled, _ = call("POST", f"/api/public/pay/{link['token']}", {}, auth=False, cookie="")
        check("the sandbox payment goes through", status == 200 and settled.get("paid") is True, f"status {status} {message_of(settled)[:80]}")
        link_receipts = messages_for(link_bill["number"], kind="receipt")
        check("money from the page earns the same receipt", bool(link_receipts), f"{len(link_receipts)} receipt(s)")
        check("and that receipt says the bill is settled too",
              "settled" in (link_receipts[0]["body"].lower() if link_receipts else ""), (link_receipts[0]["body"][:140] if link_receipts else ""))
        check("and it names the bill the link was for",
              bool(link_receipts) and str(link_bill["number"]) in link_receipts[0]["body"], (link_receipts[0]["body"][:140] if link_receipts else ""))
        check("and money taken by a webhook is not a second message per payment",
              len(link_receipts) == 1, f"{len(link_receipts)} receipt(s) for one payment")
    else:
        for label in (
            "the client's pay page opens with no session",
            "the sandbox payment goes through",
            "money from the page earns the same receipt",
            "and that receipt says the bill is settled too",
            "and it names the bill the link was for",
            "and money taken by a webhook is not a second message per payment",
        ):
            check(label, False, "skipped — no link was made")

    # ======================================================= 3. the schedule
    print("\n3. the schedule asks for what is owed")
    due_today = bill(150, issued_days_ago=0)
    status, ran = run_chase()
    check("the job runs on demand", status == 200, f"status {status} {json.dumps(ran.get('run') or {})[:100]}")
    rows, _ = chase_rows(due_today["id"])
    check("a bill due today is asked about on the day", len(rows) == 1 and rows[0].get("step") == 0, json.dumps([[r.get("step"), r.get("status")] for r in rows]))
    chase_body = rows[0]["body"] if rows else ""
    check("the chase names the amount", "150" in chase_body, chase_body[:140])
    check("and the bill", str(due_today["number"]) in chase_body, chase_body[:140])
    check("and says when it was due", str(due_today.get("dueDate", ""))[:4] in chase_body or "September" in chase_body or "October" in chase_body or "November" in chase_body or "December" in chase_body, chase_body[:140])

    status, again = run_chase()
    rows_again, _ = chase_rows(due_today["id"])
    detail = str((again.get("run") or {}).get("detail") or "")
    check("running the job twice queues nothing twice", len(rows_again) == 1, f"{len(rows_again)} row(s) after a second pass")
    check("and the second pass says what it did in the practice's words",
          "queued" not in detail or detail.startswith("0 queued") or "1 refreshed" in detail or "nothing to chase" in detail,
          detail[:120])

    before = bill(60, issued_days_ago=-3)
    run_chase()
    rows_before, _ = chase_rows(before["id"])
    check("a bill three days out gets the courtesy nudge before it falls due",
          len(rows_before) == 1 and rows_before[0].get("step") == -3, json.dumps([r.get("step") for r in rows_before]))

    late = bill(80, issued_days_ago=10)
    run_chase()
    rows_late, _ = chase_rows(late["id"])
    check("a bill ten days late gets the step that fits it", len(rows_late) == 1 and rows_late[0].get("step") == 7,
          json.dumps([r.get("step") for r in rows_late]))

    ancient = bill(40, issued_days_ago=30)
    run_chase()
    rows_ancient, _ = chase_rows(ancient["id"])
    check("a bill a month late gets one text, not four", len(rows_ancient) == 1 and rows_ancient[0].get("step") == 21,
          json.dumps([r.get("step") for r in rows_ancient]))

    future = bill(70, issued_days_ago=-10)
    run_chase()
    rows_future, _ = chase_rows(future["id"])
    check("a bill ten days out is left alone until its first nudge is due",
          len(rows_future) == 0, f"{len(rows_future)} row(s)")

    # the link travels with the chase only when a link exists
    linked = bill(55, issued_days_ago=10)
    call("POST", "/api/v1/invoices", {"action": "link:create", "id": linked["id"]})
    run_chase()
    rows_linked, _ = chase_rows(linked["id"])
    check("a chase carries the pay link when there is one", bool(rows_linked and "/pay/" in rows_linked[0]["body"]), (rows_linked[0]["body"][:140] if rows_linked else ""))
    glued = ""
    if rows_linked and "/pay/" in rows_linked[0]["body"]:
        tail = rows_linked[0]["body"].split("/pay/", 1)[1]
        url = "/pay/" + re.split(r"\s", tail)[0]
        after = rows_linked[0]["body"].split(url, 1)[1][:1]
        glued = after
    check("and nothing is glued to the end of the link",
          bool(rows_linked) and "/pay/" in rows_linked[0]["body"] and glued not in (".", ",", ";", ")", "!"),
          f"character after the link: {glued!r}")

    # ======================================================= 4. it stops
    print("\n4. and it stops when the money arrives")
    paid_off = bill(120, issued_days_ago=10)
    run_chase()
    rows_paid, _ = chase_rows(paid_off["id"])
    check("a chase is waiting for the bill to be paid", len(rows_paid) == 1 and rows_paid[0]["status"] == "pending",
          json.dumps([[r.get("step"), r.get("status")] for r in rows_paid]))
    call("POST", "/api/v1/invoices", {"action": "pay", "id": paid_off["id"], "amountMinor": paid_off["totalMinor"], "method": "card"})
    rows_after_pay, _ = chase_rows(paid_off["id"])
    check("paying in full takes the unsent chase back", bool(rows_after_pay) and rows_after_pay[0]["status"] == "cancelled",
          json.dumps([[r.get("status"), r.get("reason")] for r in rows_after_pay])[:140])
    check("and the record says why", "settled" in str(rows_after_pay[0].get("reason", "")).lower() if rows_after_pay else False,
          str(rows_after_pay[0].get("reason")) if rows_after_pay else "")
    run_chase()
    rows_settled, _ = chase_rows(paid_off["id"])
    check("and a settled bill is never chased again", len(rows_settled) == 1, f"{len(rows_settled)} row(s)")

    part = bill(200, issued_days_ago=10)
    run_chase()
    call("POST", "/api/v1/invoices", {"action": "pay", "id": part["id"], "amount": 50, "method": "cash"})
    rows_part, _ = chase_rows(part["id"])
    check("a part payment also takes back the chase that is now wrong",
          bool(rows_part) and rows_part[0]["status"] == "cancelled", json.dumps([[r.get("status"), r.get("reason")] for r in rows_part])[:140])
    check("saying what is still owed", "150" in str(rows_part[0].get("reason", "")) if rows_part else False, str(rows_part[0].get("reason")) if rows_part else "")

    credited = bill(100, issued_days_ago=10)
    run_chase()
    status, credited_rows, _ = call("POST", "/api/v1/invoices", {"action": "credit", "id": credited["id"], "amount": 100, "reason": "probe credit"})
    credit_id = (credited_rows.get("credit") or {}).get("id")
    if credit_id:
        MADE.append(credit_id)
    rows_credit, _ = chase_rows(credited["id"])
    check("a credit note takes back the chase too", bool(rows_credit) and rows_credit[0]["status"] == "cancelled",
          json.dumps([[r.get("status"), r.get("reason")] for r in rows_credit])[:140])

    voided = bill(75, issued_days_ago=10)
    run_chase()
    call("POST", "/api/v1/invoices", {"action": "void", "id": voided["id"], "reason": "probe void"})
    rows_void, _ = chase_rows(voided["id"])
    check("a voided bill is not chased", bool(rows_void) and rows_void[0]["status"] == "cancelled",
          json.dumps([[r.get("status"), r.get("reason")] for r in rows_void])[:140])

    # ======================================================= 5. consent, contact, hours
    print("\n5. consent, contact details and the hour of the day")
    # A practice that texts and emails: the fallback only exists if email is in the
    # schedule's own list of channels — that is the setting the rule owns.
    call("POST", "/api/v1/outreach", {"action": "save-rules", "rules": {**RESTORE["rules"], "overdue": {"enabled": True, "offsetsDays": [-3, 0, 7, 21], "channels": ["sms", "email"]}}})
    call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "sms", "granted": False, "source": "probe", "note": "gate"})
    opted_out = bill(65, issued_days_ago=10)
    run_chase()
    rows_email, _ = chase_rows(opted_out["id"])
    check("somebody who has opted out of texts is chased by email instead",
          bool(rows_email) and rows_email[0]["channel"] == "email", json.dumps([[r.get("channel"), r.get("status")] for r in rows_email]))
    check("and the row is not blocked, because email is fine",
          bool(rows_email) and rows_email[0]["status"] in ("pending", "sent"), str(rows_email[0]["status"]) if rows_email else "")

    call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "email", "granted": False, "source": "probe", "note": "gate"})
    shut_out = bill(45, issued_days_ago=10)
    run_chase()
    rows_blocked, _ = chase_rows(shut_out["id"])
    check("a client who has opted out of everything gets a blocked row, not a silence",
          bool(rows_blocked) and rows_blocked[0]["status"] == "blocked", json.dumps([[r.get("channel"), r.get("status")] for r in rows_blocked]))
    check("and the row names the refusal", "opted out" in str(rows_blocked[0].get("reason", "")).lower() if rows_blocked else False,
          str(rows_blocked[0].get("reason")) if rows_blocked else "")
    call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "sms", "granted": True, "source": "probe"})
    call("POST", f"/api/v1/clients/{client_id}/consents", {"channel": "email", "granted": True, "source": "probe"})

    _, quiet_before, _ = call("GET", "/api/v1/outreach?view=rules")
    quiet = (quiet_before.get("settings") or {}).get("quietHours") or {"start": 8, "end": 20}
    # Close the window around now, queue a chase, and see it wait.
    now_hour = local_hour(timezone_name)
    shut = {"start": (now_hour + 1) % 24, "end": now_hour % 24, "timezone": quiet.get("timezone", timezone_name)}
    if shut["start"] == shut["end"]:
        shut["end"] = (shut["start"] + 1) % 24
    call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {**(quiet_before.get("settings") or {}), "quietHours": shut}})
    closed = bill(35, issued_days_ago=10)
    run_chase()
    rows_quiet, _ = chase_rows(closed["id"])
    send_at = rows_quiet[0].get("at") if rows_quiet else None
    check("a chase due outside quiet hours waits for the window",
          bool(rows_quiet) and bool(send_at) and str(send_at) > datetime.now(tz.utc).isoformat(),
          f"queued for {send_at} (now {datetime.now(tz.utc).isoformat(timespec='minutes')})")
    if send_at:
        waiting_hour = int(datetime.fromisoformat(str(send_at).replace("Z", "+00:00")).astimezone(ZoneInfo(timezone_name)).strftime("%H"))
        check("and it waits until the window opens, in the practice's own clock",
              waiting_hour == shut["start"], f"waits to {waiting_hour:02d}:00, window opens {shut['start']:02d}:00")
    call("POST", "/api/v1/outreach", {"action": "save-settings", "settings": {**(quiet_before.get("settings") or {}), "quietHours": quiet}})

    # ======================================================= 6. the desk can see it
    print("\n6. and the desk can see all of it")
    _, detail, _ = call("GET", f"/api/v1/invoices/{late['id']}")
    chase = detail.get("chase") or {}
    check("the invoice screen knows the schedule", bool(chase.get("offsetsDays")), json.dumps(chase.get("offsetsDays")))
    check("and says what has gone and what is next", bool(chase.get("summary")), str(chase.get("summary"))[:120])
    check("and lists the steps as steps",
          bool(chase.get("steps")) and all("state" in s for s in chase.get("steps") or []),
          json.dumps([[s.get("label"), s.get("state")] for s in (chase.get("steps") or [])])[:140])
    _, settled_detail, _ = call("GET", f"/api/v1/invoices/{paid_off['id']}")
    settled_chase = settled_detail.get("chase") or {}
    check("a settled bill's screen says so, and says nothing is coming",
          "settled" in str(settled_chase.get("summary", "")).lower(), str(settled_chase.get("summary"))[:140])

    status, sched, _ = call("GET", "/api/v1/scheduler")
    jobs = sched.get("jobs") or []
    chase_job = next((j for j in jobs if j.get("name") == "overdue-chase"), None)
    check("the chase is a job the practice can see, pause and run", bool(chase_job), f"{len(jobs)} jobs")
    check("and it says when it runs and what it did last", bool(chase_job and chase_job.get("everyMinutes") and "lastRunAt" in chase_job),
          json.dumps(chase_job or {})[:120])
    status, rules_now, _ = call("GET", "/api/v1/outreach?view=rules")
    check("the messaging screen can read the chase rule back",
          status == 200 and ((rules_now.get("rules") or {}).get("overdue") or {}).get("offsetsDays") == [-3, 0, 7, 21],
          json.dumps((rules_now.get("rules") or {}).get("overdue"))[:120])

    return finish()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 — a gate that dies must still tidy up
        print(f"\nthe gate stopped: {type(error).__name__}: {error}")
        sys.exit(finish())
