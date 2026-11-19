#!/usr/bin/env python3
"""HTTP/security gate for administrative tasks and constrained automations.

Run against an isolated synthetic fixture only.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000").rstrip("/")
STAMP = secrets.token_hex(5)
SYNTHETIC = {"x-voxera-synthetic-data": "1"}
passes = 0
failures: list[str] = []


def check(label: str, condition: object, detail: object = "") -> None:
    global passes
    if condition:
        passes += 1
        print(f"PASS  {label}" + (f" — {detail}" if detail != "" else ""))
    else:
        failures.append(label)
        print(f"FAIL  {label}" + (f" — {detail}" if detail != "" else ""))


def request(method: str, path: str, body: object | None = None, *, cookie: str = "", headers: dict[str, str] | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("x-forwarded-for", "198.51.100.117")
    if body is not None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            payload = json.loads(response.read() or b"{}")
            return response.status, payload, response.headers.get("set-cookie", "").split(";", 1)[0]
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return error.code, payload, ""


def message(payload: object) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        return str(payload["error"].get("message", payload["error"]))
    return str(payload)[:240]


def login(email: str, password: str = "demo-password-2026") -> str:
    status, body, cookie = request("POST", "/api/auth/login", {"email": email, "password": password})
    check(f"sign in {email}", status == 200 and bool(cookie), f"HTTP {status}: {message(body)}")
    return cookie


def main() -> None:
    owner = login("jordan@northwind.dev")
    desk = login("desk@northwind.dev")

    status, migrated, _ = request("POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"}, cookie=owner)
    check("checksummed migrations include task/automation permissions", status == 200 and migrated.get("completed") == migrated.get("total"), f"HTTP {status}: {message(migrated)}")
    status, readiness, _ = request("POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"}, cookie=owner)
    check("synthetic-test mode enabled", status == 200 and readiness.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}: {message(readiness)}")

    status, unauth_tasks, _ = request("GET", "/api/v1/tasks")
    check("task queue requires authentication", status == 401, f"HTTP {status}: {message(unauth_tasks)}")
    status, unauth_rules, _ = request("GET", "/api/v1/automations")
    check("automation configuration requires authentication", status == 401, f"HTTP {status}: {message(unauth_rules)}")

    status, team, _ = request("GET", "/api/v1/team?view=members", cookie=owner)
    members = team.get("members", []) if isinstance(team, dict) else []
    owner_id = next((row.get("id") for row in members if row.get("email") == "jordan@northwind.dev"), "")
    check("active owner is available for allowlisted assignment", status == 200 and bool(owner_id), f"HTTP {status}")

    status, automations, _ = request("GET", "/api/v1/automations", cookie=owner)
    catalogue = automations.get("catalogue", {}) if isinstance(automations, dict) else {}
    check("server returns bounded automation catalogue", status == 200 and len(catalogue.get("triggers", [])) == 5 and len(catalogue.get("actions", [])) == 3 and catalogue.get("limits", {}).get("loopDepth") == 4, f"HTTP {status}")
    prohibited = " ".join(catalogue.get("prohibited", [])).lower()
    check("catalogue declares prohibited high-risk effects", all(term in prohibited for term in ("clinical note", "claim", "refund", "deny care")), prohibited)

    status, unsafe_action, _ = request("POST", "/api/v1/automations", {
        "name": "Unsafe", "trigger": "task.due", "actions": [{"type": "javascript", "code": "return true"}],
    }, cookie=owner)
    check("arbitrary JavaScript action is rejected", status == 400 and "not allowed" in message(unsafe_action).lower(), f"HTTP {status}: {message(unsafe_action)}")
    status, unsafe_path, _ = request("POST", "/api/v1/automations", {
        "name": "Unsafe private condition", "trigger": "referral.received",
        "condition": {"operator": "equals", "path": "referral.patientName", "value": "private"},
        "actions": [{"type": "internal_notification", "title": "Review", "message": "Review", "severity": "information"}],
    }, cookie=owner)
    check("patient-content condition path is rejected", status == 400 and "path" in message(unsafe_path).lower(), f"HTTP {status}: {message(unsafe_path)}")
    status, forged_rule, _ = request("POST", "/api/v1/automations", {
        "name": "Forged", "trigger": "task.due", "orgId": "other",
        "actions": [{"type": "internal_notification", "title": "Review", "message": "Review", "severity": "information"}],
    }, cookie=owner)
    check("unsupported automation ownership field is rejected", status == 400 and "orgid" in message(forged_rule).lower(), f"HTTP {status}: {message(forged_rule)}")

    rule_payload = {
        "name": f"Urgent due task {STAMP}", "trigger": "task.due",
        "condition": {"operator": "equals", "path": "task.priority", "value": "urgent"},
        "actions": [
            {"type": "internal_notification", "title": f"Urgent task {STAMP}", "message": "An urgent administrative task is now due.", "severity": "warning"},
            {"type": "create_task", "title": f"Follow due task {STAMP}", "taskType": "follow_up", "priority": "high", "dueMinutes": 60, "assigneeId": owner_id},
        ],
    }
    status, created, _ = request("POST", "/api/v1/automations", rule_payload, cookie=owner)
    rule = created.get("rule", {}) if isinstance(created, dict) else {}
    rule_id = rule.get("id", "")
    check("automation rule starts paused at immutable version one", status == 201 and str(rule_id).startswith("auto_") and rule.get("active") is False and created.get("version", {}).get("version") == 1, f"HTTP {status}: {message(created)}")
    status, preview, _ = request("POST", f"/api/v1/automations/{rule_id}", {"values": {"task.priority": "urgent"}}, cookie=owner)
    check("server preview evaluates the latest version without persistence", status == 200 and preview.get("matched") is True and preview.get("version") == 1 and preview.get("persisted") is False and len(preview.get("actions", [])) == 2, f"HTTP {status}: {message(preview)}")
    status, unsafe_preview, _ = request("POST", f"/api/v1/automations/{rule_id}", {"values": {"task.patientName": "private"}}, cookie=owner)
    check("preview rejects metadata outside the trigger catalogue", status == 400 and "path" in message(unsafe_preview).lower(), f"HTTP {status}: {message(unsafe_preview)}")
    status, preview_detail, _ = request("GET", f"/api/v1/automations/{rule_id}", cookie=owner)
    check("preview creates no run evidence", status == 200 and preview_detail.get("runs") == [], f"HTTP {status}: {message(preview_detail)}")
    status, stale_rule, _ = request("PATCH", f"/api/v1/automations/{rule_id}", {"action": "activate", "expectedRevision": 0}, cookie=owner)
    check("stale automation revision is rejected", status == 409, f"HTTP {status}: {message(stale_rule)}")
    status, invalid_rule_action, _ = request("PATCH", f"/api/v1/automations/{rule_id}", {"action": "execute", "expectedRevision": rule.get("revision")}, cookie=owner)
    check("forged automation action is rejected instead of coerced", status == 400 and "action" in message(invalid_rule_action).lower(), f"HTTP {status}: {message(invalid_rule_action)}")
    status, active, _ = request("PATCH", f"/api/v1/automations/{rule_id}", {"action": "activate", "expectedRevision": rule.get("revision")}, cookie=owner)
    check("explicit activation pins version one", status == 200 and active.get("active") is True and active.get("activeVersion") == 1, f"HTTP {status}: {message(active)}")

    status, workspace_task, _ = request("POST", "/api/v1/tasks", {
        "title": f"Workspace task {STAMP}", "priority": "normal", "resourceType": "workspace",
    }, cookie=owner)
    task_id = workspace_task.get("id", "") if isinstance(workspace_task, dict) else ""
    check("workspace administrative task needs no clinical acknowledgement", status == 201 and str(task_id).startswith("tsk_") and workspace_task.get("state") == "open", f"HTTP {status}: {message(workspace_task)}")
    status, forged_task, _ = request("POST", "/api/v1/tasks", {"title": "Forged task", "orgId": "other"}, cookie=owner)
    check("unsupported task ownership field is rejected", status == 400 and "orgid" in message(forged_task).lower(), f"HTTP {status}: {message(forged_task)}")
    status, stale_task, _ = request("PATCH", f"/api/v1/tasks/{task_id}", {"action": "transition", "to": "completed", "expectedRevision": 0}, cookie=owner)
    check("stale task transition is rejected", status == 409, f"HTTP {status}: {message(stale_task)}")
    status, completed, _ = request("PATCH", f"/api/v1/tasks/{task_id}", {"action": "transition", "to": "completed", "expectedRevision": workspace_task.get("revision")}, cookie=owner)
    check("task completion preserves state evidence", status == 200 and completed.get("state") == "completed" and completed.get("completedAt") and completed.get("completedBy"), f"HTTP {status}: {message(completed)}")
    status, terminal_edit, _ = request("PATCH", f"/api/v1/tasks/{task_id}", {"action": "update", "expectedRevision": completed.get("revision"), "patch": {"title": "Silent edit"}}, cookie=owner)
    check("terminal task cannot be silently edited", status == 400 and "reopened" in message(terminal_edit).lower(), f"HTTP {status}: {message(terminal_edit)}")
    status, reopened, _ = request("PATCH", f"/api/v1/tasks/{task_id}", {"action": "transition", "to": "open", "expectedRevision": completed.get("revision")}, cookie=owner)
    check("completed task can be explicitly reopened", status == 200 and reopened.get("state") == "open" and not reopened.get("completedAt"), f"HTTP {status}: {message(reopened)}")

    status, desk_task, _ = request("POST", "/api/v1/tasks", {"title": f"Desk task {STAMP}"}, cookie=desk)
    check("reception role can create administrative tasks", status == 201 and desk_task.get("state") == "open", f"HTTP {status}: {message(desk_task)}")
    status, desk_clinical, _ = request("POST", "/api/v1/tasks", {"title": "Restricted task", "visibility": "clinical"}, cookie=desk, headers=SYNTHETIC)
    check("reception cannot create clinical-restricted task", status == 403, f"HTTP {status}: {message(desk_clinical)}")
    status, desk_rules, _ = request("GET", "/api/v1/automations", cookie=desk)
    check("reception cannot inspect automation configuration", status == 403, f"HTTP {status}: {message(desk_rules)}")
    status, desk_queue, _ = request("GET", "/api/v1/tasks?state=open", cookie=desk)
    check("reception can read its administrative work queue", status == 200 and any(row.get("id") == desk_task.get("id") for row in desk_queue.get("data", [])), f"HTTP {status}")

    referral_payload = {"patient": {"name": f"Synthetic Referral {STAMP}"}, "reason": "Synthetic linked-task API check", "priority": "routine"}
    status, referral_created, _ = request("POST", "/api/v1/referrals", referral_payload, cookie=owner, headers=SYNTHETIC)
    referral_id = referral_created.get("referral", {}).get("id", "") if isinstance(referral_created, dict) else ""
    check("synthetic referral resource created", status == 201 and bool(referral_id), f"HTTP {status}: {message(referral_created)}")
    status, unack_link, _ = request("POST", "/api/v1/tasks", {"title": "Linked without acknowledgement", "resourceType": "referral", "resourceId": referral_id}, cookie=owner)
    check("patient-linked task fails closed without synthetic acknowledgement", status == 403 and "prohibited" in message(unack_link).lower(), f"HTTP {status}: {message(unack_link)}")
    status, linked, _ = request("POST", "/api/v1/tasks", {"title": f"Review referral {STAMP}", "type": "referral_review", "resourceType": "referral", "resourceId": referral_id}, cookie=owner, headers=SYNTHETIC)
    check("acknowledged task links to same-workspace referral", status == 201 and linked.get("resourceId") == referral_id, f"HTTP {status}: {message(linked)}")

    due_at = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
    status, due_task, _ = request("POST", "/api/v1/tasks", {
        "title": f"Due urgent {STAMP}", "priority": "urgent", "dueAt": due_at, "assigneeId": owner_id,
    }, cookie=owner)
    check("due task schedules durable work", status == 201 and due_task.get("dueAt"), f"HTTP {status}: {message(due_task)}")
    for _ in range(8):
        request("POST", "/api/v1/scheduler", {"action": "run", "job": "domain-jobs", "force": True}, cookie=owner)
    status, after_run, _ = request("GET", "/api/v1/automations", cookie=owner)
    matching_runs = [row for row in after_run.get("runs", []) if row.get("ruleId") == rule_id and row.get("state") == "completed"]
    matching_notices = [row for row in after_run.get("notifications", []) if row.get("title") == f"Urgent task {STAMP}"]
    check("scheduler executes due-task automation through durable runner", status == 200 and len(matching_runs) == 1 and len(matching_notices) == 1, f"HTTP {status}: runs={len(matching_runs)} notices={len(matching_notices)}")
    generated_notice = matching_notices[0] if matching_notices else {}
    notice_id = generated_notice.get("id", "")
    status, unauth_notice, _ = request("PATCH", f"/api/v1/automations/notifications/{notice_id}", {"action": "read", "expectedRevision": generated_notice.get("revision")})
    check("automation notice mutation requires authentication", status == 401, f"HTTP {status}: {message(unauth_notice)}")
    status, forged_notice, _ = request("PATCH", f"/api/v1/automations/notifications/{notice_id}", {"action": "read", "expectedRevision": generated_notice.get("revision"), "orgId": "other"}, cookie=owner)
    check("automation notice rejects forged ownership fields", status == 400 and "orgid" in message(forged_notice).lower(), f"HTTP {status}: {message(forged_notice)}")
    status, read_notice, _ = request("PATCH", f"/api/v1/automations/notifications/{notice_id}", {"action": "read", "expectedRevision": generated_notice.get("revision")}, cookie=owner)
    check("automation notice can be marked read with durable evidence", status == 200 and read_notice.get("readAt") and read_notice.get("readBy"), f"HTTP {status}: {message(read_notice)}")
    status, stale_notice, _ = request("PATCH", f"/api/v1/automations/notifications/{notice_id}", {"action": "dismiss", "expectedRevision": generated_notice.get("revision")}, cookie=owner)
    check("stale automation notice transition is rejected", status == 409, f"HTTP {status}: {message(stale_notice)}")
    status, dismissed_notice, _ = request("PATCH", f"/api/v1/automations/notifications/{notice_id}", {"action": "dismiss", "expectedRevision": read_notice.get("revision")}, cookie=owner)
    check("automation notice dismissal retains read and audit state", status == 200 and dismissed_notice.get("dismissedAt") and dismissed_notice.get("dismissedBy") and dismissed_notice.get("readAt"), f"HTTP {status}: {message(dismissed_notice)}")
    status, active_notices, _ = request("GET", "/api/v1/automations", cookie=owner)
    detail_status, retained_notice, _ = request("GET", f"/api/v1/automations/notifications/{notice_id}", cookie=owner)
    check("dismissed notice leaves active inbox but remains retrievable", status == 200 and not any(row.get("id") == notice_id for row in active_notices.get("notifications", [])) and active_notices.get("notificationSummary", {}).get("dismissed", 0) >= 1 and detail_status == 200 and retained_notice.get("id") == notice_id, f"HTTP {status}/{detail_status}")
    status, desk_notice, _ = request("PATCH", f"/api/v1/automations/notifications/{notice_id}", {"action": "read", "expectedRevision": dismissed_notice.get("revision")}, cookie=desk)
    check("reception cannot mutate automation notices", status == 403, f"HTTP {status}: {message(desk_notice)}")
    status, queue_after_run, _ = request("GET", f"/api/v1/tasks?q={STAMP}", cookie=owner)
    generated = [row for row in queue_after_run.get("data", []) if row.get("title") == f"Follow due task {STAMP}"]
    check("allowlisted action creates one resource-safe administrative task", status == 200 and len(generated) == 1 and generated[0].get("resourceType") == "workspace", f"HTTP {status}: {len(generated)}")
    for _ in range(2):
        request("POST", "/api/v1/scheduler", {"action": "run", "job": "domain-jobs", "force": True}, cookie=owner)
    status, idempotent_rules, _ = request("GET", "/api/v1/automations", cookie=owner)
    status_tasks, idempotent_tasks, _ = request("GET", f"/api/v1/tasks?q={STAMP}", cookie=owner)
    check("repeated scheduler delivery does not duplicate effects", status == 200 and status_tasks == 200 and len([row for row in idempotent_rules.get("notifications", []) if row.get("title") == f"Urgent task {STAMP}"]) == 0 and idempotent_rules.get("notificationSummary", {}).get("dismissed", 0) >= 1 and len([row for row in idempotent_tasks.get("data", []) if row.get("title") == f"Follow due task {STAMP}"]) == 1, f"HTTP {status}/{status_tasks}")

    detail_status, detail, _ = request("GET", f"/api/v1/automations/{rule_id}", cookie=owner)
    current_rule = detail.get("rule", {}) if isinstance(detail, dict) else {}
    revision_payload = {
        "action": "revise", "expectedRevision": current_rule.get("revision"), "name": current_rule.get("name"), "trigger": "task.due",
        "condition": {"operator": "equals", "path": "task.priority", "value": "high"},
        "actions": [{"type": "internal_notification", "title": f"Version two {STAMP}", "message": "Version two", "severity": "information"}],
    }
    status, revised, _ = request("PATCH", f"/api/v1/automations/{rule_id}", revision_payload, cookie=owner)
    revised_rule = revised.get("rule", {}) if isinstance(revised, dict) else {}
    check("active rule revision creates version two without moving pinned version", detail_status == 200 and status == 200 and revised_rule.get("currentVersion") == 2 and revised_rule.get("activeVersion") == 1 and revised_rule.get("active") is True, f"HTTP {detail_status}/{status}")
    status, changed_trigger, _ = request("PATCH", f"/api/v1/automations/{rule_id}", {**revision_payload, "expectedRevision": revised_rule.get("revision"), "trigger": "referral.received"}, cookie=owner)
    check("active rule trigger cannot change behind pinned version", status == 400 and "pause" in message(changed_trigger).lower(), f"HTTP {status}: {message(changed_trigger)}")

    # Revision claims must have one winner when two nodes/requests race.
    race_revision = reopened.get("revision")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda to: request("PATCH", f"/api/v1/tasks/{task_id}", {"action": "transition", "to": to, "expectedRevision": race_revision}, cookie=owner), ["completed", "cancelled"]))
    codes = sorted(item[0] for item in outcomes)
    texts = " ".join(message(item[1]).lower() for item in outcomes)
    check("concurrent task transitions have one revision winner", codes == [200, 409] and all(term not in texts for term in ("sqlite", "constraint", "docs/")), f"HTTP {codes}: {texts[:160]}")

    race_rule_revision = revised_rule.get("revision")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        rule_outcomes = list(pool.map(lambda _: request("PATCH", f"/api/v1/automations/{rule_id}", {"action": "activate", "expectedRevision": race_rule_revision}, cookie=owner), range(2)))
    rule_codes = sorted(item[0] for item in rule_outcomes)
    rule_texts = " ".join(message(item[1]).lower() for item in rule_outcomes)
    check("concurrent rule activation has one revision winner", rule_codes == [200, 409] and all(term not in rule_texts for term in ("sqlite", "constraint", "docs/")), f"HTTP {rule_codes}: {rule_texts[:160]}")

    print(f"\ntasks-automations-api-check: {passes} assertions passed")
    if failures:
        print(f"tasks-automations-api-check: {len(failures)} failed — {', '.join(failures)}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
