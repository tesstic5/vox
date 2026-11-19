#!/usr/bin/env python3
"""
API surface check — the endpoints the docs promise, and the fixes around them.

Covers what the improvement audit found missing or inconsistent, at the HTTP
level, and cleans up everything it creates:

  * the canonical list envelope (`object` / `data` / `total` / `has_more`)
  * tools: create, list, read, test (a real HTTP call), update, delete + detach
  * squads: create, list (members resolved), reorder, delete
  * analytics: overview / costs / outcomes, consistent with the call records
  * assistant knowledge: attach snippets and files, read back
  * rate limiting: login and signup are both limited, per identity
  * security headers on the app and the docs

Run it with the app up:

    python3 scripts/api_check.py
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

cookie = ""
failures: list[str] = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def api(method, path, body=None, headers=None, keep_cookie=True):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if cookie and keep_cookie:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            set_cookie = res.headers.get("set-cookie")
            if set_cookie and keep_cookie:
                globals()["cookie"] = set_cookie.split(";")[0]
            raw = res.read()
            try:
                return res.status, json.loads(raw or b"{}"), dict(res.headers)
            except json.JSONDecodeError:
                return res.status, {"_raw": raw[:200].decode("utf-8", "replace")}, dict(res.headers)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw or b"{}"), dict(err.headers)
        except json.JSONDecodeError:
            return err.code, {"_raw": raw[:200].decode("utf-8", "replace")}, dict(err.headers)


def main():
    globals()["cookie"] = cached_cookie(BASE, EMAIL, PASSWORD)
    check("sign in", bool(cookie), "session cookie" if cookie else "no session")
    if not cookie:
        return 1

    print("\n— list envelope ————————————————————————————")
    for path in ["/api/v1/numbers", "/api/v1/keys", "/api/v1/bookings", "/api/v1/calls", "/api/v1/files"]:
        status, body, _ = api("GET", path)
        ok = status == 200 and all(k in body for k in ("object", "data", "total", "has_more"))
        check(f"{path} uses the canonical envelope", ok, f"keys={sorted(body.keys())[:6]}")

    print("\n— documented call filters ————————————————————")
    status, all_calls, _ = api("GET", "/api/v1/calls?limit=100")
    # The *least* common reason on this page, so a filter that does nothing is
    # caught: filtering on the most common one can leave the page size unchanged.
    counts = {}
    for row in all_calls.get("data", []):
        if row.get("endedReason"):
            counts[row["endedReason"]] = counts.get(row["endedReason"], 0) + 1
    if counts:
        reason = min(counts, key=lambda k: counts[k])
        base_total = all_calls.get("total", 0)
        status, filtered, _ = api("GET", f"/api/v1/calls?endedReason={reason}&limit=100")
        rows = filtered.get("data", [])
        # The `counts` above come from one page of 100 rows, but the filter runs
        # over the whole set — so the right comparison is against the filter's own
        # total, not against how often the reason appeared on the first page.
        # (Comparing the two made this check pass or fail on which calls happened
        # to be newest, which is not something a gate should depend on.)
        check(
            "a filter really narrows the page",
            status == 200
            and 0 < len(rows) <= 100
            and len(rows) == min(100, filtered.get("total", 0))
            and all(r.get("endedReason") == reason for r in rows)
            and 0 < filtered.get("total", 0) < base_total,
            f"{filtered.get('total')} of {base_total} are `{reason}`",
        )
        status, in_body, _ = api("GET", f"/api/v1/calls?endedReason=in:{reason},no-such-reason&limit=100")
        check(
            "the documented `in:` operator works",
            status == 200 and all(r.get("endedReason") == reason for r in in_body.get("data", [])) and len(in_body.get("data", [])) >= len(rows),
            f"{len(in_body.get('data', []))} rows",
        )
        status, ranged, _ = api("GET", "/api/v1/calls?durationSecondsGt=1&limit=100")
        check(
            "numeric comparisons work (`durationSecondsGt`)",
            status == 200 and all(float(r.get("durationSeconds") or 0) > 1 for r in ranged.get("data", [])),
            f"{len(ranged.get('data', []))} rows over a second",
        )
        status, asc, _ = api("GET", "/api/v1/calls?sort=startedAt:asc&limit=5")
        stamps = [r.get("startedAt") for r in asc.get("data", [])]
        check("sort=…:asc is honoured, not ignored", status == 200 and stamps == sorted(stamps), f"{stamps[:2]}")
    status, bad_filter, _ = api("GET", "/api/v1/calls?nonsenseField=1")
    check(
        "an unknown filter field is refused rather than ignored",
        status == 400 and bad_filter.get("error", {}).get("code") == "VALIDATION_ERROR",
        f"HTTP {status} · {bad_filter.get('error', {}).get('code')}",
    )

    print("\n— tools —————————————————————————————————————")
    status, assistants, _ = api("GET", "/api/v1/assistants")
    assistant_id = assistants["data"][0]["id"] if assistants.get("data") else None
    tool_name = "api_check_probe"
    existing = api("GET", "/api/v1/tools")[1].get("data", [])
    for tool in existing:
        if tool.get("name") == tool_name:
            api("DELETE", f"/api/v1/tools/{tool['id']}")

    status, created, _ = api(
        "POST",
        "/api/v1/tools",
        {
            "name": tool_name,
            "description": "Probe tool created by api_check; removed at the end.",
            "method": "POST",
            "endpoint": f"{BASE}/api/webhook-echo",
        },
    )
    tool_id = created.get("id")
    check("create a tool", status == 201 and bool(tool_id), f"HTTP {status}")
    if tool_id:
        status, test, _ = api("POST", f"/api/v1/tools/{tool_id}/test", {"args": {"probe": "api_check"}})
        if test.get("ok") is False and test.get("status") is None and "policy" in str(test.get("error", "")):
            # The deployment forbids outbound calls to private addresses (the
            # shipping default). The endpoint here is loopback, so the honest
            # result is a refusal — and the refusal must say why, not invent an
            # answer. `scripts/endpoint-probe.ts --mode=blocked` is the full
            # version of this assertion.
            check(
                "a tool endpoint behind the outbound policy is refused honestly",
                status == 200 and bool(test.get("error")) and not str(test.get("response") or "").strip(),
                str(test.get("error"))[:80],
            )
        else:
            check(
                "test a tool dials the endpoint for real",
                status == 200 and test.get("ok") is True and test.get("status") == 200 and test.get("ms", -1) >= 0,
                f"HTTP {status} · {test.get('status')} in {test.get('ms')}ms",
            )
        status, patched, _ = api("PATCH", f"/api/v1/tools/{tool_id}", {"description": "Updated by api_check."})
        check("update a tool", status == 200 and patched.get("description") == "Updated by api_check.", f"HTTP {status}")
        status, listed, _ = api("GET", "/api/v1/tools")
        row = next((t for t in listed.get("data", []) if t.get("id") == tool_id), None)
        check("tool appears in the list with usedBy", bool(row) and "usedBy" in row, f"usedBy={row.get('usedBy') if row else None}")
        status, deleted, _ = api("DELETE", f"/api/v1/tools/{tool_id}")
        check("delete a tool reports detach count", status == 200 and "detachedFrom" in deleted, f"HTTP {status}")
        check("deleted tool is gone", api("GET", f"/api/v1/tools/{tool_id}")[0] == 404)

    status, dup, _ = api("POST", "/api/v1/tools", {"name": "not a valid name!"})
    check("tool names are validated", status == 400, f"HTTP {status} · {dup.get('error', {}).get('code')}")

    print("\n— squads ————————————————————————————————————")
    squad_name = "api_check squad"
    for squad in api("GET", "/api/v1/squads")[1].get("data", []):
        if squad.get("name") == squad_name:
            api("DELETE", f"/api/v1/squads/{squad['id']}")
    # The workspace may have a single assistant; a squad needs two, so the check
    # brings its own and removes it again.
    probe_assistant = None
    for assistant in (assistants.get("data") or []):
        if assistant.get("name") == "api_check assistant":
            api("DELETE", f"/api/v1/assistants/{assistant['id']}")
    status, created_assistant, _ = api(
        "POST",
        "/api/v1/assistants",
        {
            "name": "api_check assistant",
            "template": "Blank",
            "firstMessage": "Probe assistant for the API check.",
            "systemPrompt": "You exist so the API check has a second squad member. Nothing else.",
        },
    )
    if status == 201:
        probe_assistant = created_assistant.get("id") or created_assistant.get("doc", {}).get("id")
    members = ([assistants["data"][0]["id"]] if assistants.get("data") else []) + ([probe_assistant] if probe_assistant else [])
    if len(members) >= 2:
        status, squad, _ = api("POST", "/api/v1/squads", {"name": squad_name, "members": members, "brief": "Probe handoff brief."})
        squad_id = squad.get("id")
        check("create a squad", status == 201 and bool(squad_id), f"HTTP {status}")
        if squad_id:
            status, listed, _ = api("GET", "/api/v1/squads")
            row = next((s for s in listed.get("data", []) if s.get("id") == squad_id), None)
            check("members resolve to assistant names", bool(row) and all("name" in m for m in row.get("members", [])), f"{row.get('members') if row else None}")
            status, swapped, _ = api("PATCH", f"/api/v1/squads/{squad_id}", {"members": list(reversed(members))})
            order = [m["assistantId"] for m in (swapped.get("members") or [])]
            check("reorder members", status == 200 and order == list(reversed(members)), f"{order}")
            status, bad, _ = api("POST", "/api/v1/squads", {"name": "bad", "members": ["asst_nope"]})
            check("unknown members are rejected", status == 400, f"HTTP {status}")
            check("delete a squad", api("DELETE", f"/api/v1/squads/{squad_id}")[0] == 200)
    else:
        check("two assistants available to build a squad", False, "could not create a probe assistant")
    if probe_assistant:
        check("probe assistant removed", api("DELETE", f"/api/v1/assistants/{probe_assistant}")[0] == 200)

    print("\n— analytics ————————————————————————————————")
    status, overview, _ = api("GET", "/api/v1/analytics/overview?days=30")
    check(
        "overview computes real totals",
        status == 200 and set(["totals", "latency", "series", "costPerMinute"]).issubset(overview.keys()) and overview["totals"]["ended"] > 0,
        f"calls={overview['totals']['calls']} minutes={overview['totals']['minutes']} cost={overview['totals']['cost']}",
    )
    status, calls, _ = api("GET", "/api/v1/calls?limit=200")
    check(
        "overview is consistent with the call list",
        overview["totals"]["calls"] <= calls["total"],
        f"analytics={overview['totals']['calls']} calls_total={calls['total']}",
    )
    status, costs, _ = api("GET", "/api/v1/analytics/costs?days=30")
    components = costs.get("components", {})
    component_total = sum(float(components.get(name, 0)) for name in ("platform", "stt", "tts", "llm", "telephony"))
    check(
        "costs break down by component without inventing provider attribution",
        status == 200
        and set(["platform", "stt", "tts", "llm", "telephony"]).issubset(components.keys())
        and abs(component_total - float(costs["total"])) < 0.0002
        and costs.get("providerAttributionAvailable") is False
        and costs.get("byProvider") == [],
        f"total=${costs.get('total')} componentTotal=${component_total:.4f} providerAttribution={costs.get('providerAttributionAvailable')}",
    )
    status, outcomes, _ = api("GET", "/api/v1/analytics/outcomes?days=30")
    check(
        "outcomes report intents, endings and tools",
        status == 200 and len(outcomes.get("byIntent", [])) > 0 and "byEndedReason" in outcomes and "byBookingStatus" in outcomes.get("bookings", {}),
        f"intents={len(outcomes.get('byIntent', []))} bookings={outcomes.get('bookings', {}).get('total')}",
    )

    print("\n— assistant knowledge ———————————————————————")
    if assistant_id:
        status, before, _ = api("GET", f"/api/v1/assistants/{assistant_id}/knowledge")
        original = before.get("snippets", {}).get("data", [])
        original_files = before.get("fileIds", [])
        status, attached, _ = api(
            "POST",
            f"/api/v1/assistants/{assistant_id}/knowledge",
            {"snippets": ["api_check probe: refunds over $500 need a supervisor."]},
        )
        check("attach a snippet", status == 200 and attached.get("knowledge", {}).get("snippets") == len(original) + 1, f"HTTP {status}")
        status, after, _ = api("GET", f"/api/v1/assistants/{assistant_id}/knowledge")
        check(
            "snippet is readable back and reaches the assistant",
            any("api_check probe" in s for s in after.get("snippets", {}).get("data", [])),
            f"{after.get('snippets', {}).get('total')} snippets",
        )
        api("POST", f"/api/v1/assistants/{assistant_id}/knowledge", {"snippets": original, "fileIds": original_files, "replace": True})
        status, restored, _ = api("GET", f"/api/v1/assistants/{assistant_id}/knowledge")
        check("restored the assistant's original knowledge", restored.get("snippets", {}).get("total") == len(original))
        status, bad, _ = api("POST", f"/api/v1/assistants/{assistant_id}/knowledge", {"fileIds": ["file_nope"]})
        check("unknown file ids are rejected", status == 400, f"HTTP {status}")

    print("\n— rate limiting ————————————————————————————")
    # Each probe gets a client address of its own, fresh this run. The limiters
    # are real and counted per address, so a probe pinned to one address would
    # spend the *previous* run's budget and then pass or fail on a warm bucket
    # instead of on the limiter. A cold address has to earn its 429.
    stamp = int(time.time()) % 200
    identity = f"203.0.113.{stamp}"
    codes = [api("POST", "/api/auth/login", {"email": "nobody@example.com", "password": "wrong"}, headers={"x-forwarded-for": identity})[0] for _ in range(12)]
    check("login is rate limited per client", codes[-1] == 429 and codes[0] != 429, f"codes={codes}")
    # Signup allows 15 in ten minutes from one address, so the probe spends 18.
    signup_ip = f"198.51.100.{stamp}"
    codes = [api("POST", "/api/auth/signup", {"email": "not-an-email"}, headers={"x-forwarded-for": signup_ip})[0] for _ in range(18)]
    check("signup is rate limited too", codes[-1] == 429 and codes[0] != 429, f"codes={codes}")

    print("\n— security headers —————————————————————————")
    for path in ["/", "/dashboard"]:
        status, _, headers = api("GET", path)
        lowered = {k.lower(): v for k, v in headers.items()}
        csp = lowered.get("content-security-policy", "")
        check(
            f"{path} carries a CSP",
            "default-src 'self'" in csp and "object-src 'none'" in csp and "frame-ancestors" in csp,
            csp[:70] + "…" if csp else "missing",
        )
        check(
            f"{path} carries nosniff + referrer policy",
            lowered.get("x-content-type-options") == "nosniff" and bool(lowered.get("referrer-policy")),
            f"nosniff={lowered.get('x-content-type-options')} referrer={lowered.get('referrer-policy')}",
        )

    print()
    print(f"{len(failures)} failure(s)" if failures else "API CHECK: ALL PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
