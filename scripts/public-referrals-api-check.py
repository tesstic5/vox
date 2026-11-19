#!/usr/bin/env python3
"""HTTP/security gate for public referral configuration, drafts, uploads and inbox evidence."""
from __future__ import annotations

import http.client
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3201").rstrip("/")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
STAMP = secrets.token_hex(5)
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


def request(method: str, path: str, body: object | None = None, *, cookie: str = "", raw: bytes | None = None, headers: dict[str, str] | None = None):
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("accept", "application/json")
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
            try:
                payload = json.loads(content or b"{}")
            except json.JSONDecodeError:
                payload = content
            return response.status, payload, response.headers, response.headers.get("set-cookie", "").split(";", 1)[0]
    except urllib.error.HTTPError as error:
        content = error.read()
        try:
            payload = json.loads(content or b"{}")
        except json.JSONDecodeError:
            payload = content.decode("utf-8", "replace")
        return error.code, payload, error.headers, ""


def oversized_header_request(path: str, headers: dict[str, str]):
    target = urllib.parse.urlsplit(BASE)
    connection = http.client.HTTPSConnection(target.hostname, target.port or 443, timeout=30) if target.scheme == "https" else http.client.HTTPConnection(target.hostname, target.port or 80, timeout=30)
    connection.putrequest("PUT", (target.path.rstrip("/") + path) or "/")
    connection.putheader("accept", "application/json")
    connection.putheader("content-length", str(10 * 1024 * 1024 + 1))
    connection.putheader("x-voxera-synthetic-data", "1")
    for key, value in headers.items():
        connection.putheader(key, value)
    connection.endheaders()
    response = connection.getresponse()
    content = response.read()
    try:
        payload = json.loads(content or b"{}")
    except json.JSONDecodeError:
        payload = content.decode("utf-8", "replace")
    status = response.status
    connection.close()
    return status, payload


