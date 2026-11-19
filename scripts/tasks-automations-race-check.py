#!/usr/bin/env python3
"""Two-node revision/idempotency race gate for tasks and constrained automations."""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

BASE_A = os.environ.get("VOXERA_BASE_A", "http://127.0.0.1:3201").rstrip("/")
BASE_B = os.environ.get("VOXERA_BASE_B", "http://127.0.0.1:3202").rstrip("/")
STAMP = secrets.token_hex(6)
PASS = 0
FAIL: list[str] = []


def check(label: str, condition: object, detail: object = "") -> None:
    global PASS
    if condition:
        PASS += 1
        print(f"PASS  {label}" + (f" — {detail}" if detail != "" else ""))
    else:
        FAIL.append(label)
        print(f"FAIL  {label}" + (f" — {detail}" if detail != "" else ""))


def message(payload: object) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        return str(payload["error"].get("message", payload["error"]))
    return str(payload)[:220]


def safe(*payloads: object) -> bool:
    text = " | ".join(message(payload).lower() for payload in payloads)
    return all(term not in text for term in ("sqlite", "constraint", "duplicate key", "voxera_docs", "docs_automation", "docs/"))


def request(base: str, method: str, path: str, body: object | None = None, *, cookie: str = ""):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("x-forwarded-for", "203.0.113.119")
    if body is not None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, json.loads(response.read() or b"{}"), response.headers.get("set-cookie", "").split(";", 1)[0]
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return error.code, payload, ""


def login(base: str) -> str:
    status, payload, cookie = request(base, "POST", "/api/auth/login", {"email": "jordan@northwind.dev", "password": "demo-password-2026"})
    check(f"owner signs in on {base}", status == 200 and bool(cookie), f"HTTP {status}: {message(payload)}")
    return cookie


def simultaneous(work_a, work_b):
    barrier = threading.Barrier(3)

    def wrapped(work):
        barrier.wait(timeout=20)
        return work()

    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(wrapped, work_a)
        b = pool.submit(wrapped, work_b)
        barrier.wait(timeout=20)
        return a.result(timeout=150), b.result(timeout=150)


