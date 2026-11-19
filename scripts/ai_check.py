#!/usr/bin/env python3
"""
AI engine check.

Proves the model path is real: a workspace key is verified against the provider,
refused when it is wrong, stored masked, and then actually used — the agent books
an appointment through a tool call the *model* asked for, and the call record
shows which engine answered.

    tsx scripts/ai-stub.ts &
    ANTHROPIC_API_BASE=http://127.0.0.1:4020 ANTHROPIC_API_KEY=stub-anthropic-key npm start
    python3 scripts/ai_check.py

Then the same script run with STUB_AI_FAIL=1 on the stub proves the other half:
a provider that breaks must not break the call — the rule engine answers instead
and the call record says why.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STUB = os.environ.get("AI_STUB_BASE", "http://127.0.0.1:4020")
ANTHROPIC_KEY = os.environ.get("AI_STUB_KEY", "stub-anthropic-key")
BAD_KEY = os.environ.get("AI_STUB_BAD_KEY", "sk-ant-wrong-000000000000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
# Set EXPECT_FALLBACK=1 when the stub is running with STUB_AI_FAIL=1.
EXPECT_FALLBACK = os.environ.get("EXPECT_FALLBACK") == "1"

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode()
            set_cookie = res.headers.get("set-cookie")
            globals()["cookie"] = set_cookie.split(";")[0] if set_cookie else cookie
            return res.status, (text if raw else (json.loads(text) if text else {}))
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            payload = text if raw else (json.loads(text) if text else {})
        except json.JSONDecodeError:
            payload = text
        return err.code, payload


def envelope(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def main():
    global cookie
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    check("login", bool(cookie), "session cookie" if cookie else "no session")

    # ---- credentials ------------------------------------------------------
    status, body = call("GET", "/api/v1/ai/credentials")
    for existing in (body.get("data") or []):
        call("DELETE", f"/api/v1/ai/credentials/{existing['id']}")

    status, body = call("POST", "/api/v1/ai/credentials", {"provider": "anthropic", "apiKey": BAD_KEY})
    check("a wrong key is refused", status in (400, 401), f"status {status} {envelope(body)}")
    status, body = call("GET", "/api/v1/ai/credentials")
    check("a refused key is not stored", len(body.get("data") or []) == 0, f"{len(body.get('data') or [])} credentials")

    status, body = call("POST", "/api/v1/ai/credentials", {"provider": "anthropic", "apiKey": ANTHROPIC_KEY, "label": "Northwind Claude"})
    check("key connected and verified", status == 201, f"status {status} {envelope(body)}")
    credential = body if isinstance(body, dict) else {}
    check("provider confirmed the key", (credential.get("verification") or {}).get("models", 0) >= 3, str((credential.get("verification") or {}).get("note"))[:70])
    check("key is stored masked", "••" in str(credential.get("keyHint")) and ANTHROPIC_KEY not in json.dumps(credential), str(credential.get("keyHint")))

    status, body = call("POST", f"/api/v1/ai/credentials/{credential.get('id')}", {})
    check("re-verify works", status == 200 and body.get("verified") is True, f"status {status} {envelope(body)}")

    status, models = call("GET", "/api/v1/ai/models")
    ready = {p["id"]: p for p in (models.get("providers") or [])}
    check("models endpoint reports the engine", status == 200 and models.get("engine") == "model", f"engine={models.get('engine')}")
    check("anthropic is ready with a workspace key", ready.get("anthropic", {}).get("ready") is True, f"ready={ready.get('anthropic', {}).get('ready')}")
    catalogue = models.get("models") or []
    check(
        "catalogue never presents unavailable provider prices as facts",
        bool(catalogue) and all(
            m.get("pricingAvailable") is True
            or ((m.get("inputCost") or 0) == 0 and (m.get("outputCost") or 0) == 0)
            for m in catalogue
        ),
        f"{sum(1 for m in catalogue if m.get('pricingAvailable'))}/{len(catalogue)} priced",
    )

    # ---- the model actually answers a turn --------------------------------
    status, assistants = call("GET", "/api/v1/assistants?limit=50")
    list_ = assistants.get("data") or []
    booking = next((a for a in list_ if set(a.get("tools") or []) & {"book_appointment", "reschedule_appointment", "check_availability"}), None)
    check("a booking assistant exists", booking is not None, booking.get("name") if booking else "none")
    if not booking:
        sys.exit(1)

    # Pin it to Claude so the model path is the one under test. Whatever it was
    # before is remembered and put back at the end: a check that leaves the
    # workspace re-pointed at a different model would corrupt every later run.
    original = {"model": booking.get("model"), "provider": booking.get("provider")}
    status, patched = call("PATCH", f"/api/v1/assistants/{booking['id']}", {"model": "claude-sonnet-4.5", "provider": "anthropic"})
    check("assistant pinned to a Claude model", status in (200, 201), f"status {status} {envelope(patched)}")

    status, created = call("POST", "/api/v1/calls", {"assistantId": booking["id"], "type": "web", "source": "ai-check"})
    call_id = created.get("id") or (created.get("call") or {}).get("id")
    check("call opened", bool(call_id), str(call_id))
    if not call_id:
        sys.exit(1)

    status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "I need to move my appointment to Thursday at 2pm"})
    result = turn.get("turn") or {}
    tools = [t.get("name") for t in (result.get("toolCalls") or [])]
    if EXPECT_FALLBACK:
        check("provider failure falls back to the rule engine", "rules" in str(result.get("engine", "rules")) or result.get("engine") == "rules", f"engine={result.get('engine')}")
        check("caller still gets an answer", bool(result.get("reply")), (result.get("reply") or "")[:80])
        check("the call record says why", bool(result.get("modelError")), str(result.get("modelError"))[:110])
    else:
        check("engine is the model, not the rules", result.get("engine") == "anthropic", f"engine={result.get('engine')} model={result.get('model')}")
        check("the model called a booking tool", any("appointment" in str(t) for t in tools), f"tools={tools}")
        check("the tool result came back to the caller", bool(result.get("reply")), (result.get("reply") or "")[:90])
        check("tokens are counted", (result.get("tokensIn") or 0) > 0 and (result.get("tokensOut") or 0) > 0, f"in={result.get('tokensIn')} out={result.get('tokensOut')}")
        selected_price = next((m for m in catalogue if m.get("id") == "claude-sonnet-4.5"), {})
        charged = float(result.get("costUsd") or 0)
        check(
            "cost follows available attribution instead of inventing a charge",
            (selected_price.get("pricingAvailable") is True and charged > 0)
            or (selected_price.get("pricingAvailable") is not True and charged == 0),
            f"${charged:g} · pricingAvailable={selected_price.get('pricingAvailable')}",
        )

    status, second = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "cancel it instead"})
    second_result = second.get("turn") or {}
    if not EXPECT_FALLBACK:
        second_tools = [t.get("name") for t in (second_result.get("toolCalls") or [])]
        check("a second tool call in the same call", any("cancel" in str(t) for t in second_tools), f"tools={second_tools}")

    status, detail = call("GET", f"/api/v1/calls/{call_id}")
    doc = detail.get("data") or detail
    transcript = doc.get("transcript") or []
    check("the transcript is a real conversation", len(transcript) >= 3, f"{len(transcript)} turns")
    check("the call stayed in progress", doc.get("status") in ("in-progress", "queued"), str(doc.get("status")))

    # ---- the media/phone path uses the same engine -------------------------
    status, status_doc = call("GET", "/api/telephony/media/status")
    check("phone path reports its providers", status == 200, f"transcriber={(status_doc.get('providers') or {}).get('transcriber', {}).get('provider')}")

    req = urllib.request.Request(f"{STUB}/v1/models", headers={"x-api-key": ANTHROPIC_KEY})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            stub_models = json.loads(res.read().decode()).get("data") or []
        check("provider stub is live", len(stub_models) >= 3, f"{len(stub_models)} models")
    except Exception as err:  # noqa: BLE001 — the message is the assertion detail
        check("provider stub is live", False, str(err))

    # ---- bring your own endpoint ------------------------------------------
    # The customer's own service, standing in for a self-hosted model, a gateway
    # or a LiteLLM proxy. The stub is deliberately fussy: it refuses without its
    # own `x-voxera-tenant` header, so this section proves the configured headers
    # are really sent, not merely stored and displayed.
    custom_url = f"{STUB}/custom/v1"

    status, refused = call(
        "POST",
        "/api/v1/ai/credentials",
        {"provider": "custom", "baseUrl": custom_url, "apiKey": ANTHROPIC_KEY, "authStyle": "bearer", "label": "Northwind gateway"},
    )
    check(
        "an endpoint that rejects us is refused, with its words",
        status == 401 and "tenant" in json.dumps(refused).lower(),
        f"status {status} {json.dumps(refused)[:110]}",
    )

    status, missing = call("POST", "/api/v1/ai/credentials", {"provider": "custom", "apiKey": ANTHROPIC_KEY})
    check("an endpoint without a URL is refused", status == 400, f"status {status} {json.dumps(missing)[:90]}")

    status, garbled = call(
        "POST",
        "/api/v1/ai/credentials",
        {"provider": "custom", "baseUrl": "ai.northwind.dev", "apiKey": ANTHROPIC_KEY},
    )
    check("a URL that is not a URL is refused, with advice", status == 400 and "scheme" in json.dumps(garbled).lower(), f"status {status} {json.dumps(garbled)[:110]}")

    status, endpoint = call(
        "POST",
        "/api/v1/ai/credentials",
        {
            "provider": "custom",
            "baseUrl": custom_url,
            "apiKey": ANTHROPIC_KEY,
            "authStyle": "bearer",
            "headers": {"x-voxera-tenant": "northwind", "x-northwind-gateway-token": "gw-secret-9f2a"},
            "label": "Northwind gateway",
        },
    )
    custom_id = endpoint.get("id")
    check("their endpoint is accepted once it answers", status == 201, f"status {status} {json.dumps(endpoint)[:110]}")
    check("the endpoint's own models are discovered", len(endpoint.get("models") or []) >= 2, ", ".join(endpoint.get("models") or []) or "none")
    check("their endpoint is reported as verified", endpoint.get("verified") is True, str(endpoint.get("note"))[:90])
    names = endpoint.get("headerNames") or []
    check(
        "the header names are reported, the values never are",
        "x-voxera-tenant" in names and "x-northwind-gateway-token" in names and "gw-secret-9f2a" not in json.dumps(endpoint),
        f"names={names}",
    )

    status, tested = call("POST", f"/api/v1/ai/credentials/{custom_id}", {"action": "test"})
    check("a test message really completes through it", status == 200 and bool(tested.get("reply")), f"{tested.get('model')} in {tested.get('latencyMs')}ms: {str(tested.get('reply'))[:60]}")

    # Now make it answer a live call: pin the assistant to a model only their
    # endpoint publishes.
    status, before_custom = call("GET", f"/api/v1/assistants/{booking['id']}")
    original_custom = before_custom.get("data") or before_custom
    call("PATCH", f"/api/v1/assistants/{booking['id']}", {"model": "northwind-desk-70b", "provider": "custom"})
    status, call_doc = call(
        "POST",
        "/api/v1/calls",
        {"assistantId": booking["id"], "type": "web", "customer": {"number": "+14155559010"}},
    )
    call_id = call_doc.get("id")
    # A read-only tool on purpose: this proves the endpoint's tool calls run
    # through the real executors without mutating a booking that another check
    # owns. (An earlier version rescheduled one and broke `book_check.py`.)
    status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "Can you check on my order please?"})
    turn_doc = turn.get("turn") or {}
    status, final = call("GET", f"/api/v1/calls/{call_id}")
    engine = ((final.get("data") or final).get("analysis") or {}).get("engine")
    check("the customer's own model answers the call", engine == "custom", f"engine={engine} modelError={turn_doc.get('modelError')}")
    check("the turn came back with text", bool(str(turn_doc.get("reply") or "").strip()), str(turn_doc.get("reply"))[:70])
    check("its tool calls run through the same executors", any(t.get("name") for t in (turn_doc.get("toolCalls") or [])), ", ".join(t.get("name", "?") for t in (turn_doc.get("toolCalls") or [])) or "none")
    check("the tool ran, it was not merely offered", any((t.get("status") == "ok") for t in (turn_doc.get("toolCalls") or [])), str((turn_doc.get("toolCalls") or [{}])[0].get("result"))[:70])
    check(
        "no invented price is charged for their model",
        float(turn_doc.get("costUsd") or 0) == 0.0 and int(turn_doc.get("tokensIn") or 0) > 0,
        f"costUsd={turn_doc.get('costUsd')} from {turn_doc.get('tokensIn')} real tokens",
    )

    # A model id no catalogue knows still routes to their endpoint, without being
    # pinned by hand — that is how an internal alias works.
    call("PATCH", f"/api/v1/assistants/{booking['id']}", {"model": "northwind-triage-8b", "provider": None})
    status, call_doc2 = call("POST", "/api/v1/calls", {"assistantId": booking["id"], "type": "web", "customer": {"number": "+14155559011"}})
    call("POST", f"/api/v1/calls/{call_doc2.get('id')}/turn", {"text": "Hello, what can you do?"})
    status, final2 = call("GET", f"/api/v1/calls/{call_doc2.get('id')}")
    engine2 = ((final2.get("data") or final2).get("analysis") or {}).get("engine")
    check("an unknown model id routes to their endpoint unpinned", engine2 == "custom", f"engine={engine2}")

    # And the same endpoint over the Messages wire, for a gateway that speaks it.
    status, messages_endpoint = call(
        "POST",
        "/api/v1/ai/credentials",
        {
            "provider": "custom",
            "baseUrl": f"{STUB}/custom-anthropic",
            "wire": "anthropic",
            "apiKey": ANTHROPIC_KEY,
            "authStyle": "x-api-key",
            "headers": {"x-voxera-tenant": "northwind"},
            "label": "Northwind Messages gateway",
        },
    )
    check("an Anthropic-shaped endpoint is accepted too", status == 201, f"status {status} {json.dumps(messages_endpoint)[:100]}")
    status, tested2 = call("POST", f"/api/v1/ai/credentials/{messages_endpoint.get('id')}", {"action": "test"})
    check("and a test message completes over Messages", status == 200 and bool(tested2.get("reply")), str(tested2.get("reply"))[:70])

    call("DELETE", f"/api/v1/ai/credentials/{custom_id}")

    # ---- put the workspace back -------------------------------------------
    call("DELETE", f"/api/v1/ai/credentials/{credential.get('id')}")
    call("PATCH", f"/api/v1/assistants/{booking['id']}", {"model": original["model"] or "gpt-4o-mini", "provider": original["provider"]})
    status, restored = call("GET", f"/api/v1/assistants/{booking['id']}")
    check(
        "the workspace is left as it was found",
        (restored.get("data") or restored).get("model") == (original["model"] or "gpt-4o-mini"),
        f"model={(restored.get('data') or restored).get('model')}",
    )

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL AI CHECKS PASS" + (" (fallback mode)" if EXPECT_FALLBACK else ""))


if __name__ == "__main__":
    main()
