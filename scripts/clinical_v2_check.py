#!/usr/bin/env python3
"""Production-HTTP acceptance probe for Phase 4 versioned clinical notes."""

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

checks = 0
failures: list[str] = []


def check(label: str, condition: object, detail: str = ""):
    global checks
    checks += 1
    ok = bool(condition)
    print(("PASS  " if ok else "FAIL  ") + label + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def request(method: str, path: str, body=None, cookie: str = "", bearer: str = ""):
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
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}, response.headers
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return error.code, payload, error.headers


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def login(email: str):
    status, body, headers = request("POST", "/api/auth/login", {"email": email, "password": PASSWORD})
    cookie = (headers.get("set-cookie") or "").split(";", 1)[0]
    return status, body, cookie


def main():
    owner_status, _, owner = login(EMAIL)
    check("owner session authenticates", owner_status == 200 and owner.startswith("voxera_session="), str(owner_status))
    if not owner:
        return finish()

    status, clients, _ = request("GET", "/api/v1/clients?limit=10", cookie=owner)
    client_rows = clients.get("data") or clients.get("clients") or []
    client_id = (client_rows[0] if client_rows else {}).get("id")
    check("a synthetic fixture client is available", status == 200 and bool(client_id), f"HTTP {status}")
    if not client_id:
        return finish()

    stamp = str(int(time.time() * 1000))[-8:]
    sections_v1 = [
        {"id": "presentation", "label": "Presentation", "prompt": "Clinician-authored presentation", "required": True, "kind": "long_text"},
        {"id": "record", "label": "Clinical record", "prompt": "What the clinician records", "required": True, "kind": "long_text"},
    ]
    status, created_template, _ = request("POST", "/api/v1/note-templates", {
        "action": "create", "name": f"Phase 4 API template {stamp}", "sections": sections_v1, "state": "published",
    }, cookie=owner)
    template = created_template.get("template") or {}
    template_id = template.get("id")
    check("template API creates immutable version 1", status == 201 and template.get("currentVersion") == 1 and template.get("revision") == 1, f"HTTP {status}: {message(created_template)}")

    status, template_detail, _ = request("GET", f"/api/v1/note-templates/{template_id}", cookie=owner)
    first_version = (template_detail.get("versions") or [{}])[0]
    check("template detail exposes exact version 1 schema", status == 200 and first_version.get("version") == 1 and first_version.get("sections") == sections_v1, f"HTTP {status}")

    sections_v2 = sections_v1 + [{"id": "review", "label": "Review", "prompt": "Clinician review", "required": False, "kind": "long_text"}]
    status, revised_template, _ = request("POST", "/api/v1/note-templates", {
        "action": "revise", "id": template_id, "expectedRevision": template.get("revision"),
        "name": template.get("name"), "sections": sections_v2, "changeReason": "Add explicit clinician review",
    }, cookie=owner)
    template2 = revised_template.get("template") or {}
    check("template revision creates version 2", status == 200 and template2.get("currentVersion") == 2 and template2.get("revision") == 2, f"HTTP {status}: {message(revised_template)}")
    status, history, _ = request("GET", f"/api/v1/note-templates/{template_id}", cookie=owner)
    versions = history.get("versions") or []
    check("version 1 remains byte-equivalent after version 2", status == 200 and len(versions) == 2 and versions[1].get("sections") == sections_v1, f"{len(versions)} versions")

    status, opened_body, _ = request("POST", "/api/v1/notes", {
        "action": "create", "clientId": client_id, "templateId": template_id, "title": f"Synthetic phase 4 note {stamp}",
    }, cookie=owner)
    note = opened_body.get("note") or {}
    note_id = note.get("id")
    check("draft binds to current immutable template version", status == 201 and note.get("templateVersion") == 2 and note.get("revision") == 1 and len(note.get("sections") or []) == 3, f"HTTP {status}: {message(opened_body)}")

    status, blocked, _ = request("POST", "/api/v1/notes", {
        "action": "finalise", "id": note_id, "expectedRevision": note.get("revision"),
    }, cookie=owner)
    check("blank required sections block finalisation", status == 400 and "not finished" in message(blocked).lower(), f"HTTP {status}: {message(blocked)}")

    filled = [{**section, "body": f"Synthetic clinician text for {section['label']}"} for section in note.get("sections") or []]
    status, saved_body, _ = request("POST", "/api/v1/notes", {
        "action": "update", "id": note_id, "expectedRevision": note.get("revision"), "sections": filled,
    }, cookie=owner)
    saved = saved_body.get("note") or {}
    check("draft update advances optimistic revision", status == 200 and saved.get("revision") == 2 and not saved_body.get("incomplete"), f"HTTP {status}: {message(saved_body)}")

    stale_sections = [{**section, "body": f"Preserved concurrent text for {section['label']}"} for section in note.get("sections") or []]
    status, stale, _ = request("POST", "/api/v1/notes", {
        "action": "update", "id": note_id, "expectedRevision": note.get("revision"), "sections": stale_sections,
    }, cookie=owner)
    check("stale clinical update returns HTTP 409 instead of overwriting", status == 409 and "both drafts were kept" in message(stale).lower(), f"HTTP {status}: {message(stale)}")

    status, detail, _ = request("GET", f"/api/v1/notes/{note_id}", cookie=owner)
    conflicts = detail.get("conflicts") or []
    check("losing concurrent draft is persisted for reconciliation", status == 200 and len(conflicts) == 1 and conflicts[0].get("sections", [{}])[0].get("body", "").startswith("Preserved concurrent"), f"{len(conflicts)} conflicts")
    status, reconciled_body, _ = request("POST", "/api/v1/notes", {
        "action": "resolve_conflict", "id": note_id, "conflictId": conflicts[0].get("id"),
        "resolution": "keep_current", "expectedRevision": saved.get("revision"),
    }, cookie=owner)
    reconciled = reconciled_body.get("note") or {}
    check("explicit reconciliation clears conflict without auto-merging", status == 200 and not reconciled_body.get("conflicts") and "Synthetic clinician" in reconciled.get("body", ""), f"HTTP {status}: {message(reconciled_body)}")

    status, signed_body, _ = request("POST", "/api/v1/notes", {
        "action": "finalise", "id": note_id, "expectedRevision": reconciled.get("revision"),
    }, cookie=owner)
    signed = signed_body.get("note") or {}
    signed_versions = signed_body.get("versions") or []
    check("staff session finalises with a 64-character evidence hash", status == 200 and signed.get("status") == "final" and len(signed.get("signedHash", "")) == 64, f"HTTP {status}: {message(signed_body)}")
    check("signed version reports verified integrity", len(signed_versions) == 1 and signed_versions[0].get("integrity") == "verified" and signed_versions[0].get("contentHash") == signed.get("signedHash"), json.dumps(signed_versions[:1]))

    status, rejected, _ = request("POST", "/api/v1/notes", {
        "action": "update", "id": note_id, "expectedRevision": signed.get("revision"), "sections": stale_sections,
    }, cookie=owner)
    check("final note edit is HTTP 409", status == 409 and "amend" in message(rejected).lower(), f"HTTP {status}: {message(rejected)}")

    status, key_body, _ = request("POST", "/api/v1/keys", {
        "name": f"Phase 4 API probe {stamp}", "scopes": ["clinical:read", "clinical:write"],
    }, cookie=owner)
    secret = key_body.get("secret", "")
    check("narrow clinical API key is issued", status == 201 and secret.startswith("vk_"), f"HTTP {status}: {message(key_body)}")
    status, key_draft_body, _ = request("POST", "/api/v1/notes", {
        "action": "create", "clientId": client_id, "templateId": template_id, "title": f"API-key draft {stamp}",
    }, bearer=secret)
    key_draft = key_draft_body.get("note") or {}
    check("API key may create an explicitly unsigned draft", status == 201 and key_draft.get("status") == "draft", f"HTTP {status}: {message(key_draft_body)}")
    status, key_finalise, _ = request("POST", "/api/v1/notes", {
        "action": "finalise", "id": key_draft.get("id"), "expectedRevision": key_draft.get("revision"),
    }, bearer=secret)
    check("API key cannot finalise a clinical note", status == 403 and "staff session" in message(key_finalise).lower(), f"HTTP {status}: {message(key_finalise)}")

    status, amended_body, _ = request("POST", "/api/v1/notes", {
        "action": "amend", "id": note_id, "expectedRevision": signed.get("revision"), "reason": "Correct wording after clinician review",
    }, cookie=owner)
    amended = amended_body.get("note") or {}
    check("session amendment opens note version 2", status == 200 and amended.get("status") == "draft" and amended.get("version") == 2, f"HTTP {status}: {message(amended_body)}")
    corrected = [{**section, "body": f"Corrected synthetic clinician text for {section['label']}"} for section in amended.get("sections") or []]
    status, corrected_body, _ = request("POST", "/api/v1/notes", {
        "action": "update", "id": note_id, "expectedRevision": amended.get("revision"), "sections": corrected,
    }, cookie=owner)
    corrected_note = corrected_body.get("note") or {}
    status2, resigned_body, _ = request("POST", "/api/v1/notes", {
        "action": "finalise", "id": note_id, "expectedRevision": corrected_note.get("revision"),
    }, cookie=owner)
    resigned_versions = resigned_body.get("versions") or []
    check("amended note can be explicitly re-signed", status == 200 and status2 == 200 and (resigned_body.get("note") or {}).get("version") == 2, f"HTTP {status}/{status2}")
    check("hash chain retains both verified signed versions", len(resigned_versions) == 2 and all(row.get("integrity") == "verified" for row in resigned_versions) and resigned_versions[0].get("previousHash") == resigned_versions[1].get("contentHash"), json.dumps([{k: row.get(k) for k in ("version", "integrity")} for row in resigned_versions]))

    status, access, _ = request("GET", f"/api/v1/clinical-access?resourceType=clinical_note&resourceId={urllib.parse.quote(note_id)}", cookie=owner)
    access_rows = access.get("data") or []
    check("clinical note reads create append-only clinical-access evidence", status == 200 and any(row.get("action") == "view" and row.get("patientId") == client_id for row in access_rows), f"HTTP {status}, {len(access_rows)} events")

    desk_status, _, desk = login(DESK_EMAIL)
    check("reception session authenticates", desk_status == 200 and bool(desk), str(desk_status))
    status, desk_detail, _ = request("GET", f"/api/v1/notes/{note_id}", cookie=desk)
    check("reception cannot open clinical note content", status == 403 and "clinical content" in message(desk_detail).lower(), f"HTTP {status}: {message(desk_detail)}")
    status, desk_list, _ = request("GET", f"/api/v1/notes?clientId={urllib.parse.quote(client_id)}", cookie=desk)
    desk_rows = desk_list.get("data") or []
    target = next((row for row in desk_rows if row.get("id") == note_id), {})
    check("reception list exposes administrative status but no clinical text", status == 200 and target.get("restricted") is True and "body" not in target and "preview" not in target and target.get("title") == "Clinical note", f"HTTP {status}")

    finish()


def finish():
    print()
    if failures:
        print(f"{len(failures)} FAILED of {checks}: " + "; ".join(failures))
        sys.exit(1)
    print(f"Phase 4 clinical v2 API check passed: {checks}/{checks}")


if __name__ == "__main__":
    main()
