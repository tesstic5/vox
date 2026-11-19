#!/usr/bin/env python3
"""HTTP verification for associated contacts, patient relationships and typed custom fields.

Run only against an isolated synthetic fixture. Every patient-data write carries the
synthetic acknowledgement header.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000").rstrip("/")
STAMP = secrets.token_hex(5)
passes = 0
failures: list[str] = []
SYNTHETIC = {"x-voxera-synthetic-data": "1"}


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
    req.add_header("x-forwarded-for", "198.51.100.91")
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
    return str(payload)[:200]


def login(email: str, password: str = "demo-password-2026") -> str:
    status, body, cookie = request("POST", "/api/auth/login", {"email": email, "password": password})
    check(f"sign in {email}", status == 200 and bool(cookie), f"HTTP {status}: {message(body)}")
    return cookie


def main() -> None:
    owner = login("jordan@northwind.dev")
    desk = login("desk@northwind.dev")

    status, migrated, _ = request("POST", "/api/v1/clinical/migrations", {"confirmation": "RUN PHASE 1 DATA MIGRATIONS"}, cookie=owner)
    check("checksummed migrations include the intake slice", status == 200 and migrated.get("completed") == migrated.get("total"), f"HTTP {status}: {message(migrated)}")
    status, readiness, _ = request("POST", "/api/v1/clinical/readiness", {"mode": "synthetic_test"}, cookie=owner)
    check("synthetic-test mode enabled", status == 200 and readiness.get("profile", {}).get("operatingMode") == "synthetic_test", f"HTTP {status}: {message(readiness)}")

    status, unauthenticated, _ = request("GET", "/api/v1/contacts")
    check("contact directory requires authentication", status == 401, f"HTTP {status}: {message(unauthenticated)}")

    patient_payload = {
        "name": f"Intake Patient {STAMP}", "number": f"+44771{int(STAMP[:7], 16) % 10000000:07d}",
        "email": f"intake-{STAMP}@example.test", "dateOfBirth": "1992-03-04", "address": "1 Legacy API Road, Oldtown",
    }
    status, patient, _ = request("POST", "/api/v1/clients", patient_payload, cookie=owner, headers=SYNTHETIC)
    patient_id = patient.get("id", "") if isinstance(patient, dict) else ""
    check("synthetic patient created", status == 201 and str(patient_id).startswith("cli_"), f"HTTP {status}: {message(patient)}")

    contact_payload = {
        "kind": "person", "name": f"Guardian {STAMP}", "email": f"guardian-{STAMP}@example.test",
        "phone": "+447700920001", "address": "2 Legacy API Road, Oldtown", "payer": True,
    }
    status, contact, _ = request("POST", "/api/v1/contacts", contact_payload, cookie=owner, headers=SYNTHETIC)
    contact_id = contact.get("id", "") if isinstance(contact, dict) else ""
    check("associated contact created", status == 201 and str(contact_id).startswith("con_") and contact.get("revision") == 1, f"HTTP {status}: {message(contact)}")
    status, invalid_kind, _ = request("POST", "/api/v1/contacts", {"kind": "patient", "name": "Invalid Kind"}, cookie=owner, headers=SYNTHETIC)
    check("forged contact kind rejected", status == 400 and "kind" in message(invalid_kind).lower(), f"HTTP {status}: {message(invalid_kind)}")
    status, invalid_bool, _ = request("POST", "/api/v1/contacts", {"name": "Invalid Boolean", "payer": "false"}, cookie=owner, headers=SYNTHETIC)
    check("forged contact boolean rejected", status == 400 and "true or false" in message(invalid_bool), f"HTTP {status}: {message(invalid_bool)}")
    status, stale_contact, _ = request("PATCH", f"/api/v1/contacts/{contact_id}", {"expectedRevision": 0, "patch": {"name": "Stale"}}, cookie=owner, headers=SYNTHETIC)
    check("stale contact revision refused", status == 409, f"HTTP {status}: {message(stale_contact)}")
    status, immutable_contact, _ = request("PATCH", f"/api/v1/contacts/{contact_id}", {"expectedRevision": contact.get("revision"), "patch": {"orgId": "forged"}}, cookie=owner, headers=SYNTHETIC)
    check("unsupported contact patch refused explicitly", status == 400 and "cannot be changed" in message(immutable_contact), f"HTTP {status}: {message(immutable_contact)}")
    contact_address = {"line1": "2 API Road", "city": "Leeds", "county": "West Yorkshire", "postcode": "LS1 1AA", "countryCode": "GB"}
    status, reviewed_contact, _ = request("PUT", f"/api/v1/contacts/{contact_id}/address", {"expectedRevision": contact.get("revision"), "address": contact_address}, cookie=owner, headers=SYNTHETIC)
    check("contact legacy address is explicitly reviewed without losing its source", status == 200 and reviewed_contact.get("structuredAddress", {}).get("reviewStatus") == "reviewed" and reviewed_contact.get("structuredAddress", {}).get("legacyText") == contact_payload["address"] and "Leeds" in reviewed_contact.get("address", ""), f"HTTP {status}: {message(reviewed_contact)}")
    status, stale_contact_address, _ = request("PUT", f"/api/v1/contacts/{contact_id}/address", {"expectedRevision": contact.get("revision"), "address": contact_address}, cookie=owner, headers=SYNTHETIC)
    check("stale contact address review is refused", status == 409, f"HTTP {status}: {message(stale_contact_address)}")
    patient_address = {"line1": "1 API Road", "city": "York", "postcode": "YO1 1AA", "countryCode": "GB"}
    status, reviewed_patient, _ = request("PUT", f"/api/v1/clients/{patient_id}/address", {"expectedRevision": patient.get("revision"), "address": patient_address}, cookie=owner, headers=SYNTHETIC)
    check("patient address review is revision checked and preserves legacy text", status == 200 and reviewed_patient.get("structuredAddress", {}).get("legacyText") == patient_payload["address"] and reviewed_patient.get("structuredAddress", {}).get("reviewStatus") == "reviewed", f"HTTP {status}: {message(reviewed_patient)}")

    relationship_payload = {"contactId": contact_id, "relationshipType": "guardian", "guardian": True, "proxy": True, "billing": True, "verified": True}
    status, relationship, _ = request("POST", f"/api/v1/clients/{patient_id}/relationships", relationship_payload, cookie=owner, headers=SYNTHETIC)
    relationship_id = relationship.get("id", "") if isinstance(relationship, dict) else ""
    check("verified guardian relationship created", status == 201 and relationship.get("verified") is True and str(relationship_id).startswith("rel_"), f"HTTP {status}: {message(relationship)}")
    status, duplicate_relationship, _ = request("POST", f"/api/v1/clients/{patient_id}/relationships", relationship_payload, cookie=owner, headers=SYNTHETIC)
    check("duplicate active relationship refused", status == 409 and "docs" not in message(duplicate_relationship).lower() and "constraint" not in message(duplicate_relationship).lower(), f"HTTP {status}: {message(duplicate_relationship)}")
    status, relationship_list, _ = request("GET", f"/api/v1/clients/{patient_id}/relationships", cookie=owner)
    linked = relationship_list.get("data", [{}])[0] if isinstance(relationship_list, dict) and relationship_list.get("data") else {}
    check("relationship list resolves its contact without leaking another record", status == 200 and linked.get("contact", {}).get("id") == contact_id and linked.get("contact", {}).get("orgId") == patient.get("orgId"), f"HTTP {status}")

    field_key = f"mobility_{STAMP}"
    field_payload = {
        "targetType": "client", "key": field_key, "label": "Mobility level", "valueType": "single_choice",
        "options": [{"value": "basic", "label": "Basic"}, {"value": "advanced", "label": "Advanced"}, {"value": "independent", "label": "Independent"}],
        "sensitivity": "sensitive", "required": False,
    }
    status, definition, _ = request("POST", "/api/v1/custom-fields", field_payload, cookie=owner)
    definition_id = definition.get("id", "") if isinstance(definition, dict) else ""
    check("typed sensitive custom field created", status == 201 and str(definition_id).startswith("cfd_") and definition.get("key") == field_key, f"HTTP {status}: {message(definition)}")
    status, duplicate_definition, _ = request("POST", "/api/v1/custom-fields", field_payload, cookie=owner)
    check("duplicate custom-field key refused", status == 409 and "constraint" not in message(duplicate_definition).lower(), f"HTTP {status}: {message(duplicate_definition)}")
    status, immutable_definition, _ = request("PATCH", f"/api/v1/custom-fields/{definition_id}", {"expectedRevision": definition.get("revision"), "patch": {"key": "renamed"}}, cookie=owner)
    check("custom-field key is explicitly immutable", status == 400 and "immutable" in message(immutable_definition).lower(), f"HTTP {status}: {message(immutable_definition)}")
    status, desk_def_create, _ = request("POST", "/api/v1/custom-fields", {**field_payload, "key": f"desk_{STAMP}"}, cookie=desk)
    check("reception cannot configure custom fields", status == 403, f"HTTP {status}: {message(desk_def_create)}")
    status, desk_fields, _ = request("GET", f"/api/v1/clients/{patient_id}/custom-fields", cookie=desk)
    check("reception does not receive restricted custom fields", status == 200 and all(row.get("definition", {}).get("id") != definition_id for row in desk_fields.get("data", [])), f"HTTP {status}")
    status, desk_write, _ = request("PUT", f"/api/v1/clients/{patient_id}/custom-fields", {"definitionId": definition_id, "value": "basic"}, cookie=desk, headers=SYNTHETIC)
    check("reception cannot write a restricted custom field", status == 403, f"HTTP {status}: {message(desk_write)}")

    contact_field_payload = {"targetType": "contact", "key": f"contact_channel_{STAMP}", "label": "Contact channel", "valueType": "single_choice", "options": [{"value": "email", "label": "Email"}, {"value": "phone", "label": "Phone"}], "sensitivity": "administrative"}
    status, contact_definition, _ = request("POST", "/api/v1/custom-fields", contact_field_payload, cookie=owner)
    contact_definition_id = contact_definition.get("id", "") if isinstance(contact_definition, dict) else ""
    check("associated-contact field definition created", status == 201 and str(contact_definition_id).startswith("cfd_"), f"HTTP {status}: {message(contact_definition)}")
    status, contact_value, _ = request("PUT", f"/api/v1/contacts/{contact_id}/custom-fields", {"definitionId": contact_definition_id, "value": "email", "expectedRevision": None}, cookie=owner, headers=SYNTHETIC)
    check("associated-contact value entry is typed and verified", status == 200 and contact_value.get("value") == "email" and contact_value.get("verificationStatus") == "verified", f"HTTP {status}: {message(contact_value)}")
    status, contact_values, _ = request("GET", f"/api/v1/contacts/{contact_id}/custom-fields", cookie=owner)
    contact_entry = next((row for row in contact_values.get("data", []) if row.get("definition", {}).get("id") == contact_definition_id), {})
    check("associated-contact value round-trips with its definition", status == 200 and contact_entry.get("value", {}).get("id") == contact_value.get("id"), f"HTTP {status}")
    status, stale_contact_value, _ = request("PUT", f"/api/v1/contacts/{contact_id}/custom-fields", {"definitionId": contact_definition_id, "value": "phone", "expectedRevision": None}, cookie=owner, headers=SYNTHETIC)
    check("existing associated-contact value requires its revision", status == 409, f"HTTP {status}: {message(stale_contact_value)}")

    referral_payload = {"source": "manual", "patient": {"name": f"Referral Field Patient {STAMP}", "address": "3 Legacy API Road, Oldtown"}, "priority": "routine", "reason": "Synthetic custom-field and address review"}
    status, referral_created, _ = request("POST", "/api/v1/referrals", referral_payload, cookie=owner, headers=SYNTHETIC)
    referral = referral_created.get("referral", {}) if isinstance(referral_created, dict) else {}
    referral_id = referral.get("id", "")
    check("referral target created for generic values", status == 201 and str(referral_id).startswith("ref_"), f"HTTP {status}: {message(referral_created)}")
    referral_field_payload = {"targetType": "referral", "key": f"source_category_{STAMP}", "label": "Source category", "valueType": "text", "sensitivity": "administrative"}
    status, referral_definition, _ = request("POST", "/api/v1/custom-fields", referral_field_payload, cookie=owner)
    referral_definition_id = referral_definition.get("id", "") if isinstance(referral_definition, dict) else ""
    check("referral field definition created", status == 201 and str(referral_definition_id).startswith("cfd_"), f"HTTP {status}: {message(referral_definition)}")
    status, referral_value, _ = request("PUT", f"/api/v1/referrals/{referral_id}/custom-fields", {"definitionId": referral_definition_id, "value": "Community", "expectedRevision": None}, cookie=owner, headers=SYNTHETIC)
    check("referral value entry is typed and verified", status == 200 and referral_value.get("value") == "Community" and referral_value.get("source") == "staff", f"HTTP {status}: {message(referral_value)}")
    status, referral_values, _ = request("GET", f"/api/v1/referrals/{referral_id}/custom-fields", cookie=owner)
    check("referral value round-trips through its permission-scoped route", status == 200 and any(row.get("value", {}).get("id") == referral_value.get("id") for row in referral_values.get("data", [])), f"HTTP {status}")
    referral_address = {"line1": "3 API Road", "city": "Sheffield", "postcode": "S1 1AA", "countryCode": "GB"}
    status, reviewed_referral, _ = request("PUT", f"/api/v1/referrals/{referral_id}/address", {"expectedRevision": referral.get("revision"), "address": referral_address}, cookie=owner, headers=SYNTHETIC)
    check("referral address review preserves source text", status == 200 and reviewed_referral.get("patient", {}).get("structuredAddress", {}).get("legacyText") == referral_payload["patient"]["address"] and reviewed_referral.get("patient", {}).get("structuredAddress", {}).get("reviewStatus") == "reviewed", f"HTTP {status}: {message(reviewed_referral)}")
    status, stale_referral_address, _ = request("PUT", f"/api/v1/referrals/{referral_id}/address", {"expectedRevision": referral.get("revision"), "address": referral_address}, cookie=owner, headers=SYNTHETIC)
    check("stale referral address review is refused", status == 409, f"HTTP {status}: {message(stale_referral_address)}")

    schema = {
        "version": 1, "title": f"Mapped intake {STAMP}", "fields": [{
            "id": "mobility", "key": "mobility", "label": "Mobility level", "type": "single_choice", "required": True,
            "options": field_payload["options"], "updateTarget": f"custom:{field_key}", "sensitivity": "clinical",
        }],
    }
    status, template_created, _ = request("POST", "/api/v1/forms/templates", {"name": schema["title"], "category": "intake", "schema": schema}, cookie=owner)
    template = template_created.get("template", {}) if isinstance(template_created, dict) else {}
    check("form template accepts a compatible configured mapping", status == 201 and template.get("state") == "draft", f"HTTP {status}: {message(template_created)}")
    status, published, _ = request("PATCH", f"/api/v1/forms/templates/{template.get('id')}", {"action": "publish", "expectedRevision": template.get("revision")}, cookie=owner)
    check("mapped template published", status == 200 and published.get("state") == "published", f"HTTP {status}: {message(published)}")

    def submit_form(value: str):
        status, assigned, _ = request("POST", "/api/v1/forms/assignments", {"templateId": template.get("id"), "clientId": patient_id, "send": False}, cookie=owner, headers=SYNTHETIC)
        token = str(assigned.get("publicUrl", "")).rsplit("/", 1)[-1]
        submit_status, submitted, _ = request("POST", f"/api/public/forms/{token}", {"answers": {"mobility": value}, "submit": True, "respondent": {"relationship": "self"}}, headers=SYNTHETIC)
        response_status, responses, _ = request("GET", "/api/v1/forms/responses?status=submitted", cookie=owner)
        assignment_id = assigned.get("assignment", {}).get("id")
        matching = [row for row in responses.get("data", []) if row.get("assignmentId") == assignment_id]
        detail_status, detail, _ = request("GET", f"/api/v1/forms/responses/{matching[0].get('id') if matching else ''}", cookie=owner)
        return status, submit_status, response_status, detail_status, assigned, submitted, detail

    assign_status, submit_status, _, detail_status, _, _, detail = submit_form("advanced")
    suggestions = detail.get("suggestions", []) if isinstance(detail, dict) else []
    suggestion = suggestions[0] if suggestions else {}
    check("public mapped answer creates one pending typed suggestion", assign_status == 201 and submit_status == 200 and detail_status == 200 and len(suggestions) == 1 and suggestion.get("target") == f"custom:{field_key}" and suggestion.get("proposedTypedValue") == "advanced", f"statuses {assign_status}/{submit_status}/{detail_status}")
    status, before_value, _ = request("GET", f"/api/v1/clients/{patient_id}/custom-fields", cookie=owner)
    before_entry = next((row for row in before_value.get("data", []) if row.get("definition", {}).get("id") == definition_id), {})
    check("submission does not silently set the patient value", status == 200 and before_entry.get("value") is None, f"HTTP {status}")
    status, accepted, _ = request("PATCH", f"/api/v1/forms/suggestions/{suggestion.get('id')}", {"accept": True, "expectedRevision": suggestion.get("revision")}, cookie=owner, headers=SYNTHETIC)
    check("authorised explicit acceptance applies typed value", status == 200 and accepted.get("customFieldValue", {}).get("value") == "advanced" and accepted.get("customFieldValue", {}).get("source") == "form", f"HTTP {status}: {message(accepted)}")
    status, patient_after, _ = request("GET", f"/api/v1/clients/{patient_id}", cookie=owner)
    check("custom suggestion acceptance leaves core identity unchanged", status == 200 and patient_after.get("name") == patient_payload["name"], f"HTTP {status}")

    _, _, _, _, _, _, stale_detail = submit_form("basic")
    stale_suggestion = (stale_detail.get("suggestions") or [{}])[0]
    status, values, _ = request("GET", f"/api/v1/clients/{patient_id}/custom-fields", cookie=owner)
    value_entry = next(row for row in values.get("data", []) if row.get("definition", {}).get("id") == definition_id)
    current_revision = value_entry.get("value", {}).get("revision")
    status, intervening, _ = request("PUT", f"/api/v1/clients/{patient_id}/custom-fields", {"definitionId": definition_id, "value": "independent", "expectedRevision": current_revision}, cookie=owner, headers=SYNTHETIC)
    check("staff can make a revision-checked intervening update", status == 200 and intervening.get("value") == "independent", f"HTTP {status}: {message(intervening)}")
    status, stale_decision, _ = request("PATCH", f"/api/v1/forms/suggestions/{stale_suggestion.get('id')}", {"accept": True, "expectedRevision": stale_suggestion.get("revision")}, cookie=owner, headers=SYNTHETIC)
    leaked = message(stale_decision).lower()
    check("stale suggestion cannot overwrite newer value", status == 409 and "changed" in leaked and all(term not in leaked for term in ("sqlite", "constraint", "customfieldvalues", "docs/")), f"HTTP {status}: {message(stale_decision)}")
    status, stale_without_revision, _ = request("PUT", f"/api/v1/clients/{patient_id}/custom-fields", {"definitionId": definition_id, "value": "basic"}, cookie=owner, headers=SYNTHETIC)
    check("existing custom value requires expected revision", status == 400 and "expectedrevision" in message(stale_without_revision).lower().replace("`", ""), f"HTTP {status}: {message(stale_without_revision)}")

    # Exercise database-backed uniqueness through concurrent HTTP requests.
    status, race_contact, _ = request("POST", "/api/v1/contacts", {"name": f"Race Contact {STAMP}", "phone": "+447700920099"}, cookie=owner, headers=SYNTHETIC)
    race_contact_id = race_contact.get("id", "")
    race_relationship = {"contactId": race_contact_id, "relationshipType": "emergency_contact", "emergency": True}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: request("POST", f"/api/v1/clients/{patient_id}/relationships", race_relationship, cookie=owner, headers=SYNTHETIC), range(2)))
    codes = sorted(item[0] for item in outcomes)
    texts = " ".join(message(item[1]).lower() for item in outcomes)
    check("concurrent duplicate relationship has one winner", status == 201 and codes == [201, 409] and all(term not in texts for term in ("sqlite", "constraint", "docs_")), f"HTTP {codes}: {texts[:180]}")

    race_key = f"race_{STAMP}"
    race_definition = {"targetType": "client", "key": race_key, "label": "Race field", "valueType": "text", "sensitivity": "administrative"}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        field_outcomes = list(pool.map(lambda _: request("POST", "/api/v1/custom-fields", race_definition, cookie=owner), range(2)))
    field_codes = sorted(item[0] for item in field_outcomes)
    field_texts = " ".join(message(item[1]).lower() for item in field_outcomes)
    check("concurrent custom-field key creation has one winner", field_codes == [201, 409] and all(term not in field_texts for term in ("sqlite", "constraint", "docs_")), f"HTTP {field_codes}: {field_texts[:180]}")
    race_field = next((item[1] for item in field_outcomes if item[0] == 201), {})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        value_outcomes = list(pool.map(lambda value: request("PUT", f"/api/v1/clients/{patient_id}/custom-fields", {"definitionId": race_field.get("id"), "value": value, "expectedRevision": None}, cookie=owner, headers=SYNTHETIC), ["one", "two"]))
    value_codes = sorted(item[0] for item in value_outcomes)
    value_texts = " ".join(message(item[1]).lower() for item in value_outcomes)
    check("concurrent first custom value has one winner", value_codes == [200, 409] and all(term not in value_texts for term in ("sqlite", "constraint", "docs_")), f"HTTP {value_codes}: {value_texts[:180]}")

    status, ended, _ = request("DELETE", f"/api/v1/clients/{patient_id}/relationships/{relationship_id}?expectedRevision={relationship.get('revision')}", cookie=owner, headers=SYNTHETIC)
    check("relationship can be ended without deletion", status == 200 and ended.get("status") == "ended" and bool(ended.get("effectiveTo")), f"HTTP {status}: {message(ended)}")
    status, active_relationships, _ = request("GET", f"/api/v1/clients/{patient_id}/relationships", cookie=owner)
    check("ended relationship leaves the active list", status == 200 and all(row.get("id") != relationship_id for row in active_relationships.get("data", [])), f"HTTP {status}")
    status, history, _ = request("GET", f"/api/v1/clients/{patient_id}/relationships?includeEnded=true", cookie=owner)
    check("ended relationship remains in history", status == 200 and any(row.get("id") == relationship_id and row.get("status") == "ended" for row in history.get("data", [])), f"HTTP {status}")

    print(f"\nintake-admin-api-check: {passes} assertions passed")
    if failures:
        print(f"intake-admin-api-check: {len(failures)} failed — {', '.join(failures)}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
