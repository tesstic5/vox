#!/usr/bin/env python3
"""Boundary checks for provider, service and location configuration writes."""

import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
COOKIE = cached_cookie(BASE, EMAIL, PASSWORD)
STAMP = str(int(time.time() * 1000))
passes = 0
failures = []
created = {"providers": [], "services": [], "locations": []}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"content-type": "application/json", "cookie": COOKIE},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return error.code, {"raw": raw}


def error_message(payload):
    error = payload.get("error") if isinstance(payload, dict) else None
    return error.get("message", "") if isinstance(error, dict) else str(error or "")


def check(label, condition, detail=""):
    global passes
    print(("PASS  " if condition else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if condition:
        passes += 1
    else:
        failures.append(label)


def rejected(label, method, path, body, param=None, status=400):
    code, payload = call(method, path, body)
    error = payload.get("error") or {}
    ok = code == status and (param is None or error.get("param") == param)
    check(label, ok, f"{code} {error_message(payload)}")


def main():
    service_rows = call("GET", "/api/v1/services")[1].get("data") or []
    location_rows = call("GET", "/api/v1/locations")[1].get("data") or []
    service_id = service_rows[0]["id"]
    location_id = location_rows[0]["id"]

    rejected("a provider body must be an object", "POST", "/api/v1/providers", [], "body")
    rejected("provider create requires a name", "POST", "/api/v1/providers", {"active": True}, "name")
    rejected("provider create rejects server-owned fields", "POST", "/api/v1/providers", {"name": "Validation Probe", "orgId": "other"}, "orgId")
    rejected("provider active is really boolean", "POST", "/api/v1/providers", {"name": "Validation Probe", "active": "false"}, "active")
    rejected("provider assignments are arrays", "POST", "/api/v1/providers", {"name": "Validation Probe", "serviceIds": service_id}, "serviceIds")
    rejected("provider assignments cannot repeat", "POST", "/api/v1/providers", {"name": "Validation Probe", "serviceIds": [service_id, service_id]}, "serviceIds")
    rejected("provider assignments stay inside active workspace services", "POST", "/api/v1/providers", {"name": "Validation Probe", "serviceIds": ["svc_not_here"]}, "serviceIds")
    rejected("provider email is validated", "POST", "/api/v1/providers", {"name": "Validation Probe", "email": "not-an-email"}, "email")
    rejected("provider colour is bounded", "POST", "/api/v1/providers", {"name": "Validation Probe", "colour": "url(javascript:bad)"}, "colour")

    code, provider = call("POST", "/api/v1/providers", {
        "name": f"  Validation Probe Provider {STAMP}  ",
        "email": "  VALIDATION.PROBE@EXAMPLE.TEST ",
        "serviceIds": [service_id],
        "locationIds": [location_id],
        "active": True,
    })
    if provider.get("id"):
        created["providers"].append(provider["id"])
    check("a valid provider is normalized and stored", code == 201 and provider.get("name", "").startswith("Validation Probe") and provider.get("email") == "validation.probe@example.test", f"{code} {provider.get('email')}")
    if provider.get("id"):
        rejected("provider update rejects linked login mutation", "PATCH", f"/api/v1/providers/{provider['id']}", {"userId": "usr_other"}, "userId")
        rejected("provider update rejects empty names", "PATCH", f"/api/v1/providers/{provider['id']}", {"name": "   "}, "name")

    rejected("service create requires a name", "POST", "/api/v1/services", {"durationMinutes": 30}, "name")
    rejected("a service rejects unknown fields", "POST", "/api/v1/services", {"name": "Validation Probe", "mystery": True}, "mystery")
    rejected("service duration does not coerce strings", "POST", "/api/v1/services", {"name": "Validation Probe", "durationMinutes": "30"}, "durationMinutes")
    rejected("service duration has a practical ceiling", "POST", "/api/v1/services", {"name": "Validation Probe", "durationMinutes": 1441}, "durationMinutes")
    rejected("service buffers cannot be negative", "POST", "/api/v1/services", {"name": "Validation Probe", "bufferBeforeMinutes": -1}, "bufferBeforeMinutes")
    rejected("service prices cannot be negative", "POST", "/api/v1/services", {"name": "Validation Probe", "price": -0.01}, "price")
    rejected("service tax stays a percentage", "POST", "/api/v1/services", {"name": "Validation Probe", "taxRatePct": 101}, "taxRatePct")
    rejected("service capacity must be a whole number", "POST", "/api/v1/services", {"name": "Validation Probe", "capacity": 1.5}, "capacity")
    rejected("service recalls are bounded", "POST", "/api/v1/services", {"name": "Validation Probe", "recallDays": 3651}, "recallDays")

    code, service = call("POST", "/api/v1/services", {
        "name": f"Validation Probe Service {STAMP}",
        "durationMinutes": 45,
        "bufferBeforeMinutes": 5,
        "bufferAfterMinutes": 10,
        "slotStepMinutes": 15,
        "capacity": 7,
        "price": 123.45,
        "taxRatePct": 20,
        "recallDays": 90,
        "colour": "#7c3aed",
    })
    if service.get("id"):
        created["services"].append(service["id"])
    check("a valid service keeps every constrained number, including capacity", code == 201 and service.get("capacity") == 7 and service.get("price") == 123.45, f"{code} capacity={service.get('capacity')}")
    if service.get("id"):
        rejected("service update rejects server-owned identity", "PATCH", f"/api/v1/services/{service['id']}", {"id": "changed"}, "id")
        existing_name = service_rows[0]["name"]
        rejected("service update cannot duplicate another name", "PATCH", f"/api/v1/services/{service['id']}", {"name": existing_name}, "name", 409)
        code, patched = call("PATCH", f"/api/v1/services/{service['id']}", {"capacity": 8, "recallDays": 0})
        check("service update persists capacity and can return recall to the practice default", code == 200 and patched.get("capacity") == 8 and not patched.get("recallDays"), f"{code} {patched.get('capacity')} / {patched.get('recallDays')}")
        call("PATCH", f"/api/v1/services/{service['id']}", {"active": False})
        rejected("a retired service cannot be newly assigned", "POST", "/api/v1/providers", {"name": "Validation Probe Retired Ref", "serviceIds": [service["id"]]}, "serviceIds")

    rejected("location create requires a name", "POST", "/api/v1/locations", {"timezone": "UTC"}, "name")
    rejected("location create cannot write the room mirror", "POST", "/api/v1/locations", {"name": "Validation Probe Site", "rooms": [{"name": "Back door"}]}, "rooms")
    rejected("location active is really boolean", "POST", "/api/v1/locations", {"name": "Validation Probe Site", "active": 1}, "active")
    rejected("location names are bounded", "POST", "/api/v1/locations", {"name": "x" * 121}, "name")
    rejected("location timezone is an IANA zone", "POST", "/api/v1/locations", {"name": "Validation Probe Site", "timezone": "Mars/Olympus"}, "timezone")

    code, location = call("POST", "/api/v1/locations", {
        "name": f"  Validation Probe Site {STAMP}  ",
        "address": "  1 Test Way  ",
        "timezone": "Asia/Karachi",
    })
    if location.get("id"):
        created["locations"].append(location["id"])
    check("a valid location is normalized and keeps its authoritative timezone", code == 201 and location.get("name", "").startswith("Validation Probe") and location.get("address") == "1 Test Way" and location.get("timezone") == "Asia/Karachi", f"{code} {location.get('timezone')}")
    if location.get("id"):
        rejected("location update rejects the room mirror too", "PATCH", f"/api/v1/locations/{location['id']}", {"rooms": []}, "rooms")
        rejected("location update cannot duplicate another name", "PATCH", f"/api/v1/locations/{location['id']}", {"name": location_rows[0]["name"]}, "name", 409)

    return finish()


def finish():
    for provider_id in reversed(created["providers"]):
        call("DELETE", f"/api/v1/providers/{provider_id}")
    for service_id in reversed(created["services"]):
        call("DELETE", f"/api/v1/services/{service_id}")
    for location_id in reversed(created["locations"]):
        call("DELETE", f"/api/v1/locations/{location_id}")
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        return 1
    print(f"ALL PASS — {passes} setup-boundary checks reject coercion, foreign references and server-field mutation.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        failures.append(f"gate crashed: {error}")
        print(f"FAIL  gate crashed — {type(error).__name__}: {error}")
        sys.exit(finish())
