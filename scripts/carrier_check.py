#!/usr/bin/env python3
"""Twilio carrier, ownership, callback, and compensation runtime gate.

Run only against an isolated test deployment whose Twilio and email transports
point at ``scripts/twilio-stub.ts``. The gate refuses to borrow arbitrary carrier
accounts and cleans up only the known stub connection and numbers it creates.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402
from _twilio import direct_headers, twilio_headers  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000").rstrip("/")
PUBLIC_ORIGIN = os.environ.get("VOXERA_PUBLIC_URL", BASE).rstrip("/")
STUB = os.environ.get("STUB_BASE", "http://127.0.0.1:4010").rstrip("/")
SID = os.environ.get("STUB_SID", "AC" + "0123456789abcdef0123456789abcdef")
TOKEN = os.environ.get("STUB_TOKEN", "stub-auth-token")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
OTHER_EMAIL = os.environ.get("VOXERA_CARRIER_TENANT_EMAIL", "carrier-tenant-probe@example.test")
OTHER_PASSWORD = os.environ.get("VOXERA_CARRIER_TENANT_PASSWORD", "carrier-probe-password-2026")

cookie = ""
failures: list[str] = []
created_number_ids: list[tuple[str, bool]] = []  # (id, release at carrier?)
carrier_id = ""
other_cookie = ""
other_carrier_id = ""


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)
    return bool(ok)


def message(payload):
    return (payload.get("error") or {}).get("message", "") if isinstance(payload, dict) else str(payload)


def masked_sid(sid: str) -> str:
    return f"{sid[:6]}••••{sid[-3:]}"


def call(
    method,
    path,
    body=None,
    *,
    form=None,
    headers=None,
    session_cookie=None,
    base=BASE,
    raw=False,
):
    """HTTP request; ``session_cookie=False`` means deliberately unauthenticated."""
    global cookie
    url = path if path.startswith("http") else base + path
    data = None
    request_headers = {"accept": "application/json", **(headers or {})}
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        request_headers["content-type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        request_headers["content-type"] = "application/json"
    jar = cookie if session_cookie is None else ("" if session_cookie is False else session_cookie)
    if jar and base == BASE:
        request_headers["cookie"] = jar
    req = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            text = res.read().decode()
            set_cookie = res.headers.get("set-cookie")
            if set_cookie and session_cookie is None and base == BASE:
                cookie = set_cookie.split(";")[0]
            if raw:
                payload = text
            else:
                try:
                    payload = json.loads(text or "{}")
                except json.JSONDecodeError:
                    payload = {"raw": text}
            return res.status, payload, dict(res.headers), (set_cookie or "").split(";")[0]
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        if raw:
            payload = text
        else:
            try:
                payload = json.loads(text or "{}")
            except json.JSONDecodeError:
                payload = {"raw": text}
        return err.code, payload, dict(err.headers), ""


def stub_control(**fail_next):
    return call("POST", "/__control", {"failNext": fail_next}, base=STUB)[:2]


def stub_state():
    return call("GET", "/__state", base=STUB)[1]


def clean_old_stub_state():
    """Detach only known stub-linked workspace state; never touch another carrier."""
    status, carriers, _, _ = call("GET", "/api/v1/carriers")
    for carrier in carriers.get("data") or []:
        if carrier.get("accountSid") != masked_sid(SID):
            continue
        cid = str(carrier.get("id") or "")
        _, detail, _, _ = call("GET", f"/api/v1/carriers/{cid}")
        for number in detail.get("numbers") or []:
            # The seeded stub number is adopted and must stay owned; any minted
            # number was purchased by an interrupted probe and can be released.
            at_carrier = number.get("number") != "+14155550999"
            call("POST", f"/api/v1/phone-numbers/{number['id']}/release", {"atCarrier": at_carrier})
        call("DELETE", f"/api/v1/carriers/{cid}")


def verify_other_account() -> bool:
    """Create/reuse and verify a second workspace through the actual email flow."""
    global other_cookie
    status, payload, _, set_cookie = call(
        "POST",
        "/api/auth/signup",
        {
            "email": OTHER_EMAIL,
            "password": OTHER_PASSWORD,
            "name": "Carrier Tenant Probe",
            "orgName": "Carrier Tenant Probe",
            "businessType": "other",
            "otherDescription": "Carrier ownership isolation test",
        },
        session_cookie=False,
    )
    if status == 201:
        other_cookie = set_cookie
    else:
        status, payload, _, set_cookie = call(
            "POST",
            "/api/auth/login",
            {"email": OTHER_EMAIL, "password": OTHER_PASSWORD},
            session_cookie=False,
        )
        if status != 200:
            check("the second tenant can sign in", False, f"{status} {message(payload)}")
            return False
        other_cookie = set_cookie

    status, me, _, _ = call("GET", "/api/auth/me", session_cookie=other_cookie)
    if status == 200 and (me.get("user") or {}).get("emailVerified") is True:
        return True

    status, sent, _, _ = call("POST", "/api/auth/verify", {}, session_cookie=other_cookie)
    if status != 200:
        check("the second tenant can request verification", False, f"{status} {message(sent)}")
        return False
    relay = stub_state().get("sentEmails") or []
    email = next((row for row in relay if str(row.get("to", "")).lower() == OTHER_EMAIL.lower()), None)
    match = re.search(r"\b(\d{6})\b", str((email or {}).get("text") or ""))
    if not match:
        check("the verification code reaches the configured relay", False, json.dumps(email)[:180])
        return False
    status, confirmed, _, _ = call(
        "POST", "/api/auth/verify/confirm", {"code": match.group(1)}, session_cookie=other_cookie
    )
    return check("the second tenant verifies through the real code flow", status == 200 and confirmed.get("verified") is True, f"{status} {message(confirmed)}")


def cleanup():
    """Provider-first cleanup, even after a failed assertion."""
    global carrier_id, other_carrier_id
    if other_carrier_id and other_cookie:
        status, detail, _, _ = call("GET", f"/api/v1/carriers/{other_carrier_id}", session_cookie=other_cookie)
        for number in detail.get("numbers") or [] if status == 200 else []:
            call(
                "POST",
                f"/api/v1/phone-numbers/{number['id']}/release",
                {"atCarrier": number.get("number") != "+14155550999"},
                session_cookie=other_cookie,
            )
        call("DELETE", f"/api/v1/carriers/{other_carrier_id}", session_cookie=other_cookie)
    if carrier_id:
        status, detail, _, _ = call("GET", f"/api/v1/carriers/{carrier_id}")
        for number in detail.get("numbers") or [] if status == 200 else []:
            call(
                "POST",
                f"/api/v1/phone-numbers/{number['id']}/release",
                {"atCarrier": number.get("number") != "+14155550999"},
            )
        call("DELETE", f"/api/v1/carriers/{carrier_id}")


def main():
    global cookie, carrier_id, other_carrier_id
    cookie = cached_cookie(BASE, EMAIL, PASSWORD)
    if not check("login", bool(cookie), "session cookie" if cookie else "no session"):
        return 1

    status, assistants, _, _ = call("GET", "/api/v1/assistants?limit=50")
    rows = assistants.get("data") or []
    assistant = next((row for row in rows if row.get("status") == "published"), rows[0] if rows else None)
    if not check("a published assistant is available", bool(assistant), "none"):
        return 1

    clean_old_stub_state()
    status, reset, _, _ = call("POST", "/__reset", {}, base=STUB)
    check("carrier stub reset", status == 200 and reset.get("owned") == 1, f"{status} {reset}")

    # Credential and adapter rejection.
    status, rejected, _, _ = call("POST", "/api/v1/carriers", {"provider": "twilio", "accountSid": SID, "authToken": "wrong-token"})
    check("the carrier rejects wrong credentials and they are not retained", status == 400, f"{status} {message(rejected)}")
    status, rejected, _, _ = call("POST", "/api/v1/carriers", {"provider": "telnyx", "accountSid": SID, "authToken": TOKEN})
    check("unsupported carrier names are refused", status == 400 and "only" in message(rejected).lower(), f"{status} {message(rejected)}")
    status, rejected, _, _ = call("POST", "/api/v1/carriers", {"provider": "twilio", "accountSid": "ACshort", "authToken": TOKEN})
    check("a malformed Twilio SID is refused", status == 400, f"{status} {message(rejected)}")

    status, connected, _, _ = call(
        "POST",
        "/api/v1/carriers",
        {"provider": "twilio", "accountSid": SID, "authToken": TOKEN, "label": "carrier runtime probe"},
    )
    carrier_id = str(connected.get("id") or "")
    check("the Twilio account connects and verifies immediately", status == 201 and connected.get("verified") is True and bool(carrier_id), f"{status} {message(connected)}")
    check("carrier secrets are masked and never returned", TOKEN not in json.dumps(connected) and connected.get("accountSid") == masked_sid(SID), str(connected.get("accountSid")))
    check("the verified carrier balance is provider evidence", "412.38" in str(connected.get("balance")), str(connected.get("balance")))

    # Older builds allowed credential deletion before detaching a number. A new
    # connection proves ownership and relinks that orphan so it can be reconciled
    # through the provider-first route instead of being force-deleted locally.
    if connected.get("relinkedNumbers"):
        status, recovered, _, _ = call("GET", f"/api/v1/carriers/{carrier_id}")
        recovered_numbers = recovered.get("numbers") or []
        check("verified reconnect recovers orphaned carrier links", status == 200 and len(recovered_numbers) == connected.get("relinkedNumbers"), json.dumps(recovered_numbers))
        for row in recovered_numbers:
            call("POST", f"/api/v1/phone-numbers/{row['id']}/release", {"atCarrier": False})
        # Restore the deterministic provider fixture after reconciling the stale
        # local row; this does not change the still-valid connected credentials.
        call("POST", "/__reset", {}, base=STUB)

    status, verified, _, _ = call("POST", f"/api/v1/carriers/{carrier_id}/verify", {})
    check("re-verification returns live carrier facts", status == 200 and verified.get("verified") is True, f"{status} {message(verified)}")

    status, available_payload, _, _ = call("GET", f"/api/v1/carriers/{carrier_id}/numbers?mode=available&areaCode=415&limit=10")
    available = available_payload.get("data") or []
    check("available inventory comes from the carrier", status == 200 and len(available) >= 3 and all(str(row.get("number", "")).startswith("+1415") for row in available), f"{len(available)} row(s)")
    status, owned_payload, _, _ = call("GET", f"/api/v1/carriers/{carrier_id}/numbers?mode=owned")
    owned = owned_payload.get("data") or []
    check("the owned inventory exposes the seeded line as unadopted", status == 200 and any(row.get("number") == "+14155550999" and row.get("adopted") is False for row in owned), json.dumps(owned)[:180])

    # A provider rejection must release the pending reservation, proven by a
    # successful retry of the exact same E.164 number.
    buy_number = str(available[0]["number"])
    stub_control(purchase=1)
    status, failed_purchase, _, _ = call(
        "POST", f"/api/v1/carriers/{carrier_id}/purchase",
        {"number": buy_number, "label": "injected failure", "assistantId": assistant["id"]},
    )
    check("provider purchase rejection is surfaced", status == 400 and "carrier refused" in message(failed_purchase).lower(), f"{status} {message(failed_purchase)}")
    status, purchased_payload, _, _ = call(
        "POST", f"/api/v1/carriers/{carrier_id}/purchase",
        {"number": buy_number, "label": "support line", "assistantId": assistant["id"]},
    )
    purchased = purchased_payload.get("number") or {}
    if purchased.get("id"):
        created_number_ids.append((purchased["id"], True))
    check("the same number succeeds after rejection, so no stale claim remains", status == 201 and purchased.get("carrierId") == carrier_id and bool(purchased.get("carrierSid")), f"{status} {message(purchased_payload)}")
    wiring = purchased_payload.get("wiring") or {}
    check("purchased callbacks use the trusted public origin", wiring.get("voiceUrl") == f"{PUBLIC_ORIGIN}/api/telephony/twilio/voice" and wiring.get("statusCallback") == f"{PUBLIC_ORIGIN}/api/telephony/twilio/status", json.dumps(wiring))

    # Ownership pair mismatch and provider-side configure failure both leave no
    # local row; configure failure is retryable because its reservation is freed.
    status, mismatch, _, _ = call(
        "POST", f"/api/v1/carriers/{carrier_id}/numbers",
        {"number": "+14155550999", "sid": purchased.get("carrierSid")},
    )
    check("an owned SID/number mismatch is refused", status == 400 and "matching" in message(mismatch).lower(), f"{status} {message(mismatch)}")
    stub_control(configure=1)
    status, refused_adopt, _, _ = call(
        "POST", f"/api/v1/carriers/{carrier_id}/numbers",
        {"number": "+14155550999", "sid": "PNstub000900", "label": "configure failure", "assistantId": assistant["id"]},
    )
    check("provider webhook rejection leaves adoption uncommitted", status == 400 and "re-point" in message(refused_adopt).lower(), f"{status} {message(refused_adopt)}")
    status, local_after_failure, _, _ = call("GET", "/api/v1/phone-numbers")
    check("failed adoption created no local claim", not any(row.get("number") == "+14155550999" and row.get("carrierId") == carrier_id for row in local_after_failure.get("data") or []))

    status, adopted_payload, _, _ = call(
        "POST", f"/api/v1/carriers/{carrier_id}/numbers",
        {"number": "+14155550999", "sid": "PNstub000900", "label": "adopted line", "assistantId": assistant["id"]},
    )
    adopted = adopted_payload.get("number") or {}
    if adopted.get("id"):
        created_number_ids.append((adopted["id"], False))
    check("the owned line adopts after the failed attempt", status == 201 and adopted.get("carrierId") == carrier_id, f"{status} {message(adopted_payload)}")
    status, duplicate, _, _ = call(
        "POST", f"/api/v1/carriers/{carrier_id}/numbers",
        {"number": "+14155550999", "sid": "PNstub000900"},
    )
    check("a duplicate claim is refused before rewiring", status == 409, f"{status} {message(duplicate)}")

    # Carrier-backed rows cannot be removed locally and the account cannot be
    # disconnected while either row still needs its credentials.
    status, unsafe_delete, _, _ = call("DELETE", f"/api/v1/numbers/{adopted.get('id')}")
    check("direct local deletion of a carrier number is refused", status == 400 and "release" in message(unsafe_delete).lower(), f"{status} {message(unsafe_delete)}")
    status, blocked_disconnect, _, _ = call("DELETE", f"/api/v1/carriers/{carrier_id}")
    check("disconnect is blocked while numbers remain linked", status == 409 and "detach" in message(blocked_disconnect).lower(), f"{status} {message(blocked_disconnect)}")

    # Cross-tenant global ownership. The second workspace uses the same verified
    # stub account but must not claim a number already routed to this workspace.
    if verify_other_account():
        # Clear a prior probe's harmless carrier row first.
        status, other_carriers, _, _ = call("GET", "/api/v1/carriers", session_cookie=other_cookie)
        for row in other_carriers.get("data") or []:
            if row.get("accountSid") == masked_sid(SID):
                call("DELETE", f"/api/v1/carriers/{row['id']}", session_cookie=other_cookie)
        status, other_connected, _, _ = call(
            "POST", "/api/v1/carriers",
            {"provider": "twilio", "accountSid": SID, "authToken": TOKEN, "label": "second tenant"},
            session_cookie=other_cookie,
        )
        other_carrier_id = str(other_connected.get("id") or "")
        check("a second tenant can connect its own credential record", status == 201 and bool(other_carrier_id), f"{status} {message(other_connected)}")
        status, cross_claim, _, _ = call(
            "POST", f"/api/v1/carriers/{other_carrier_id}/numbers",
            {"number": "+14155550999", "sid": "PNstub000900"},
            session_cookie=other_cookie,
        )
        check("a second tenant cannot claim the first tenant's active E.164 line", status == 409, f"{status} {message(cross_claim)}")

    # Outbound call uses the selected carrier-backed sender.
    status, dialled, _, _ = call(
        "POST", "/api/telephony/outbound",
        {"to": "+14155559876", "assistantId": assistant["id"], "numberId": purchased.get("id")},
    )
    check("an outbound call reaches the carrier", status in (200, 201) and dialled.get("dialled") is True, f"{status} {message(dialled)}")
    check("the carrier returns a call SID", str((dialled.get("carrier") or {}).get("sid") or "").startswith("CA"), json.dumps(dialled)[:160])

    # Signed callback suite. Attacker-controlled forwarding headers do not change
    # the URL Twilio signatures are checked against.
    voice_path = "/api/telephony/twilio/voice"
    inbound_sid = f"CAcarriercheck{int(time.time())}"
    voice_form = {"CallSid": inbound_sid, "From": "+14155559877", "To": "+14155550999", "CallStatus": "ringing"}
    status, _, _, _ = call("POST", voice_path, form=voice_form, headers={"X-Twilio-Signature": "invalid-signature"}, session_cookie=False)
    check("a forged inbound voice callback is rejected", status == 403, str(status))
    evil_headers = direct_headers("https://attacker.invalid", voice_path, voice_form, TOKEN)
    evil_headers.update({"X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "https"})
    status, _, _, _ = call("POST", voice_path, form=voice_form, headers=evil_headers, session_cookie=False)
    check("forwarded host headers cannot redefine the signed callback URL", status == 403, str(status))
    good_headers = twilio_headers(PUBLIC_ORIGIN, voice_path, voice_form, TOKEN)
    good_headers.update({"X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "https"})
    status, voice_xml, _, _ = call("POST", voice_path, form=voice_form, headers=good_headers, session_cookie=False, raw=True)
    check("the same callback signed for the trusted origin is accepted", status == 200 and "<Response>" in voice_xml, f"{status} {voice_xml[:100]}")

    gather_path = "/api/telephony/twilio/gather"
    gather_form = {**voice_form, "SpeechResult": "Hello, I need help", "Confidence": "0.98"}
    status, _, _, _ = call("POST", gather_path, form=gather_form, headers={"X-Twilio-Signature": "invalid-signature"}, session_cookie=False)
    check("a forged gather turn is rejected", status == 403, str(status))
    status, gather_xml, _, _ = call(
        "POST", gather_path, form=gather_form,
        headers=twilio_headers(PUBLIC_ORIGIN, gather_path, gather_form, TOKEN),
        session_cookie=False, raw=True,
    )
    check("a signed gather turn runs the shared agent", status == 200 and "<Response>" in gather_xml, f"{status} {gather_xml[:100]}")

    stream_path = "/api/telephony/twilio/stream"
    status, _, _, _ = call("POST", stream_path, form=voice_form, headers={"X-Twilio-Signature": "invalid-signature"}, session_cookie=False)
    check("a forged media-stream callback is rejected", status == 403, str(status))
    status, stream_xml, _, _ = call(
        "POST", stream_path, form=voice_form,
        headers=twilio_headers(PUBLIC_ORIGIN, stream_path, voice_form, TOKEN),
        session_cookie=False, raw=True,
    )
    check("a signed media-stream callback returns carrier XML", status == 200 and "<Response>" in stream_xml, f"{status} {stream_xml[:100]}")

    status_path = "/api/telephony/twilio/status"
    status_form = {**voice_form, "CallStatus": "completed", "CallDuration": "42"}
    status, _, _, _ = call("POST", status_path, form=status_form, headers={"X-Twilio-Signature": "invalid-signature"}, session_cookie=False)
    check("a forged terminal status is rejected", status == 403, str(status))
    status, terminal, _, _ = call(
        "POST", status_path, form=status_form,
        headers=twilio_headers(PUBLIC_ORIGIN, status_path, status_form, TOKEN),
        session_cookie=False,
    )
    check("a signed terminal status closes the mapped call", status == 200 and terminal.get("status") == "ended", f"{status} {terminal}")

    # Provider refusal during detach/release must preserve the local claim. Then
    # successful retry restores/removes it, proving compensation is explicit.
    stub_control(configure=1)
    status, detach_failed, _, _ = call("POST", f"/api/v1/phone-numbers/{adopted.get('id')}/release", {"atCarrier": False})
    check("a provider detach failure is surfaced", status == 400 and "detach" in message(detach_failed).lower(), f"{status} {message(detach_failed)}")
    status, numbers_after_detach_failure, _, _ = call("GET", "/api/v1/phone-numbers")
    check("failed detach keeps the local claim", any(row.get("id") == adopted.get("id") for row in numbers_after_detach_failure.get("data") or []))
    status, detached, _, _ = call("POST", f"/api/v1/phone-numbers/{adopted.get('id')}/release", {"atCarrier": False})
    check("detach retry restores previous routing and removes only the workspace claim", status == 200 and detached.get("releasedAtCarrier") is False and (detached.get("carrier") or {}).get("restoredPrevious") is True, f"{status} {detached}")

    stub_control(release=1)
    status, release_failed, _, _ = call("POST", f"/api/v1/phone-numbers/{purchased.get('id')}/release", {"atCarrier": True})
    check("a provider release failure is surfaced", status == 400 and "would not release" in message(release_failed).lower(), f"{status} {message(release_failed)}")
    status, numbers_after_release_failure, _, _ = call("GET", "/api/v1/phone-numbers")
    check("failed release keeps the local billing claim", any(row.get("id") == purchased.get("id") for row in numbers_after_release_failure.get("data") or []))
    status, released, _, _ = call("POST", f"/api/v1/phone-numbers/{purchased.get('id')}/release", {"atCarrier": True})
    check("release retry succeeds provider-first", status == 200 and released.get("releasedAtCarrier") is True, f"{status} {released}")

    state = stub_state()
    seeded = next((row for row in state.get("owned") or [] if row.get("phone_number") == "+14155550999"), {})
    check("detaching the adopted line restored its pre-Voxera voice route", seeded.get("voice_url") == "https://old-ivr.example.com/answer" and not seeded.get("sms_url") and not seeded.get("status_callback"), json.dumps(seeded))
    check("the released purchase is gone at the carrier", not any(row.get("phone_number") == buy_number for row in state.get("owned") or []), json.dumps(state.get("owned")))

    status, disconnected, _, _ = call("DELETE", f"/api/v1/carriers/{carrier_id}")
    check("the carrier disconnects only after every linked number is reconciled", status == 200 and disconnected.get("numbersKept") == 0, f"{status} {message(disconnected)}")
    carrier_id = ""
    if other_carrier_id:
        status, other_disconnected, _, _ = call("DELETE", f"/api/v1/carriers/{other_carrier_id}", session_cookie=other_cookie)
        check("the second tenant's unused credential row disconnects cleanly", status == 200, f"{status} {message(other_disconnected)}")
        other_carrier_id = ""

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: " + "; ".join(failures))
        return 1
    print("ALL CARRIER CHECKS PASS")
    return 0


if __name__ == "__main__":
    try:
        result = main()
    except Exception as error:  # cleanup must run even on a malformed response
        failures.append(f"carrier gate crashed: {type(error).__name__}: {error}")
        print(f"FAIL  carrier gate crashed — {type(error).__name__}: {error}")
        result = 1
    finally:
        cleanup()
    sys.exit(1 if failures else result)
