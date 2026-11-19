#!/usr/bin/env python3
"""
Growth check — the signup-to-value funnel, from the workspaces' own rows.

    baseline  →  a fresh workspace signs up  →  the funnel moves by one,
    at the first stage only

The funnel counts a workspace when a row proves the stage (an
assistant exists, a call exists). A brand-new workspace has proved
exactly one thing — that it signed up — so this gate can assert the
shape precisely rather than approximately.

    python3 scripts/growth_check.py
"""

import json
import os
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
STAMP = str(int(time.time()))

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, use_cookie=True):
    global cookie
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if use_cookie and cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode()
            sc = res.headers.get("set-cookie")
            # Adopt the cookie from our own sign-in only. The stranger signup
            # below (use_cookie=False) also sets one, and adopting it made
            # every later read run as the stranger — invisible while any
            # owner counted as operator, a 403 the moment
            # VOXERA_OPERATOR_EMAILS is configured, as production should.
            if sc and path == "/api/auth/login":
                cookie = sc.split(";")[0]
            return res.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (json.loads(text) if text else {})
        except json.JSONDecodeError:
            return err.code, {}


def main():
    status, _ = call("GET", "/api/v1/growth", use_cookie=False)
    check("the funnel refuses anonymous callers", status == 401, f"HTTP {status}")

    status, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, use_cookie=False)
    check("the operator can sign in", status == 200, f"HTTP {status}")
    status, before = call("GET", "/api/v1/growth")
    check("the funnel answers", status == 200 and "stages" in before, f"HTTP {status}")
    w0 = before.get("workspaces", -1)
    stages0 = {s["id"]: s["workspaces"] for s in before.get("stages", [])}
    check("the stages are in order", [s["id"] for s in before.get("stages", [])] == [
        "signed_up", "assistant_created", "assistant_published", "number_connected", "first_call", "first_booking", "first_payment",
    ])
    counts = [s["workspaces"] for s in before.get("stages", [])]
    check("the funnel only narrows", all(a >= b for a, b in zip(counts, counts[1:])), str(counts))
    check("the percentages add up", all(0 <= s["fromStart"] <= 100 for s in before.get("stages", [])))
    median = before.get("medianHoursToFirstCall")
    check("time to first call is never negative", median is None or median >= 0, str(median))

    # A fresh workspace, as a stranger makes it.
    status, signup = call("POST", "/api/auth/signup", {
        "email": f"growth+{STAMP}@example.com", "password": "correct-horse-battery",
        "name": "Growth Check", "orgName": f"Growth Check {STAMP}",
    }, use_cookie=False)
    check("a stranger can sign up", status == 201, f"HTTP {status}")

    status, after = call("GET", "/api/v1/growth")
    stages1 = {s["id"]: s["workspaces"] for s in after.get("stages", [])}
    check("the funnel counts the new workspace", after.get("workspaces") == w0 + 1, f"{w0} → {after.get('workspaces')}")
    check("at the first stage only", stages1.get("signed_up") == stages0.get("signed_up", -1) + 1 and
          all(stages1.get(k, -1) == v for k, v in stages0.items() if k != "signed_up"),
          str({k: (stages0.get(k), stages1.get(k)) for k in stages0}))

    this_week = after.get("signupsByWeek", [])[-1] if after.get("signupsByWeek") else {}
    check("the signup lands in the weekly series", this_week.get("signups", 0) >= 1, str(this_week))

    print(f"\n{('ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures))}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