def main() -> int:
    cookie_a = login(BASE_A)
    cookie_b = login(BASE_B)
    if not cookie_a or not cookie_b:
        return 1

    status, migrations, _ = request(BASE_A, "POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"}, cookie=cookie_a)
    check("shared schema/data migrations are current", status == 200 and migrations.get("completed") == migrations.get("total"), f"HTTP {status}: {message(migrations)}")
    status, readiness, _ = request(BASE_A, "POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"}, cookie=cookie_a)
    check("shared store is synthetic-test only", status == 200 and readiness.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}")

    create_status, freshness_task, _ = request(BASE_A, "POST", "/api/v1/tasks", {"title": f"Foreign-read freshness {STAMP}"}, cookie=cookie_a)
    freshness_id = freshness_task.get("id", "")
    warm_status, _, _ = request(BASE_B, "GET", f"/api/v1/tasks/{freshness_id}", cookie=cookie_b)
    write_status, freshness_write, _ = request(BASE_A, "PATCH", f"/api/v1/tasks/{freshness_id}", {"action": "transition", "to": "completed", "expectedRevision": freshness_task.get("revision")}, cookie=cookie_a)
    read_status, freshness_read, _ = request(BASE_B, "GET", f"/api/v1/tasks/{freshness_id}", cookie=cookie_b)
    check("one-way foreign commit is immediately visible on the other node", create_status == 201 and warm_status == write_status == read_status == 200 and freshness_read.get("state") == "completed" and freshness_read.get("revision") == freshness_write.get("revision"), f"states {freshness_write.get('state')}/{freshness_read.get('state')}")

    status, task, _ = request(BASE_A, "POST", "/api/v1/tasks", {"title": f"Transition race {STAMP}"}, cookie=cookie_a)
    task_id = task.get("id", "")
    request(BASE_A, "GET", f"/api/v1/tasks/{task_id}", cookie=cookie_a)
    request(BASE_B, "GET", f"/api/v1/tasks/{task_id}", cookie=cookie_b)
    outcomes = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/tasks/{task_id}", {"action": "transition", "to": "completed", "expectedRevision": task.get("revision")}, cookie=cookie_a),
        lambda: request(BASE_B, "PATCH", f"/api/v1/tasks/{task_id}", {"action": "transition", "to": "cancelled", "expectedRevision": task.get("revision")}, cookie=cookie_b),
    )
    codes = sorted([outcomes[0][0], outcomes[1][0]])
    check("two-node task transition has one revision winner", status == 201 and codes == [200, 409] and safe(outcomes[0][1], outcomes[1][1]), f"HTTP {codes}: {message(outcomes[0][1])} | {message(outcomes[1][1])}")
    status_a, final_a, _ = request(BASE_A, "GET", f"/api/v1/tasks/{task_id}", cookie=cookie_a)
    status_b, final_b, _ = request(BASE_B, "GET", f"/api/v1/tasks/{task_id}", cookie=cookie_b)
    check("both nodes converge on one terminal task revision", status_a == status_b == 200 and final_a.get("revision") == final_b.get("revision") == task.get("revision") + 1 and final_a.get("state") == final_b.get("state") and final_a.get("state") in ("completed", "cancelled"), f"states {final_a.get('state')}/{final_b.get('state')}")

    rule_payload = {
        "name": f"Two-node due rule {STAMP}", "trigger": "task.due",
        "condition": {"operator": "equals", "path": "task.priority", "value": "urgent"},
        "actions": [
            {"type": "create_task", "title": f"Generated once {STAMP}", "taskType": "follow_up", "priority": "normal", "dueMinutes": 120},
            {"type": "internal_notification", "title": f"Notice once {STAMP}", "message": "Two-node idempotency evidence.", "severity": "information"},
        ],
    }
    status, created, _ = request(BASE_A, "POST", "/api/v1/automations", rule_payload, cookie=cookie_a)
    rule = created.get("rule", {})
    rule_id = rule.get("id", "")
    request(BASE_A, "GET", f"/api/v1/automations/{rule_id}", cookie=cookie_a)
    request(BASE_B, "GET", f"/api/v1/automations/{rule_id}", cookie=cookie_b)
    activations = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/automations/{rule_id}", {"action": "activate", "expectedRevision": rule.get("revision")}, cookie=cookie_a),
        lambda: request(BASE_B, "PATCH", f"/api/v1/automations/{rule_id}", {"action": "activate", "expectedRevision": rule.get("revision")}, cookie=cookie_b),
    )
    activation_codes = sorted([activations[0][0], activations[1][0]])
    active = activations[0][1] if activations[0][0] == 200 else activations[1][1]
    check("two-node rule activation has one revision winner", status == 201 and activation_codes == [200, 409] and active.get("activeVersion") == 1 and safe(activations[0][1], activations[1][1]), f"HTTP {activation_codes}")

    revision_body = {
        "action": "revise", "expectedRevision": active.get("revision"), "name": rule_payload["name"], "trigger": "task.due",
        "condition": {"operator": "equals", "path": "task.priority", "value": "high"},
        "actions": [{"type": "internal_notification", "title": f"Draft v2 {STAMP}", "message": "Draft", "severity": "warning"}],
    }
    request(BASE_A, "GET", f"/api/v1/automations/{rule_id}", cookie=cookie_a)
    request(BASE_B, "GET", f"/api/v1/automations/{rule_id}", cookie=cookie_b)
    revisions = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/automations/{rule_id}", revision_body, cookie=cookie_a),
        lambda: request(BASE_B, "PATCH", f"/api/v1/automations/{rule_id}", revision_body, cookie=cookie_b),
    )
    revision_codes = sorted([revisions[0][0], revisions[1][0]])
    revision_winner = revisions[0][1] if revisions[0][0] == 200 else revisions[1][1]
    check("two-node rule revision creates exactly one immutable version two", revision_codes == [200, 409] and revision_winner.get("rule", {}).get("currentVersion") == 2 and revision_winner.get("rule", {}).get("activeVersion") == 1 and safe(revisions[0][1], revisions[1][1]), f"HTTP {revision_codes}")
    status_a, detail_a, _ = request(BASE_A, "GET", f"/api/v1/automations/{rule_id}", cookie=cookie_a)
    status_b, detail_b, _ = request(BASE_B, "GET", f"/api/v1/automations/{rule_id}", cookie=cookie_b)
    check("both nodes read one version-two document", status_a == status_b == 200 and detail_a.get("version", {}).get("version") == detail_b.get("version", {}).get("version") == 2, f"versions {detail_a.get('version', {}).get('version')}/{detail_b.get('version', {}).get('version')}")

    # Version one remains active; an urgent due task must execute v1 exactly once.
    due_at = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
    status, due_task, _ = request(BASE_A, "POST", "/api/v1/tasks", {"title": f"Due race {STAMP}", "priority": "urgent", "dueAt": due_at}, cookie=cookie_a)
    check("one overdue task creates shared durable work", status == 201 and due_task.get("dueAt"), f"HTTP {status}: {message(due_task)}")

    # Race the same shared queue several times: revision claims may split distinct jobs,
    # but the task event and rule run must each retain one winner.
    for _ in range(4):
        sched_a, sched_b = simultaneous(
            lambda: request(BASE_A, "POST", "/api/v1/scheduler", {"action": "run", "job": "domain-jobs", "force": True}, cookie=cookie_a),
            lambda: request(BASE_B, "POST", "/api/v1/scheduler", {"action": "run", "job": "domain-jobs", "force": True}, cookie=cookie_b),
        )
        check("concurrent domain-job scheduler calls remain controlled", sched_a[0] == sched_b[0] == 200 and safe(sched_a[1], sched_b[1]), f"HTTP {sched_a[0]}/{sched_b[0]}")

    status_a, config_a, _ = request(BASE_A, "GET", "/api/v1/automations", cookie=cookie_a)
    status_b, config_b, _ = request(BASE_B, "GET", "/api/v1/automations", cookie=cookie_b)
    runs_a = [row for row in config_a.get("runs", []) if row.get("ruleId") == rule_id and row.get("state") == "completed"]
    runs_b = [row for row in config_b.get("runs", []) if row.get("ruleId") == rule_id and row.get("state") == "completed"]
    notices_a = [row for row in config_a.get("notifications", []) if row.get("title") == f"Notice once {STAMP}"]
    notices_b = [row for row in config_b.get("notifications", []) if row.get("title") == f"Notice once {STAMP}"]
    check("two nodes converge on one version-one run and one notice", status_a == status_b == 200 and len(runs_a) == len(runs_b) == 1 and runs_a[0].get("id") == runs_b[0].get("id") and runs_a[0].get("ruleVersion") == 1 and len(notices_a) == len(notices_b) == 1 and notices_a[0].get("id") == notices_b[0].get("id"), f"runs {len(runs_a)}/{len(runs_b)} notices {len(notices_a)}/{len(notices_b)}")
    status_a, tasks_a, _ = request(BASE_A, "GET", f"/api/v1/tasks?q={STAMP}", cookie=cookie_a)
    status_b, tasks_b, _ = request(BASE_B, "GET", f"/api/v1/tasks?q={STAMP}", cookie=cookie_b)
    generated_a = [row for row in tasks_a.get("data", []) if row.get("title") == f"Generated once {STAMP}"]
    generated_b = [row for row in tasks_b.get("data", []) if row.get("title") == f"Generated once {STAMP}"]
    check("two nodes converge on one idempotent generated task", status_a == status_b == 200 and len(generated_a) == len(generated_b) == 1 and generated_a[0].get("id") == generated_b[0].get("id") and generated_a[0].get("automationOriginRunId") == runs_a[0].get("id"), f"tasks {len(generated_a)}/{len(generated_b)}")

    print(f"\n{PASS} passed / {len(FAIL)} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
