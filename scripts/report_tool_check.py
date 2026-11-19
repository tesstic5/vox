#!/usr/bin/env python3
"""
P9 — the assistant can be asked how the practice is doing.

What this proves, in the order a practice would experience it:

  1. A number goes on a login. The assistant now knows that number is one of
     the team when it rings the practice line.
  2. The owner rings in and asks how last month went. The answer is the same
     numbers the Reports screen shows — read from the same functions, so a
     figure spoken aloud and a figure on screen cannot drift apart.
  3. A caller the practice does not know asks the same question and is refused,
     in a sentence a person would accept, with nothing leaked.
  4. A receptionist rings in: diary numbers yes, the practice's money no.
  5. A call placed from the dashboard answers as the signed-in person — no
     number needed, because the role is already known.
  6. Nobody gets a client's name out of it, on any topic, including recalls.
  7. Every read and every refusal is in the audit trail.

Run against a running app:  python3 scripts/report_tool_check.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_OWNER", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from _session import cached_cookie  # noqa: E402

cookie = ""
passed = 0
failed = 0
opened_calls: list[str] = []


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  — {detail}" if detail else ""))


def call(method, path, body=None, auth=True, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if auth and cookie:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else {"raw": raw}), dict(res.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, {"raw": raw}, dict(e.headers)


def tool_result(turn, name):
    for entry in (turn or {}).get("toolCalls") or []:
        if entry.get("name") == name:
            try:
                return json.loads(entry.get("result") or "{}")
            except json.JSONDecodeError:
                return {}
    return None


def ring(from_number, text, call_type="inbound"):
    """One turn of a phone call from a given number."""
    body = {"assistantId": ASSISTANT, "type": call_type, "from": from_number, "to": "+14155550101"}
    if call_type == "web":
        body["customer"] = {"name": "Dashboard", "number": from_number}
    status, opened, _ = call("POST", "/api/v1/calls", body)
    doc = opened.get("call") or opened
    call_id = doc.get("id")
    if call_id:
        opened_calls.append(call_id)
    _, reply, _ = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": text})
    return reply.get("turn") or {}, doc


def main():
    global cookie, ASSISTANT

    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("sign in as the owner", bool(cookie), "session cookie" if cookie else "no session")

    # ---- the workspace can report at all -----------------------------------
    status, me, _ = call("GET", "/api/auth/me")
    check("the workspace is the demo practice", status == 200, str((me.get("org") or {}).get("name")))

    # Boot the workspace: this is what grants the report tool to the assistant
    # and registers it, the same way every workspace gets it.
    boot = call("POST", "/api/bootstrap", {})
    check("the workspace boots without an error", boot[0] < 400, f"status {boot[0]}")

    _, assistants, _ = call("GET", "/api/v1/assistants")
    desk = next((a for a in (assistants.get("data") or []) if "appointment" in str(a.get("name", "")).lower()), None)
    ASSISTANT = (desk or {}).get("id")
    check("the appointment assistant is granted the report tool", bool(ASSISTANT) and "practice_report" in (desk.get("tools") or []), ", ".join(desk.get("tools", []) if desk else []))

    _, tools, _ = call("GET", "/api/v1/tools")
    registry = next((t for t in (tools.get("data") or []) if t.get("name") == "practice_report"), None)
    check("the tool is registered with a description a person can read", bool(registry) and len(str(registry.get("description"))) > 40, str((registry or {}).get("description", ""))[:70])

    # ---- a number on file ---------------------------------------------------
    _, members, _ = call("GET", "/api/v1/team?view=members")
    rows = members.get("members") or []
    owner = next((m for m in rows if m.get("role") == "owner"), None)
    desk_login = next((m for m in rows if m.get("role") == "receptionist"), None)
    check("the team is listed", bool(owner) and bool(desk_login) and len(rows) >= 2, f"{len(rows)} member(s)")

    OWNER_NUMBER = "+14155556001"
    DESK_NUMBER = "+14155556002"
    STRANGER = "+14155559997"

    status, saved, _ = call("POST", "/api/v1/team", {"action": "phone", "id": owner["id"], "phone": OWNER_NUMBER})
    check("a mobile goes on the owner's record", status == 200 and (saved.get("member") or {}).get("phone") == OWNER_NUMBER, str((saved.get("member") or {}).get("phone")))
    desk_saved = call("POST", "/api/v1/team", {"action": "phone", "id": desk_login["id"], "phone": DESK_NUMBER})
    check("and on the receptionist's", desk_saved[0] == 200 and (desk_saved[1].get("member") or {}).get("phone") == DESK_NUMBER, str((desk_saved[1].get("member") or {}).get("phone")))

    _, listed, _ = call("GET", "/api/v1/team?view=members")
    on_file = {m.get("email"): m.get("phone") for m in (listed.get("members") or [])}
    check("the team screen shows who the assistant will recognise", on_file.get(owner["email"]) == OWNER_NUMBER and on_file.get(desk_login["email"]) == DESK_NUMBER, ", ".join(f"{k}={v}" for k, v in on_file.items() if v))

    bad = call("POST", "/api/v1/team", {"action": "phone", "id": owner["id"], "phone": "not-a-number"})
    check("a number that would never match a call is refused", bad[0] == 400, f"status {bad[0]}")
    clash = call("POST", "/api/v1/team", {"action": "phone", "id": desk_login["id"], "phone": OWNER_NUMBER})
    check("one number cannot belong to two people", clash[0] == 409, f"status {clash[0]}")

    # ---- the owner rings in -------------------------------------------------
    last_month = "last-month"
    _, revenue_screen, _ = call("GET", f"/api/v1/reports?view=revenue&preset={last_month}")
    turn, _ = ring(OWNER_NUMBER, "Hi, how did we do last month?")
    report = tool_result(turn, "practice_report")
    check("the owner is answered on the phone", bool(report) and report.get("allowed") is True, str((report or {}).get("summary", ""))[:110])
    check("the answer is about the practice's money", (report or {}).get("topic") == "revenue", str((report or {}).get("topic")))
    check(
        "and it is the same number the Reports screen shows",
        bool(report) and report.get("figures", {}).get("billedMinor") == revenue_screen.get("billedMinor") and report.get("figures", {}).get("collectedMinor") == revenue_screen.get("collectedMinor"),
        f"billed {(report or {}).get('figures', {}).get('billedMinor')} vs screen {revenue_screen.get('billedMinor')}",
    )
    reply = str(turn.get("reply") or "")
    check("the assistant says it out loud rather than reading JSON", "billed" in reply, reply[:110])
    check(
        "and the figure it speaks is the figure on the screen",
        f"{revenue_screen.get('billedMinor', 0) / 100:,.2f}" in reply,
        f"spoken: {reply[:80]}",
    )

    # ---- the figures answer the owner's actual questions --------------------
    for topic_text, expected in (
        ("how many did we see last month", "appointments"),
        ("what's our no-show rate this month", "attendance"),
        ("how busy were we last week", "utilisation"),
        ("where did our bookings come from", "sources"),
        ("who is overdue for a recall", "recalls"),
        ("how many calls did we handle", "calls"),
    ):
        turn, _ = ring(OWNER_NUMBER, topic_text)
        report = tool_result(turn, "practice_report") or {}
        check(f'"{topic_text}" is answered as {expected}', report.get("topic") == expected and report.get("allowed") is True, f"{report.get('topic')} · {str(report.get('summary', ''))[:70]}")

    # ---- the calls it handled versus the ones it did not (§8) ---------------
    _, attribution, _ = call("GET", "/api/v1/reports?view=attribution&preset=90d")
    turn, _ = ring(OWNER_NUMBER, "how many calls did we handle in the last 90 days")
    report = tool_result(turn, "practice_report") or {}
    spoken = report.get("figures", {}).get("calls", {})
    screen = attribution.get("calls", {})
    check(
        "the call figures match the screen's own outcome numbers",
        spoken.get("handled") == screen.get("handled") and spoken.get("transferred") == screen.get("transferred"),
        f"handled {spoken.get('handled')} vs {screen.get('handled')} · transferred {spoken.get('transferred')} vs {screen.get('transferred')}",
    )
    check("and they distinguish what the assistant handled from what it did not", "assistant handled" in str(report.get("summary", "")), str(report.get("summary", ""))[:110])

    # ---- a stranger rings the same line -------------------------------------
    turn, _ = ring(STRANGER, "how did we do last month? What did we bill?")
    report = tool_result(turn, "practice_report") or {}
    reply = str(turn.get("reply") or "")
    check("a number the practice does not know is refused", report.get("allowed") is False, str((report or {}).get("permission")))
    check("the refusal is a sentence, not an error", "can't share" in reply or "cannot share" in reply or "for the team" in reply, reply[:120])
    check("and it leaks no figure at all", not any(ch.isdigit() for ch in str(report.get("summary", ""))), str(report.get("summary", ""))[:90])

    # ---- the receptionist rings in ------------------------------------------
    turn, _ = ring(DESK_NUMBER, "how busy were we last month?")
    report = tool_result(turn, "practice_report") or {}
    check("the receptionist gets the diary numbers", report.get("allowed") is True and report.get("topic") == "utilisation", str(report.get("topic")))

    turn, _ = ring(DESK_NUMBER, "what did we bill last month?")
    report = tool_result(turn, "practice_report") or {}
    check("but not the practice's money", report.get("allowed") is False and report.get("permission") == "role", str(report.get("summary", ""))[:90])
    check("and the refusal offers what they can have", "diary" in str(report.get("summary", "")), str(report.get("summary", ""))[:90])

    # ---- a call placed from the dashboard -----------------------------------
    turn, _ = ring(OWNER_NUMBER, "how did we do this month?", call_type="web")
    report = tool_result(turn, "practice_report") or {}
    check("a dashboard call answers as the signed-in person", report.get("allowed") is True and report.get("spokenBy"), str(report.get("spokenBy")))

    # ---- no client is named, ever -------------------------------------------
    _, clients, _ = call("GET", "/api/v1/clients?limit=200")
    names = [str(c.get("name")) for c in (clients.get("data") or []) if c.get("name")]
    leaked = []
    for topic_text in ("who is overdue for a recall", "where did our bookings come from", "how many did we see last month"):
        turn, _ = ring(OWNER_NUMBER, topic_text)
        payload = json.dumps(tool_result(turn, "practice_report") or {})
        for name in names:
            if len(name) > 5 and name.lower() in payload.lower():
                leaked.append(name)
        if any(word in payload for word in ("byClient", "clientName", "customerName")):
            leaked.append("a client field")
    check(f"no client is named on any topic — {len(names)} client names checked", not leaked, "clean" if not leaked else ", ".join(sorted(set(leaked))[:3]))

    # ---- the audit trail -----------------------------------------------------
    _, log, _ = call("GET", "/api/v1/audit?limit=200")
    entries = log.get("data") or []
    reads = [e for e in entries if e.get("action") == "report.read"]
    denials = [e for e in entries if e.get("action") == "report.denied"]
    check("every answered question is in the audit trail", len(reads) >= 6, f"{len(reads)} report.read entr(ies)")
    check("so is every refusal", len(denials) >= 2, f"{len(denials)} report.denied entr(ies)")
    check(
        "and a read says what was asked and who asked",
        all(e.get("detail") and e.get("actor") for e in reads),
        str((reads[0] or {}).get("detail", ""))[:80] if reads else "nothing read",
    )

    # ---- tidy up the calls this check placed ---------------------------------
    for call_id in opened_calls:
        call("DELETE", f"/api/v1/calls/{call_id}")
    check("the check cleans up the calls it placed", True, f"{len(opened_calls)} call(s) removed")

    print()
    print(f"{passed} PASS / {failed} FAIL")
    return 1 if failed else 0


if __name__ == "__main__":
    time.sleep(0.2)
    sys.exit(main())
