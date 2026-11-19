#!/usr/bin/env python3
"""
Onboarding check — the whole self-serve path, as a new customer walks it.

    sign up  →  create the agent  →  buy a number  →  make the first call

Nothing in this script touches an admin endpoint: it is exactly the sequence the
wizard performs, against a real workspace, with a real carrier (the stub) and the
real agent runtime. It is the test that answers "can somebody sign up and get a
working phone line without talking to us?"

    tsx scripts/twilio-stub.ts &
    TWILIO_API_BASE=http://127.0.0.1:4010 npm start
    python3 scripts/onboard_check.py
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STUB = os.environ.get("TWILIO_STUB_BASE", "http://127.0.0.1:4010")
SID = os.environ.get("STUB_SID", "AC" + "0123456789abcdef0123456789abcdef")
TOKEN = os.environ.get("STUB_TOKEN", "stub-auth-token")

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, base=None, expect=None, timeout=60):
    global cookie
    url = (base or BASE) + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie and not base:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
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
            return err.code, {"raw": text[:200]}


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def code_from_inbox(email):
    """The six-digit code, read from the mail the deployment actually sent.

    The relay is the carrier stub in this environment, so the evidence is the
    stub's own record of what left the building — not a value the test invented.
    """
    status, payload = call("GET", "/__state", base=STUB)
    for mail in payload.get("sentEmails") or []:
        if mail.get("to") != email:
            continue
        found = re.search(r"code is (\d{6})", mail.get("text") or "")
        if found:
            return found.group(1)
    return None


def main():
    global cookie
    cookie = ""
    stamp = str(int(time.time()))

    # A clean carrier side, so this run's purchases are this run's.
    call("POST", "/__reset", {}, base=STUB)
    # One fixed address: the first run signs up, later runs sign back in and reset
    # their own artefacts, so repeating this check does not litter the database
    # with a workspace per run.
    email = os.environ.get("ONBOARD_EMAIL", "founder@sunrise-dental.example")

    # ---- 1. sign up, as a stranger would --------------------------------
    status, signup = call(
        "POST",
        "/api/auth/signup",
        {
            "email": email,
            "password": "correct-horse-battery",
            "name": "New Founder",
            "orgName": "Sunrise Dental",
            "businessType": "dental",
        },
    )
    fresh_workspace = status == 201
    if fresh_workspace:
        check("a stranger can sign up", True, "status 201, new workspace")
        org = signup.get("org") or {}
        check("signup creates the workspace", bool(org.get("id")), str(org.get("name")))
    else:
        # A fixed address, so repeating this check does not leave a workspace
        # behind every run: sign back in and reset this workspace's artefacts.
        status, login = call("POST", "/api/auth/login", {"email": email, "password": "correct-horse-battery"})
        check("the returning founder can sign in", status == 200, f"status {status} {message(login)[:70]}")
        check("signup creates the workspace", bool((login.get("org") or {}).get("id")), "existing workspace")
        for c in (call("GET", "/api/v1/booking-campaigns")[1].get("data") or []):
            call("DELETE", f"/api/v1/booking-campaigns/{c['id']}")
        for n in (call("GET", "/api/v1/numbers")[1].get("data") or []):
            if n.get("carrierSid"):
                call("POST", f"/api/v1/phone-numbers/{n['id']}/release", {"atCarrier": True})

    # Bootstrap must initialise only real workspace state. A production signup no
    # longer receives invented assistants, numbers, calls, staff or practice data.
    status, boot = call("POST", "/api/bootstrap", timeout=240)
    check("the workspace is initialised on first load", status in (200, 201), f"status {status}")

    status, before_profile = call("GET", "/api/v1/onboarding")
    check(
        "setup state is readable immediately",
        status == 200 and before_profile.get("total") == 5,
        f"{before_profile.get('done')}/{before_profile.get('total')} done",
    )
    initial_steps = {step.get("id"): step for step in (before_profile.get("steps") or [])}
    profile_step = initial_steps.get("business_profile", {})
    if fresh_workspace:
        check(
            "a typed signup still asks for locale details",
            profile_step.get("done") is False,
            str(profile_step.get("detail")),
        )
    else:
        # This gate deliberately reuses one workspace. Once its owner has supplied
        # locale details, a later run must preserve and report them rather than
        # pretending the returning account is incomplete again.
        check(
            "a returning typed workspace reports its saved locale details",
            profile_step.get("done") is True or "still need review" in str(profile_step.get("detail")),
            str(profile_step.get("detail")),
        )
    if fresh_workspace:
        check(
            "a new production workspace has no invented demo history",
            before_profile.get("preloaded") is False and not before_profile.get("demo"),
            str(before_profile.get("demo")),
        )

    # Type recommends modules, but country/timezone/currency are explicit owner
    # choices. Complete them through the same profile API as the dashboard.
    status, profile = call(
        "PATCH",
        "/api/v1/workspace/profile",
        {
            "type": "dental",
            "useRecommendedModules": True,
            "country": "US",
            "timezone": "America/Los_Angeles",
            "currency": "USD",
            "businessHours": [
                {"weekday": day, "open": day not in (0, 6), **({"start": "09:00", "end": "17:00"} if day not in (0, 6) else {})}
                for day in range(7)
            ],
            "termPack": "clinical",
        },
    )
    business = profile.get("business") or {}
    check(
        "the owner can complete the typed business profile",
        status == 200 and business.get("type") == "dental" and business.get("configured") is True,
        f"status {status} type={business.get('type')}",
    )
    check(
        "dental recommendations do not enable unrelated field-service or developer modules",
        "field_service" not in (business.get("modules") or []) and "developer" not in (business.get("modules") or []),
        ", ".join(business.get("modules") or []),
    )

    # ---- 1b. the verification gate --------------------------------------
    # Publishing an assistant, buying a number, and creating API keys are refused
    # until the address is verified (`requireVerifiedEmail`). A first run walks
    # the whole thing; later runs take the already-verified path.
    status, vstate = call("GET", "/api/auth/verify")
    if not vstate.get("verified"):
        status, drafted = call(
            "POST",
            "/api/v1/onboarding/assistant",
            {"useCase": "booking-confirmation", "business": "Sunrise Dental"},
        )
        draft = drafted.get("assistant") or {}
        check(
            "an unverified account can still draft an agent",
            status == 201 and draft.get("status") == "draft",
            f"status {status} agent={draft.get('status')}",
        )
        status, refused = call("POST", f"/api/v1/assistants/{draft.get('id')}/publish", {})
        check(
            "publishing is refused until the address is verified",
            status == 403 and (refused.get("error") or {}).get("code") == "EMAIL_NOT_VERIFIED",
            f"status {status} {message(refused)[:60]}",
        )
        status, refused_buy = call("POST", "/api/v1/numbers", {"areaCode": "415"})
        check("buying a number is refused until the address is verified", status == 403, f"status {status}")
        status, sent = call("POST", "/api/auth/verify", {})
        code = code_from_inbox(email)
        check(
            "a six-digit code is emailed",
            status == 200 and sent.get("sent") is True and bool(code),
            f"status {status} code={'sent' if code else 'missing'}",
        )
        status, wrong = call("POST", "/api/auth/verify/confirm", {"code": "000000"})
        check(
            "a wrong code is refused, with the attempts left",
            status == 400 and "attempts left" in message(wrong),
            message(wrong)[:70],
        )
        status, confirmed = call("POST", "/api/auth/verify/confirm", {"code": code or "000000"})
        check("the code verifies the account", status == 200 and confirmed.get("verified") is True, message(confirmed)[:60])
        status, published = call("POST", f"/api/v1/assistants/{draft.get('id')}/publish", {})
        check(
            "publishing works the moment the address is verified",
            status == 200 and published.get("status") == "published",
            f"status {status}",
        )
    else:
        status, again = call("POST", "/api/auth/verify", {})
        check(
            "a verified account is not sent another code",
            status == 200 and again.get("alreadyVerified") is True,
            f"status {status}",
        )

    status, state = call("GET", "/api/v1/onboarding")
    check("setup state is still readable once work has begun", status == 200 and state.get("total") == 5, f"{state.get('done')}/{state.get('total')} done")
    if not fresh_workspace:
        check("a returning workspace reports its own state", state.get("done", 0) >= 1, f"{state.get('done')}/5 at start")
    open_before = {st["id"] for st in state.get("steps") or [] if not st["done"]}
    use_cases = state.get("useCases") or []
    check(
        "the wizard lists profile-relevant use cases",
        len(use_cases) >= 2 and not any(u.get("id") == "contractor-enquiries" for u in use_cases),
        ", ".join(u["label"] for u in use_cases),
    )
    check(
        "telephony mode is reported honestly",
        state.get("telephony", {}).get("mode") in ("workspace", "managed", "none"),
        f"mode={state.get('telephony', {}).get('mode')} hint={str(state.get('telephony', {}).get('hint'))[:60]}",
    )

    # ---- 2. create the agent -------------------------------------------
    status, made = call(
        "POST",
        "/api/v1/onboarding/assistant",
        {"useCase": "booking-confirmation", "business": "Sunrise Dental"},
    )
    check("a use case produces an agent", status == 201, f"status {status} {message(made)[:80]}")
    assistant = made.get("assistant") or {}
    check("a new agent starts as a draft for review", assistant.get("status") == "draft", str(assistant.get("status")))
    check("the draft has no invented business policies", not (assistant.get("knowledge") or []), str(assistant.get("knowledge")))
    check("the agent has the tools its job needs", {"reschedule_appointment", "cancel_appointment"} <= set(assistant.get("tools") or []), f"{len(assistant.get('tools') or [])} tools")
    check("the business name reached the greeting", "Sunrise Dental" in str(assistant.get("firstMessage")), str(assistant.get("firstMessage"))[:70])
    onboarding = made.get("onboarding") or {}
    step = next((s for s in onboarding.get("steps") or [] if s["id"] == "assistant"), {})
    check("a draft is not reported as published", step.get("done") is False, str(step.get("detail")))
    status, published = call("POST", f"/api/v1/assistants/{assistant.get('id')}/publish", {"message": "Reviewed for the onboarding gate"})
    check("explicit publishing succeeds after verification", status == 200 and published.get("status") == "published", f"status {status}")
    status, onboarding = call("GET", "/api/v1/onboarding")
    step = next((s for s in onboarding.get("steps") or [] if s["id"] == "assistant"), {})
    check("the checklist notices the published agent", step.get("done") is True, str(step.get("detail")))

    # ---- 3. buy a number ------------------------------------------------
    status, carriers = call("GET", "/api/v1/carriers")
    if not (carriers.get("data") or []):
        status, connected = call(
            "POST",
            "/api/v1/carriers",
            {"provider": "twilio", "accountSid": SID, "authToken": TOKEN, "label": "Onboard check carrier"},
        )
        check("the workspace connects a carrier", status in (200, 201), f"status {status} {message(connected)[:70]}")
        carrier_id = connected.get("id")
        created_carrier = True
    else:
        carrier_id = carriers["data"][0]["id"]
        created_carrier = False
        check("the workspace already had a carrier", True, carriers["data"][0].get("label", ""))

    status, search = call("GET", "/api/v1/onboarding/numbers?areaCode=415")
    available = search.get("available") or []
    check("area-code search returns inventory", status == 200 and len(available) >= 1, f"{len(available)} numbers for {search.get('areaCodeLabel')}")
    check("inventory is labelled with its locality", any(n.get("locality") for n in available), str(available[0])[:80] if available else "none")

    # Keep reporting the remaining dependent failures instead of crashing when a
    # carrier/search regression returns no inventory.
    picked = (available[0] or {}).get("number") if available else None
    status, bought = call("POST", "/api/v1/onboarding/numbers/buy", {"number": picked, "label": "Front desk", "country": "US"})
    check("the number is bought on the first try", status == 201, f"status {status} {message(bought)[:80]}")
    number = bought.get("number") or {}
    check("the number is stored with its carrier", bool(number.get("carrierSid")) and bool(number.get("carrierId")), str(number.get("carrierId"))[:40])
    check("the number is assigned to the agent", bool(number.get("assistantId")), str(number.get("assistantId"))[:40])
    check("the purchase says which account it used", bought.get("boughtOn") in ("workspace", "managed"), str(bought.get("boughtOn")))

    status, again = call("POST", "/api/v1/onboarding/numbers/buy", {"number": picked})
    check("buying the same number twice is not a second purchase", again.get("reused") is True, f"reused={again.get('reused')}")

    # The stub records what the carrier was asked to do — proof the number is live.
    status, stub_state = call("GET", "/__state", base=STUB)
    checks = [str(entry) for entry in (stub_state.get("requests") or [])]
    check(
        "the carrier was told where to send calls",
        any("IncomingPhoneNumbers" in entry for entry in checks),
        f"{len(checks)} carrier request(s)",
    )
    wired = [entry for entry in checks if "IncomingPhoneNumbers" in entry and entry.startswith("POST")]
    check("voice webhooks were set at purchase time", bool(wired), wired[0] if wired else "none")

    # ---- 4. the first call ---------------------------------------------
    status, browser = call("POST", "/api/v1/onboarding/first-call", {"mode": "browser"})
    check("the browser test call opens", status == 201 and bool((browser.get("call") or {}).get("id")), f"status {status} {message(browser)[:70]}")
    call_id = (browser.get("call") or {}).get("id")

    if call_id:
        status, turn = call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "Hi — is my appointment still on for tomorrow?"})
        reply = str((turn.get("turn") or {}).get("reply") or "")
        check("the agent answers on the very first call", status == 200 and len(reply) > 12, reply[:80])
        status, record = call("GET", f"/api/v1/calls/{call_id}")
        doc = record.get("data") or record
        check("the call is on the record as a test", (doc.get("source") or "") == "onboarding", str(doc.get("source")))
        check("the record names the engine that answered", bool((doc.get("analysis") or {}).get("engine")), str((doc.get("analysis") or {}).get("engine")))

    status, phone = call("POST", "/api/v1/onboarding/first-call", {"mode": "phone", "to": "+14155559999"})
    if phone.get("dialled") is True:
        check("ringing your own phone works", bool(phone.get("carrierSid")), str(phone.get("carrierSid")))
        status, stub_after = call("GET", "/__state", base=STUB)
        calls = stub_after.get("placedCalls") or []
        check("the dial really left through the carrier", bool(calls), f"{len(calls)} call(s) at the carrier")
    else:
        check("ringing your own phone explains itself when it cannot", phone.get("error") is not None or phone.get("dialled") is False, str(phone.get("error"))[:80])

    # ---- 5. the checklist agrees ----------------------------------------
    status, final = call("GET", "/api/v1/onboarding")
    steps = {s["id"]: s for s in final.get("steps") or []}
    check("agent step is done", steps.get("assistant", {}).get("done") is True, str(steps.get("assistant", {}).get("detail")))
    check("number step is done", steps.get("number", {}).get("done") is True, str(steps.get("number", {}).get("detail")))
    check("first-call step is done", steps.get("first_call", {}).get("done") is True, str(steps.get("first_call", {}).get("detail")))
    # This run completes the profile, assistant, number and first call. Operations
    # may remain open until the owner supplies real services/rotas; it must not be
    # faked merely to make the progress bar reach 100%.
    still_open = {st for st, v in steps.items() if not v.get("done")}
    check(
        "every actionable onboarding step this run opened is now closed",
        not ((open_before - {"operations"}) & still_open),
        f"open before: {sorted(open_before)} · still open: {sorted(still_open)}",
    )
    check(
        "any unfinished setup is named rather than hidden",
        still_open <= {"operations"} and (not still_open or bool(steps.get("operations", {}).get("detail"))),
        f"still open: {sorted(still_open)}",
    )
    check("the disabled developer module adds no pretend webhook step", "connect" not in steps, ", ".join(steps))
    check("progress is reported as a number", final.get("percent", 0) >= 80, f"{final.get('percent')}%")

    # Production signup does not mint an undisclosed wildcard credential. An
    # owner can create one deliberately, and sees its secret exactly once.
    status, keys = call("GET", "/api/v1/keys")
    active_keys = [row for row in (keys.get("data") or []) if not row.get("revokedAt")]
    check("signup invents no active API key", status == 200 and len(active_keys) == 0, f"{len(active_keys)} active / {len(keys.get('data') or [])} historical")
    status, made_key = call("POST", "/api/v1/keys", {"name": "onboarding probe", "scopes": ["bookings:read"]})
    check("the verified owner can create a scoped key explicitly", status == 201 and bool(made_key.get("secret")), f"status {status}")

    # ---- 6. the loop closes: a booking can be confirmed by this workspace
    soon = (datetime.now(timezone.utc) + timedelta(hours=5)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    status, synced = call(
        "POST",
        "/api/v1/bookings/sync",
        {
            "mode": "partial",
            "bookings": [
                {"externalId": f"ONB-{stamp}", "customer": {"name": "Test Patient", "number": "+14155559901"}, "service": "Checkup", "startsAt": soon}
            ],
        },
    )
    check("the new workspace can take its own bookings", status == 200 and synced.get("created", 0) >= 1, f"created={synced.get('created')}")

    status, campaign = call(
        "POST",
        "/api/v1/booking-campaigns",
        {"name": f"ONB {stamp} confirmations", "kind": "confirm", "assistantId": assistant.get("id"), "withinHours": 24, "quietHours": {"start": 0, "end": 24}},
    )
    check("a campaign can be created against the new agent", status == 201, f"status {status} {message(campaign)[:70]}")
    check("and it warns about nothing missing", not (campaign.get("warnings") or []), str(campaign.get("warnings"))[:90])

    status, dry = call("POST", f"/api/v1/booking-campaigns/{campaign.get('id')}/run", {"dryRun": True})
    check("the new workspace sees who it would ring", dry.get("skipped", 0) >= 1, f"would call {dry.get('skipped')}")

    # ---- cleanup: the account is disposable ------------------------------
    if made_key.get("id"):
        call("DELETE", f"/api/v1/keys/{made_key['id']}")
    call("DELETE", f"/api/v1/booking-campaigns/{campaign.get('id')}")
    for row in (call("GET", "/api/v1/bookings?limit=100")[1].get("data") or []):
        if str(row.get("externalId", "")).startswith("ONB-"):
            call("POST", f"/api/v1/bookings/{row['id']}/status", {"status": "cancelled", "note": "onboard_check cleanup"})
    # Order matters: give the number back to the carrier *before* disconnecting the
    # carrier, or there is no account left to release it from.
    if number.get("id"):
        status, released = call("POST", f"/api/v1/phone-numbers/{number['id']}/release", {"atCarrier": True})
        check("the number is given back at the end", status == 200 and released.get("releasedAtCarrier") is True, f"status {status} {message(released)[:70]}")
    if created_carrier and carrier_id:
        call("DELETE", f"/api/v1/carriers/{carrier_id}")

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("ALL ONBOARDING CHECKS PASS")


if __name__ == "__main__":
    main()
