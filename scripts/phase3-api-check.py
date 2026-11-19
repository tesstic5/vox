#!/usr/bin/env python3
"""Live HTTP boundary check for native forms, referrals and letters.

Run against an isolated synthetic fixture. The script enables synthetic-test mode
and writes synthetic records; it must never target a live patient workspace.
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


def check(label: str, condition: object, detail: object = "") -> None:
    global passes
    if condition:
        passes += 1
        print(f"PASS  {label}" + (f" — {detail}" if detail != "" else ""))
    else:
        failures.append(label)
        print(f"FAIL  {label}" + (f" — {detail}" if detail != "" else ""))


def request(method: str, path: str, body: object | None = None, *, raw: bytes | None = None, cookie: str = "", headers: dict[str, str] | None = None, binary: bool = False):
    if body is not None and raw is not None:
        raise ValueError("request accepts either JSON body or raw bytes, not both")
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("x-forwarded-for", "198.51.100.63")
    if body is not None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            payload = raw if binary else json.loads(raw or b"{}")
            return response.status, payload, {key.lower(): value for key, value in response.headers.items()}, response.headers.get("set-cookie", "").split(";", 1)[0]
    except urllib.error.HTTPError as error:
        raw = error.read()
        if binary:
            payload = raw
        else:
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                payload = raw.decode("utf-8", "replace")
        return error.code, payload, {key.lower(): value for key, value in error.headers.items()}, ""


def message(payload: object) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        return str(payload["error"].get("message", payload["error"]))
    return str(payload)[:180]


def login(email: str, password: str):
    status, body, _, cookie = request("POST", "/api/auth/login", {"email": email, "password": password})
    check(f"sign in {email}", status == 200 and bool(cookie), f"HTTP {status}: {message(body)}")
    return cookie


def main() -> None:
    cookie = login(EMAIL, PASSWORD)
    status, body, _, _ = request("POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"}, cookie=cookie)
    check("checksummed migrations run", status == 200 and body.get("completed") == body.get("total"), f"HTTP {status}: {message(body)}")
    status, body, _, _ = request("POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"}, cookie=cookie)
    check("synthetic-test mode enabled", status == 200 and body.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}: {message(body)}")

    status, client, _, _ = request("POST", "/api/v1/clients", {"name": f"Phase Three {STAMP}", "number": f"+447700{int(STAMP[:6], 16) % 1000000:06d}", "email": f"phase3-{STAMP}@example.test", "dateOfBirth": "1991-03-12"}, cookie=cookie)
    check("synthetic patient created", status == 201 and str(client.get("id", "")).startswith("cli_"), f"HTTP {status}: {message(client)}")
    client_id = client.get("id", "")

    schema = {
        "version": 1, "title": f"API intake {STAMP}", "description": "Synthetic verification form",
        "fields": [
            {"id": "preferred_name", "key": "preferred_name", "label": "Preferred name", "type": "text", "required": True, "updateTarget": "name"},
            {"id": "symptoms", "key": "symptoms", "label": "Symptoms present?", "type": "yes_no", "required": True},
            {"id": "detail", "key": "detail", "label": "Symptom detail", "type": "long_text", "required": True, "condition": {"op": "equals", "field": "symptoms", "value": True}},
            {"id": "attachment", "key": "attachment", "label": "Supporting document", "type": "file", "required": False},
            {"id": "confirm", "key": "confirm", "label": "Information is accurate", "type": "acknowledgement", "required": True},
        ],
    }
    status, created_form, _, _ = request("POST", "/api/v1/forms/templates", {"name": schema["title"], "category": "intake", "schema": schema}, cookie=cookie)
    check("form template created", status == 201 and created_form.get("template", {}).get("state") == "draft", f"HTTP {status}: {message(created_form)}")
    form_template = created_form.get("template", {})
    status, published_form, _, _ = request("PATCH", f"/api/v1/forms/templates/{form_template.get('id')}", {"action": "publish", "expectedRevision": form_template.get("revision")}, cookie=cookie)
    check("form version published", status == 200 and published_form.get("state") == "published", f"HTTP {status}: {message(published_form)}")
    status, assigned, _, _ = request("POST", "/api/v1/forms/assignments", {"templateId": form_template.get("id"), "clientId": client_id, "send": False}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    public_url = assigned.get("publicUrl", "") if isinstance(assigned, dict) else ""
    token = public_url.rsplit("/", 1)[-1]
    check("single-use form link returned", status == 201 and token and "tokenHash" not in json.dumps(assigned), f"HTTP {status}: {message(assigned)}")
    status, assignment_list, _, _ = request("GET", "/api/v1/forms/assignments", cookie=cookie)
    check("assignment list never exposes bearer hashes", status == 200 and "tokenHash" not in json.dumps(assignment_list), f"HTTP {status}")
    status, public_form, headers, _ = request("GET", f"/api/public/forms/{token}")
    check("public form is private and noindex", status == 200 and headers.get("cache-control", "").startswith("no-store") and headers.get("referrer-policy") == "no-referrer" and "noindex" in headers.get("x-robots-tag", ""), f"HTTP {status}")

    probe_pdf = b"%PDF-1.4\n% synthetic phase-three attachment\n%%EOF\n"
    upload_headers = {
        "content-type": "application/pdf",
        "x-voxera-form-field": "attachment",
        "x-voxera-file-name": "synthetic-evidence.pdf",
        "x-voxera-synthetic-data": "1",
    }
    status, uploaded, _, _ = request("PUT", f"/api/public/forms/{token}/uploads", raw=probe_pdf, headers=upload_headers)
    attachment_id = uploaded.get("documentId", "") if isinstance(uploaded, dict) else ""
    check("public attachment enters quarantine-first storage", status == 201 and str(attachment_id).startswith("doc_") and uploaded.get("scanStatus") in ("pending", "unavailable"), f"HTTP {status}: {message(uploaded)}")
    status, document_detail, _, _ = request("GET", f"/api/v1/documents/{attachment_id}", cookie=cookie)
    versions = document_detail.get("versions", []) if isinstance(document_detail, dict) else []
    check("attachment metadata is tenant-linked and never exposes object keys", status == 200 and document_detail.get("ownerType") == "form_response" and document_detail.get("category") == "form_attachment" and len(versions) == 1 and len(versions[0].get("plaintextSha256", "")) == 64 and "objectKey" not in json.dumps(document_detail), f"HTTP {status}: {message(document_detail)}")
    status, quarantined, _, _ = request("GET", f"/api/v1/documents/{attachment_id}/download", cookie=cookie, binary=True)
    check("quarantined public attachment cannot be downloaded", status == 409 and b"quarantined" in quarantined.lower(), f"HTTP {status}")

    status, second_assigned, _, _ = request("POST", "/api/v1/forms/assignments", {"templateId": form_template.get("id"), "clientId": client_id, "send": False}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    second_url = second_assigned.get("publicUrl", "") if isinstance(second_assigned, dict) else ""
    second_token = second_url.rsplit("/", 1)[-1]
    second_id = second_assigned.get("assignment", {}).get("id", "") if isinstance(second_assigned, dict) else ""
    status, _, _, _ = request("GET", f"/api/public/forms/{second_token}")
    status, second_upload, _, _ = request("PUT", f"/api/public/forms/{second_token}/uploads", raw=probe_pdf, headers=upload_headers)
    second_document_id = second_upload.get("documentId", "") if isinstance(second_upload, dict) else ""
    check("a second assignment owns a distinct attachment", status == 201 and second_document_id != attachment_id, f"HTTP {status}: {message(second_upload)}")
    status, injected, _, _ = request("POST", f"/api/public/forms/{token}", {"answers": {"attachment": [second_document_id]}, "submit": False}, headers={"x-voxera-synthetic-data": "1"})
    check("an attachment from another response is rejected", status == 400 and "not uploaded for this form response" in message(injected), f"HTTP {status}: {message(injected)}")
    status, second_current, _, _ = request("GET", f"/api/v1/forms/assignments/{second_id}", cookie=cookie)
    status, revoked, _, _ = request("PATCH", f"/api/v1/forms/assignments/{second_id}", {"action": "revoke", "expectedRevision": second_current.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("staff can revoke an unfinished form link", status == 200 and revoked.get("status") == "revoked", f"HTTP {status}: {message(revoked)}")
    revoked_get = request("GET", f"/api/public/forms/{second_token}")[0]
    revoked_post = request("POST", f"/api/public/forms/{second_token}", {"answers": {}, "submit": False}, headers={"x-voxera-synthetic-data": "1"})[0]
    revoked_upload = request("PUT", f"/api/public/forms/{second_token}/uploads", raw=probe_pdf, headers=upload_headers)[0]
    check("revocation closes view, save and upload boundaries", revoked_get == 403 and revoked_post == 409 and revoked_upload == 409, f"GET/POST/PUT {revoked_get}/{revoked_post}/{revoked_upload}")

    status, rejected_hidden, _, _ = request("POST", f"/api/public/forms/{token}", {"answers": {"preferred_name": "Synthetic A", "symptoms": False, "detail": "must not be accepted", "confirm": True}, "submit": True}, headers={"x-voxera-synthetic-data": "1"})
    check("hidden form answers rejected", status == 400 and "Hidden field" in message(rejected_hidden), f"HTTP {status}: {message(rejected_hidden)}")
    status, submitted, _, _ = request("POST", f"/api/public/forms/{token}", {"answers": {"preferred_name": "Synthetic A", "symptoms": False, "attachment": [attachment_id], "confirm": True}, "submit": True, "respondent": {"relationship": "self"}}, headers={"x-voxera-synthetic-data": "1"})
    check("public form submitted", status == 200 and submitted.get("status") == "submitted", f"HTTP {status}: {message(submitted)}")
    status, response_list, _, _ = request("GET", "/api/v1/forms/responses?status=submitted", cookie=cookie)
    matching = [row for row in response_list.get("data", []) if row.get("assignmentId") == assigned.get("assignment", {}).get("id")]
    check("submission enters review inbox", status == 200 and len(matching) == 1, f"HTTP {status}")
    response_id = matching[0].get("id", "") if matching else ""
    status, response_detail, _, _ = request("GET", f"/api/v1/forms/responses/{response_id}", cookie=cookie)
    suggestions = response_detail.get("suggestions", []) if isinstance(response_detail, dict) else []
    check("review detail contains immutable answers and pending update", status == 200 and response_detail.get("version", {}).get("answers", {}).get("preferred_name") == "Synthetic A" and len(suggestions) == 1, f"HTTP {status}")
    suggestion = suggestions[0] if suggestions else {}
    status, decision, _, _ = request("PATCH", f"/api/v1/forms/suggestions/{suggestion.get('id')}", {"accept": True, "expectedRevision": suggestion.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("patient update requires explicit acceptance", status == 200 and decision.get("client", {}).get("name") == "Synthetic A", f"HTTP {status}: {message(decision)}")

    referral_payload = {"source": "manual", "patient": {"name": f"Referral {STAMP}", "email": f"ref-{STAMP}@example.test", "dateOfBirth": "1985-08-22"}, "referrer": {"name": "Synthetic Case Manager", "email": f"referrer-{STAMP}@example.test", "organisation": "Synthetic Referrals"}, "priority": "urgent", "reason": "Synthetic mobility assessment"}
    status, referral_created, _, _ = request("POST", "/api/v1/referrals", referral_payload, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    referral = referral_created.get("referral", {}) if isinstance(referral_created, dict) else {}
    check("urgent referral received", status == 201 and referral.get("status") == "received" and referral.get("priority") == "urgent", f"HTTP {status}: {message(referral_created)}")
    desk_cookie = login("desk@northwind.dev", "demo-password-2026")
    status, desk_denied, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", {"action": "transition", "to": "triaged", "expectedRevision": referral.get("revision")}, cookie=desk_cookie, headers={"x-voxera-synthetic-data": "1"})
    check("reception cannot make triage decisions", status == 403, f"HTTP {status}: {message(desk_denied)}")
    status, triaged, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", {"action": "transition", "to": "triaged", "note": "Synthetic triage", "expectedRevision": referral.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("authorised triage transition recorded", status == 200 and triaged.get("status") == "triaged", f"HTTP {status}: {message(triaged)}")
    status, accepted, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", {"action": "transition", "to": "accepted", "note": "Synthetic acceptance", "expectedRevision": triaged.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("referral accepted", status == 200 and accepted.get("status") == "accepted", f"HTTP {status}: {message(accepted)}")
    notification_payload = {"action": "notify_referrer", "expectedRevision": accepted.get("revision"), "subject": "Synthetic referral update", "message": "The referral has been accepted for administrative booking follow-up."}
    status, desk_notification, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", notification_payload, cookie=desk_cookie, headers={"x-voxera-synthetic-data": "1"})
    check("reception cannot send referral decisions externally", status == 403, f"HTTP {status}: {message(desk_notification)}")
    status, notification_queued, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", notification_payload, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    notification = notification_queued.get("notification", {}) if isinstance(notification_queued, dict) else {}
    check("authorised referrer notification is durably queued", status == 200 and notification.get("state") == "queued" and str(notification.get("id", "")).startswith("rfn_") and notification.get("to") == referral_payload["referrer"]["email"], f"HTTP {status}: {message(notification_queued)}")
    status, notification_retry, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", notification_payload, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("identical notification retry returns the same evidence", status == 200 and notification_retry.get("notification", {}).get("id") == notification.get("id"), f"HTTP {status}: {message(notification_retry)}")
    competing_payload = {**notification_payload, "message": "A different competing notification must not overwrite the first update."}
    status, notification_conflict, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", competing_payload, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("different notification content for one referral revision conflicts", status == 409, f"HTTP {status}: {message(notification_conflict)}")
    notification_detail = {}
    for _ in range(5):
        request("POST", "/api/v1/scheduler", {"action": "run", "job": "domain-jobs", "force": True}, cookie=cookie)
        _, current_detail, _, _ = request("GET", f"/api/v1/referrals/{referral.get('id')}", cookie=cookie)
        notifications = current_detail.get("notifications", []) if isinstance(current_detail, dict) else []
        notification_detail = next((row for row in notifications if row.get("id") == notification.get("id")), {})
        if notification_detail.get("messageId"):
            break
    check("domain-job scheduler materialises one controlled referral message", bool(notification_detail.get("messageId")) and notification_detail.get("state") in ("pending", "blocked", "sent", "failed"), notification_detail)
    status, converted, _, _ = request("PATCH", f"/api/v1/referrals/{referral.get('id')}", {"action": "convert", "expectedRevision": accepted.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("accepted referral converts to patient", status == 200 and converted.get("referral", {}).get("status") == "converted" and str(converted.get("client", {}).get("id", "")).startswith("cli_"), f"HTTP {status}: {message(converted)}")
    status, referral_detail, _, _ = request("GET", f"/api/v1/referrals/{referral.get('id')}", cookie=cookie)
    check("referral decision trail is complete", status == 200 and [event.get("to") for event in referral_detail.get("events", [])] == ["received", "triaged", "accepted", "converted"], f"HTTP {status}")

    letter_template_payload = {"name": f"API letter {STAMP}", "category": "clinical", "subject": "Regarding {{patient.name}}", "body": "Dear {{recipient.name}},\n\nSynthetic correspondence about {{patient.name}}.\n\n{{author.name}}", "footer": "{{practice.name}}", "requiresApproval": True}
    status, letter_template_created, _, _ = request("POST", "/api/v1/letters/templates", letter_template_payload, cookie=cookie)
    template = letter_template_created.get("template", {}) if isinstance(letter_template_created, dict) else {}
    check("letter template created", status == 201 and template.get("state") == "draft", f"HTTP {status}: {message(letter_template_created)}")
    status, letter_template_published, _, _ = request("PATCH", f"/api/v1/letters/templates/{template.get('id')}", {"action": "publish", "expectedRevision": template.get("revision")}, cookie=cookie)
    check("letter template published", status == 200 and letter_template_published.get("state") == "published", f"HTTP {status}: {message(letter_template_published)}")
    status, letter_created, _, _ = request("POST", "/api/v1/letters", {"templateId": template.get("id"), "clientId": client_id, "recipient": {"name": "Synthetic recipient", "email": f"letter-{STAMP}@example.test"}}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    letter = letter_created.get("letter", {}) if isinstance(letter_created, dict) else {}
    check("letter composed from snapshot", status == 201 and letter.get("status") == "draft" and letter_created.get("version", {}).get("body"), f"HTTP {status}: {message(letter_created)}")
    status, awaiting, _, _ = request("PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "submit", "expectedRevision": letter.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("letter submitted for approval", status == 200 and awaiting.get("status") == "awaiting_approval", f"HTTP {status}: {message(awaiting)}")
    status, approved, _, _ = request("PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "approve", "expectedRevision": awaiting.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    status2, finalised, _, _ = request("PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "finalise", "expectedRevision": approved.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("letter approval and finalisation persists encrypted evidence", status == 200 and status2 == 200 and finalised.get("status") == "finalised" and len(finalised.get("artifactHash", "")) == 64 and str(finalised.get("artifactDocumentId", "")).startswith("doc_gen_") and str(finalised.get("artifactVersionId", "")).startswith("dver_gen_"), f"HTTP {status}/{status2}: {message(finalised)}")
    status, pdf, pdf_headers, _ = request("GET", f"/api/v1/letters/{letter.get('id')}/pdf", cookie=cookie, binary=True)
    check("finalised PDF downloads with no-store policy", status == 200 and pdf.startswith(b"%PDF-") and pdf_headers.get("cache-control", "").startswith("no-store"), f"HTTP {status}")
    status, final_cancel, _, _ = request("PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "cancel", "expectedRevision": finalised.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("finalised evidence cannot be cancelled instead of corrected", status == 409, f"HTTP {status}: {message(final_cancel)}")
    status, queued, _, _ = request("PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "email", "to": f"letter-{STAMP}@example.test", "expectedRevision": finalised.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("finalised letter enters controlled message queue", status == 200 and queued.get("letter", {}).get("status") in ("queued", "failed") and queued.get("message", {}).get("meta", {}).get("artifactHash") == finalised.get("artifactHash"), f"HTTP {status}: {message(queued)}")
    status, stale, _, _ = request("PATCH", f"/api/v1/letters/{letter.get('id')}", {"action": "email", "to": f"letter-{STAMP}@example.test", "expectedRevision": finalised.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("stale delivery retry is rejected", status == 409, f"HTTP {status}: {message(stale)}")

    status, correction_source_created, _, _ = request("POST", "/api/v1/letters", {"templateId": template.get("id"), "clientId": client_id, "recipient": {"name": "Correction recipient", "email": f"correction-{STAMP}@example.test"}}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    correction_source = correction_source_created.get("letter", {}) if isinstance(correction_source_created, dict) else {}
    status1, correction_source_awaiting, _, _ = request("PATCH", f"/api/v1/letters/{correction_source.get('id')}", {"action": "submit", "expectedRevision": correction_source.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    status2, correction_source_approved, _, _ = request("PATCH", f"/api/v1/letters/{correction_source.get('id')}", {"action": "approve", "expectedRevision": correction_source_awaiting.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    status3, correction_source_finalised, _, _ = request("PATCH", f"/api/v1/letters/{correction_source.get('id')}", {"action": "finalise", "expectedRevision": correction_source_approved.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("second source letter is finalised for correction", status == 201 and status1 == status2 == status3 == 200 and correction_source_finalised.get("status") == "finalised", f"HTTP {status}/{status1}/{status2}/{status3}")
    pdf_status, correction_source_pdf, _, _ = request("GET", f"/api/v1/letters/{correction_source.get('id')}/pdf", cookie=cookie, binary=True)
    correction_request = {"action": "correct", "expectedRevision": correction_source_finalised.get("revision"), "reason": "The finalised wording requires a factual administrative correction."}
    status, desk_correction, _, _ = request("PATCH", f"/api/v1/letters/{correction_source.get('id')}", correction_request, cookie=desk_cookie, headers={"x-voxera-synthetic-data": "1"})
    check("reception cannot create final-evidence corrections", status == 403, f"HTTP {status}: {message(desk_correction)}")
    status, correction_created, _, _ = request("PATCH", f"/api/v1/letters/{correction_source.get('id')}", correction_request, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    corrected_source = correction_created.get("corrected", {}) if isinstance(correction_created, dict) else {}
    correction_letter = correction_created.get("letter", {}) if isinstance(correction_created, dict) else {}
    correction_version = correction_created.get("version", {}) if isinstance(correction_created, dict) else {}
    check("authorised correction creates a linked draft", status == 200 and corrected_source.get("status") == "corrected" and corrected_source.get("correctedByLetterId") == correction_letter.get("id") and correction_letter.get("correctsLetterId") == correction_source.get("id") and correction_letter.get("status") == "draft", f"HTTP {status}: {message(correction_created)}")
    status, duplicate_correction, _, _ = request("PATCH", f"/api/v1/letters/{correction_source.get('id')}", {**correction_request, "expectedRevision": corrected_source.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("second correction of the same evidence conflicts", status == 409, f"HTTP {status}: {message(duplicate_correction)}")
    detail_status, corrected_detail, _, _ = request("GET", f"/api/v1/letters/{correction_source.get('id')}", cookie=cookie)
    after_pdf_status, correction_source_pdf_after, _, _ = request("GET", f"/api/v1/letters/{correction_source.get('id')}/pdf", cookie=cookie, binary=True)
    check("corrected source retains exact downloadable artifact evidence", pdf_status == detail_status == after_pdf_status == 200 and corrected_detail.get("letter", {}).get("artifactHash") == correction_source_finalised.get("artifactHash") and correction_source_pdf_after == correction_source_pdf, f"HTTP {pdf_status}/{detail_status}/{after_pdf_status}")
    revised_body = f"{correction_version.get('body', '')}\n\nCorrection: factual administrative wording updated."
    status, correction_revised, _, _ = request("PATCH", f"/api/v1/letters/{correction_letter.get('id')}", {"action": "revise", "expectedRevision": correction_letter.get("revision"), "subject": correction_version.get("subject"), "body": revised_body, "footer": correction_version.get("footer")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    revised_letter = correction_revised.get("letter", {}) if isinstance(correction_revised, dict) else {}
    status1, correction_awaiting, _, _ = request("PATCH", f"/api/v1/letters/{correction_letter.get('id')}", {"action": "submit", "expectedRevision": revised_letter.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    status2, correction_approved, _, _ = request("PATCH", f"/api/v1/letters/{correction_letter.get('id')}", {"action": "approve", "expectedRevision": correction_awaiting.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    status3, correction_finalised, _, _ = request("PATCH", f"/api/v1/letters/{correction_letter.get('id')}", {"action": "finalise", "expectedRevision": correction_approved.get("revision")}, cookie=cookie, headers={"x-voxera-synthetic-data": "1"})
    check("linked correction finalises to a distinct superseding artifact", status == status1 == status2 == status3 == 200 and correction_finalised.get("status") == "finalised" and correction_finalised.get("correctsLetterId") == correction_source.get("id") and correction_finalised.get("artifactHash") != correction_source_finalised.get("artifactHash"), f"HTTP {status}/{status1}/{status2}/{status3}: {message(correction_finalised)}")

    status, patient_detail, _, _ = request("GET", f"/api/v1/clients/{client_id}", cookie=cookie)
    check("patient aggregate links forms and correspondence without answer leakage", status == 200 and len(patient_detail.get("formAssignments", [])) >= 1 and len(patient_detail.get("letters", [])) >= 1 and "answers" not in json.dumps(patient_detail.get("formResponses", [])), f"HTTP {status}")

    print(f"\n{passes} passed / {len(failures)} failed")
    if failures:
        print("Failures: " + ", ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
