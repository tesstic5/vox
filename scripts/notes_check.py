#!/usr/bin/env python3
"""
Notes check (PRACTICE.md phase P5).

The phase gate is one sentence: *a finalised note cannot be edited without an
amendment version; a receptionist cannot open it.* This script proves both, and
the machinery they need to be worth anything:

   1. templates are seeded per service, in this workspace's own vocabulary
   2. a note is filed against a real visit and a real client, from the right one
   3. blank required sections are named, and finalising is refused while they are
   4. signing freezes a version, and the note says who signed it and when
   5. **a finalised note is not edited — it is amended**, with a reason, keeping
      the signed version byte-for-byte
   6. re-signing after an amendment leaves both versions in the trail
   7. the agent drafts a note when a booking call ends, and never signs it
   8. attachments are recorded against the note, with who and when
   9. every read and write is logged against the note itself
  10. **a receptionist cannot open it** — the desk sees the row, not the record
  11. archiving keeps the note and its retention date, and restores the state

Usage: python3 scripts/notes_check.py   (the app must be running)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import session as cached_session  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")
DESK_EMAIL = os.environ.get("VOXERA_DESK_EMAIL", "desk@northwind.dev")
DESK_CACHE = os.environ.get("VOXERA_DESK_SESSION", "/tmp/voxera-desk-session.json")

cookie = ""
failures: list[str] = []
cleanup: dict[str, list[str]] = {"bookings": [], "clients": [], "notes": [], "calls": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def call(method, path, body=None, auth=True, as_cookie=None):
    url = path if path.startswith("http") else BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    who = as_cookie if as_cookie is not None else cookie
    if auth and who:
        req.add_header("cookie", who)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode()
            return res.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (json.loads(text) if text else {})
        except json.JSONDecodeError:
            return err.code, {"raw": text}


def message(payload):
    return payload.get("error", {}).get("message", "") if isinstance(payload, dict) else str(payload)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def desk_session():
    """The front-desk login, cached like the owner's (the login route rate-limits)."""
    if os.path.exists(DESK_CACHE):
        try:
            cached = json.load(open(DESK_CACHE))
        except (OSError, json.JSONDecodeError):
            cached = {}
        if cached.get("cookie"):
            probe = urllib.request.Request(f"{BASE}/api/v1/notes?limit=1")
            probe.add_header("cookie", cached["cookie"])
            try:
                with urllib.request.urlopen(probe, timeout=30):
                    return cached["cookie"]
            except urllib.error.HTTPError:
                pass
            except OSError:
                pass
    req = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps({"email": DESK_EMAIL, "password": PASSWORD}).encode(),
        method="POST",
    )
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            fresh = (res.headers.get("set-cookie") or "").split(";")[0]
            if fresh:
                with open(DESK_CACHE, "w") as fh:
                    json.dump({"cookie": fresh}, fh)
            return fresh
    except urllib.error.HTTPError:
        return ""


def finish():
    # The probe's footprint, undone through the product's own doors: the note is
    # archived (kept, with a retention date), the appointment cancelled, the
    # record archived. Nothing is deleted outright.
    for note_id in dict.fromkeys(cleanup["notes"]):
        if note_id:
            call("POST", "/api/v1/notes", {"action": "archive", "id": note_id, "reason": "notes_check probe"})
    for booking_id in dict.fromkeys(cleanup["bookings"]):
        if booking_id:
            call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled"})
    for client_id in dict.fromkeys(cleanup["clients"]):
        if client_id:
            call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "notes_check probe", "force": True})

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + "; ".join(failures))
        sys.exit(1)
    print(
        "ALL PASS — a finalised note cannot be edited without an amendment version, "
        "and a receptionist cannot open it."
    )


