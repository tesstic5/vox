#!/usr/bin/env python3
"""Cross-process race gate for Phase 3 forms, referrals and letters.

Run two production Next servers against the same isolated database/blob root, then:

  VOXERA_BASE_A=http://127.0.0.1:3201 \
  VOXERA_BASE_B=http://127.0.0.1:3202 \
  python3 scripts/phase3-race-check.py

The two origins are intentional: a single JavaScript process can serialize the
synchronous commit boundary and would not prove cross-container behaviour.
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE_A = os.environ.get("VOXERA_BASE_A", "http://127.0.0.1:3201").rstrip("/")
BASE_B = os.environ.get("VOXERA_BASE_B", "http://127.0.0.1:3202").rstrip("/")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
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
    return str(payload)[:240]


def request(base: str, method: str, path: str, body: object | None = None, *, cookie: str = "", binary: bool = False, raw: bytes | None = None, headers: dict[str, str] | None = None):
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("accept", "application/json")
    req.add_header("x-forwarded-for", "203.0.113.77")
    if body is not None and raw is None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    if method in {"POST", "PATCH", "PUT", "DELETE"} and path.startswith("/api/"):
        req.add_header("x-voxera-synthetic-data", "1")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            payload = raw if binary else json.loads(raw or b"{}")
            return response.status, payload, response.headers.get("set-cookie", "").split(";", 1)[0]
    except urllib.error.HTTPError as error:
        raw = error.read()
        if binary:
            payload = raw
        else:
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                payload = raw.decode("utf-8", "replace")
        return error.code, payload, ""


def login(base: str) -> str:
    status, payload, cookie = request(base, "POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    check(f"owner signs in on {base}", status == 200 and bool(cookie), f"HTTP {status}: {message(payload)}")
    return cookie


def simultaneous(work_a, work_b):
    barrier = threading.Barrier(3)

    def wrapped(work):
        barrier.wait(timeout=15)
        return work()

    with ThreadPoolExecutor(max_workers=2) as pool:
        future_a = pool.submit(wrapped, work_a)
        future_b = pool.submit(wrapped, work_b)
        barrier.wait(timeout=15)
        return future_a.result(timeout=120), future_b.result(timeout=120)


def main() -> int:
    cookie_a = login(BASE_A)
    cookie_b = login(BASE_B)
    if not cookie_a or not cookie_b:
        return 1

    status, migrations, _ = request(BASE_A, "POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"}, cookie=cookie_a)
    check("checksummed migrations are current", status == 200 and migrations.get("completed") == migrations.get("total"), f"HTTP {status}: {message(migrations)}")
    status, readiness, _ = request(BASE_A, "POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"}, cookie=cookie_a)
    check("shared fixture is in synthetic-test mode", status == 200 and readiness.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}: {message(readiness)}")

    status, client, _ = request(BASE_A, "POST", "/api/v1/clients", {
        "name": f"Race Patient {STAMP}",
        "number": f"+447701{int(STAMP[:6], 16) % 1000000:06d}",
        "email": f"race-{STAMP}@example.test",
        "dateOfBirth": "1992-06-18",
    }, cookie=cookie_a)
    client_id = client.get("id", "") if isinstance(client, dict) else ""
    check("race fixture patient is created once", status == 201 and str(client_id).startswith("cli_"), f"HTTP {status}: {message(client)}")

    # ---------------------------------------------------------------- forms
    schema = {
        "version": 1,
        "title": f"Race form {STAMP}",
        "fields": [
            {"id": "name", "key": "name", "label": "Preferred name", "type": "text", "required": True},
            {"id": "confirm", "key": "confirm", "label": "Accurate", "type": "acknowledgement", "required": True},
            {"id": "evidence", "key": "evidence", "label": "Supporting evidence", "type": "file", "required": False},
        ],
    }
    status, created, _ = request(BASE_A, "POST", "/api/v1/forms/templates", {"name": schema["title"], "category": "intake", "schema": schema}, cookie=cookie_a)
    template = created.get("template", {}) if isinstance(created, dict) else {}
    status, published, _ = request(BASE_A, "PATCH", f"/api/v1/forms/templates/{template.get('id')}", {"action": "publish", "expectedRevision": template.get("revision")}, cookie=cookie_a)
    check("race form is published", status == 200 and published.get("state") == "published", f"HTTP {status}: {message(published)}")

    def assignment():
        status_, payload_, _ = request(BASE_A, "POST", "/api/v1/forms/assignments", {"templateId": template.get("id"), "clientId": client_id, "send": False}, cookie=cookie_a)
        row_ = payload_.get("assignment", {}) if isinstance(payload_, dict) else {}
        token_ = str(payload_.get("publicUrl", "")).rsplit("/", 1)[-1] if isinstance(payload_, dict) else ""
        return status_, row_, token_

    # Two application processes may receive file uploads before either has
    # created the draft response. Both uploads must converge on one response
    # owner, without an orphaned second aggregate or raw uniqueness details.
    status, upload_row, upload_token = assignment()
    check("concurrent-upload assignment is issued", status == 201 and upload_token and upload_row.get("id"), f"HTTP {status}")
    pdf_a = b"%PDF-1.4\n% synthetic concurrent upload A\n%%EOF\n"
    pdf_b = b"%PDF-1.4\n% synthetic concurrent upload B\n%%EOF\n"
    upload_a, upload_b = simultaneous(
        lambda: request(BASE_A, "PUT", f"/api/public/forms/{upload_token}/uploads", raw=pdf_a, headers={"content-type": "application/pdf", "x-voxera-file-name": "race-a.pdf", "x-voxera-form-field": "evidence"}),
        lambda: request(BASE_B, "PUT", f"/api/public/forms/{upload_token}/uploads", raw=pdf_b, headers={"content-type": "application/pdf", "x-voxera-file-name": "race-b.pdf", "x-voxera-form-field": "evidence"}),
    )
    upload_messages = f"{message(upload_a[1])} | {message(upload_b[1])}"
    upload_ids = [item[1].get("documentId") for item in (upload_a, upload_b) if isinstance(item[1], dict)]
    no_storage_leak = all(term not in upload_messages.lower() for term in ("duplicate key", "unique constraint", "sqlite_constraint", "voxera_docs", "docs_custom"))
    check("simultaneous public uploads both complete without database-detail leakage", sorted([upload_a[0], upload_b[0]]) == [201, 201] and len(set(upload_ids)) == 2 and no_storage_leak, f"statuses {upload_a[0]}/{upload_b[0]}: {upload_messages}")
    _, upload_responses, _ = request(BASE_A, "GET", "/api/v1/forms/responses", cookie=cookie_a)
    upload_matches = [item for item in upload_responses.get("data", []) if item.get("assignmentId") == upload_row.get("id")] if isinstance(upload_responses, dict) else []
    upload_response_id = upload_matches[0].get("id", "") if len(upload_matches) == 1 else ""
    status_docs, upload_documents, _ = request(BASE_A, "GET", f"/api/v1/documents?ownerType=form_response&ownerId={urllib.parse.quote(str(upload_response_id))}", cookie=cookie_a)
    owned_documents = upload_documents.get("data", []) if isinstance(upload_documents, dict) else []
    owned_ids = {item.get("id") for item in owned_documents}
    exact_ownership = len(upload_matches) == 1 and len(owned_documents) == 2 and set(upload_ids) == owned_ids and all(item.get("ownerId") == upload_response_id and item.get("patientId") == client_id and item.get("currentScanStatus") in ("pending", "unavailable") for item in owned_documents)
    check("upload race leaves one draft response with two quarantined, exactly-owned documents", status_docs == 200 and exact_ownership, f"responses={len(upload_matches)} documents={len(owned_documents)}")

    status, row, token = assignment()
    check("double-submit assignment is issued", status == 201 and token and row.get("id"), f"HTTP {status}")
    request(BASE_A, "GET", f"/api/public/forms/{token}")
    request(BASE_B, "GET", f"/api/public/forms/{token}")
    submit_body = {"answers": {"name": "Race safe", "confirm": True}, "submit": True, "respondent": {"relationship": "self"}}
    submit_a, submit_b = simultaneous(
        lambda: request(BASE_A, "POST", f"/api/public/forms/{token}", submit_body),
        lambda: request(BASE_B, "POST", f"/api/public/forms/{token}", submit_body),
    )
    submit_statuses = sorted([submit_a[0], submit_b[0]])
    submit_messages = f"{message(submit_a[1])} | {message(submit_b[1])}"
    check("simultaneous form submits have exactly one winner without database-detail leakage", submit_statuses == [200, 409] and "duplicate key" not in submit_messages.lower() and "voxera_docs" not in submit_messages.lower(), f"statuses {submit_a[0]}/{submit_b[0]}: {submit_messages}")
    status, responses, _ = request(BASE_A, "GET", "/api/v1/forms/responses?status=submitted", cookie=cookie_a)
    matching = [item for item in responses.get("data", []) if item.get("assignmentId") == row.get("id")] if isinstance(responses, dict) else []
    status2, assignment_after, _ = request(BASE_A, "GET", f"/api/v1/forms/assignments/{row.get('id')}", cookie=cookie_a)
    check("double submit leaves one response aggregate and a submitted assignment", status == 200 and status2 == 200 and len(matching) == 1 and assignment_after.get("status") == "submitted", f"responses={len(matching)} assignment={assignment_after.get('status')}")

    # Revoke-versus-submit: either operation may win, but never both.
    status, revoke_row, revoke_token = assignment()
    check("revoke race assignment is issued", status == 201 and revoke_token and revoke_row.get("id"), f"HTTP {status}")
    request(BASE_A, "GET", f"/api/public/forms/{revoke_token}")
    request(BASE_B, "GET", f"/api/public/forms/{revoke_token}")
    _, current, _ = request(BASE_A, "GET", f"/api/v1/forms/assignments/{revoke_row.get('id')}", cookie=cookie_a)
    revoke_result, submit_result = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/forms/assignments/{revoke_row.get('id')}", {"action": "revoke", "expectedRevision": current.get("revision")}, cookie=cookie_a),
        lambda: request(BASE_B, "POST", f"/api/public/forms/{revoke_token}", submit_body),
    )
    one_committed = [revoke_result[0], submit_result[0]].count(200) == 1 and all(code in (200, 403, 404, 409) for code in [revoke_result[0], submit_result[0]])
    check("revoke versus submit has one committed outcome", one_committed, f"statuses {revoke_result[0]}/{submit_result[0]}: {message(revoke_result[1])} | {message(submit_result[1])}")
    _, revoke_after, _ = request(BASE_A, "GET", f"/api/v1/forms/assignments/{revoke_row.get('id')}", cookie=cookie_a)
    _, all_responses, _ = request(BASE_A, "GET", "/api/v1/forms/responses", cookie=cookie_a)
    revoke_matches = [item for item in all_responses.get("data", []) if item.get("assignmentId") == revoke_row.get("id")] if isinstance(all_responses, dict) else []
    safe_terminal = (revoke_after.get("status") == "revoked" and not revoke_matches) or (revoke_after.get("status") == "submitted" and len(revoke_matches) == 1)
    check("revoke race cannot create a response behind a revoked link", safe_terminal, f"assignment={revoke_after.get('status')} responses={len(revoke_matches)}")

    # ---------------------------------------------------------- referral convert
    referral_payload = {
        "source": "manual",
        "patient": {"name": f"Race Referral {STAMP}", "email": f"race-ref-{STAMP}@example.test", "dateOfBirth": "1987-02-11"},
        "priority": "routine",
        "reason": "Cross-process conversion proof",
    }
    status, created_referral, _ = request(BASE_A, "POST", "/api/v1/referrals", referral_payload, cookie=cookie_a)
    referral = created_referral.get("referral", {}) if isinstance(created_referral, dict) else {}
    status, triaged, _ = request(BASE_A, "PATCH", f"/api/v1/referrals/{referral.get('id')}", {"action": "transition", "to": "triaged", "expectedRevision": referral.get("revision")}, cookie=cookie_a)
    status, accepted, _ = request(BASE_A, "PATCH", f"/api/v1/referrals/{referral.get('id')}", {"action": "transition", "to": "accepted", "expectedRevision": triaged.get("revision")}, cookie=cookie_a)
    check("referral is ready for a conversion race", status == 200 and accepted.get("status") == "accepted", f"HTTP {status}: {message(accepted)}")
    request(BASE_A, "GET", f"/api/v1/referrals/{referral.get('id')}", cookie=cookie_a)
    request(BASE_B, "GET", f"/api/v1/referrals/{referral.get('id')}", cookie=cookie_b)
    convert_body = {"action": "convert", "expectedRevision": accepted.get("revision")}
    converted_a, converted_b = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/referrals/{referral.get('id')}", convert_body, cookie=cookie_a),
        lambda: request(BASE_B, "PATCH", f"/api/v1/referrals/{referral.get('id')}", convert_body, cookie=cookie_b),
    )
    check("simultaneous referral conversion has at least one successful idempotent result", 200 in [converted_a[0], converted_b[0]] and all(code in (200, 409) for code in [converted_a[0], converted_b[0]]), f"statuses {converted_a[0]}/{converted_b[0]}")
    _, referral_detail, _ = request(BASE_A, "GET", f"/api/v1/referrals/{referral.get('id')}", cookie=cookie_a)
    final_referral = referral_detail.get("referral", {}) if isinstance(referral_detail, dict) else {}
    conversion_events = [event for event in referral_detail.get("events", []) if event.get("to") == "converted"] if isinstance(referral_detail, dict) else []
    query = urllib.parse.quote(referral_payload["patient"]["email"])
    _, clients, _ = request(BASE_A, "GET", f"/api/v1/clients?q={query}&limit=100", cookie=cookie_a)
    exact_clients = [item for item in clients.get("data", []) if item.get("email") == referral_payload["patient"]["email"]] if isinstance(clients, dict) else []
    check("conversion race creates exactly one patient and one conversion event", final_referral.get("status") == "converted" and len(exact_clients) == 1 and exact_clients[0].get("id") == final_referral.get("convertedClientId") and len(conversion_events) == 1, f"clients={len(exact_clients)} events={len(conversion_events)} converted={final_referral.get('convertedClientId')}")

    # ------------------------------------------------------------- letter finalise
    status, template_payload, _ = request(BASE_A, "POST", "/api/v1/letters/templates", {
        "name": f"Race letter {STAMP}",
        "category": "clinical",
        "subject": "Race evidence for {{patient.name}}",
        "body": "Dear {{recipient.name}},\n\nThis is synthetic race evidence.\n\n{{author.name}}",
        "footer": "{{practice.name}}",
        "requiresApproval": True,
    }, cookie=cookie_a)
    letter_template = template_payload.get("template", {}) if isinstance(template_payload, dict) else {}
    status, _, _ = request(BASE_A, "PATCH", f"/api/v1/letters/templates/{letter_template.get('id')}", {"action": "publish", "expectedRevision": letter_template.get("revision")}, cookie=cookie_a)
    status, letter_payload, _ = request(BASE_A, "POST", "/api/v1/letters", {"templateId": letter_template.get("id"), "clientId": client_id, "recipient": {"name": "Race recipient", "email": f"race-letter-{STAMP}@example.test"}}, cookie=cookie_a)
    letter = letter_payload.get("letter", {}) if isinstance(letter_payload, dict) else {}
    status, awaiting, _ = request(BASE_A, "PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "submit", "expectedRevision": letter.get("revision")}, cookie=cookie_a)
    status, approved, _ = request(BASE_A, "PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "approve", "expectedRevision": awaiting.get("revision")}, cookie=cookie_a)
    check("letter is approved for a finalisation race", status == 200 and approved.get("status") == "approved", f"HTTP {status}: {message(approved)}")
    request(BASE_A, "GET", f"/api/v1/letters/{letter.get('id')}", cookie=cookie_a)
    request(BASE_B, "GET", f"/api/v1/letters/{letter.get('id')}", cookie=cookie_b)
    finalise_body = {"action": "finalise", "expectedRevision": approved.get("revision")}
    finalise_a, finalise_b = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/letters/{letter.get('id')}", finalise_body, cookie=cookie_a),
        lambda: request(BASE_B, "PATCH", f"/api/v1/letters/{letter.get('id')}", finalise_body, cookie=cookie_b),
    )
    check("simultaneous finalise has one committed letter transition", sorted([finalise_a[0], finalise_b[0]]) == [200, 409], f"statuses {finalise_a[0]}/{finalise_b[0]}: {message(finalise_a[1])} | {message(finalise_b[1])}")
    _, letter_detail, _ = request(BASE_A, "GET", f"/api/v1/letters/{letter.get('id')}", cookie=cookie_a)
    final_letter = letter_detail.get("letter", {}) if isinstance(letter_detail, dict) else {}
    artifact_id = final_letter.get("artifactDocumentId", "")
    artifact_version = final_letter.get("artifactVersionId", "")
    status, artifact_detail, _ = request(BASE_A, "GET", f"/api/v1/documents/{artifact_id}", cookie=cookie_a)
    versions = artifact_detail.get("versions", []) if isinstance(artifact_detail, dict) else []
    status2, documents, _ = request(BASE_A, "GET", f"/api/v1/documents?ownerType=letter&ownerId={urllib.parse.quote(str(letter.get('id')))}", cookie=cookie_a)
    status3, pdf, _ = request(BASE_A, "GET", f"/api/v1/letters/{letter.get('id')}/pdf", cookie=cookie_a, binary=True)
    one_artifact = status == 200 and status2 == 200 and documents.get("total") == 1 and len(versions) == 1
    valid_artifact = one_artifact and versions[0].get("id") == artifact_version and versions[0].get("source") == "generated" and versions[0].get("scan", {}).get("status") == "clean" and versions[0].get("plaintextSha256") == final_letter.get("artifactHash")
    check("finalise race leaves one encrypted, hash-verified artifact", final_letter.get("status") == "finalised" and valid_artifact and status3 == 200 and pdf.startswith(b"%PDF-"), f"documents={documents.get('total') if isinstance(documents, dict) else '?'} versions={len(versions)} PDF={status3}")

    print(f"\n{PASS} passed / {len(FAIL)} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