def main() -> int:
    status, payload, _, cookie = request("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("owner signs in", status == 200 and bool(cookie), f"HTTP {status}: {message(payload)}")
    if not cookie:
        return 1

    status, migrated, _, _ = request("POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"}, cookie=cookie)
    check("checksummed data migrations are current", status == 200 and migrated.get("completed") == migrated.get("total"), f"HTTP {status}: {message(migrated)}")
    status, mode, _, _ = request("POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"}, cookie=cookie)
    check("isolated workspace is in synthetic-test mode", status == 200 and mode.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}: {message(mode)}")

    unauth_status, unauth, _, _ = request("GET", "/api/v1/referral-forms")
    check("referral-form administration requires authentication", unauth_status == 401, f"HTTP {unauth_status}: {message(unauth)}")

    schema = {
        "version": 1,
        "title": f"Synthetic referral {STAMP}",
        "description": "Synthetic HTTP referral evidence only.",
        "fields": [
            {"id": "patient_name", "key": "patient_name", "label": "Patient name", "type": "text", "required": True, "updateTarget": "name"},
            {"id": "date_of_birth", "key": "date_of_birth", "label": "Date of birth", "type": "date", "required": True},
            {"id": "patient_email", "key": "patient_email", "label": "Patient email", "type": "text", "required": True},
            {"id": "reason", "key": "reason", "label": "Reason for referral", "type": "long_text", "required": True},
            {"id": "consent", "key": "consent", "label": "Permission confirmed", "type": "acknowledgement", "required": True},
            {"id": "attachment", "key": "attachment", "label": "Supporting attachment", "type": "file"},
        ],
    }
    status, created, _, _ = request("POST", "/api/v1/forms/templates", {"name": schema["title"], "category": "referral", "schema": schema}, cookie=cookie)
    template = created.get("template", {}) if isinstance(created, dict) else {}
    check("referral template draft is created", status == 201 and str(template.get("id", "")).startswith("frm_"), f"HTTP {status}: {message(created)}")
    status, published, _, _ = request("PATCH", f"/api/v1/forms/templates/{template.get('id')}", {"action": "publish", "expectedRevision": template.get("revision")}, cookie=cookie)
    check("referral template is explicitly published", status == 200 and published.get("state") == "published", f"HTTP {status}: {message(published)}")

    slug = f"synthetic-referral-{STAMP}"
    config = {
        "name": f"Website referral {STAMP}", "slug": slug, "templateId": template.get("id"),
        "mapping": {"patientName": "patient_name", "dateOfBirth": "date_of_birth", "email": "patient_email", "reason": "reason", "consent": "consent"},
        "routing": {"priority": "routine"},
        "privacyNotice": "Synthetic information is processed only to verify this isolated referral workflow; never enter real patient data.",
        "emergencyNotice": "This synthetic form is not monitored continuously and must never be used for urgent or emergency concerns.",
        "completionMessage": "The synthetic referral was received for administrative review.",
        "active": True,
    }
    status, form, _, _ = request("POST", "/api/v1/referral-forms", config, cookie=cookie)
    check("public referral configuration is created active", status == 201 and form.get("slug") == slug and form.get("publicPath") == f"/refer/{slug}" and form.get("active") is True, f"HTTP {status}: {message(form)}")
    form_id = form.get("id", "")

    status2, collision, _, _ = request("POST", "/api/v1/referral-forms", {**config, "name": "Collision"}, cookie=cookie)
    collision_text = message(collision).lower()
    check("duplicate slug returns a controlled conflict without storage details", status2 == 409 and "already in use" in collision_text and all(term not in collision_text for term in ("sqlite", "unique constraint", "docs_referral")), f"HTTP {status2}: {message(collision)}")
    immutable_status, immutable, _, _ = request("PATCH", f"/api/v1/referral-forms/{form_id}", {"expectedRevision": form.get("revision"), "patch": {"slug": "changed-address"}}, cookie=cookie)
    check("public slug is immutable through the API", immutable_status == 400 and "immutable" in message(immutable).lower(), f"HTTP {immutable_status}: {message(immutable)}")

    status, public, public_headers, _ = request("GET", f"/api/public/referrals/{slug}")
    public_json = json.dumps(public)
    fields = public.get("schema", {}).get("fields", []) if isinstance(public, dict) else []
    privacy_headers = public_headers.get("cache-control", "") == "no-store, private" and public_headers.get("referrer-policy") == "no-referrer" and "noindex" in public_headers.get("x-robots-tag", "")
    check("public configuration is privacy-labelled and identifies synthetic mode", status == 200 and public.get("operatingMode") == "synthetic_test" and privacy_headers, f"HTTP {status}")
    check("public schema strips internal update mappings and bearer material", all("updateTarget" not in field for field in fields) and "tokenHash" not in public_json and "createdBy" not in public_json, public_json[:240])
    missing_status, missing, missing_headers, _ = request("GET", f"/api/public/referrals/not-a-real-{STAMP}")
    check("unknown public addresses use a generic no-store response", missing_status == 404 and "unavailable" in message(missing).lower() and "no-store" in missing_headers.get("cache-control", ""), f"HTTP {missing_status}: {message(missing)}")

    status, started, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "start"})
    token = str(started.get("draftToken", "")) if isinstance(started, dict) else ""
    check("public draft returns one opaque expiring token", status == 201 and token.startswith("rrd_") and started.get("status") == "draft" and "tokenHash" not in json.dumps(started), f"HTTP {status}: {message(started)}")
    status, resumed, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "resume", "draftToken": token})
    check("opaque token resumes only its draft", status == 200 and resumed.get("status") == "draft" and resumed.get("answers") == {}, f"HTTP {status}: {message(resumed)}")
    bad_token_status, bad_token, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "resume", "draftToken": "rrd_" + "x" * 43})
    check("invalid opaque token reveals no tenant or storage detail", bad_token_status == 404 and "draft is unavailable" in message(bad_token).lower() and "org_" not in json.dumps(bad_token), f"HTTP {bad_token_status}: {message(bad_token)}")

    partial_answers = {"patient_name": f"Synthetic Patient {STAMP}"}
    status, saved, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "save", "draftToken": token, "answers": partial_answers})
    check("partial referral draft saves", status == 200 and saved.get("status") == "draft" and bool(saved.get("savedAt")), f"HTTP {status}: {message(saved)}")
    injection_status, injection, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "save", "draftToken": token, "answers": {**partial_answers, "invented": "injected"}})
    check("answer injection is rejected", injection_status == 400 and "unknown form answer" in message(injection).lower(), f"HTTP {injection_status}: {message(injection)}")

    wrong_status, wrong, _, _ = request("PUT", f"/api/public/referrals/{slug}/uploads", raw=b"not a pdf", headers={"content-type": "application/pdf", "x-voxera-file-name": "wrong.pdf", "x-voxera-form-field": "attachment", "x-voxera-referral-draft": token})
    check("attachment signature mismatch is rejected", wrong_status == 400 and "signature" in message(wrong).lower(), f"HTTP {wrong_status}: {message(wrong)}")
    oversized_status, oversized = oversized_header_request(f"/api/public/referrals/{slug}/uploads", {"content-type": "application/pdf", "x-voxera-file-name": "oversized.pdf", "x-voxera-form-field": "attachment", "x-voxera-referral-draft": token})
    check("declared upload bytes are capped at 10 MB", oversized_status == 413 and "10 mb" in message(oversized).lower(), f"HTTP {oversized_status}: {message(oversized)}")
    pdf = b"%PDF-1.4\n% synthetic HTTP referral evidence\n%%EOF\n"
    status, uploaded, _, _ = request("PUT", f"/api/public/referrals/{slug}/uploads", raw=pdf, headers={"content-type": "application/pdf", "x-voxera-file-name": "synthetic.pdf", "x-voxera-form-field": "attachment", "x-voxera-referral-draft": token})
    document_id = uploaded.get("documentId", "") if isinstance(uploaded, dict) else ""
    check("valid attachment is encrypted and quarantined", status == 201 and str(document_id).startswith("doc_") and uploaded.get("scanStatus") in ("pending", "unavailable"), f"HTTP {status}: {message(uploaded)}")

    email = f"public-referral-{STAMP}@example.test"
    complete_answers = {
        "patient_name": f"Synthetic Patient {STAMP}", "date_of_birth": "1991-03-14", "patient_email": email,
        "reason": "<script>must remain inert</script> synthetic shoulder evidence", "consent": True, "attachment": [document_id],
    }
    missing_attachment_status, missing_attachment, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "submit", "draftToken": token, "answers": {key: value for key, value in complete_answers.items() if key != "attachment"}})
    check("submission cannot omit a secured attachment", missing_attachment_status == 400 and "do not match" in message(missing_attachment).lower(), f"HTTP {missing_attachment_status}: {message(missing_attachment)}")
    status, submitted, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "submit", "draftToken": token, "answers": complete_answers})
    check("valid public referral reaches the administrative queue", status == 201 and submitted.get("status") == "received" and bool(submitted.get("reference")), f"HTTP {status}: {message(submitted)}")
    double_status, double, _, _ = request("POST", f"/api/public/referrals/{slug}", {"action": "submit", "draftToken": token, "answers": complete_answers})
    double_text = message(double).lower()
    check("double submit is a controlled conflict without database detail", double_status == 409 and "already submitted" in double_text and all(term not in double_text for term in ("duplicate key", "sqlite", "voxera_docs")), f"HTTP {double_status}: {message(double)}")

    query = urllib.parse.quote(email)
    status, referrals, _, _ = request("GET", f"/api/v1/referrals?q={query}", cookie=cookie)
    matches = [row for row in referrals.get("data", []) if row.get("patient", {}).get("email") == email] if isinstance(referrals, dict) else []
    check("submission creates exactly one secure-form referral", status == 200 and len(matches) == 1 and matches[0].get("source") == "secure_form" and matches[0].get("priority") == "routine", f"matches={len(matches)}")
    referral_id = matches[0].get("id", "") if matches else ""
    status, detail, _, _ = request("GET", f"/api/v1/referrals/{referral_id}", cookie=cookie)
    submission = detail.get("publicSubmission", {}) if isinstance(detail, dict) else {}
    attachments = detail.get("attachments", []) if isinstance(detail, dict) else []
    reason_value = submission.get("answers", {}).get("reason") if isinstance(submission.get("answers"), dict) else None
    check("staff detail exposes verified pinned submission evidence", status == 200 and submission.get("templateVersion") == 1 and submission.get("evidence", {}).get("verified") is True and reason_value == complete_answers["reason"], f"HTTP {status}: {message(detail)}")
    check("staff detail resolves the exact quarantined attachment", len(attachments) == 1 and attachments[0].get("id") == document_id and not attachments[0].get("downloadPath"), attachments)

    status, listed, _, _ = request("GET", "/api/v1/referral-forms", cookie=cookie)
    listed_json = json.dumps(listed)
    check("administration list never returns draft tokens or submission answers", status == 200 and "tokenHash" not in listed_json and "draftToken" not in listed_json and "answers" not in listed_json, listed_json[:240])
    stale_status, stale, _, _ = request("PATCH", f"/api/v1/referral-forms/{form_id}", {"expectedRevision": max(0, int(form.get("revision", 1)) - 1), "patch": {"active": False}}, cookie=cookie)
    check("stale referral-form update is refused", stale_status == 409 and "changed" in message(stale).lower(), f"HTTP {stale_status}: {message(stale)}")
    current = next((row for row in listed.get("data", []) if row.get("id") == form_id), {})
    status, disabled, _, _ = request("PATCH", f"/api/v1/referral-forms/{form_id}", {"expectedRevision": current.get("revision"), "patch": {"active": False}}, cookie=cookie)
    check("owner can disable new public intake without deleting evidence", status == 200 and disabled.get("active") is False, f"HTTP {status}: {message(disabled)}")
    unavailable_status, unavailable, _, _ = request("GET", f"/api/public/referrals/{slug}")
    status, preserved, _, _ = request("GET", f"/api/v1/referrals/{referral_id}", cookie=cookie)
    check("disable rollback closes the public address and preserves submitted evidence", unavailable_status == 404 and status == 200 and preserved.get("publicSubmission", {}).get("evidence", {}).get("verified") is True, f"public={unavailable_status} detail={status}")

    print(f"\n{PASS} passed / {len(FAIL)} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