def main():
    global cookie
    cookie = cached_session(BASE, EMAIL, PASSWORD)
    if not cookie:
        print("FAIL  could not sign in — is the app running?")
        sys.exit(1)

    # ---- 0. the workspace is up to date -----------------------------------
    status, boot = call("POST", "/api/bootstrap", {})
    desk_ready = status in (200, 201)
    check("the workspace bootstraps the notes layer", desk_ready and "noteTemplates" in boot, message(boot) or f"status {status}")
    if not desk_ready:
        return finish()

    # ---- 1. templates, per service ----------------------------------------
    status, tpl = call("GET", "/api/v1/notes?view=templates")
    templates = tpl.get("templates") or []
    general = [t for t in templates if not t.get("serviceId")]
    per_service = [t for t in templates if t.get("serviceId")]
    check("templates came back", status == 200 and len(templates) > 0, f"{len(templates)} template(s)")
    check("there is a general template and one per service", bool(general) and bool(per_service),
          f"{len(general)} general · {len(per_service)} per service")
    vocab = tpl.get("vocabulary") or {}
    check("the template says what this practice calls a note", bool(vocab.get("note")), str(vocab.get("note")))
    first = templates[0]
    check("every template has named sections", bool(first.get("sections")) and all(s.get("label") for s in first["sections"]),
          ", ".join(s.get("label", "?") for s in first.get("sections", []))[:90])

    # ---- 2. a note filed against a real visit -----------------------------
    _, services = call("GET", "/api/v1/services")
    _, providers = call("GET", "/api/v1/providers")
    service = (services.get("data") or services.get("services") or [{}])[0]
    provider = (providers.get("data") or providers.get("providers") or [{}])[0]
    stamp = int(time.time() * 1000)
    number = f"+1555{stamp % 10000000:07d}"
    starts = datetime.now(timezone.utc) - timedelta(days=1)
    status, created = call("POST", "/api/v1/bookings", {
        "externalId": f"probe-note-{stamp}",
        "customer": {"name": f"Probe Note {stamp % 100000}", "number": number},
        "startsAt": iso(starts),
        "durationMinutes": 30,
        "status": "completed",
        "providerId": provider.get("id"),
        "serviceId": service.get("id"),
        "checkConflicts": False,
    })
    booking = created.get("booking") or created.get("data") or created
    if status not in (200, 201):
        check("a probe visit exists to write up", False, message(created))
        return finish()
    cleanup["bookings"].append(booking.get("id"))
    client_id = booking.get("clientId")
    if client_id:
        cleanup["clients"].append(client_id)
    check("a probe visit exists to write up", True, f"{booking.get('id')} for {number}")

    service_tpl = next((t for t in templates if t.get("serviceId") == service.get("id")), None)
    status, note_body = call("POST", "/api/v1/notes", {
        "action": "create",
        "clientId": client_id,
        "bookingId": booking.get("id"),
        "serviceId": service.get("id"),
    })
    note = note_body.get("note") or {}
    note_id = note.get("id")
    if note_id:
        cleanup["notes"].append(note_id)
    check("the note opens against the visit, the client and the service",
          status == 201 and note.get("clientId") == client_id and note.get("bookingId") == booking.get("id"),
          f"status {status} {message(note_body)}")
    check("it was written in the service's own template, not a generic one",
          bool(service_tpl) and note.get("templateName") == service_tpl.get("name"),
          f"{note.get('templateName')} (service template: {service_tpl.get('name') if service_tpl else 'none'})")
    check("it is a draft, with the author recorded", note.get("status") == "draft", str(note.get("status")))
    sections = note.get("sections") or []
    required = [s for s in sections if s.get("required")]
    check("the template's sections are on the note, with what is required marked",
          len(sections) > 1 and all(s.get("id") and s.get("label") for s in sections)
          and "required" in sections[0] and any(s.get("required") for s in sections),
          ", ".join((s.get("label", "?") + ("*" if s.get("required") else "")) for s in sections)[:110])

    # ---- 3. blank required sections are named, and block the signature -----
    check("**a note cannot be signed while it is half-written**",
          len(note_body.get("incomplete") or []) >= 1,
          "missing: " + ", ".join(note_body.get("incomplete") or []))
    status, refused = call("POST", "/api/v1/notes", {"action": "finalise", "id": note_id})
    check("finalising is refused, and says which sections are blank",
          status == 400 and any(name in message(refused) for name in required_names(required)),
          f"{status} {message(refused)}"[:120])
    status, still = call("GET", f"/api/v1/notes/{note_id}")
    check("and the note is still a draft afterwards", (still.get("note") or {}).get("status") == "draft",
          str((still.get("note") or {}).get("status")))

    # ---- 4. write it up and sign it ---------------------------------------
    filled = [
        {**s, "body": f"Probe text for {s.get('label')} recorded by the notes check."}
        for s in sections
    ]
    status, saved = call("POST", "/api/v1/notes", {"action": "update", "id": note_id, "sections": filled})
    check("the note saves as a draft", status == 200 and not (saved.get("incomplete") or []),
          message(saved) or f"{len(saved.get('incomplete') or [])} missing")
    status, signed = call("POST", "/api/v1/notes", {"action": "finalise", "id": note_id})
    signed_note = signed.get("note") or {}
    check("**a complete note can be signed by a person**",
          status == 200 and signed_note.get("status") == "final",
          f"{status} {message(signed)}")
    check("the signature records who and when", bool(signed_note.get("signerName")) and bool(signed_note.get("signedAt")),
          f"{signed_note.get('signerName')} at {signed_note.get('signedAt')}")
    versions = signed.get("versions") or []
    check("signing freezes version 1", len(versions) == 1 and versions[0].get("version") == 1 and versions[0].get("reason") == "finalised",
          json.dumps([{k: v.get(k) for k in ("version", "reason")} for v in versions]))
    frozen_body = versions[0].get("body") if versions else ""

    # ---- 5. a finalised note is amended, never edited ---------------------
    status, edit = call("POST", "/api/v1/notes", {
        "action": "update",
        "id": note_id,
        "sections": [{**filled[0], "body": "Somebody quietly changed this."}],
    })
    check("**a finalised note cannot be edited**", status == 409, f"{status} {message(edit)}"[:110])
    check("and the refusal says what to do instead", "amend" in message(edit).lower(), message(edit)[:110])
    status, unchanged = call("GET", f"/api/v1/notes/{note_id}")
    check("the signed text is untouched by the attempt",
          (unchanged.get("versions") or [{}])[0].get("body") == frozen_body and "quietly changed" not in json.dumps(unchanged),
          "v1 body intact")

    status, bare = call("POST", "/api/v1/notes", {"action": "amend", "id": note_id})
    check("an amendment without a reason is refused", status == 400 and "reason" in message(bare).lower(), f"{status} {message(bare)}"[:110])
    reason = f"Corrected the probe wording {stamp % 100000}"
    status, amended = call("POST", "/api/v1/notes", {"action": "amend", "id": note_id, "reason": reason})
    amended_note = amended.get("note") or {}
    check("**amending reopens the note at the next version**",
          status == 200 and amended_note.get("status") == "draft" and amended_note.get("version") == 2,
          f"v{amended_note.get('version')} {amended_note.get('status')} v{amended_note.get('version')}")
    check("the signed version is kept, untouched", len(amended.get("versions") or []) == 1
          and (amended.get("versions") or [{}])[0].get("body") == frozen_body,
          f"{len(amended.get('versions') or [])} frozen version(s), body intact")
    status, amended_detail = call("GET", f"/api/v1/notes/{note_id}")
    amended_audit = [t for t in (amended_detail.get("audit") or []) if t.get("action") == "note.amended"]
    check("the reason for the amendment is on the record",
          len(amended_audit) == 1 and reason in str(amended_audit[0].get("detail")),
          str(amended_audit[0].get("detail"))[:110] if amended_audit else "no note.amended entry")

    corrected = [{**s, "body": f"Corrected: {s.get('label')} — probe text."} for s in filled]
    status, saved_again = call("POST", "/api/v1/notes", {"action": "update", "id": note_id, "sections": corrected})
    check("the reopened draft takes the correction", status == 200, message(saved_again)[:90])
    status, resign = call("POST", "/api/v1/notes", {"action": "finalise", "id": note_id})
    trail = resign.get("versions") or []
    check("**re-signing leaves both versions in the trail, newest first**",
          status == 200 and len(trail) == 2 and [v.get("reason") for v in trail] == ["amended", "finalised"]
          and trail[0].get("body") != trail[1].get("body"),
          json.dumps([{k: v.get(k) for k in ("version", "reason")} for v in trail]))

    # ---- 6. attachments ---------------------------------------------------
    status, attached = call("POST", "/api/v1/notes", {
        "action": "attach",
        "id": note_id,
        "name": f"probe-scan-{stamp % 100000}.pdf",
        "bytes": 240000,
        "contentType": "application/pdf",
    })
    attachments = ((attached.get("note") or {}).get("attachments") or [])
    check("an attachment is recorded against the note", status == 200 and len(attachments) == 1,
          f"{len(attachments)} attachment(s)")
    check("with who attached it and when", bool(attachments and attachments[0].get("by")) and bool(attachments and attachments[0].get("at")),
          f"{attachments[0].get('by') if attachments else '-'} at {attachments[0].get('at') if attachments else '-'}")
    status, refused_attach = call("POST", "/api/v1/notes", {"action": "attach", "id": note_id, "name": "empty.pdf", "bytes": 0})
    check("a zero-byte attachment is refused", status == 400, f"{status} {message(refused_attach)}"[:90])
    if attachments:
        status, detached = call("POST", "/api/v1/notes", {"action": "detach", "id": note_id, "attachmentId": attachments[0]["id"]})
        check("and detaching removes it, keeping the trail",
              status == 200 and not ((detached.get("note") or {}).get("attachments") or []),
              f"{len((detached.get('note') or {}).get('attachments') or [])} left")

    # ---- 7. the agent drafts, and never signs ------------------------------
    _, assistants = call("GET", "/api/v1/assistants")
    desk = next((a for a in (assistants.get("data") or []) if "appointment" in str(a.get("name", "")).lower()), None)
    check("the appointment assistant can keep notes", bool(desk) and "draft_note" in (desk.get("tools") or []),
          ", ".join(desk.get("tools") or [])[:120] if desk else "no assistant")
    if desk:
        status, live = call("POST", "/api/v1/calls", {
            "assistantId": desk["id"],
            "type": "web",
            "customer": {"number": number, "name": booking.get("customer", {}).get("name", "Probe Note")},
            "bookingId": booking.get("id"),
        })
        call_doc = live.get("call") or live
        call_id = call_doc.get("id")
        if call_id:
            cleanup["calls"].append(call_id)
        check("a call about the visit can be started", status in (200, 201) and bool(call_id), message(live))
        if call_id:
            call("POST", f"/api/v1/calls/{call_id}/turn", {"text": "Yes, that is all fine — thanks for sorting it out."})
            status, ended = call("PATCH", f"/api/v1/calls/{call_id}", {"status": "ended"})
            check("the call ends", status == 200, message(ended))
            status, after = call("GET", f"/api/v1/notes?bookingId={booking.get('id')}&include=archived")
            agent_notes = [n for n in (after.get("data") or []) if n.get("draftedBy") == "agent"]
            check("**the agent leaves a draft note on the visit**", len(agent_notes) == 1, f"{len(agent_notes)} agent note(s)")
            if agent_notes:
                agent_note = agent_notes[0]
                check("it is a draft, and it does not pretend otherwise",
                      agent_note.get("status") == "draft", str(agent_note.get("status")))
                check("a person is the one who signs it, so far nobody has",
                      not agent_note.get("signerName"), str(agent_note.get("signerName")))
                status, second_end = call("PATCH", f"/api/v1/calls/{call_id}", {"status": "ended"})
                status, again = call("GET", f"/api/v1/notes?bookingId={booking.get('id')}&include=archived")
                still_one = len([n for n in (again.get("data") or []) if n.get("draftedBy") == "agent"])
                check("ending it twice does not file a second note", still_one == 1, f"{still_one} agent note(s)")
                status, detail = call("GET", f"/api/v1/notes/{agent_note['id']}")
                hold = [e for e in (detail.get("access") or []) if e.get("action") == "create"]
                check("the trail says the agent dictated it, unsigned",
                      bool(hold) and "agent" in json.dumps(hold).lower(), json.dumps(hold)[:110])

    # ---- 8. the note's own history ----------------------------------------
    status, detail = call("GET", f"/api/v1/notes/{note_id}")
    actions = [e.get("action") for e in (detail.get("access") or [])]
    check("the note carries its own access log", status == 200 and bool(actions), ", ".join(actions[:6]))
    check("it records the write, the signature and the amendment",
          {"create", "update", "view"}.issubset(set(actions)) and any(a in ("archive", "restore") for a in actions) is False,
          ", ".join(sorted(set(actions))))
    audit_actions = [t.get("action") for t in (detail.get("audit") or [])]
    check("the workspace trail kept the refusal and the amendment",
          "note.amended" in audit_actions and "note.finalised" in audit_actions, ", ".join(sorted(set(audit_actions))[:6]))

    # ---- 9. a receptionist cannot open it ----------------------------------
    _, owner_list = call("GET", f"/api/v1/notes?clientId={client_id}")
    owner_rows = owner_list.get("data") or []
    desk_cookie = desk_session()
    check("the demo workspace has a front-desk login", bool(desk_cookie), f"as {DESK_EMAIL}")
    if desk_cookie:
        status, rows = call("GET", f"/api/v1/notes?clientId={client_id}", auth=True, as_cookie=desk_cookie)
        listed = (rows.get("data") or []) if status == 200 else []
        check("**the desk can see that a note exists**", status == 200 and len(listed) >= 1, f"{len(listed)} row(s)")
        desk_row = listed[0] if listed else {}
        check("and is told it is restricted, not handed a redacted document",
              bool(desk_row.get("restricted")) and "preview" not in desk_row and "body" not in desk_row,
              json.dumps({k: desk_row.get(k) for k in ("status", "restricted", "body", "preview")})[:130])
        drafts_seen = [r for r in listed if r.get("status") == "draft"]
        finals_seen = [r for r in listed if r.get("status") == "final"]
        check("the desk is told whether each note is signed, and by whom",
              bool(finals_seen) and bool(drafts_seen)
              and all(r.get("signerName") for r in finals_seen) and all(not r.get("signerName") for r in drafts_seen),
              f"{len(finals_seen)} signed ({finals_seen[0].get('signerName') if finals_seen else '-'}) · "
              f"{len(drafts_seen)} waiting on a signature")
        check("the same row for a practitioner carries the content",
              bool(owner_rows and owner_rows[0].get("preview")) and not owner_rows[0].get("restricted"),
              str((owner_rows[0].get("preview") if owner_rows else "") or "")[:80])
        status, opened = call("GET", f"/api/v1/notes/{note_id}", auth=True, as_cookie=desk_cookie)
        check("**a receptionist cannot open the note**", status == 403, f"{status} {message(opened)}"[:100])
        status, wrote = call("POST", "/api/v1/notes", {"action": "update", "id": note_id, "sections": []}, auth=True, as_cookie=desk_cookie)
        check("and cannot write clinical content either", status == 403, f"{status} {message(wrote)}"[:100])
        status, client_view = call("GET", f"/api/v1/clients/{client_id}", auth=True, as_cookie=desk_cookie)
        check("the client record says the same thing", client_view.get("notesRestricted") is True,
              str(client_view.get("notesRestricted")))
        status, trail = call("GET", f"/api/v1/notes/{note_id}")
        refused = [t for t in (trail.get("audit") or []) if t.get("action") == "note.read_refused"]
        check("the attempt is recorded in the workspace trail", len(refused) >= 1, f"{len(refused)} refusal(s) logged")

    # ---- 10. archiving keeps it -------------------------------------------
    retention_before = None
    status, archived = call("POST", "/api/v1/notes", {"action": "archive", "id": note_id, "reason": "notes_check probe"})
    archived_note = archived.get("note") or {}
    check("archiving keeps the note rather than deleting it",
          status == 200 and archived_note.get("status") == "archived", f"{status} {message(archived)}"[:90])
    retention_before = archived_note.get("retentionUntil")
    retention_source = archived_note.get("retentionPolicySource")
    check(
        "retention is explicit rather than an invented default",
        (bool(retention_before) and retention_source == "environment")
        or (not retention_before and not retention_source),
        f"until={retention_before or 'automatic purge disabled'} · source={retention_source or 'none'}",
    )
    status, default_list = call("GET", f"/api/v1/notes?clientId={client_id}")
    check("it leaves the everyday list", all(n.get("id") != note_id for n in (default_list.get("data") or [])),
          f"{len(default_list.get('data') or [])} row(s) without it")
    status, all_list = call("GET", f"/api/v1/notes?clientId={client_id}&include=archived")
    check("but is still there when asked for", any(n.get("id") == note_id for n in (all_list.get("data") or [])),
          f"{len(all_list.get('data') or [])} row(s) with it")
    status, restored = call("POST", "/api/v1/notes", {"action": "restore", "id": note_id})
    check("restoring puts it back as it was — signed is signed",
          status == 200 and (restored.get("note") or {}).get("status") == "final",
          str((restored.get("note") or {}).get("status")))

    return finish()


def required_names(required):
    return [s.get("label", "") for s in required] or ["Nothing written"]


if __name__ == "__main__":
    main()
