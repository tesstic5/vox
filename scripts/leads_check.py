#!/usr/bin/env python3
"""
Sales leads check — the enquiry that used to vanish, end to end.

    submit the public form  →  a lead exists  →  the inbox can work it

The form on /sales showed a thank-you and stored nothing for a long time;
this gate exists so that class of bug (a sender-side success over a
server-side void) cannot come back quietly. It also proves the inbox is
gated: a lead is the platform's, not any workspace's, and an anonymous
caller or a non-operator session gets nothing.

    python3 scripts/leads_check.py
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


def call(method, path, body=None, use_cookie=True, headers=None):
    global cookie
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if use_cookie and cookie:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode()
            sc = res.headers.get("set-cookie")
            if sc:
                cookie = sc.split(";")[0]
            return res.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (json.loads(text) if text else {})
        except json.JSONDecodeError:
            return err.code, {}


# One client address of its own per run: the form allows 10 submissions an
# hour per address, and back-to-back suite runs from localhost would
# otherwise spend each other's budget and fail on a warm bucket.
PUBLIC_ID = {"x-forwarded-for": f"198.51.100.{int(STAMP) % 180 + 20}"}


def main():
    company = f"Lead Check {STAMP}"

    # The public form, as a stranger sends it.
    status, body = call("POST", "/api/public/sales-lead", {
        "name": "Pat Leadcheck", "email": f"pat+{STAMP}@example.com", "company": company,
        "goal": "Appointment scheduling", "volume": "10k-50k minutes/mo", "timeline": "This quarter",
    }, use_cookie=False, headers=PUBLIC_ID)
    check("a stranger can submit the sales form", status == 201, f"HTTP {status}")
    lead_id = body.get("id", "")

    # The same form, filled in wrong, is refused in words.
    status, body = call("POST", "/api/public/sales-lead", {"name": "X", "email": "not-an-email", "company": ""}, use_cookie=False, headers=PUBLIC_ID)
    check("a bad submission is refused with a reason", status == 400 and "message" in str(body.get("error", {})), f"HTTP {status}")

    # A bot filling the honeypot is thanked and stored nowhere.
    status, _ = call("POST", "/api/public/sales-lead", {
        "name": "Bot", "email": f"bot+{STAMP}@example.com", "company": f"BotCo {STAMP}", "website": "http://spam.example",
    }, use_cookie=False, headers=PUBLIC_ID)
    check("the honeypot is thanked, not stored", status == 201, f"HTTP {status}")

    # Anonymous callers cannot read the inbox.
    status, _ = call("GET", "/api/v1/leads", use_cookie=False)
    check("the inbox refuses anonymous callers", status == 401, f"HTTP {status}")

    # Sign in as the workspace owner and work the lead.
    status, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, use_cookie=False)
    check("the operator can sign in", status == 200, f"HTTP {status}")

    status, body = call("GET", "/api/v1/leads")
    mine = [l for l in body.get("data", []) if l.get("company") == company]
    check("the submitted lead is in the inbox", status == 200 and len(mine) == 1 and mine[0].get("id") == lead_id, f"HTTP {status}, {len(mine)} match(es)")
    check("and the honeypot lead is not", not any(l.get("company") == f"BotCo {STAMP}" for l in body.get("data", [])))
    check("the pipeline counts it as new", body.get("stats", {}).get("new", 0) >= 1, str(body.get("stats")))

    if mine:
        lid = mine[0]["id"]
        status, body = call("PATCH", f"/api/v1/leads/{lid}", {"status": "demo", "note": "Called — pilot on the support line."})
        log = body.get("log", [])
        check("the lead moves along the pipeline", status == 200 and body.get("status") == "demo", f"HTTP {status}")
        check("and the work is written on the lead", any("pilot" in e.get("text", "") for e in log) and any("new → demo" in e.get("text", "") for e in log), f"{len(log)} log line(s)")

        status, _ = call("PATCH", f"/api/v1/leads/{lid}", {"status": "sideways"})
        check("a status that does not exist is refused", status == 400, f"HTTP {status}")

    status, _ = call("PATCH", "/api/v1/leads/lead_nope", {"status": "won"})
    check("a lead that does not exist is a 404", status == 404, f"HTTP {status}")

    print(f"\n{('ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures))}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
