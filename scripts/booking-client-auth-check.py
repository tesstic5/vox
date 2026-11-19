#!/usr/bin/env python3
"""Focused booking/client authorization and non-destructive-write regression gate."""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import session as cached_session  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
OWNER_EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
OWNER_PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
PRACTITIONER_EMAIL = "probe-booking-auth@northwind.test"
STAMP = int(time.time() * 1000)

owner_cookie = ""
failures: list[str] = []
key_ids: list[str] = []
keys: dict[str, str] = {}
practitioner_id = ""
practitioner_cookie = ""
client_id = ""
booking_id = ""


def check(label, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def message(payload):
    if not isinstance(payload, dict):
        return str(payload)
    error = payload.get("error") or {}
    return str(error.get("message") or payload.get("message") or "")


def call(method, path, body=None, *, cookie=None, key=None, ip="203.0.113.84"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    if key:
        req.add_header("authorization", f"Bearer {key}")
    req.add_header("x-forwarded-for", ip)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            text = response.read().decode()
            try:
                payload = json.loads(text) if text else {}
            except json.JSONDecodeError:
                payload = {"raw": text}
            return response.status, payload, (response.headers.get("set-cookie") or "").split(";")[0]
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            payload = json.loads(text) if text else {}
        except json.JSONDecodeError:
            payload = {"raw": text}
        return error.code, payload, ""


def owner(method, path, body=None):
    return call(method, path, body, cookie=owner_cookie)


def with_key(name, method, path, body=None):
    return call(method, path, body, key=keys.get(name, ""))


def make_key(name, scopes):
    status, payload, _ = owner("POST", "/api/v1/keys", {"name": f"auth probe {name} {STAMP}", "scopes": scopes})
    secret = str(payload.get("secret") or "")
    key_id = str(payload.get("id") or "")
    if key_id:
        key_ids.append(key_id)
    if secret:
        keys[name] = secret
    check(f"a {name.replace('_', ' ')} key can be minted", status == 201 and bool(secret) and bool(key_id), f"{status} {message(payload)}")


def setup_practitioner():
    global practitioner_id, practitioner_cookie
    status, payload, _ = owner(
        "POST",
        "/api/v1/team",
        {"action": "invite", "email": PRACTITIONER_EMAIL, "name": "Booking Auth Probe", "role": "practitioner"},
    )
    if status == 201:
        practitioner_id = str((payload.get("member") or {}).get("id") or "")
    else:
        _, members, _ = owner("GET", "/api/v1/team?view=members")
        member = next((row for row in (members.get("members") or []) if row.get("email") == PRACTITIONER_EMAIL), {})
        practitioner_id = str(member.get("id") or "")
    check("a practitioner test login exists", bool(practitioner_id), f"invite={status}")
    if not practitioner_id:
        return
    owner("POST", "/api/v1/team", {"action": "role", "id": practitioner_id, "role": "practitioner"})
    owner("POST", "/api/v1/team", {"action": "reactivate", "id": practitioner_id})
    status, reset, _ = owner("POST", "/api/v1/team", {"action": "password", "id": practitioner_id})
    temporary = str(reset.get("temporaryPassword") or "")
    check("the practitioner gets a one-time test password", status == 200 and bool(temporary), f"{status}")
    if not temporary:
        return
    status, payload, cookie = call(
        "POST",
        "/api/auth/login",
        {"email": PRACTITIONER_EMAIL, "password": temporary},
        ip="203.0.113.85",
    )
    practitioner_cookie = cookie
    check("the practitioner signs in as themselves", status == 200 and bool(cookie), f"{status} {message(payload)}")


def main():
    global owner_cookie, client_id, booking_id
    owner_cookie = cached_session(BASE, OWNER_EMAIL, OWNER_PASSWORD)
    check("the owner session is available", bool(owner_cookie))
    if not owner_cookie:
        return finish()

    setup_practitioner()
    make_key("clients_read", ["clients:read"])
    make_key("clients_write", ["clients:write"])
    make_key("bookings_read", ["bookings:read"])
    make_key("bookings_write", ["bookings:write"])
    make_key("wrong_scope", ["calls:read"])
    if len(keys) < 5:
        return finish()

    # Narrow read/write scopes do not silently imply one another or cross domains.
    status, _, _ = with_key("clients_read", "GET", "/api/v1/clients?limit=1")
    check("clients:read can list clients", status == 200, str(status))
    status, payload, _ = with_key("clients_read", "POST", "/api/v1/clients", {"name": "Should Not Exist", "number": "+14155550001"})
    check("clients:read cannot write clients", status == 403, f"{status} {message(payload)}")
    status, _, _ = with_key("clients_read", "GET", "/api/v1/bookings?limit=1")
    check("clients:read cannot read bookings", status == 403, str(status))
    status, _, _ = with_key("bookings_read", "GET", "/api/v1/bookings?limit=1")
    check("bookings:read can list bookings", status == 200, str(status))
    status, _, _ = with_key("bookings_read", "GET", "/api/v1/clients?limit=1")
    check("bookings:read cannot read clients", status == 403, str(status))
    status, _, _ = with_key("wrong_scope", "GET", "/api/v1/clients?limit=1")
    check("an unrelated scope is denied client data", status == 403, str(status))
    status, _, _ = with_key("wrong_scope", "GET", "/api/v1/bookings?limit=1")
    check("an unrelated scope is denied booking data", status == 403, str(status))

    number = f"+14156{STAMP % 1000000:06d}"
    status, created, _ = with_key(
        "clients_write",
        "POST",
        "/api/v1/clients",
        {"name": f"Auth Probe Client {STAMP}", "number": number, "email": f"auth-probe-{STAMP}@example.test", "tags": ["auth-probe"]},
    )
    client_id = str(created.get("id") or "")
    check("clients:write can create a client", status == 201 and bool(client_id), f"{status} {message(created)}")
    status, _, _ = with_key("clients_write", "GET", "/api/v1/clients?limit=1")
    check("clients:write alone cannot read clients", status == 403, str(status))

    if client_id:
        status, detail, _ = with_key("clients_read", "GET", f"/api/v1/clients/{client_id}")
        check("clients:read can open its client record", status == 200 and detail.get("id") == client_id, f"{status}")
        check("a narrow client key cannot piggyback into clinical notes", detail.get("notesRestricted") is True and "notes" in detail, str(detail.get("notesRestricted")))
        check("a narrow client key cannot piggyback into money", detail.get("moneyRestricted") is True and "money" not in detail, str(detail.get("moneyRestricted")))

    future = (datetime.now(timezone.utc) + timedelta(days=12)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    external = f"AUTH-{STAMP}"
    booking_payload = {
        "externalId": external,
        "customer": {"name": f"Auth Probe Client {STAMP}", "number": number},
        "service": "Authorization probe",
        "startsAt": future,
        "durationMinutes": 30,
        "status": "confirmed",
        "metadata": {"probe": "booking-client-auth"},
    }
    status, made, _ = with_key("bookings_write", "POST", "/api/v1/bookings", booking_payload)
    booking_id = str(made.get("id") or "")
    check("bookings:write can create a booking", status == 201 and bool(booking_id), f"{status} {message(made)}")
    status, _, _ = with_key("bookings_write", "GET", f"/api/v1/bookings?externalId={urllib.parse.quote(external)}")
    check("bookings:write alone cannot read bookings", status == 403, str(status))

    if booking_id:
        status, detail, _ = with_key("bookings_read", "GET", f"/api/v1/bookings/{booking_id}")
        check("bookings:read can open the new booking", status == 200 and detail.get("id") == booking_id, f"{status}")
        status, refused, _ = with_key("bookings_read", "DELETE", f"/api/v1/bookings/{booking_id}")
        check("bookings:read cannot mutate a booking", status == 403, f"{status} {message(refused)}")
        status, refused, _ = with_key("bookings_write", "PATCH", f"/api/v1/bookings/{booking_id}", {"startsAt": future})
        check("generic PATCH cannot bypass the conflict-checked move action", status == 400 and "move" in message(refused).lower(), f"{status} {message(refused)}")
        status, refused, _ = with_key("bookings_write", "DELETE", f"/api/v1/bookings/{booking_id}")
        check("appointment DELETE is non-destructive and refused", status == 400 and "cancel" in message(refused).lower(), f"{status} {message(refused)}")
        status, still_there, _ = with_key("bookings_read", "GET", f"/api/v1/bookings/{booking_id}")
        check("the refused DELETE leaves the appointment intact", status == 200 and still_there.get("id") == booking_id, f"{status}")

    bad = dict(booking_payload)
    bad["externalId"] = f"AUTH-BAD-NUMBER-{STAMP}"
    bad["customer"] = {"name": "Bad Number", "number": "555"}
    status, payload, _ = with_key("bookings_write", "POST", "/api/v1/bookings", bad)
    check("booking creation rejects a non-E.164 number", status == 400, f"{status} {message(payload)}")
    bad_duration = dict(booking_payload)
    bad_duration["externalId"] = f"AUTH-BAD-DURATION-{STAMP}"
    bad_duration["durationMinutes"] = 0
    status, payload, _ = with_key("bookings_write", "POST", "/api/v1/bookings", bad_duration)
    check("booking creation rejects an unsafe duration", status == 400, f"{status} {message(payload)}")

    status, providers, _ = owner("GET", "/api/v1/providers")
    provider = next(iter(providers.get("data") or []), None) if status == 200 else None
    if provider:
        bypass = dict(booking_payload)
        bypass.update({"externalId": f"AUTH-BYPASS-{STAMP}", "providerId": provider["id"], "checkConflicts": False})
        status, payload, _ = with_key("bookings_write", "POST", "/api/v1/bookings", bypass)
        check("future provider work cannot disable conflict checks", status == 400 and "past" in message(payload).lower(), f"{status} {message(payload)}")
    else:
        check("future provider work cannot disable conflict checks", False, "no provider available for the proof")

    sync_external = f"AUTH-SYNC-{STAMP}"
    valid_sync = {
        "externalId": sync_external,
        "customer": {"name": "Atomic Sync", "number": f"+14157{STAMP % 1000000:06d}"},
        "service": "Sync probe",
        "startsAt": future,
        "durationMinutes": 25,
        "status": "confirmed",
    }
    invalid_sync = {**valid_sync, "externalId": f"{sync_external}-BAD", "customer": {"name": "Bad", "number": "123"}}
    status, payload, _ = with_key("bookings_write", "POST", "/api/v1/bookings/sync", {"mode": "full", "sourceId": "booking-client-auth-check", "bookings": [valid_sync, invalid_sync]})
    check("a malformed full snapshot is rejected atomically", status == 400 and "nothing was written" in message(payload).lower(), f"{status} {message(payload)}")
    status, listing, _ = with_key("bookings_read", "GET", f"/api/v1/bookings?externalId={urllib.parse.quote(sync_external)}")
    check("the valid row beside a malformed row was not written", status == 200 and listing.get("total") == 0, f"{status} total={listing.get('total')}")
    if booking_id:
        _, existing, _ = with_key("bookings_read", "GET", f"/api/v1/bookings/{booking_id}")
        check("the malformed full snapshot did not mark existing work removed", (existing.get("metadata") or {}).get("removedFromSource") != "true")

    since_external = f"AUTH-SINCE-{STAMP}"
    bad_since = {**valid_sync, "externalId": since_external}
    status, payload, _ = with_key("bookings_write", "POST", "/api/v1/bookings/sync?since=not-a-date", {"bookings": [bad_since]})
    check("an invalid sync cursor is rejected before writes", status == 400, f"{status} {message(payload)}")
    _, listing, _ = with_key("bookings_read", "GET", f"/api/v1/bookings?externalId={urllib.parse.quote(since_external)}")
    check("the invalid cursor produced no hidden write", listing.get("total") == 0, f"total={listing.get('total')}")

    duplicate = {**valid_sync, "externalId": f"AUTH-DUP-{STAMP}"}
    status, payload, _ = with_key("bookings_write", "POST", "/api/v1/bookings/sync", {"bookings": [duplicate, duplicate]})
    check("a sync rejects duplicate external ids", status == 400, f"{status} {message(payload)}")

    if practitioner_cookie:
        status, _, _ = call("GET", "/api/v1/clients?limit=1", cookie=practitioner_cookie, ip="203.0.113.86")
        check("a practitioner can read client records needed for care", status == 200, str(status))
        status, payload, _ = call(
            "POST",
            "/api/v1/clients",
            {"name": "Practitioner Must Not Create", "number": "+14155550002"},
            cookie=practitioner_cookie,
            ip="203.0.113.86",
        )
        check("a practitioner cannot create client records", status == 403, f"{status} {message(payload)}")
        status, _, _ = call("GET", "/api/v1/bookings?limit=1", cookie=practitioner_cookie, ip="203.0.113.86")
        check("a practitioner can read the diary", status == 200, str(status))
        status, payload, _ = call(
            "POST",
            "/api/v1/bookings",
            {**booking_payload, "externalId": f"AUTH-PRACTITIONER-{STAMP}"},
            cookie=practitioner_cookie,
            ip="203.0.113.86",
        )
        check("a practitioner cannot create or move diary records", status == 403, f"{status} {message(payload)}")
        status, payload, _ = call("GET", "/api/v1/audit?limit=1", cookie=practitioner_cookie, ip="203.0.113.86")
        check("a practitioner cannot read the workspace security audit", status == 403, f"{status} {message(payload)}")
    status, _, _ = owner("GET", "/api/v1/audit?limit=1")
    check("an owner can read the workspace security audit", status == 200, str(status))

    return finish()


def finish():
    # Preserve history: cancel the appointment and archive its client. Never use
    # appointment DELETE as test cleanup.
    if booking_id and keys.get("bookings_write"):
        with_key("bookings_write", "POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled", "note": "authorization probe cleanup"})
    if client_id and keys.get("clients_write"):
        with_key("clients_write", "DELETE", f"/api/v1/clients/{client_id}", {"reason": "authorization probe cleanup"})

    revoked_secret = ""
    revoked_id = ""
    if keys:
        revoked_secret = next(iter(keys.values()))
    if key_ids:
        revoked_id = key_ids[0]
    for key_id in key_ids:
        owner("DELETE", f"/api/v1/keys/{key_id}")
    if revoked_secret and revoked_id:
        status, _, _ = call("GET", "/api/v1/clients?limit=1", key=revoked_secret)
        check("a revoked key stops working immediately", status == 401, str(status))
    if practitioner_id:
        owner("POST", "/api/v1/team", {"action": "deactivate", "id": practitioner_id})

    print(f"\n{len(failures) and 'FAIL' or 'PASS'}  booking/client authorization — {len(failures)} failure(s)")
    if failures:
        print("Failed: " + ", ".join(failures))
        raise SystemExit(1)
    return 0


if __name__ == "__main__":
    main()
