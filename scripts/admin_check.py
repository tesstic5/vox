#!/usr/bin/env python3
"""
Operator console check — the platform layer above every workspace.

Proves, at the HTTP level:

  * the overview answers only for the operator (anonymous 401, a customer
    — even a workspace owner who is not on the operator list — 403 when
    VOXERA_OPERATOR_EMAILS is configured, as it is for this gate run)
  * the overview's workspace rows agree with what the workspaces contain
  * suspending a workspace refuses its API access (ORG_SUSPENDED) until
    the operator reactivates it, and the operator is never locked out
  * the operator cannot suspend their own workspace from the console

Run it with the app up (operator = demo owner via VOXERA_OPERATOR_EMAILS):

    python3 scripts/admin_check.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
STAMP = int(time.time())

failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def api(method, path, body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return res.status, json.loads(raw or b"{}"), (res.headers.get("set-cookie") or "").split(";")[0]
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw or b"{}"), (err.headers.get("set-cookie") or "").split(";")[0]
        except json.JSONDecodeError:
            return err.code, {"_raw": raw[:200].decode("utf-8", "replace")}, ""


def main():
    operator = cached_cookie(BASE, EMAIL, PASSWORD)

    status, _, _ = api("GET", "/api/v1/admin/overview")
    check("anonymous gets no platform view", status == 401, f"HTTP {status}")

    status, mine, _ = api("GET", "/api/auth/me", cookie=operator)
    check("the demo owner is flagged as operator", status == 200 and (mine.get("user") or {}).get("platformOperator") is True,
          f"platformOperator={(mine.get('user') or {}).get('platformOperator')}")

    status, overview, _ = api("GET", "/api/v1/admin/overview", cookie=operator)
    totals = overview.get("totals") or {}
    check("the overview answers for the operator", status == 200 and totals.get("orgs", 0) >= 1,
          f"orgs={totals.get('orgs')} users={totals.get('users')} calls={totals.get('calls')}")
    demo = next((o for o in overview.get("orgs", []) if o.get("slug") == "northwind-labs"), None)
    check("the demo workspace reads real usage", demo is not None and demo.get("calls", 0) > 0 and demo.get("members", 0) >= 1,
          f"calls={demo.get('calls') if demo else None} members={demo.get('members') if demo else None}")
    check("queue and store health are reported", "queues" in overview and (overview.get("store") or {}).get("docs", 0) > 0,
          f"docs={(overview.get('store') or {}).get('docs')}")

    # A stranger's workspace: its owner is not the operator.
    email = f"admin.check.{STAMP}@example.com"
    status, made, stranger = api("POST", "/api/auth/signup", {
        "email": email, "password": "correct-horse-battery", "name": "Admin Check", "orgName": f"Admin Check {STAMP}",
    })
    check("a stranger can sign up a workspace", status == 201 and bool(stranger), f"HTTP {status}")
    org_id = ((made.get("org") or {}).get("id")) if isinstance(made, dict) else None

    status, _, _ = api("GET", "/api/v1/admin/overview", cookie=stranger)
    check("a workspace owner who is not the operator is refused", status == 403, f"HTTP {status}")

    status, before, _ = api("GET", "/api/v1/calls?limit=1", cookie=stranger)
    check("the stranger's workspace works before suspension", status == 200, f"HTTP {status}")

    status, res, _ = api("POST", "/api/v1/admin/orgs", {"action": "suspend", "orgId": org_id}, cookie=operator)
    check("the operator can suspend it", status == 200 and res.get("suspended") is True, f"HTTP {status}")

    status, body, _ = api("GET", "/api/v1/calls?limit=1", cookie=stranger)
    code = ((body.get("error") or {}).get("code")) if isinstance(body, dict) else None
    check("a suspended workspace's API access is refused", status == 403 and code == "ORG_SUSPENDED", f"HTTP {status} code={code}")

    status, overview, _ = api("GET", "/api/v1/admin/overview", cookie=operator)
    row = next((o for o in overview.get("orgs", []) if o.get("id") == org_id), None)
    check("the operator is never locked out, and sees the suspension", status == 200 and row is not None and row.get("suspended") is True,
          f"HTTP {status}")

    status, _, _ = api("POST", "/api/v1/admin/orgs", {"action": "reactivate", "orgId": org_id}, cookie=operator)
    check("the operator can reactivate it", status == 200, f"HTTP {status}")
    status, _, _ = api("GET", "/api/v1/calls?limit=1", cookie=stranger)
    check("a reactivated workspace works again", status == 200, f"HTTP {status}")

    status, me, _ = api("GET", "/api/auth/me", cookie=operator)
    own_org = ((me.get("org") or {}).get("id"))
    status, _, _ = api("POST", "/api/v1/admin/orgs", {"action": "suspend", "orgId": own_org}, cookie=operator)
    check("the operator cannot suspend their own workspace", status == 400, f"HTTP {status}")

    status, _, _ = api("POST", "/api/v1/admin/orgs", {"action": "suspend", "orgId": "org_does_not_exist"}, cookie=operator)
    check("an unknown workspace is a 404", status == 404, f"HTTP {status}")

    print(f"\n{('ALL PASS — operator console' if not failures else 'FAILED: ' + ', '.join(failures))}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
