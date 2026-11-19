#!/usr/bin/env python3
"""Two-node HTTP race gate for Phase 4 clinical notes and template versions."""

import concurrent.futures
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

A = os.environ.get("VOXERA_ORIGIN_A", "http://127.0.0.1:3301").rstrip("/")
B = os.environ.get("VOXERA_ORIGIN_B", "http://127.0.0.1:3302").rstrip("/")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

checks = 0
failures: list[str] = []


def check(label, condition, detail=""):
    global checks
    checks += 1
    ok = bool(condition)
    print(("PASS  " if ok else "FAIL  ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(base, method, path, body=None, cookie=""):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return error.code, {"raw": raw}


def message(body):
    return body.get("error", {}).get("message", "") if isinstance(body, dict) else str(body)


def race(left, right):
    barrier = threading.Barrier(2)

    def run(work):
        barrier.wait(timeout=10)
        return work()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, left), pool.submit(run, right)]
        return [future.result(timeout=120) for future in futures]


def main():
    status, login = call(A, "POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    # Login helper needs response headers, so issue one raw request here.
    req = urllib.request.Request(A + "/api/auth/login", data=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(), method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        cookie = (response.headers.get("set-cookie") or "").split(";", 1)[0]
    check("shared session authenticates on node A", status == 200 and bool(cookie), str(status))
    status_b, me_b = call(B, "GET", "/api/auth/me", cookie=cookie)
    check("node B observes node A session", status_b == 200 and bool(me_b.get("user")), f"HTTP {status_b}")

    status, clients = call(A, "GET", "/api/v1/clients?limit=5", cookie=cookie)
    client_id = ((clients.get("data") or [{}])[0]).get("id")
    check("race fixture has a client", status == 200 and bool(client_id), f"HTTP {status}")
    if not client_id:
        return finish()

    stamp = str(int(time.time() * 1000))[-8:]
    sections = [
        {"id": "record", "label": "Clinical record", "prompt": "Synthetic race text", "required": True, "kind": "long_text"},
        {"id": "plan", "label": "Plan", "prompt": "Clinician-authored plan", "required": True, "kind": "long_text"},
    ]
    status, template_body = call(A, "POST", "/api/v1/note-templates", {"action": "create", "name": f"Race template {stamp}", "sections": sections}, cookie=cookie)
    template = template_body.get("template") or {}
    check("race template created", status == 201 and template.get("revision") == 1, f"HTTP {status}: {message(template_body)}")

    revise_payload_a = {"action": "revise", "id": template.get("id"), "expectedRevision": 1, "sections": sections + [{"id": "a", "label": "A", "kind": "long_text"}], "changeReason": "Concurrent revision A"}
    revise_payload_b = {"action": "revise", "id": template.get("id"), "expectedRevision": 1, "sections": sections + [{"id": "b", "label": "B", "kind": "long_text"}], "changeReason": "Concurrent revision B"}
    template_race = race(
        lambda: call(A, "POST", "/api/v1/note-templates", revise_payload_a, cookie=cookie),
        lambda: call(B, "POST", "/api/v1/note-templates", revise_payload_b, cookie=cookie),
    )
    template_statuses = sorted(result[0] for result in template_race)
    check("concurrent template revision has one winner", template_statuses == [200, 409], str(template_statuses))
    status, template_detail = call(B, "GET", f"/api/v1/note-templates/{template.get('id')}", cookie=cookie)
    versions = template_detail.get("versions") or []
    check("template race creates exactly one immutable version 2", status == 200 and len(versions) == 2 and versions[0].get("version") == 2, f"HTTP {status}, {len(versions)} versions")

    status, opened_body = call(A, "POST", "/api/v1/notes", {"action": "create", "clientId": client_id, "templateId": template.get("id"), "title": f"Race note {stamp}"}, cookie=cookie)
    note = opened_body.get("note") or {}
    check("race note created on node A", status == 201 and note.get("revision") == 1, f"HTTP {status}: {message(opened_body)}")
    filled_a = [{**section, "body": f"Node A text for {section['label']}"} for section in note.get("sections") or []]
    filled_b = [{**section, "body": f"Node B text for {section['label']}"} for section in note.get("sections") or []]
    update_payload_a = {"action": "update", "id": note.get("id"), "expectedRevision": 1, "sections": filled_a}
    update_payload_b = {"action": "update", "id": note.get("id"), "expectedRevision": 1, "sections": filled_b}
    update_race = race(
        lambda: call(A, "POST", "/api/v1/notes", update_payload_a, cookie=cookie),
        lambda: call(B, "POST", "/api/v1/notes", update_payload_b, cookie=cookie),
    )
    update_statuses = sorted(result[0] for result in update_race)
    check("concurrent clinical text save has one winner", update_statuses == [200, 409], str(update_statuses))
    status, after_update = call(A, "GET", f"/api/v1/notes/{note.get('id')}", cookie=cookie)
    current = after_update.get("note") or {}
    conflicts = after_update.get("conflicts") or []
    check("losing text is preserved and current text is not merged", status == 200 and len(conflicts) == 1 and ("Node A text" in current.get("body", "")) != ("Node B text" in current.get("body", "")), f"HTTP {status}, {len(conflicts)} conflicts")
    if not conflicts:
        return finish()
    status, resolved_body = call(A, "POST", "/api/v1/notes", {"action": "resolve_conflict", "id": current.get("id"), "conflictId": conflicts[0].get("id"), "resolution": "keep_current", "expectedRevision": current.get("revision")}, cookie=cookie)
    current = resolved_body.get("note") or {}
    check("race conflict requires and accepts explicit reconciliation", status == 200 and not resolved_body.get("conflicts"), f"HTTP {status}: {message(resolved_body)}")

    finalise_payload = {"action": "finalise", "id": current.get("id"), "expectedRevision": current.get("revision")}
    double_finalise = race(
        lambda: call(A, "POST", "/api/v1/notes", finalise_payload, cookie=cookie),
        lambda: call(B, "POST", "/api/v1/notes", finalise_payload, cookie=cookie),
    )
    finalise_statuses = sorted(result[0] for result in double_finalise)
    check("double finalise has one winner", finalise_statuses == [200, 409], str(finalise_statuses))
    winner = next((result[1] for result in double_finalise if result[0] == 200), {})
    signed = winner.get("note") or {}
    check("double-finalise winner has one evidence hash", len(signed.get("signedHash", "")) == 64 and len(winner.get("versions") or []) == 1, json.dumps(finalise_statuses))

    # A separate note races a clinical edit against finalisation from the same
    # reviewed revision. Exactly one command may commit.
    status, second_opened = call(A, "POST", "/api/v1/notes", {"action": "create", "clientId": client_id, "templateId": template.get("id"), "title": f"Finalise-edit race {stamp}"}, cookie=cookie)
    second = second_opened.get("note") or {}
    second_filled = [{**section, "body": f"Reviewed text for {section['label']}"} for section in second.get("sections") or []]
    status, second_saved = call(A, "POST", "/api/v1/notes", {"action": "update", "id": second.get("id"), "expectedRevision": second.get("revision"), "sections": second_filled}, cookie=cookie)
    reviewed = second_saved.get("note") or {}
    edited = [{**section, "body": f"Competing edit for {section['label']}"} for section in reviewed.get("sections") or []]
    finalise_edit = race(
        lambda: call(A, "POST", "/api/v1/notes", {"action": "finalise", "id": reviewed.get("id"), "expectedRevision": reviewed.get("revision")}, cookie=cookie),
        lambda: call(B, "POST", "/api/v1/notes", {"action": "update", "id": reviewed.get("id"), "expectedRevision": reviewed.get("revision"), "sections": edited}, cookie=cookie),
    )
    finalise_edit_statuses = sorted(result[0] for result in finalise_edit)
    check("finalise-versus-edit has one atomic winner", finalise_edit_statuses == [200, 409], str(finalise_edit_statuses))
    status, second_detail = call(B, "GET", f"/api/v1/notes/{reviewed.get('id')}", cookie=cookie)
    final_note = second_detail.get("note") or {}
    final_versions = second_detail.get("versions") or []
    if final_note.get("status") == "final":
        coherent = len(final_versions) == 1 and final_versions[0].get("integrity") == "verified" and final_versions[0].get("body") == final_note.get("body")
    else:
        coherent = final_note.get("status") == "draft" and not final_versions and final_note.get("revision") == reviewed.get("revision") + 1
    check("finalise-edit result is internally coherent", status == 200 and coherent, f"status={final_note.get('status')} versions={len(final_versions)} revision={final_note.get('revision')}")

    finish()


def finish():
    print()
    if failures:
        print(f"{len(failures)} FAILED of {checks}: " + "; ".join(failures))
        sys.exit(1)
    print(f"Phase 4 clinical two-node race check passed: {checks}/{checks}")


if __name__ == "__main__":
    main()
