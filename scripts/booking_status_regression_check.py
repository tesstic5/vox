#!/usr/bin/env python3
"""Focused runtime regression for booking-upsert lifecycle preservation.

Proves that omitting `status` on an existing external booking:
  * keeps the existing lifecycle state;
  * cannot turn `checkConflicts: false` into a future-work bypass;
  * still runs the collision engine using links already held by the booking; and
  * does not resurrect a cancelled row when it is updated later.

Usage: python3 scripts/booking_status_regression_check.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402

COOKIE = ""
PASSES = 0
FAILURES: list[str] = []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"accept": "application/json"}
    if data is not None:
        headers["content-type"] = "application/json"
    if COOKIE:
        headers["cookie"] = COOKIE
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return error.code, payload


def message(payload):
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str((payload or {}).get("message") or payload)


def check(label, condition, detail=""):
    global PASSES
    if condition:
        PASSES += 1
        print(f"PASS  {label}{f' — {detail}' if detail else ''}")
    else:
        FAILURES.append(label)
        print(f"FAIL  {label}{f' — {detail}' if detail else ''}")


def finish():
    print(f"\n{PASSES} PASS / {len(FAILURES)} FAIL")
    if FAILURES:
        for failure in FAILURES:
            print(f"  · {failure}")
    return 1 if FAILURES else 0


def main():
    global COOKIE
    try:
        COOKIE = cached_cookie(BASE, EMAIL, PASSWORD)
    except Exception as error:
        check("owner signs in", False, str(error))
        return finish()
    check("owner signs in", True)

    _, providers = call("GET", "/api/v1/providers")
    _, services = call("GET", "/api/v1/services")
    provider = next((row for row in providers.get("data", []) if row.get("active") is not False), None)
    service = next(
        (
            row
            for row in services.get("data", [])
            if row.get("active") is not False
            and (not provider or not provider.get("serviceIds") or row.get("id") in provider.get("serviceIds", []))
        ),
        None,
    )
    check("an active practitioner and service exist", bool(provider and service), f"{(provider or {}).get('name')} · {(service or {}).get('name')}")
    if not provider or not service:
        return finish()

    params = [
        f"providerId={provider['id']}",
        f"serviceId={service['id']}",
        "days=21",
        "limit=200",
    ]
    if provider.get("locationIds"):
        params.append(f"locationId={provider['locationIds'][0]}")
    _, availability = call("GET", "/api/v1/availability?" + "&".join(params))
    duration_ms = int(service.get("durationMinutes") or 30) * 60_000
    # Leave a wide gap: service setup may reserve buffers on either side even
    # though each returned start is independently valid in the original snapshot.
    separation_ms = max(
        4 * 60 * 60_000,
        (int(service.get("durationMinutes") or 30)
         + int(service.get("bufferBeforeMinutes") or 0)
         + int(service.get("bufferAfterMinutes") or 0)) * 60_000,
    )
    slots = availability.get("data") or []
    chosen = []
    for slot in slots:
        at = int(__import__("datetime").datetime.fromisoformat(slot["startsAt"].replace("Z", "+00:00")).timestamp() * 1000)
        if all(abs(at - prior) >= separation_ms for prior in [entry[0] for entry in chosen]):
            chosen.append((at, slot))
        if len(chosen) == 2:
            break
    check("two non-overlapping live slots exist", len(chosen) == 2, f"{len(slots)} offered")
    if len(chosen) < 2:
        return finish()

    stamp = f"{int(time.time() * 1000)}-{os.getpid()}"
    number = f"+141555{int(time.time()) % 10_000_000:07d}"
    customer = {"name": f"Probe Status Preserve {stamp}", "number": number}
    blocker_ref = f"STATUS-BLOCK-{stamp}"
    moving_ref = f"STATUS-MOVE-{stamp}"
    created_ids: list[str] = []

    def booking_body(reference, slot):
        body = {
            "externalId": reference,
            "customer": customer,
            "startsAt": slot["startsAt"],
            "providerId": provider["id"],
            "serviceId": service["id"],
        }
        for key in ("locationId", "roomId"):
            if slot.get(key):
                body[key] = slot[key]
        return body

    first_slot = chosen[0][1]
    second_slot = chosen[1][1]
    status, blocker = call("POST", "/api/v1/bookings", booking_body(blocker_ref, first_slot))
    if blocker.get("id"):
        created_ids.append(blocker["id"])
    check("a blocker occupies the first live slot", status == 201 and bool(blocker.get("id")), f"HTTP {status}")

    status, moving = call("POST", "/api/v1/bookings", booking_body(moving_ref, second_slot))
    if moving.get("id"):
        created_ids.append(moving["id"])
    check("the upsert target occupies the second live slot", status == 201 and moving.get("status") == "confirmed", f"HTTP {status} · {moving.get('status')}")
    if not blocker.get("id") or not moving.get("id"):
        for booking_id in created_ids:
            call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled"})
        return finish()

    # Deliberately omit status and every persisted diary link. The server has to
    # derive the effective confirmed state/provider from the existing row.
    omitted = {
        "externalId": moving_ref,
        "customer": customer,
        "startsAt": second_slot["startsAt"],
        "notes": "status omitted by regression probe",
        "checkConflicts": False,
    }
    status, bypass = call("POST", "/api/v1/bookings", omitted)
    check(
        "omitted confirmed status cannot authorize checkConflicts false",
        status == 400 and "only for past" in message(bypass),
        f"HTTP {status} · {message(bypass)}",
    )

    collision = {key: value for key, value in omitted.items() if key not in ("checkConflicts", "notes")}
    collision["startsAt"] = first_slot["startsAt"]
    status, refused = call("POST", "/api/v1/bookings", collision)
    check(
        "omitted status still runs conflicts through the persisted provider",
        status == 409 and "not free" in message(refused).lower(),
        f"HTTP {status} · {message(refused)}",
    )

    _, listed = call("GET", f"/api/v1/bookings?externalId={moving_ref}")
    unchanged = next(iter(listed.get("data") or []), {})
    check(
        "a refused upsert leaves status and start untouched",
        unchanged.get("status") == "confirmed" and unchanged.get("startsAt") == second_slot["startsAt"],
        f"{unchanged.get('status')} · {unchanged.get('startsAt')}",
    )

    status, cancelled = call("POST", f"/api/v1/bookings/{moving['id']}/status", {"status": "cancelled"})
    cancelled_row = cancelled.get("booking") or cancelled
    check("the target can enter the cancelled terminal state", status == 200 and cancelled_row.get("status") == "cancelled", f"HTTP {status} · {cancelled_row.get('status')}")

    # A cancelled record may overlap harmlessly, but omission must not resurrect
    # it as confirmed while doing so.
    status, updated = call("POST", "/api/v1/bookings", collision)
    check(
        "omitted status preserves cancelled on a later upsert",
        status == 200 and updated.get("status") == "cancelled" and updated.get("startsAt") == first_slot["startsAt"],
        f"HTTP {status} · {updated.get('status')} · {updated.get('startsAt')}",
    )

    call("POST", f"/api/v1/bookings/{blocker['id']}/status", {"status": "cancelled"})
    # Cancelled probe rows keep an honest lifecycle trail. The conservative tidy
    # task removes their `Probe Status Preserve …` client when nothing live remains.
    print("\ncleanup: both probe appointments are cancelled")
    return finish()


if __name__ == "__main__":
    raise SystemExit(main())
