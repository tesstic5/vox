#!/usr/bin/env python3
"""
Workspace export check — the whole workspace, in one file, safely.

    export as the owner  →  every collection present, counts honest,
    secrets redacted, machinery and other people's data absent

An export is a trust feature: it has to be complete enough to leave
with, and careful enough that leaving does not mean leaking password
hashes. Both halves are checked here against the seeded demo workspace.

    python3 scripts/workspace_export_check.py
"""

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, use_cookie=True, raw=False):
    global cookie
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if use_cookie and cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode()
            sc = res.headers.get("set-cookie")
            if sc:
                cookie = sc.split(";")[0]
            return res.status, (text if raw else (json.loads(text) if text else {})), dict(res.headers)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (text if raw else (json.loads(text) if text else {})), dict(err.headers)
        except json.JSONDecodeError:
            return err.code, text, dict(err.headers)


def main():
    status, _, _ = call("GET", "/api/v1/workspaces/export", use_cookie=False)
    check("the export refuses anonymous callers", status == 401, f"HTTP {status}")

    status, _, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, use_cookie=False)
    check("the owner can sign in", status == 200, f"HTTP {status}")

    status, text, headers = call("GET", "/api/v1/workspaces/export", raw=True)
    check("the owner can export the workspace", status == 200, f"HTTP {status}")
    disposition = next((v for k, v in headers.items() if k.lower() == "content-disposition"), "")
    check("it arrives as a download", "attachment" in disposition, disposition[:60])

    data = json.loads(text)
    check("the file says what it is", data.get("format") == "voxera-workspace-export" and data.get("version") == 1)
    cols = data.get("collections", {})
    counts = data.get("counts", {})
    for expected in ("clients", "bookings", "calls", "invoices", "assistants"):
        check(f"it contains {expected}", expected in cols and len(cols[expected]) > 0, f"{len(cols.get(expected, []))} rows")
    check("the counts are the rows", all(counts.get(k) == len(v) for k, v in cols.items()))
    check("every row belongs to this workspace", all(
        (row.get("orgId") == data.get("orgId") or (name == "orgs" and row.get("id") == data.get("orgId")))
        for name, rows in cols.items() for row in rows
    ))
    for machinery in ("sessions", "authTokens", "rateBuckets", "salesLeads"):
        check(f"it leaves {machinery} behind", machinery not in cols)

    # Secrets: the field names may travel (the shape is the data), the
    # values may not.
    import re
    leaked = [m for m in re.findall(r'"(?:passwordHash|keyHash|secret|token)"\s*:\s*"([^"]+)"', text) if m != "[redacted]"]
    check("no secret travels in the clear", not leaked, f"{len(leaked)} leaked")

    # And the export itself is on the audit trail.
    status, body, _ = call("GET", "/api/v1/audit?limit=50")
    rows = body.get("data", []) if isinstance(body, dict) else []
    check("the export is written into the audit trail", any(r.get("action") == "workspace.exported" for r in rows))

    print(f"\n{('ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures))}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
