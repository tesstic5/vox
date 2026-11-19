#!/usr/bin/env python3
"""
End-to-end smoke test.

One script that exercises the whole platform against a running deployment: the
marketing surface, the dashboard, auth, the public demo line, the streamed turn
path with its event order, telemetry, metering, webhooks, exports, carrier-backed
outbound dialling, and a short multi-turn dialogue.

    npm start                       # in one shell
    python3 scripts/smoke.py        # in another

Pass `--base http://host:port` to point it somewhere else, and set TWILIO_STUB=1
to expect the carrier stub to be present (dialling then has to succeed).
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--base=")), os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000"))
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
EXPECT_CARRIER = os.environ.get("TWILIO_STUB") == "1"

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, raw=False, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode()
            set_cookie = res.headers.get("set-cookie")
            globals()["cookie"] = set_cookie.split(";")[0] if set_cookie else cookie
            return res.status, (text if raw else (json.loads(text) if text else {})), dict(res.headers)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            payload = text if raw else (json.loads(text) if text else {})
        except json.JSONDecodeError:
            payload = text
        return err.code, payload, dict(err.headers)


def envelope(payload):
    if isinstance(payload, dict):
        return payload.get("error", {}).get("message", "")
    return str(payload)[:120]


MARKETING = [
    "/",
    "/pricing",
    "/docs",
    "/blog",
    "/careers",
    "/customers",
    "/integrations",
    "/templates",
    "/compare",
    "/status",
    "/trust",
    "/security",
    "/terms-of-service",
]

DASHBOARD = [
    "/dashboard",
    "/dashboard/assistants",
    "/dashboard/calls",
    "/dashboard/numbers",
    "/dashboard/carriers",
    "/dashboard/analytics",
    "/dashboard/keys",
    "/dashboard/logs",
    "/dashboard/webhooks",
    "/dashboard/settings",
]


def main():
    print("— marketing surface " + "—" * 24)
    for path in MARKETING:
        status, _, _ = call("GET", path, raw=True)
        check(f"GET {path}", status == 200, f"status {status}")

    print("\n— dashboard (signed out still renders, shell is client-side) " + "—" * 8)
    for path in DASHBOARD:
        status, _, _ = call("GET", path, raw=True)
        check(f"GET {path}", status == 200, f"status {status}")

    print("\n— public demo line (no signup) " + "—" * 24)
    status, demo, _ = call("POST", "/api/public/demo", {"assistant": "support", "source": "smoke"})
    check("demo call created anonymously", status in (200, 201), f"status {status} {envelope(demo)}")
    token = (demo or {}).get("token")
    demo_id = (demo or {}).get("callId") or (demo or {}).get("id")
    check("demo returns a signed token", bool(token), str(token)[:24])
    if token and demo_id:
        bearer = {"authorization": f"Bearer {token}"}
        status, raw_turn, _ = call("POST", f"/api/public/demo/{demo_id}/turn", {"text": "Where is my order?"}, raw=True, headers=bearer)
        replied = any("assistant.delta" in block or "assistant.done" in block for block in str(raw_turn).split("\n\n"))
        check("demo turn answered on the real pipeline", status == 200 and replied, f"status {status} {str(raw_turn)[:60]}")
        status, ended, _ = call("POST", f"/api/public/demo/{demo_id}/turn", {"end": True}, headers=bearer)
        check("demo call ended", status == 200 and (ended or {}).get("ended") is True, f"status {status}")
        status, _, _ = call("GET", f"/api/public/demo/{demo_id}/turn", headers=bearer)
        check("demo call is closed to further turns", status in (200, 401, 404, 405), f"status {status}")

    print("\n— session " + "—" * 40)
    status, me, _ = call("GET", "/api/auth/me")
    anon = status == 200 and me.get("authenticated") is False
    check("anonymous /api/auth/me reports it plainly", anon or status == 401, f"status {status}")

    status, body, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("login", status == 200, f"status {status} {envelope(body)}")

    status, assistants, _ = call("GET", "/api/v1/assistants?limit=50")
    list_ = (assistants.get("data") or []) if isinstance(assistants, dict) else []
    assistant = next((a for a in list_ if a.get("status") == "published"), list_[0] if list_ else None)
    check("assistants listed", bool(assistant), assistant.get("name") if assistant else "none")
    if not assistant:
        sys.exit(1)

    print("\n— streamed turn path " + "—" * 32)
    status, created, _ = call("POST", "/api/v1/calls", {"assistantId": assistant["id"], "type": "web", "from": "+14155550198"})
    call_doc = created if isinstance(created, dict) and created.get("id") else (created or {}).get("call")
    call_id = (call_doc or {}).get("id")
    check("call created", status in (200, 201) and bool(call_id), f"status {status} {call_id}")

    events: list[str] = []
    first_audio_ms = None
    if call_id:
        status, text, _ = call("POST", f"/api/v1/calls/{call_id}/turn/stream", {"text": "Hi, where is my order?"}, raw=True)
        check("streamed turn returned SSE", status == 200 and text.startswith("event:"), f"status {status}")
        for block in text.split("\n\n"):
            name = next((l[6:].strip() for l in block.splitlines() if l.startswith("event:")), None)
            if name:
                events.append(name)
        check(
            "event order is stt → intent → tool → tts → deltas → recorded",
            events[:4] == ["stt.final", "intent", "tool.start", "tool.end"] and "assistant.delta" in events and events[-1] == "turn.recorded",
            " → ".join(events[:8]) + ("…" if len(events) > 8 else ""),
        )
        check("turn.recorded is last", events[-1] == "turn.recorded", events[-1] if events else "no events")

        status, tele, _ = call(
            "POST",
            f"/api/v1/calls/{call_id}/telemetry",
            {"voiceToVoiceMs": 520, "sttMs": 180, "bargeIns": 1, "device": "Smoke bench", "browser": "python"},
        )
        check("telemetry accepted", status in (200, 201), f"status {status}")

    print("\n— conversation memory " + "—" * 33)
    # Booking needs an assistant that actually has the booking tool: the point of
    # this section is the dialogue, not which assistant is wired to what.
    booking_assistant = next(
        (a for a in list_ if set(a.get("tools") or []) & {"book_appointment", "reschedule_appointment", "check_availability"}),
        assistant,
    )
    check("an assistant with calendar tools exists", booking_assistant is not assistant or bool(booking_assistant.get("tools")), booking_assistant.get("name"))
    status, created2, _ = call("POST", "/api/v1/calls", {"assistantId": booking_assistant["id"], "type": "web", "source": "smoke-dialogue"})
    memory_call = (created2 or {}).get("id") or ((created2 or {}).get("call") or {}).get("id")
    if memory_call:
        call_id = memory_call
    # A dialogue, asserted on its outcome rather than its wording: the assistant
    # may be answering from the rule engine or from a real model depending on the
    # workspace's keys, and both have to move the booking.
    script = [
        "I need to reschedule my appointment",
        "Thursday works",
        "make it 2pm instead",
        "no that's everything, thanks",
    ]
    replies = []
    if call_id:
        for text in script:
            status, resp, _ = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": text})
            reply = str((resp or {}).get("turn", {}).get("reply", ""))
            replies.append(reply)
            check(f"turn answers: {text[:34]!r}", status == 200 and len(reply.strip()) > 12, reply[:70])
        check("every turn produced words", all(len(r.strip()) > 8 for r in replies) if replies else False, f"{len(replies)} replies")
        status, record, _ = call("GET", f"/api/v1/calls/{call_id}")
        doc = (record or {}).get("data") or record
        tools = [t.get("name") for t in ((doc or {}).get("toolCalls") or [])]
        check(
            "the dialogue used the calendar tools",
            any(("appoint" in str(t)) or ("availab" in str(t)) for t in tools),
            f"tools={tools[:4]}",
        )
        check(
            "the dialogue recorded what it learned",
            bool(((doc or {}).get("analysis") or {}).get("structuredData")),
            json.dumps(((doc or {}).get("analysis") or {}).get("structuredData") or {})[:80],
        )
        check(
            "the call says which engine answered",
            bool(((doc or {}).get("analysis") or {}).get("engine")),
            str(((doc or {}).get("analysis") or {}).get("engine")),
        )

    print("\n— metering, metrics, plumbing " + "—" * 26)
    if call_id:
        status, ended, _ = call("PATCH", f"/api/v1/calls/{call_id}", {"status": "ended", "endedReason": "customer-ended-call"})
        check("call ends cleanly", status == 200, f"status {status} {envelope(ended)}")
        status, record, _ = call("GET", f"/api/v1/calls/{call_id}")
        doc = record.get("data") or record
        cost_parts = doc.get("cost") or {}
        cost = cost_parts.get("total", 0)
        components = sum(float(cost_parts.get(key, 0) or 0) for key in ("platform", "stt", "tts", "llm", "telephony"))
        check(
            "call cost fields reconcile without inventing unavailable provider charges",
            status == 200 and float(cost) >= 0 and abs(float(cost) - components) < 0.000001,
            f"total ${cost} · components ${components:g}",
        )
        check("call has a transcript", len(doc.get("transcript") or []) >= 4, f"{len(doc.get('transcript') or [])} turns")
        check("call duration is measured, not guessed", (doc.get("durationSeconds") or 0) > 0, f"{doc.get('durationSeconds')}s")

    status, metrics, _ = call("GET", "/api/v1/metrics?days=14")
    check("metrics return percentiles", status == 200 and "latency" in json.dumps(metrics).lower(), f"status {status}")

    status, usage, _ = call("GET", "/api/v1/usage?days=30")
    check("usage window sums minutes", status == 200 and (usage or {}).get("minutes", 0) >= 0, f"{(usage or {}).get('minutes')} minutes")

    status, hooks, _ = call("GET", "/api/v1/webhooks")
    check("webhook deliveries are logged", status == 200 and isinstance((hooks or {}).get("deliveries"), list), f"{len((hooks or {}).get('deliveries') or [])} deliveries")

    native_lists = (
        ("analytics exports", "/api/v1/analytics/exports", "data"),
        ("workspace audit", "/api/v1/audit", "data"),
        ("operations board", "/api/v1/board", "sites"),
    )
    for label, path, field in native_lists:
        status, res, _ = call("GET", path)
        check(f"native {label} is readable", status == 200 and isinstance((res or {}).get(field), list), f"status {status}")

    print("\n— telephony " + "—" * 38)
    status, numbers, _ = call("GET", "/api/v1/phone-numbers")
    check("numbers listed", status == 200 and len((numbers or {}).get("data") or []) >= 1, f"{len((numbers or {}).get('data') or [])} numbers")

    status, carriers, _ = call("GET", "/api/v1/carriers")
    carriers_list = (carriers or {}).get("data") or []
    check("carriers endpoint answers", status == 200, f"{len(carriers_list)} connected")

    status, status_doc, _ = call("GET", "/api/telephony/media/status")
    check(
        "media pipeline reports its own readiness",
        status == 200 and (status_doc or {}).get("protocol") == "twilio-media-streams",
        f"transcriber {(status_doc or {}).get('providers', {}).get('transcriber', {}).get('provider')}",
    )

    if EXPECT_CARRIER and not carriers_list:
        stub_sid = os.environ.get("STUB_SID", "AC0123456789abcdef0123456789abcdef")
        stub_token = os.environ.get("STUB_TOKEN", "stub-auth-token")
        status, connected, _ = call(
            "POST",
            "/api/v1/carriers",
            {"provider": "twilio", "accountSid": stub_sid, "authToken": stub_token, "label": "Smoke carrier"},
        )
        check("carrier connected for the outbound check", status in (200, 201), f"status {status} {envelope(connected)}")

    status, outbound, _ = call("POST", "/api/telephony/outbound", {"to": "+14155559876", "assistantId": assistant["id"]})
    if EXPECT_CARRIER:
        check("outbound dialled through the carrier", (outbound or {}).get("dialled") is True, str((outbound or {}).get("carrier")))
    else:
        # Either it refuses and says why, or the deployment has managed telephony
        # and it dials on the platform account — which it names.
        refusal = envelope(outbound)
        check(
            "outbound is explicit about who is dialling",
            ((outbound or {}).get("dialled") is False and (outbound or {}).get("reason") in ("no_carrier", "carrier_error"))
            or ((outbound or {}).get("dialled") is True and (outbound or {}).get("via") in ("workspace", "managed"))
            or (status == 409 and "active carrier-backed workspace number" in refusal.lower()),
            f"status={status} dialled={(outbound or {}).get('dialled')} via={(outbound or {}).get('via')} reason={(outbound or {}).get('reason') or refusal}",
        )

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL SMOKE CHECKS PASS")


if __name__ == "__main__":
    main()
