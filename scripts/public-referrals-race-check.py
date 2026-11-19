#!/usr/bin/env python3
"""Two-process race gate for public referral forms, uploads, submission and conversion."""
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


def safe_messages(*payloads: object) -> bool:
    combined = " | ".join(message(payload).lower() for payload in payloads)
    return all(term not in combined for term in ("duplicate key", "unique constraint", "sqlite_constraint", "voxera_docs", "docs_referral"))


def request(base: str, method: str, path: str, body: object | None = None, *, cookie: str = "", raw: bytes | None = None, headers: dict[str, str] | None = None):
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("accept", "application/json")
    req.add_header("x-forwarded-for", "203.0.113.88")
    if body is not None and raw is None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    if method in {"POST", "PATCH", "PUT", "DELETE"} and path.startswith("/api/"):
        req.add_header("x-voxera-synthetic-data", "1")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            content = response.read()
            return response.status, json.loads(content or b"{}"), response.headers.get("set-cookie", "").split(";", 1)[0]
    except urllib.error.HTTPError as error:
        content = error.read()
        try:
            payload = json.loads(content or b"{}")
        except json.JSONDecodeError:
            payload = content.decode("utf-8", "replace")
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
    check("shared store is in synthetic-test mode", status == 200 and readiness.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}: {message(readiness)}")

    schema = {
        "version": 1,
        "title": f"Public referral race {STAMP}",
        "fields": [
            {"id": "patient_name", "key": "patient_name", "label": "Patient name", "type": "text", "required": True},
            {"id": "date_of_birth", "key": "date_of_birth", "label": "Date of birth", "type": "date", "required": True},
            {"id": "patient_email", "key": "patient_email", "label": "Patient email", "type": "text", "required": True},
            {"id": "reason", "key": "reason", "label": "Reason", "type": "long_text", "required": True},
            {"id": "consent", "key": "consent", "label": "Consent", "type": "acknowledgement", "required": True},
            {"id": "attachment", "key": "attachment", "label": "Attachment", "type": "file"},
        ],
    }
    status, created, _ = request(BASE_A, "POST", "/api/v1/forms/templates", {"name": schema["title"], "category": "referral", "schema": schema}, cookie=cookie_a)
    template = created.get("template", {}) if isinstance(created, dict) else {}
    status, published, _ = request(BASE_A, "PATCH", f"/api/v1/forms/templates/{template.get('id')}", {"action": "publish", "expectedRevision": template.get("revision")}, cookie=cookie_a)
    check("one referral template is published before racing", status == 200 and published.get("state") == "published", f"HTTP {status}: {message(published)}")

    slug = f"referral-race-{STAMP}"
    config = {
        "name": f"Referral race {STAMP}", "slug": slug, "templateId": template.get("id"),
        "mapping": {"patientName": "patient_name", "dateOfBirth": "date_of_birth", "email": "patient_email", "reason": "reason", "consent": "consent"},
        "routing": {"priority": "urgent"},
        "privacyNotice": "Synthetic two-process race evidence only; never enter real patient data.",
        "emergencyNotice": "Not monitored for urgent concerns.", "completionMessage": "Synthetic race referral received.", "active": True,
    }
    created_a, created_b = simultaneous(
        lambda: request(BASE_A, "POST", "/api/v1/referral-forms", config, cookie=cookie_a),
        lambda: request(BASE_B, "POST", "/api/v1/referral-forms", config, cookie=cookie_b),
    )
    config_statuses = sorted([created_a[0], created_b[0]])
    winner = created_a[1] if created_a[0] == 201 else created_b[1]
    check("simultaneous duplicate-slug creation has one winner and a controlled conflict", config_statuses == [201, 409] and winner.get("slug") == slug and safe_messages(created_a[1], created_b[1]), f"statuses {created_a[0]}/{created_b[0]}: {message(created_a[1])} | {message(created_b[1])}")
    status_a, public_a, _ = request(BASE_A, "GET", f"/api/public/referrals/{slug}")
    status_b, public_b, _ = request(BASE_B, "GET", f"/api/public/referrals/{slug}")
    check("both nodes resolve the same active pinned configuration", status_a == status_b == 200 and public_a.get("form", {}).get("id") == public_b.get("form", {}).get("id") == winner.get("id") and public_a.get("schema", {}).get("version") == 1, f"HTTP {status_a}/{status_b}")

    status, started, _ = request(BASE_A, "POST", f"/api/public/referrals/{slug}", {"action": "start"})
    token = str(started.get("draftToken", "")) if isinstance(started, dict) else ""
    status_b, resumed, _ = request(BASE_B, "POST", f"/api/public/referrals/{slug}", {"action": "resume", "draftToken": token})
    check("a draft token created by node A resumes on node B", status == 201 and status_b == 200 and token.startswith("rrd_") and resumed.get("status") == "draft", f"HTTP {status}/{status_b}")

    pdf_a = b"%PDF-1.4\n% synthetic public referral upload A\n%%EOF\n"
    pdf_b = b"%PDF-1.4\n% synthetic public referral upload B\n%%EOF\n"
    upload_a, upload_b = simultaneous(
        lambda: request(BASE_A, "PUT", f"/api/public/referrals/{slug}/uploads", raw=pdf_a, headers={"content-type": "application/pdf", "x-voxera-file-name": "race-a.pdf", "x-voxera-form-field": "attachment", "x-voxera-referral-draft": token}),
        lambda: request(BASE_B, "PUT", f"/api/public/referrals/{slug}/uploads", raw=pdf_b, headers={"content-type": "application/pdf", "x-voxera-file-name": "race-b.pdf", "x-voxera-form-field": "attachment", "x-voxera-referral-draft": token}),
    )
    upload_ids = [item[1].get("documentId") for item in (upload_a, upload_b) if isinstance(item[1], dict)]
    check("simultaneous uploads attach two unique quarantined documents", sorted([upload_a[0], upload_b[0]]) == [201, 201] and len(upload_ids) == len(set(upload_ids)) == 2 and safe_messages(upload_a[1], upload_b[1]), f"statuses {upload_a[0]}/{upload_b[0]} ids={upload_ids}")

    email = f"public-race-{STAMP}@example.test"
    answers = {
        "patient_name": f"Synthetic Race Patient {STAMP}", "date_of_birth": "1988-07-09", "patient_email": email,
        "reason": "Synthetic two-process submission", "consent": True, "attachment": upload_ids,
    }
    submit_body = {"action": "submit", "draftToken": token, "answers": answers}
    submitted_a, submitted_b = simultaneous(
        lambda: request(BASE_A, "POST", f"/api/public/referrals/{slug}", submit_body),
        lambda: request(BASE_B, "POST", f"/api/public/referrals/{slug}", submit_body),
    )
    check("simultaneous submission has exactly one winner without storage leakage", sorted([submitted_a[0], submitted_b[0]]) == [201, 409] and safe_messages(submitted_a[1], submitted_b[1]), f"statuses {submitted_a[0]}/{submitted_b[0]}: {message(submitted_a[1])} | {message(submitted_b[1])}")

    query = urllib.parse.quote(email)
    status, referrals, _ = request(BASE_A, "GET", f"/api/v1/referrals?q={query}&limit=100", cookie=cookie_a)
    exact_referrals = [row for row in referrals.get("data", []) if row.get("patient", {}).get("email") == email] if isinstance(referrals, dict) else []
    referral_id = exact_referrals[0].get("id", "") if len(exact_referrals) == 1 else ""
    check("submission race leaves exactly one routed referral", status == 200 and len(exact_referrals) == 1 and exact_referrals[0].get("priority") == "urgent", f"matches={len(exact_referrals)}")
    status, detail, _ = request(BASE_B, "GET", f"/api/v1/referrals/{referral_id}", cookie=cookie_b)
    attachment_ids = {row.get("id") for row in detail.get("attachments", [])} if isinstance(detail, dict) else set()
    received_events = [event for event in detail.get("events", []) if event.get("to") == "received"] if isinstance(detail, dict) else []
    check("winning submission has verified pinned evidence and exact attachment ownership", status == 200 and detail.get("publicSubmission", {}).get("evidence", {}).get("verified") is True and attachment_ids == set(upload_ids) and len(received_events) == 1, f"attachments={attachment_ids} receivedEvents={len(received_events)}")

    referral = detail.get("referral", {})
    status, triaged, _ = request(BASE_A, "PATCH", f"/api/v1/referrals/{referral_id}", {"action": "transition", "to": "triaged", "expectedRevision": referral.get("revision")}, cookie=cookie_a)
    status, accepted, _ = request(BASE_A, "PATCH", f"/api/v1/referrals/{referral_id}", {"action": "transition", "to": "accepted", "expectedRevision": triaged.get("revision")}, cookie=cookie_a)
    check("public referral is accepted before conversion race", status == 200 and accepted.get("status") == "accepted", f"HTTP {status}: {message(accepted)}")
    request(BASE_A, "GET", f"/api/v1/referrals/{referral_id}", cookie=cookie_a)
    request(BASE_B, "GET", f"/api/v1/referrals/{referral_id}", cookie=cookie_b)
    convert_body = {"action": "convert", "expectedRevision": accepted.get("revision")}
    converted_a, converted_b = simultaneous(
        lambda: request(BASE_A, "PATCH", f"/api/v1/referrals/{referral_id}", convert_body, cookie=cookie_a),
        lambda: request(BASE_B, "PATCH", f"/api/v1/referrals/{referral_id}", convert_body, cookie=cookie_b),
    )
    check("simultaneous conversion has a successful idempotent outcome", 200 in [converted_a[0], converted_b[0]] and all(code in (200, 409) for code in [converted_a[0], converted_b[0]]) and safe_messages(converted_a[1], converted_b[1]), f"statuses {converted_a[0]}/{converted_b[0]}")

    _, converted_detail, _ = request(BASE_A, "GET", f"/api/v1/referrals/{referral_id}", cookie=cookie_a)
    final_referral = converted_detail.get("referral", {})
    conversion_events = [event for event in converted_detail.get("events", []) if event.get("to") == "converted"]
    _, clients, _ = request(BASE_A, "GET", f"/api/v1/clients?q={query}&limit=100", cookie=cookie_a)
    exact_clients = [row for row in clients.get("data", []) if row.get("email") == email] if isinstance(clients, dict) else []
    patient_id = final_referral.get("convertedClientId", "")
    check("conversion race creates one patient and one transition event", final_referral.get("status") == "converted" and len(exact_clients) == 1 and exact_clients[0].get("id") == patient_id and len(conversion_events) == 1, f"clients={len(exact_clients)} events={len(conversion_events)} patient={patient_id}")

    submission_id = converted_detail.get("publicSubmission", {}).get("id", "")
    status, documents, _ = request(BASE_B, "GET", f"/api/v1/documents?ownerType=referral_submission&ownerId={urllib.parse.quote(str(submission_id))}", cookie=cookie_b)
    rows = documents.get("data", []) if isinstance(documents, dict) else []
    linked_ids = {row.get("id") for row in rows}
    patient_links_ok = all(row.get("patientId") == patient_id and row.get("links") and all(link.get("patientId") == patient_id for link in row.get("links", [])) for row in rows)
    check("conversion atomically links both referral documents to the one patient", status == 200 and len(rows) == 2 and linked_ids == set(upload_ids) and patient_links_ok, f"documents={len(rows)} linked={linked_ids}")

    print(f"\n{PASS} passed / {len(FAIL)} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
