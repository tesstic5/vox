#!/usr/bin/env python3
"""Live HTTP boundary check for the Phase 1 clinical foundation.

Run against a fresh, synthetic fixture only. It changes that fixture to
synthetic-test mode, migrates its legacy metadata and creates synthetic records.
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000").rstrip("/")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
STAMP = secrets.token_hex(5)

passes = 0
failures: list[str] = []
cookie = ""


def check(label: str, condition: object, detail: object = "") -> None:
    global passes
    if condition:
        passes += 1
        print(f"PASS  {label}" + (f" — {detail}" if detail != "" else ""))
    else:
        failures.append(label)
        print(f"FAIL  {label}" + (f" — {detail}" if detail != "" else ""))


def call(method: str, path: str, body: object | None = None, *, token: str | None = None,
         headers: dict[str, str] | None = None, raw: bytes | None = None):
    global cookie
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("x-forwarded-for", "198.51.100.88")
    if raw is None and body is not None:
        req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    elif cookie:
        req.add_header("cookie", cookie)
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            payload_bytes = res.read()
            set_cookie = res.headers.get("set-cookie")
            if set_cookie and not token:
                cookie = set_cookie.split(";", 1)[0]
            try:
                payload = json.loads(payload_bytes or b"{}")
            except json.JSONDecodeError:
                payload = payload_bytes.decode("utf-8", "replace")
            return res.status, payload, dict(res.headers)
    except urllib.error.HTTPError as err:
        payload_bytes = err.read()
        try:
            payload = json.loads(payload_bytes or b"{}")
        except json.JSONDecodeError:
            payload = payload_bytes.decode("utf-8", "replace")
        return err.code, payload, dict(err.headers)


def message(payload: object) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error)
    return str(payload)[:180]


def keys(value: object):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from keys(child)


def mint(name: str, scopes: list[str]) -> str:
    status, payload, _ = call("POST", "/api/v1/keys", {"name": f"{name}-{STAMP}", "scopes": scopes})
    check(f"API key can be minted for {name}", status == 201 and isinstance(payload, dict) and bool(payload.get("secret")), f"HTTP {status}")
    return str(payload.get("secret", "")) if isinstance(payload, dict) else ""


def main() -> None:
    global cookie
    status, payload, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("synthetic fixture owner signs in", status == 200, f"HTTP {status} {message(payload)}")
    if status != 200:
        raise SystemExit(1)

    status, clients, _ = call("GET", "/api/v1/clients?limit=5")
    rows = clients.get("data", []) if isinstance(clients, dict) else []
    patient_id = str(rows[0].get("id", "")) if rows else ""
    second_patient_id = str(rows[1].get("id", "")) if len(rows) > 1 else ""
    check("typed client API supplies synthetic patients for scoped boundary checks", status == 200 and bool(patient_id) and bool(second_patient_id), f"HTTP {status}")

    status, blocked_contact, _ = call(
        "POST", f"/api/v1/clients/{patient_id}/contacts",
        {"kind": "email", "label": "work", "value": f"blocked-{STAMP}@example.test"},
    )
    check("disabled clinical mode blocks contact-point writes", status == 403 and "disabled" in message(blocked_contact).lower(), f"HTTP {status} {message(blocked_contact)}")

    status, migration, _ = call("POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"})
    check("confirmed HTTP migration completes every Phase 1 data migration", status == 200 and migration.get("completed") == migration.get("total") and migration.get("total", 0) >= 6, f"HTTP {status} {migration.get('completed') if isinstance(migration, dict) else '?'}")

    status, mode, _ = call("POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"})
    check("owner can enable synthetic-test mode without claiming live readiness", status == 200 and mode.get("profile", {}).get("operatingMode") == "synthetic_test" and mode.get("readiness", {}).get("readyForLive") is False, f"HTTP {status}")

    status, me, _ = call("GET", "/api/auth/me")
    owner_id = str((me.get("user") or {}).get("id", "")) if isinstance(me, dict) else ""
    status, profile, _ = call("GET", "/api/v1/privacy/profile")
    profile_revision = int(profile.get("revision", 0)) if isinstance(profile, dict) else -1
    audit_cutover = profile.get("auditCompleteFromAt") if isinstance(profile, dict) else None
    status, profile, _ = call("PUT", "/api/v1/privacy/profile", {
        "expectedRevision": profile_revision,
        "controllerName": "Synthetic Phase 1 Controller Ltd",
        "controllerAddress": "1 Synthetic Street, London",
        "controllerContactEmail": "privacy@example.test",
        "privacyNoticeVersion": "synthetic-v1",
        "privacyNoticeUrl": "https://example.test/privacy",
        "dpiaReference": "SYNTHETIC-DPIA-1",
        "dpiaStatus": "approved_by_controller",
        "dpiaReviewedAt": "2026-09-20",
        "dpiaReviewedBy": "Synthetic Controller",
        "auditCompleteFromAt": audit_cutover,
        "breakGlassEnabled": True,
        "breakGlassMaxMinutes": 30,
        "breakGlassNotify": ["security@example.test"],
    })
    check("controller profile is revisioned and records no invented approval badge", status == 200 and profile.get("breakGlassEnabled") is True and profile.get("dpiaStatus") == "approved_by_controller", f"HTTP {status} {message(profile)}")

    status, flags, _ = call("GET", "/api/v1/clinical/features")
    flag_states = {row.get("key"): row.get("state") for row in flags.get("data", [])} if isinstance(flags, dict) else {}
    check("Phase 1 rollout controls expose observe/off states", status == 200 and flag_states.get("permissions_v2") == "observe" and flag_states.get("documents_v1") == "off", f"HTTP {status}")
    status, dead_letters, _ = call("GET", "/api/v1/clinical/dead-letters?status=open")
    check("signed-in privacy manager can inspect the redacted clinical failure queue", status == 200 and isinstance(dead_letters.get("data"), list), f"HTTP {status}")

    status, no_ack, _ = call(
        "POST", f"/api/v1/clients/{patient_id}/contacts",
        {"kind": "email", "label": "work", "value": f"no-ack-{STAMP}@example.test"},
    )
    check("synthetic mode requires the per-request synthetic acknowledgement", status == 403 and "acknowledgement" in message(no_ack).lower(), f"HTTP {status} {message(no_ack)}")

    synthetic_headers = {"x-voxera-synthetic-data": "1"}
    status, contact, _ = call(
        "POST", f"/api/v1/clients/{patient_id}/contacts",
        {"kind": "email", "label": "work", "value": f"synthetic-{STAMP}@example.test", "primary": False},
        headers=synthetic_headers,
    )
    check("acknowledged synthetic contact write succeeds", status == 201 and contact.get("patientId") == patient_id, f"HTTP {status} {message(contact)}")

    status, assignment, _ = call(
        "POST", f"/api/v1/clients/{patient_id}/assignments",
        {"scope": "caseload", "userId": owner_id, "kind": "administrative"}, headers=synthetic_headers,
    )
    status_list, assignment_set, _ = call("GET", f"/api/v1/clients/{patient_id}/assignments")
    check("typed client assignment route stores validated same-tenant scope", status == 201 and status_list == 200 and any(row.get("id") == assignment.get("id") for row in assignment_set.get("caseload", [])), f"HTTP {status}/{status_list}")

    status, emergency, _ = call("POST", "/api/v1/access-grants", {
        "userId": owner_id, "patientId": patient_id, "reason": "Synthetic urgent continuity-of-care test", "minutes": 10,
    })
    check("controller-enabled break-glass is short-lived and audited", status == 201 and emergency.get("resourceId") == patient_id and emergency.get("expiresAt") > emergency.get("startsAt"), f"HTTP {status} {message(emergency)}")

    status, alert, _ = call(
        "POST", f"/api/v1/clients/{patient_id}/alerts",
        {"classification": "clinical", "label": f"Synthetic restricted flag {STAMP}", "detail": "synthetic test only", "severity": "warning"},
        headers=synthetic_headers,
    )
    clinical_alert_id = str(alert.get("alert", {}).get("id", "")) if isinstance(alert, dict) else ""
    check("explicit clinical alert write succeeds only on the clinical path", status == 201 and bool(clinical_alert_id), f"HTTP {status} {message(alert)}")

    clients_read = mint("clients-read", ["clients:read"])
    status, narrow_client, _ = call("GET", f"/api/v1/clients/{patient_id}", token=clients_read)
    visible_alerts = narrow_client.get("alerts", []) if isinstance(narrow_client, dict) else []
    check("narrow client key cannot read restricted clinical alerts", status == 200 and narrow_client.get("clinicalAlertsRestricted") is True and all(a.get("classification") != "clinical" for a in visible_alerts), f"HTTP {status}")
    status, denied_export, _ = call("GET", "/api/v1/clients?view=export", token=clients_read)
    check("clients read scope cannot silently become export scope", status == 403 and "clients:export" in message(denied_export), f"HTTP {status} {message(denied_export)}")

    clients_export = mint("clients-export", ["clients:read", "clients:export"])
    status, exported_clients, _ = call("GET", "/api/v1/clients?view=export", token=clients_export)
    check("explicit client export scope permits the typed CSV export", status == 200 and isinstance(exported_clients, str) and "Name" in exported_clients, f"HTTP {status}")
    status, denied_subject, _ = call("GET", f"/api/v1/clients/{patient_id}/export", token=clients_export)
    check("broad client export cannot silently become a clinical subject-access export", status == 403 and "clinical:read" in message(denied_subject), f"HTTP {status} {message(denied_subject)}")
    subject_key = mint("client-subject-export", ["clients:read", "clients:export", "clinical:read", "documents:export", "privacy:read"])
    status, subject_export, _ = call("GET", f"/api/v1/clients/{patient_id}/export", token=subject_key)
    subject_keys = set(keys(subject_export))
    check("dedicated scopes return a patient-specific controlled export", status == 200 and subject_export.get("patientId") == patient_id and subject_export.get("boundaries", {}).get("completeClinicalAccessHistoryIncluded") is True, f"HTTP {status}")
    check("subject-access export excludes encrypted object internals", not ({"objectKey", "wrappedKey", "dataAuthTag", "ciphertextSha256", "tokenHash"} & subject_keys))

    status, unsafe_type, _ = call(
        "POST", "/api/v1/documents",
        {"ownerType": "patient", "ownerId": patient_id, "title": "Unsafe inline fixture", "allowedMimeTypes": ["text/html", "image/svg+xml"]},
        headers=synthetic_headers,
    )
    check("HTML and SVG uploads cannot obtain a capability", status == 400, f"HTTP {status} {message(unsafe_type)}")

    status, tiny_capability, _ = call(
        "POST", "/api/v1/documents",
        {"ownerType": "patient", "ownerId": patient_id, "title": "Tiny bounded fixture", "allowedMimeTypes": ["text/plain"], "maxBytes": 8},
        headers=synthetic_headers,
    )
    tiny_token = str(tiny_capability.get("token", "")) if isinstance(tiny_capability, dict) else ""
    status, oversized, _ = call(
        "PUT", f"/api/v1/documents/uploads/{tiny_token}", headers={"content-type": "text/plain", "x-voxera-file-name": "large.txt", "x-voxera-synthetic-data": "1"}, raw=b"more than eight bytes",
    )
    check("upload body is capped by the single-use capability", status == 413, f"HTTP {status} {message(oversized)}")

    status, upload_capability, _ = call(
        "POST", "/api/v1/documents",
        {"ownerType": "patient", "ownerId": patient_id, "title": f"Synthetic referral {STAMP}", "category": "referral", "allowedMimeTypes": ["text/plain"]},
        headers=synthetic_headers,
    )
    upload_token = str(upload_capability.get("token", "")) if isinstance(upload_capability, dict) else ""
    check("document upload capability is issued through the typed route", status == 201 and upload_token.startswith("vup_"), f"HTTP {status} {message(upload_capability)}")
    status, uploaded, _ = call(
        "PUT", f"/api/v1/documents/uploads/{upload_token}", token=None,
        headers={"content-type": "text/plain", "x-voxera-file-name": "synthetic.txt", "x-voxera-synthetic-data": "1"},
        raw=b"synthetic clinical bytes only - not a real patient",
    )
    document_id = str(uploaded.get("document", {}).get("id", "")) if isinstance(uploaded, dict) else ""
    version_id = str(uploaded.get("version", {}).get("id", "")) if isinstance(uploaded, dict) else ""
    check("uploaded bytes remain quarantined pending scanner work", status == 201 and uploaded.get("scanStatus") == "pending" and bool(document_id), f"HTTP {status} {message(uploaded)}")
    status, replayed, _ = call(
        "PUT", f"/api/v1/documents/uploads/{upload_token}",
        headers={"content-type": "text/plain", "x-voxera-file-name": "changed.txt", "x-voxera-synthetic-data": "1"},
        raw=b"different replay payload must not replace immutable bytes",
    )
    check("consumed upload capability is idempotent and cannot create replacement bytes", status == 201 and replayed.get("version", {}).get("id") == version_id, f"HTTP {status}")

    status, confused_capability, _ = call(
        "POST", "/api/v1/documents",
        {"ownerType": "patient", "ownerId": patient_id, "title": "MIME confusion fixture", "allowedMimeTypes": ["text/plain"]},
        headers=synthetic_headers,
    )
    confused_token = str(confused_capability.get("token", "")) if isinstance(confused_capability, dict) else ""
    status, confused, _ = call(
        "PUT", f"/api/v1/documents/uploads/{confused_token}",
        headers={"content-type": "text/plain", "x-voxera-file-name": "fake.txt", "x-voxera-synthetic-data": "1"}, raw=b"%PDF-1.7\nsynthetic",
    )
    check("declared MIME cannot override detected bytes", status == 400 and "signature" in message(confused).lower(), f"HTTP {status} {message(confused)}")

    document_revision = int((uploaded.get("document") or {}).get("revision", 0)) if isinstance(uploaded, dict) else -1
    status, linked, _ = call(
        "POST", f"/api/v1/documents/{document_id}/links",
        {"resourceType": "patient", "resourceId": patient_id, "relationship": "evidence", "expectedDocumentRevision": document_revision},
        headers=synthetic_headers,
    )
    linked_revision = int((linked.get("document") or {}).get("revision", 0)) if isinstance(linked, dict) else -1
    status_links, links_body, _ = call("GET", f"/api/v1/documents/{document_id}/links")
    check("document has a canonical owner link and a revisioned additional record link", status == 201 and status_links == 200 and len(links_body.get("data", [])) == 2 and {row.get("relationship") for row in links_body.get("data", [])} == {"owner", "evidence"}, f"HTTP {status}/{status_links}")
    status, forged_link, _ = call(
        "POST", f"/api/v1/documents/{document_id}/links",
        {"resourceType": "patient", "resourceId": second_patient_id, "relationship": "related", "expectedDocumentRevision": linked_revision},
        headers=synthetic_headers,
    )
    check("document links cannot cross the canonical patient boundary", status == 400 and "different patient" in message(forged_link), f"HTTP {status} {message(forged_link)}")
    status, portal_link, _ = call(
        "POST", f"/api/v1/documents/{document_id}/links",
        {"resourceType": "patient", "resourceId": patient_id, "relationship": "related", "visibleInPortal": True, "expectedDocumentRevision": linked_revision},
        headers=synthetic_headers,
    )
    check("Phase 1 document links cannot silently become public portal shares", status == 400 and "portal" in message(portal_link).lower(), f"HTTP {status} {message(portal_link)}")

    documents_read = mint("documents-read", ["documents:read"])
    status, denied_manifest, _ = call("GET", "/api/v1/documents?view=export", token=documents_read)
    check("document read scope cannot export a manifest", status == 403 and "documents:export" in message(denied_manifest), f"HTTP {status} {message(denied_manifest)}")
    status, denied_download, _ = call("GET", f"/api/v1/documents/{document_id}/download", token=documents_read)
    check("document read scope cannot download bytes", status == 403 and "documents:download" in message(denied_download), f"HTTP {status} {message(denied_download)}")

    documents_export = mint("documents-export", ["documents:read", "documents:export"])
    status, manifest, _ = call("GET", "/api/v1/documents?view=export", token=documents_export)
    manifest_keys = set(keys(manifest))
    check("explicit document export returns a controlled manifest", status == 200 and document_id in json.dumps(manifest) and not ({"objectKey", "envelope", "wrappedKey"} & manifest_keys), f"HTTP {status}")

    owner_cookie = cookie
    cookie = ""
    status, other_signup, _ = call("POST", "/api/auth/signup", {
        "email": f"phase1-other-{STAMP}@example.test", "password": "tenant-password-2026", "name": "Other Tenant", "orgName": f"Other Tenant {STAMP}",
    })
    other_cookie = cookie
    status_other, hidden_document, _ = call("GET", f"/api/v1/documents/{document_id}") if status == 201 and other_cookie else (0, {}, {})
    cookie = owner_cookie
    check("document identifiers do not cross tenant boundaries", status == 201 and status_other == 404, f"signup HTTP {status}; document HTTP {status_other} {message(hidden_document)}")

    status, generic, _ = call("GET", "/api/v1/collections/patientAlerts")
    check("generic collection bridge refuses clinical collections", status == 404, f"HTTP {status}")
    status, bootstrap, _ = call("POST", "/api/bootstrap", {})
    bootstrap_text = json.dumps(bootstrap)
    check("bootstrap contains no Phase 1 clinical collection", status == 200 and all(name not in bootstrap_text for name in ("patientAlerts", "patientContactPoints", "clinicalDocuments", "clinicalAccessEvents")))

    status, access, _ = call("GET", "/api/v1/clinical-access?limit=2")
    check("clinical access endpoint is paginated and summary remains complete", status == 200 and "has_more" in access and "next_cursor" in access and access.get("summary", {}).get("completeHistory") is True, f"HTTP {status}")

    merge_email = f"merge-{STAMP}@example.test"
    status_first, _, _ = call("POST", f"/api/v1/clients/{patient_id}/contacts", {"kind": "email", "label": "merge test", "value": merge_email}, headers=synthetic_headers)
    status_second, duplicate, _ = call("POST", f"/api/v1/clients/{second_patient_id}/contacts", {"kind": "email", "label": "merge test", "value": merge_email}, headers=synthetic_headers)
    status, conflicts, _ = call("GET", "/api/v1/identity-conflicts?status=open&limit=100")
    conflict_rows = conflicts.get("data", []) if isinstance(conflicts, dict) else []
    merge_conflict = next((row for row in conflict_rows if patient_id in row.get("candidatePatientIds", []) and second_patient_id in row.get("candidatePatientIds", [])), None)
    status_merge, merge_result, _ = call("POST", "/api/v1/identity-conflicts", {
        "action": "merge", "conflictId": (merge_conflict or {}).get("id"), "survivorPatientId": patient_id,
        "sourcePatientId": second_patient_id, "note": "Synthetic exact-conflict human approval",
    }, headers=synthetic_headers)
    status_redirect, canonical, _ = call("GET", f"/api/v1/clients/{second_patient_id}")
    check("exact conflict can be human-approved into one evidenced canonical patient", status_first == 201 and status_second == 409 and merge_conflict is not None and status_merge == 200 and merge_result.get("event", {}).get("survivorPatientId") == patient_id, f"HTTP {status_first}/{status_second}/{status_merge}")
    check("merged patient API resolves the archived source to its canonical record", status_redirect == 200 and canonical.get("id") == patient_id and canonical.get("redirectedFrom") == second_patient_id, f"HTTP {status_redirect} {message(canonical)}")
    status_stale_write, stale_write, _ = call("PATCH", f"/api/v1/clients/{second_patient_id}", {"name": "must not mutate redirect"})
    check("writes through a merged source ID fail with the canonical target", status_stale_write == 409 and f"canonicalPatientId={patient_id}" in str((stale_write.get("error") or {}).get("detail", "")), f"HTTP {status_stale_write}")

    status, workspace, _ = call("GET", "/api/v1/workspaces/export")
    collection_names = set(workspace.get("collections", {})) if isinstance(workspace, dict) else set()
    workspace_keys = set(keys(workspace))
    raw_document_collections = {"clinicalDocuments", "documentLinks", "clinicalDocumentVersions", "documentScanEvents", "documentUploadTokens"}
    check("whole-workspace export excludes raw encrypted document collections", status == 200 and not (raw_document_collections & collection_names), f"HTTP {status}")
    check("whole-workspace export carries only the controlled document manifest", isinstance(workspace, dict) and document_id in json.dumps(workspace.get("clinicalDocuments", {})) and not ({"objectKey", "envelope", "wrappedKey"} & workspace_keys))

    print(f"\nPhase 1 HTTP/security integration: {passes} passed; {len(failures)} failed")
    if failures:
        print("Failed: " + "; ".join(failures))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
