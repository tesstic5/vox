#!/usr/bin/env python3
"""Two-node HTTP race gate for body-chart CAS and signed evidence."""

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
with open(os.environ["VOXERA_BODY_CHART_SEED_OUT"], encoding="utf-8") as seed_file:
    SEED = json.load(seed_file)

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


def make_reviewed_note(cookie, client_id, template_id, title):
    status, opened = call(A, "POST", "/api/v1/notes", {
        "action": "create", "clientId": client_id, "templateId": template_id, "title": title,
    }, cookie=cookie)
    if status != 201:
        raise RuntimeError(f"note create failed: {status} {message(opened)}")
    note = opened["note"]
    sections = [
        {**section, "body": "Reviewed synthetic race text" if section.get("id") == "record" else ""}
        for section in note.get("sections", [])
    ]
    status, saved = call(A, "POST", "/api/v1/notes", {
        "action": "update", "id": note["id"], "expectedRevision": note["revision"], "sections": sections,
    }, cookie=cookie)
    if status != 200:
        raise RuntimeError(f"note update failed: {status} {message(saved)}")
    return saved["note"]


def main():
    req = urllib.request.Request(
        A + "/api/auth/login",
        data=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        cookie = (response.headers.get("set-cookie") or "").split(";", 1)[0]
    check("node A authenticates a shared staff session", bool(cookie), cookie.split("=", 1)[0] if cookie else "missing")
    status, me = call(B, "GET", "/api/auth/me", cookie=cookie)
    check("node B observes node A session", status == 200 and bool(me.get("user")), f"HTTP {status}")

    status, clients = call(A, "GET", "/api/v1/clients?limit=5", cookie=cookie)
    client_id = ((clients.get("data") or [{}])[0]).get("id")
    check("race fixture has a synthetic client", status == 200 and client_id, f"HTTP {status}")
    if not client_id:
        return finish()

    stamp = str(int(time.time() * 1000))[-8:]
    sections = [
        {"id": "record", "label": "Clinical record", "kind": "long_text", "required": True},
        {"id": "body_map", "label": "Body map", "kind": "body_chart", "required": True},
    ]
    status, made = call(A, "POST", "/api/v1/note-templates", {
        "action": "create", "name": f"Chart race template {stamp}", "sections": sections, "state": "published",
    }, cookie=cookie)
    template = made.get("template") or {}
    check("race note template freezes a required chart slot", status == 201 and template.get("sections", [{}, {}])[1].get("kind") == "body_chart", f"HTTP {status}: {message(made)}")

    reviewed = make_reviewed_note(cookie, client_id, template["id"], f"Chart create race {stamp}")
    create_payload = {
        "action": "create", "templateId": SEED["templateId"], "sectionId": "body_map",
        "expectedNoteRevision": reviewed["revision"], "marks": [],
    }
    create_results = race(
        lambda: call(A, "POST", f"/api/v1/notes/{reviewed['id']}/body-charts", create_payload, cookie=cookie),
        lambda: call(B, "POST", f"/api/v1/notes/{reviewed['id']}/body-charts", create_payload, cookie=cookie),
    )
    create_statuses = sorted(result[0] for result in create_results)
    check("concurrent chart creation has one atomic winner", create_statuses == [201, 409], str(create_statuses))
    winner = next((body for status, body in create_results if status == 201), {})
    annotation = winner.get("annotation") or {}
    note_revision = winner.get("noteRevision")
    status, chart_detail = call(B, "GET", f"/api/v1/notes/{reviewed['id']}/body-charts", cookie=cookie)
    check("chart-create race leaves exactly one linked annotation", status == 200 and len(chart_detail.get("data") or []) == 1 and (chart_detail.get("data") or [{}])[0].get("id") == annotation.get("id"), f"HTTP {status}")

    marks_a = [{"id": "node_a", "type": "point", "x": .2, "y": .3, "color": "#dc2626", "size": 8}]
    marks_b = [{"id": "node_b", "type": "point", "x": .8, "y": .7, "color": "#2563eb", "size": 9}]
    update_base = {
        "action": "update", "annotationId": annotation["id"], "expectedRevision": annotation["revision"],
        "expectedNoteRevision": note_revision,
    }
    update_results = race(
        lambda: call(A, "POST", f"/api/v1/notes/{reviewed['id']}/body-charts", {**update_base, "marks": marks_a}, cookie=cookie),
        lambda: call(B, "POST", f"/api/v1/notes/{reviewed['id']}/body-charts", {**update_base, "marks": marks_b}, cookie=cookie),
    )
    update_statuses = sorted(result[0] for result in update_results)
    check("concurrent chart saves produce one winner and one preserved loser", update_statuses == [200, 409], str(update_statuses))
    status, chart_detail = call(A, "GET", f"/api/v1/notes/{reviewed['id']}/body-charts", cookie=cookie)
    current = (chart_detail.get("data") or [{}])[0]
    conflicts = chart_detail.get("conflicts") or []
    current_id = ((current.get("marks") or [{}])[0]).get("id")
    losing_id = ((conflicts[0].get("marks") or [{}])[0]).get("id") if conflicts else None
    check("cross-node loser remains available without merging marks", status == 200 and len(conflicts) == 1 and {current_id, losing_id} == {"node_a", "node_b"}, f"current={current_id}, loser={losing_id}")
    status, note_detail = call(B, "GET", f"/api/v1/notes/{reviewed['id']}", cookie=cookie)
    current_note = note_detail.get("note") or {}
    status, resolved_body = call(A, "POST", f"/api/v1/notes/{reviewed['id']}/body-charts", {
        "action": "resolve_conflict", "annotationId": current["id"], "conflictId": conflicts[0]["id"],
        "expectedRevision": current["revision"], "expectedNoteRevision": current_note["revision"], "resolution": "keep_current",
    }, cookie=cookie)
    resolved = resolved_body.get("annotation") or {}
    resolved_note_revision = resolved_body.get("noteRevision")
    check("explicit cross-node reconciliation clears the preserved set", status == 200 and not resolved_body.get("conflicts") and (resolved.get("marks") or [{}])[0].get("id") == current_id, f"HTTP {status}: {message(resolved_body)}")

    finalise_payload = {"action": "finalise", "id": reviewed["id"], "expectedRevision": resolved_note_revision}
    edit_payload = {
        "action": "update", "annotationId": resolved["id"], "expectedRevision": resolved["revision"],
        "expectedNoteRevision": resolved_note_revision,
        "marks": [{"id": "finalise_edit", "type": "point", "x": .45, "y": .55, "color": "#7c3aed", "size": 10}],
    }
    finalise_edit = race(
        lambda: call(A, "POST", "/api/v1/notes", finalise_payload, cookie=cookie),
        lambda: call(B, "POST", f"/api/v1/notes/{reviewed['id']}/body-charts", edit_payload, cookie=cookie),
    )
    finalise_edit_statuses = sorted(result[0] for result in finalise_edit)
    check("chart edit versus note finalise has one atomic winner", finalise_edit_statuses == [200, 409], str(finalise_edit_statuses))
    status, note_after = call(A, "GET", f"/api/v1/notes/{reviewed['id']}", cookie=cookie)
    status_chart, chart_after = call(B, "GET", f"/api/v1/notes/{reviewed['id']}/body-charts", cookie=cookie)
    final_note = note_after.get("note") or {}
    final_charts = chart_after.get("data") or []
    chart_versions = chart_after.get("versions") or []
    if final_note.get("status") == "final":
        coherent = (
            len(note_after.get("versions") or []) == 1
            and len(chart_versions) == 1
            and chart_versions[0].get("integrity") == "verified"
            and final_charts[0].get("lastSnapshotHash") == chart_versions[0].get("contentHash")
            and (note_after.get("versions") or [{}])[0].get("bodyCharts", [{}])[0].get("contentHash") == chart_versions[0].get("contentHash")
        )
    else:
        coherent = (
            final_note.get("status") == "draft"
            and not note_after.get("versions")
            and not chart_versions
            and ((final_charts[0].get("marks") or [{}])[0]).get("id") == "finalise_edit"
        )
    check("finalise-edit result keeps note, chart and hashes coherent", status == 200 and status_chart == 200 and coherent, f"note={final_note.get('status')} chartVersions={len(chart_versions)}")

    second = make_reviewed_note(cookie, client_id, template["id"], f"Chart double finalise {stamp}")
    status, second_chart_body = call(A, "POST", f"/api/v1/notes/{second['id']}/body-charts", {
        "action": "create", "templateId": SEED["templateId"], "sectionId": "body_map",
        "expectedNoteRevision": second["revision"],
        "marks": [{"id": "double_sign", "type": "point", "x": .5, "y": .5, "color": "#059669", "size": 8}],
    }, cookie=cookie)
    second_note_revision = second_chart_body.get("noteRevision")
    check("second race note has linked chart evidence", status == 201 and second_note_revision == second["revision"] + 1, f"HTTP {status}")
    sign_payload = {"action": "finalise", "id": second["id"], "expectedRevision": second_note_revision}
    double_sign = race(
        lambda: call(A, "POST", "/api/v1/notes", sign_payload, cookie=cookie),
        lambda: call(B, "POST", "/api/v1/notes", sign_payload, cookie=cookie),
    )
    sign_statuses = sorted(result[0] for result in double_sign)
    check("double finalise with a chart has one winner", sign_statuses == [200, 409], str(sign_statuses))
    status, second_detail = call(B, "GET", f"/api/v1/notes/{second['id']}", cookie=cookie)
    status_chart, second_charts = call(A, "GET", f"/api/v1/notes/{second['id']}/body-charts", cookie=cookie)
    note_versions = second_detail.get("versions") or []
    snapshots = second_charts.get("versions") or []
    evidence_hash = (note_versions[0].get("bodyCharts") or [{}])[0].get("contentHash") if note_versions else None
    check("double finalise emits one verified note and chart snapshot", status == 200 and status_chart == 200 and len(note_versions) == 1 and len(snapshots) == 1 and snapshots[0].get("integrity") == "verified" and evidence_hash == snapshots[0].get("contentHash"), f"notes={len(note_versions)} charts={len(snapshots)}")

    finish()


def finish():
    print()
    if failures:
        print(f"{len(failures)} FAILED of {checks}: " + "; ".join(failures))
        sys.exit(1)
    print(f"Phase 4 body-chart two-node race check passed: {checks}/{checks}")


if __name__ == "__main__":
    main()
