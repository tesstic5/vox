#!/usr/bin/env python3
"""Production-HTTP acceptance probe for Phase 4 body-chart evidence."""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3300").rstrip("/")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = os.environ.get("VOXERA_DESK_EMAIL", "desk@northwind.dev")
with open(os.environ["VOXERA_BODY_CHART_SEED_OUT"], encoding="utf-8") as seed_file:
    SEED = json.load(seed_file)
checks = 0
failures: list[str] = []


def check(label: str, condition: object, detail: str = ""):
    global checks
    checks += 1
    ok = bool(condition)
    print(("PASS  " if ok else "FAIL  ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def request(method: str, path: str, body=None, cookie: str = "", bearer: str = "", raw: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    if bearer:
        req.add_header("authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            payload = response.read()
            if raw:
                return response.status, payload, response.headers
            return response.status, json.loads(payload.decode()) if payload else {}, response.headers
    except urllib.error.HTTPError as error:
        payload = error.read()
        if raw:
            return error.code, payload, error.headers
        try:
            parsed = json.loads(payload.decode()) if payload else {}
        except json.JSONDecodeError:
            parsed = {"raw": payload.decode(errors="replace")}
        return error.code, parsed, error.headers


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def login(email: str):
    status, _, headers = request("POST", "/api/auth/login", {"email": email, "password": PASSWORD})
    return status, (headers.get("set-cookie") or "").split(";", 1)[0]


def main():
    status, owner = login(EMAIL)
    check("owner session authenticates", status == 200 and owner.startswith("voxera_session="), str(status))
    status, clients, _ = request("GET", "/api/v1/clients?limit=10", cookie=owner)
    rows = clients.get("data") or clients.get("clients") or []
    client_id = (rows[0] if rows else {}).get("id")
    check("synthetic fixture client is available", status == 200 and client_id, f"HTTP {status}")
    if not client_id:
        return finish()

    status, templates, _ = request("GET", "/api/v1/body-chart-templates", cookie=owner)
    template = next((row for row in templates.get("data", []) if row.get("id") == SEED["templateId"]), {})
    check("published body-chart template is scoped and listed", status == 200 and template.get("state") == "published" and template.get("coordinateSystem") == "normalised_0_1", f"HTTP {status}")
    status, image, headers = request("GET", f"/api/v1/body-chart-templates/{SEED['templateId']}/source", cookie=owner, raw=True)
    check("pinned source image is scanner-gated and served inline", status == 200 and image.startswith(b"\x89PNG\r\n\x1a\n") and headers.get_content_type() == "image/png" and "inline" in (headers.get("content-disposition") or ""), f"HTTP {status}")
    check("source response is private, nosniff and same-origin", "no-store" in (headers.get("cache-control") or "") and headers.get("x-content-type-options") == "nosniff" and headers.get("cross-origin-resource-policy") == "same-origin")

    stamp = str(int(time.time() * 1000))[-8:]
    schema = [
        {"id": "assessment", "label": "Assessment", "kind": "long_text", "required": True},
        {"id": "body_map", "label": "Body map", "kind": "body_chart", "required": True},
    ]
    status, made_template, _ = request("POST", "/api/v1/note-templates", {"action": "create", "name": f"Body chart API {stamp}", "sections": schema, "state": "published"}, cookie=owner)
    note_template = made_template.get("template") or {}
    check("note-template API accepts an immutable body-chart slot", status == 201 and note_template.get("sections", [{}, {}])[1].get("kind") == "body_chart", f"HTTP {status}: {message(made_template)}")
    status, opened, _ = request("POST", "/api/v1/notes", {"action": "create", "clientId": client_id, "templateId": note_template.get("id"), "title": f"Synthetic chart note {stamp}"}, cookie=owner)
    note = opened.get("note") or {}
    note_id = note.get("id")
    check("draft freezes the body-chart slot", status == 201 and note_id and note.get("sections", [{}, {}])[1].get("kind") == "body_chart", f"HTTP {status}: {message(opened)}")
    sections = [{**row, "body": "Clinician-authored factual assessment" if row.get("id") == "assessment" else "browser text must be ignored"} for row in note.get("sections", [])]
    status, saved_body, _ = request("POST", "/api/v1/notes", {"action": "update", "id": note_id, "expectedRevision": note.get("revision"), "sections": sections}, cookie=owner)
    saved = saved_body.get("note") or {}
    chart_section = next((row for row in saved.get("sections", []) if row.get("id") == "body_map"), {})
    check("body-chart slot cannot be smuggled into free text", status == 200 and chart_section.get("body") == "" and "Body map" in (saved_body.get("incomplete") or []), f"HTTP {status}")
    status, blocked, _ = request("POST", "/api/v1/notes", {"action": "finalise", "id": note_id, "expectedRevision": saved.get("revision")}, cookie=owner)
    check("required empty body chart blocks signing", status == 400 and "body map" in message(blocked).lower(), f"HTTP {status}: {message(blocked)}")

    status, key_body, _ = request("POST", "/api/v1/keys", {"name": f"Body chart key {stamp}", "scopes": ["clinical:read", "clinical:write"]}, cookie=owner)
    secret = key_body.get("secret", "")
    check("narrow clinical API key is issued", status == 201 and secret.startswith("vk_"), f"HTTP {status}")
    status, key_write, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "create", "templateId": SEED["templateId"], "sectionId": "body_map", "expectedNoteRevision": saved.get("revision"), "marks": []}, bearer=secret)
    check("API key cannot write clinician-authored body-chart evidence", status == 403 and "staff session" in message(key_write).lower(), f"HTTP {status}: {message(key_write)}")

    status, created_body, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "create", "templateId": SEED["templateId"], "sectionId": "body_map", "expectedNoteRevision": saved.get("revision"), "marks": []}, cookie=owner)
    annotation = created_body.get("annotation") or {}
    note_revision = created_body.get("noteRevision")
    check("session creates chart and atomically advances parent note revision", status == 201 and annotation.get("revision") == 1 and note_revision == saved.get("revision") + 1 and not created_body.get("incomplete"), f"HTTP {status}: {message(created_body)}")

    unsafe_marks = [{"id": "label_bad", "type": "label", "x": .5, "y": .5, "text": "<script>alert(1)</script>", "color": "#dc2626"}]
    status, unsafe, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "update", "annotationId": annotation.get("id"), "expectedRevision": annotation.get("revision"), "expectedNoteRevision": note_revision, "marks": unsafe_marks}, cookie=owner)
    check("unsafe label content is rejected", status == 400 and "unsafe text" in message(unsafe).lower(), f"HTTP {status}: {message(unsafe)}")
    marks = [
        {"id": "point_1", "type": "point", "x": .125, "y": .875, "color": "#DC2626", "size": 9},
        {"id": "stroke_1", "type": "stroke", "points": [{"x": 0, "y": 0}, {"x": .25, "y": .5}, {"x": 1, "y": 1}], "color": "#2563eb", "width": 4},
        {"id": "label_1", "type": "label", "x": .55, "y": .45, "text": "Tender area & review", "color": "#059669"},
    ]
    status, updated_body, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "update", "annotationId": annotation.get("id"), "expectedRevision": annotation.get("revision"), "expectedNoteRevision": note_revision, "marks": marks}, cookie=owner)
    updated = updated_body.get("annotation") or {}
    updated_note_revision = updated_body.get("noteRevision")
    check("points, strokes and labels round-trip normalised coordinates", status == 200 and updated.get("marks", [])[0].get("x") == .125 and updated.get("marks", [])[1].get("points", [])[-1].get("x") == 1 and updated.get("marks", [])[0].get("color") == "#dc2626", f"HTTP {status}: {message(updated_body)}")

    losing = [{"id": "point_loser", "type": "point", "x": .9, "y": .1, "color": "#111111", "size": 8}]
    status, stale, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "update", "annotationId": annotation.get("id"), "expectedRevision": annotation.get("revision"), "expectedNoteRevision": note_revision, "marks": losing}, cookie=owner)
    check("stale chart save returns HTTP 409 and keeps both sets", status == 409 and "both annotation sets" in message(stale).lower(), f"HTTP {status}: {message(stale)}")
    status, chart_detail, _ = request("GET", f"/api/v1/notes/{note_id}/body-charts", cookie=owner)
    conflicts = chart_detail.get("conflicts") or []
    check("losing annotation set is retrievable for reconciliation", status == 200 and len(conflicts) == 1 and conflicts[0].get("marks", [{}])[0].get("id") == "point_loser", f"{len(conflicts)} conflict(s)")
    status, blocked_conflict, _ = request("POST", "/api/v1/notes", {"action": "finalise", "id": note_id, "expectedRevision": updated_note_revision}, cookie=owner)
    check("unresolved annotation conflict blocks signing", status == 409 and "body chart" in message(blocked_conflict).lower(), f"HTTP {status}: {message(blocked_conflict)}")

    status, resolved_body, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "resolve_conflict", "annotationId": updated.get("id"), "conflictId": conflicts[0].get("id"), "expectedRevision": updated.get("revision"), "expectedNoteRevision": updated_note_revision, "resolution": "keep_current"}, cookie=owner)
    resolved = resolved_body.get("annotation") or {}
    resolved_note_revision = resolved_body.get("noteRevision")
    check("clinician explicitly reconciles concurrent marks", status == 200 and resolved.get("marks", [])[0].get("id") == "point_1" and not resolved_body.get("conflicts"), f"HTTP {status}: {message(resolved_body)}")

    status, exported, export_headers = request("GET", f"/api/v1/notes/{note_id}/body-charts?annotationId={urllib.parse.quote(resolved.get('id'))}&format=json", cookie=owner, raw=True)
    structured = json.loads(exported.decode()) if status == 200 else {}
    check("structured export is a private attachment with exact coordinates", status == 200 and structured.get("schema") == "voxera.body-chart.normalised.v1" and structured.get("marks", [])[0].get("x") == .125 and "attachment" in (export_headers.get("content-disposition") or ""), f"HTTP {status}")
    status, overlay, overlay_headers = request("GET", f"/api/v1/notes/{note_id}/body-charts?annotationId={urllib.parse.quote(resolved.get('id'))}&format=svg", cookie=owner, raw=True)
    overlay_text = overlay.decode(errors="replace")
    check("safe SVG export escapes labels and carries no script or external reference", status == 200 and "Tender area &amp; review" in overlay_text and "<script" not in overlay_text and "href=" not in overlay_text and "sandbox" in (overlay_headers.get("content-security-policy") or ""), f"HTTP {status}")

    status, signed_body, _ = request("POST", "/api/v1/notes", {"action": "finalise", "id": note_id, "expectedRevision": resolved_note_revision}, cookie=owner)
    signed = signed_body.get("note") or {}
    note_versions = signed_body.get("versions") or []
    chart_evidence = (note_versions[0].get("bodyCharts") or [{}])[0] if note_versions else {}
    check("note signing binds body-chart SHA-256 evidence", status == 200 and signed.get("status") == "final" and len(chart_evidence.get("contentHash", "")) == 64, f"HTTP {status}: {message(signed_body)}")
    status, final_charts, _ = request("GET", f"/api/v1/notes/{note_id}/body-charts", cookie=owner)
    chart_versions = final_charts.get("versions") or []
    final_annotation = (final_charts.get("data") or [{}])[0]
    check("signed chart snapshot verifies and current chart is read-only", status == 200 and final_annotation.get("status") == "final" and len(chart_versions) == 1 and chart_versions[0].get("integrity") == "verified" and chart_versions[0].get("contentHash") == chart_evidence.get("contentHash"), json.dumps(chart_versions[:1]))
    status, final_edit, _ = request("POST", f"/api/v1/notes/{note_id}/body-charts", {"action": "update", "annotationId": final_annotation.get("id"), "expectedRevision": final_annotation.get("revision"), "expectedNoteRevision": signed.get("revision"), "marks": []}, cookie=owner)
    check("final chart cannot be edited", status == 409 and "signed evidence" in message(final_edit).lower(), f"HTTP {status}: {message(final_edit)}")

    status, subject_bytes, _ = request("GET", f"/api/v1/clients/{client_id}/export", cookie=owner, raw=True)
    subject = json.loads(subject_bytes.decode()) if status == 200 else {}
    check("complete client export includes chart, signed version and source manifest", status == 200 and len((subject.get("bodyCharts") or {}).get("annotations", [])) >= 1 and len((subject.get("bodyCharts") or {}).get("versions", [])) >= 1 and SEED["sourceDocumentId"] in json.dumps(subject.get("bodyChartSourceDocuments") or {}), f"HTTP {status}")

    status, access, _ = request("GET", f"/api/v1/clinical-access?resourceType=clinical_note&resourceId={urllib.parse.quote(note_id)}", cookie=owner)
    events = access.get("data") or []
    check("chart reads and writes create patient-linked clinical access events", status == 200 and any(row.get("patientId") == client_id and row.get("action") == "view" for row in events) and any(row.get("patientId") == client_id and row.get("action") == "update" for row in events), f"{len(events)} event(s)")

    desk_status, desk = login(DESK_EMAIL)
    check("reception session authenticates", desk_status == 200 and bool(desk), str(desk_status))
    status, denied, _ = request("GET", f"/api/v1/notes/{note_id}/body-charts", cookie=desk)
    check("reception cannot read body-chart clinical content", status == 403, f"HTTP {status}: {message(denied)}")

    finish()


def finish():
    print()
    if failures:
        print(f"{len(failures)} FAILED of {checks}: " + "; ".join(failures))
        sys.exit(1)
    print(f"Phase 4 body-chart API check passed: {checks}/{checks}")


if __name__ == "__main__":
    main()
