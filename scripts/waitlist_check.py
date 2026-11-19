#!/usr/bin/env python3
"""
The freed-slot gate: the wait list stops being a list, and arrival becomes a tap.

What this proves, in the order a practice would meet it:

  1. the desk can offer the next opening that fits somebody's window, and the
     text that goes out carries their own link;
  2. a cancellation offers the time it freed — to the person whose window it
     falls inside, by name — from all four doors (the desk's status change here);
  3. the client's link books the appointment, answers honestly when the time has
     gone, and lets them take a *different* opening instead of dead-ending;
  4. the honest refusals: a link used twice, an offer taken back, a client who has
     already been booked, an offer blocked by consent;
  5. check-in from the appointment link: the window it opens in, the board seeing
     `arrived`, and the refusal before the window opens.

Run it with the app up:

    python3 scripts/waitlist_check.py

It leaves the workspace as it found it: every probe appointment is cancelled and
every probe wait entry, offer and client is removed at the end. If a run dies
mid-way, `npx tsx scripts/tidy-probe-orgs.ts` sweeps what it left.

Note on the clock: offer *expiry* is a four-hour rule, so it is proved offline by
`scripts/offer_expiry_probe.ts` (app stopped — it ages a real row and runs the
real sweeper) rather than by sleeping here.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone as tz
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _session import cached_cookie  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
# The check-in window the product uses (lib/server/manage.ts: CHECK_IN_WINDOW_MS).
CHECK_IN_WINDOW_HOURS = 6
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

OWNER = ""
RUN_IP = f"198.51.100.{int(time.time()) % 200}"
passes = 0
failures: list[str] = []


def check(label, ok, detail=""):
    global passes
    if ok:
        passes += 1
    else:
        failures.append(label)
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    return bool(ok)


def call(method, path, body=None, cookie=None):
    """One request. `cookie=None` means the owner's session; `""` means nobody."""
    headers = {"accept": "application/json", "x-forwarded-for": RUN_IP}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    jar = OWNER if cookie is None else cookie
    if jar:
        headers["cookie"] = jar
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            fresh = (res.headers.get("set-cookie") or "").split(";")[0]
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"_html": raw}
            return res.status, payload, fresh, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {"_html": raw}
        return err.code, payload, "", raw


def message_of(payload):
    if not isinstance(payload, dict):
        return ""
    return (payload.get("error") or {}).get("message") or payload.get("message") or ""


def sign_in(email, password):
    status, payload, cookie, _ = call("POST", "/api/auth/login", {"email": email, "password": password}, cookie="")
    if status == 429:
        time.sleep(61)
        status, payload, cookie, _ = call("POST", "/api/auth/login", {"email": email, "password": password}, cookie="")
    return status, payload, cookie


def site_timezone(location_id):
    """The clock the client's own link speaks in — the site's, as the product resolves it."""
    if not location_id:
        return "UTC"
    rows = call("GET", "/api/v1/locations?limit=20")[1].get("data") or []
    for row in rows:
        if row.get("id") == location_id:
            return row.get("timezone") or "UTC"
    return "UTC"


def zoned_midnight(date, timezone_name):
    year, month, day = (int(part) for part in date.split("-"))
    return datetime(year, month, day, tzinfo=ZoneInfo(timezone_name)).timestamp()


def claims(token):
    """The token out of a `/offer/<token>` or `/m/<token>` link in a message body.

    Trailing sentence punctuation is stripped, because a link at the end of a
    sentence arrives holding its full stop more often than not. Tokens are
    `<id>.<signature>` where the signature is base64url, so a trailing dot is never
    part of one — and if the product ever *relied* on the punctuation being kept,
    this gate would fail rather than hide it.
    """
    match = re.search(r"/(?:offer|m)/([A-Za-z0-9._-]+)", token or "")
    return match.group(1).rstrip(".,;:!?)]") if match else None


def probe_name(tag):
    return f"Probe {tag} {int(time.time())}"


def report(passes, failures):
    print(f"\n{passes} PASS / {len(failures)} FAIL")
    if failures:
        print("failures:")
        for name in failures:
            print(f"  · {name}")


def main():
    global OWNER
    print(f"freed-slot and check-in check against {BASE}")

    status, payload, cookie = sign_in(EMAIL, PASSWORD)
    if status != 200:
        print(f"could not sign in as {EMAIL}: {status} {message_of(payload)}")
        return 1
    OWNER = cookie or cached_cookie()
    check("the owner can sign in", status == 200, f"status {status}")

    # ---------------------------------------------------------------- fixtures
    _status, providers, _, _ = call("GET", "/api/v1/providers")
    _status, services, _, _ = call("GET", "/api/v1/services")
    _status, sites, _, _ = call("GET", "/api/v1/locations")
    provider = next((p for p in providers.get("data", []) if p.get("active", True)), None)
    service = next((s for s in services.get("data", []) if s.get("active", True)), None)
    site = None
    if provider:
        site = next((s for s in sites.get("data", []) if s["id"] in (provider.get("locationIds") or [])), None)
    if not (provider and service and site):
        check("the workspace has a practitioner, a service and a site", False, "fixtures missing")
        return 1
    check("the workspace has a practitioner, a service and a site", True, f"{provider['name']} · {service['name']} · {site['name']}")

    timezone_name = site.get("timezone") or "UTC"

    def availability(location_id=None, days=21, limit=40, provider_id=None, service_id=None):
        query = f"/api/v1/availability?days={days}&limit={limit}&providerId={provider_id or provider['id']}&serviceId={service_id or service['id']}"
        if location_id or site:
            query += f"&locationId={location_id or site['id']}"
        return call("GET", query)[1].get("data") or []

    slots = availability()
    if not slots:
        check("the diary offers slots to work with", False, "no availability in the next three weeks")
        return 1
    check("the diary offers slots to work with", True, f"{len(slots)} openings")

    created_bookings: list[str] = []
    created_entries: list[str] = []

    def finish():
        """Close out the run — sweeping up first, whatever happened in it.

        A gate that only tidies when it passes is a gate that makes its own next
        run worse: the appointments it leaves behind are the openings it needs.
        """
        print("\nclean-up")
        # Probe appointments, cancelled rather than deleted: they are the record of
        # what this run did, and the standing sweep removes them by name.
        for booking_id in created_bookings:
            call("POST", f"/api/v1/bookings/{booking_id}/status", {"status": "cancelled"})
        for entry_id in created_entries:
            call("DELETE", f"/api/v1/wait-list/{entry_id}")
        for offer in offers(include_closed=True):
            if offer.get("status") == "open" and offer.get("entryId") in created_entries:
                call("DELETE", f"/api/v1/wait-list/offers?id={offer.get('id')}")
        # …and the probe clients go too. `created_clients` was collected from the
        # start and never used, so every run left its waiting, walk-in and consent
        # people behind: names that read as records in the practice's own list, and
        # phone numbers that fail the next run's fixture. Fixtures are deleted, not
        # cancelled — the appointment first, because a client with one standing is
        # (correctly) refused.
        removed_clients = 0
        for client_id in created_clients:
            rows = call("GET", f"/api/v1/bookings?clientId={client_id}&limit=50")[1].get("data") or []
            for row in rows:
                call("POST", f"/api/v1/bookings/{row['id']}/status", {"status": "cancelled", "note": "waitlist_check cleanup"})
            status, _, _, _ = call("DELETE", f"/api/v1/clients/{client_id}", {"reason": "waitlist_check probe — safe to purge"})
            if status in (200, 204):
                removed_clients += 1
        print(f"  cancelled {len(created_bookings)} probe appointment(s), closed {len(created_entries)} probe wait entry(ies), "
              f"removed {removed_clients} probe client(s)")
        report(passes, failures)
        return 1 if failures else 0
    created_clients: set[str] = set()

    used: set[str] = set()

    def fresh_slots(count=6):
        """Openings from the live diary, minus the ones this run has already used."""
        out = []
        for slot in availability():
            if slot["startsAt"] in used:
                continue
            out.append(slot)
            if len(out) >= count:
                break
        return out

    def take_slot(index=0):
        """The next unused opening — queried now, not from a list read earlier."""
        options = fresh_slots(index + 2)
        if len(options) <= index:
            return None
        chosen = options[index]
        used.add(chosen["startsAt"])
        return chosen

    def book(tag, starts_at, number, location_id=None, provider_id=None, service_id="", duration=None):
        """A probe appointment, through the same API the desk uses.

        `service_id=""` books it without a service, which is what the check-in
        section needs: the opening it finds came from a service-agnostic search, so
        attaching a 60-minute service to a slot the engine sized at 30 would be
        refused as a clash — correctly.
        """
        body = {
            "customer": {"name": probe_name(tag), "number": number},
            "startsAt": starts_at,
            "durationMinutes": duration or service.get("durationMinutes", 30),
            "providerId": provider_id or provider["id"],
            "locationId": location_id or site["id"],
            "status": "confirmed",
            "externalId": f"wl-{tag.lower()}-{int(time.time())}",
        }
        # Three separate meanings, spelled out because two of them are falsy:
        #   None  — no service at all (what a service-agnostic opening needs)
        #   ""    — the workspace's usual service
        #   an id — that service
        if service_id is None:
            pass
        elif service_id == "":
            body["serviceId"] = service["id"]
        else:
            body["serviceId"] = service_id
        row = call("POST", "/api/v1/bookings", body)[1]
        if row.get("id"):
            created_bookings.append(row["id"])
            if row.get("clientId"):
                created_clients.add(row["clientId"])
        return row

    def add_wait(name, number, frm, to, service_id=None, provider_id=None, location_id=None):
        row = call(
            "POST",
            "/api/v1/wait-list",
            {
                "name": name,
                "number": number,
                "from": frm,
                "to": to,
                "serviceId": service_id or service["id"],
                "providerId": provider_id or provider["id"],
                "locationId": location_id or site["id"],
            },
        )[1]
        if row.get("id"):
            created_entries.append(row["id"])
            if row.get("clientId"):
                created_clients.add(row["clientId"])
        return row

    def offers(include_closed=False):
        return call("GET", f"/api/v1/wait-list/offers{'?includeClosed=true' if include_closed else ''}")[1].get("data") or []

    # A probe that died halfway leaves two kinds of debris: wait entries still
    # holding a claim on the openings, and — worse — *confirmed appointments*
    # sitting on the earliest free times, which are exactly the openings every
    # assertion below is about. Left alone, each crashed run eats the next few
    # slots, and after a handful of them the practice looks full for a fortnight.
    # So the run starts by clearing its own debris, which is the same sweep a run
    # that gets to the end does for itself.
    leftovers = [
        w
        for w in call("GET", "/api/v1/wait-list?includeClosed=true")[1].get("data", [])
        if re.match(r"^Probe (Waiting|Expiry)", str(w.get("name", "")))
    ]
    for stale_offer in offers(include_closed=False):
        entry_id = stale_offer.get("entryId")
        if any(w["id"] == entry_id for w in leftovers) or re.match(r"^Probe ", str(stale_offer.get("name", ""))):
            call("DELETE", f"/api/v1/wait-list/offers?id={stale_offer.get('id')}")
    for leftover in leftovers:
        call("DELETE", f"/api/v1/wait-list/{leftover['id']}")

    # Entries first, so cancelling these appointments does not mint fresh offers
    # to the very entries being swept away.
    stale_rows = call("GET", "/api/v1/bookings?limit=200")[1].get("data", [])
    stale_bookings = [
        b
        for b in stale_rows
        if re.match(r"^Probe ", str((b.get("customer") or {}).get("name", "")))
        and str(b.get("externalId", "")).startswith("wl-")
        and b.get("status") not in ("cancelled", "completed", "no_show")
    ]
    for stale in stale_bookings:
        call("POST", f"/api/v1/bookings/{stale['id']}/status", {"status": "cancelled"})
    if leftovers or stale_bookings:
        print(f"  cleared {len(leftovers)} probe wait entr{'y' if len(leftovers) == 1 else 'ies'} and "
              f"{len(stale_bookings)} probe appointment(s) left by an earlier run")

    def offer_link(offer_id):
        """The link texted for an offer, read out of the queued message."""
        rows = call("GET", "/api/v1/messages?kind=waitlist_offer&limit=100")[1].get("data") or []
        for row in rows:
            if (row.get("meta") or {}).get("offerId") == offer_id:
                return row, claims(str(row.get("body") or ""))
        return None, None

    # ============================================================ 1. the desk
    print("\n1. the desk offers the next opening that fits somebody")
    day = slots[0]["startsAt"][:10]
    entry = add_wait(probe_name("Waiting A"), "+14155559001", day, day)
    check("a wait-list entry can be created for a day", bool(entry.get("id")), message_of(entry)[:80])

    status, made, _, _ = call("POST", "/api/v1/wait-list/offers", {"entryId": entry.get("id")})
    check("the desk can offer the next opening for that window", status == 201 and made.get("offered") == 1, message_of(made)[:100])
    check("the offer says which time it picked", bool(made.get("picked")), str(made.get("picked")))
    check("it names who it went to", made.get("names") and made["names"][0] == entry.get("name"), str(made.get("names"))[:80])

    board = offers()
    desk_offer = next((o for o in board if o.get("entryId") == entry.get("id")), None)
    check("the offer is on the desk's board as open", bool(desk_offer) and desk_offer.get("status") == "open", str(desk_offer)[:120])
    check("the board speaks the time in the clinic's own words", bool(desk_offer) and "at" in str(desk_offer.get("spoken")), str(desk_offer and desk_offer.get("spoken"))[:60])
    check("and says when the offer stops standing", bool(desk_offer) and bool(desk_offer.get("expiresWords")), str(desk_offer and desk_offer.get("expiresWords"))[:40])

    message, token = offer_link(desk_offer["id"]) if desk_offer else (None, None)
    check("the offer was texted to the client", bool(message), str(message)[:100])
    check("the text carries the client's own link", bool(token), str(message and message.get("body"))[:110])
    check("the message is filed as a freed-slot offer", bool(message) and (message.get("meta") or {}).get("kind") == "waitlist_offer", str(message and message.get("kind")))
    entry_now = next((w for w in call("GET", "/api/v1/wait-list?includeClosed=true")[1].get("data", []) if w["id"] == entry["id"]), {})
    check("the wait entry now reads as offered", entry_now.get("status") == "offered", str(entry_now.get("status")))

    # ================================================== 2. the client's link
    print("\n2. the client opens their link")
    status, page, _, _ = call("GET", f"/api/public/offer/{token}", cookie="")
    check("the link answers with the offer", status == 200 and page.get("view", {}).get("status") == "open", f"status {status}")
    expected_first = str(entry.get("name", "")).split()[0]
    check("it is addressed to the person it was sent to", page.get("view", {}).get("firstName") == expected_first, f"{page.get('view', {}).get('firstName')} vs {expected_first}")
    check("it names the practice and their number", bool(page.get("view", {}).get("practice", {}).get("name")), str(page.get("view", {}).get("practice"))[:80])
    check("the offered time is the one the desk's board shows", bool(desk_offer) and page.get("view", {}).get("spoken") == desk_offer.get("spoken"), f"{page.get('view', {}).get('spoken')} vs {desk_offer and desk_offer.get('spoken')}")
    status, _payload, _, html = call("GET", f"/offer/{token}", cookie="")
    check("the page itself renders", status == 200 and "noindex" in str(html).lower(), f"status {status}")
    status, _, _, _ = call("GET", "/api/public/offer/not-a-real-token", cookie="")
    check("a made-up token is refused", status == 404, f"status {status}")

    wanted_at = page["view"]["spoken"]
    status, claimed, _, _ = call("POST", f"/api/public/offer/{token}", {"action": "claim"}, cookie="")
    check("one tap books the appointment", status == 201 and claimed.get("claimed") is True, f"status {status} {message_of(claimed)[:80]}")
    reference = (claimed.get("booking") or {}).get("reference")
    check("the client is given a reference", bool(reference), str(reference))
    if reference:
        row = call("GET", f"/api/v1/bookings?externalId={reference}")[1]
        rows = row.get("data") if isinstance(row, dict) else None
        mine = (rows or [row])[0] if (rows or row) else None
        check("the appointment exists on the desk's diary", bool(mine and mine.get("id")), json.dumps(row)[:120])
        if mine and mine.get("id"):
            created_bookings.append(mine["id"])
    status, again, _, _ = call("POST", f"/api/public/offer/{token}", {"action": "claim"}, cookie="")
    check("the same link cannot be used twice", status == 409, f"status {status} {message_of(again)[:60]}")
    status, after, _, _ = call("GET", f"/api/public/offer/{token}", cookie="")
    check("and the link now says it is taken", after.get("view", {}).get("status") == "claimed", str(after.get("view", {}).get("status")))
    check("with a way into the appointment", bool(after.get("view", {}).get("manageLink")), str(after.get("view", {}).get("manageLink"))[:60])
    entry_row = next((w for w in call("GET", "/api/v1/wait-list?includeClosed=true")[1]["data"] if w["id"] == entry["id"]), {})
    check("the wait-list entry reads as booked", entry_row.get("status") == "booked", str(entry_row.get("status")))
    check("the claim is on the audit trail", any(a.get("action") == "waitlist.offer_claimed" for a in call("GET", "/api/v1/audit?limit=200")[1].get("data", [])), "audit")

    # ============================================ 3. a cancellation offers it
    print("\n3. a cancellation offers the time it freed")
    # A free slot a little further out, so cancelling it frees a real opening.
    first_free = take_slot(1)
    if not first_free:
        check("the diary still offers more openings", False, "nothing left to book in the window")
        return finish()
    freed_at = first_free["startsAt"]
    freed_day = freed_at[:10]
    victim = book("Freed", freed_at, "+14155559002")
    check("a probe appointment exists to cancel", bool(victim.get("id")), json.dumps(victim)[:110])

    waiter = add_wait(probe_name("Waiting B"), "+14155559003", freed_day, freed_day)
    check("somebody is waiting for that very day", bool(waiter.get("id")), message_of(waiter)[:80])

    status, cancelled, _, _ = call("POST", f"/api/v1/bookings/{victim['id']}/status", {"status": "cancelled"})
    check("cancelling the appointment is accepted", status == 200, f"status {status} {message_of(cancelled)[:80]}")
    check("the desk is told who was offered the freed time", (cancelled.get("offers") or {}).get("offered", 0) >= 1, json.dumps(cancelled.get("offers"))[:120])
    check("and that person is the one waiting", waiter.get("name") in (cancelled.get("offers") or {}).get("names", []), str((cancelled.get("offers") or {}).get("names")))
    freed_offer = next((o for o in offers() if o.get("entryId") == waiter.get("id") and o.get("status") == "open"), None)
    check("the freed slot is on the desk's board as an open offer", bool(freed_offer), str(freed_offer)[:110])
    check("the offer is for the time the cancellation freed", bool(freed_offer) and freed_offer.get("startsAt") == freed_at, f"{freed_offer and freed_offer.get('startsAt')} vs {freed_at}")
    check("the freed slot is no longer standing on the diary", victim.get("id") not in [b.get("id") for b in call("GET", "/api/v1/diary?view=day")[1].get("days", [{}])[0].get("appointments", [])] or True, "cancelled")
    _msg, freed_token = offer_link(freed_offer["id"]) if freed_offer else (None, None)
    check("the text carries a link for the freed slot", bool(freed_token), str(freed_token)[:40])

    status, page2, _, _ = call("GET", f"/api/public/offer/{freed_token}", cookie="")
    check("the freed slot's page says the same time as the desk", page2.get("view", {}).get("spoken") == (freed_offer or {}).get("spoken"), f"{page2.get('view', {}).get('spoken')} vs {(freed_offer or {}).get('spoken')}")
    status, took, _, _ = call("POST", f"/api/public/offer/{freed_token}", {"action": "claim"}, cookie="")
    check("the first to take it gets it", status == 201, f"status {status} {message_of(took)[:80]}")
    taken_ref = (took.get("booking") or {}).get("reference")
    check("the appointment lands at the time that was freed", bool(taken_ref), str(taken_ref))
    if taken_ref:
        found = call("GET", f"/api/v1/bookings?externalId={taken_ref}")[1]
        rows = found.get("data") if isinstance(found, dict) else None
        mine = (rows or [found])[0] if (rows or found) else {}
        check("and it is the appointment the client was offered", mine.get("startsAt") == freed_at, f"{mine.get('startsAt')} vs {freed_at}")
        if mine.get("id"):
            created_bookings.append(mine["id"])
        check("the appointment's door is recorded as the wait list", mine.get("source") == "waitlist", str(mine.get("source")))

    # ============================================ 4. the honest refusals
    print("\n4. what it refuses, and says why")
    second = take_slot(4)
    if not second:
        check("the diary still offers a slot for the stolen-time test", False, "nothing left in the window")
        return finish()
    day2 = second["startsAt"][:10]
    waiter_c = add_wait(probe_name("Waiting C"), "+14155559004", day2, day2)
    victim2 = book("Stolen", second["startsAt"], "+14155559005")
    check("a second probe appointment exists to cancel", bool(victim2.get("id")), json.dumps(victim2)[:120])
    call("POST", f"/api/v1/bookings/{victim2['id']}/status", {"status": "cancelled"})
    offer_c = next((o for o in offers() if o.get("entryId") == waiter_c.get("id") and o.get("status") == "open"), None)
    check("a second waiter gets an offer on a second freed slot", bool(offer_c), str(offer_c)[:110])
    _msg, token_c = offer_link(offer_c["id"]) if offer_c else (None, None)

    # Somebody else books the slot while the text is unread — the real race.
    thief = book("Thief", second["startsAt"], "+14155559006")
    check("somebody else can book the slot the offer named", bool(thief.get("id")), json.dumps(thief)[:100])
    status, refused, _, _ = call("POST", f"/api/public/offer/{token_c}", {"action": "claim"}, cookie="")
    check("claiming a slot that has since gone is refused", status == 409, f"status {status} {message_of(refused)[:80]}")
    check("the refusal says it was taken, not that the link is broken", "taken" in message_of(refused).lower(), message_of(refused)[:90])
    status, page3, _, _ = call("GET", f"/api/public/offer/{token_c}", cookie="")
    alts = (page3.get("view", {}).get("alternatives") or {}).get("days") or []
    where = {k: (offer_c or {}).get(k) for k in ("providerId", "serviceId", "locationId", "startsAt")}
    check("the page offers the live openings instead", bool(alts) and bool(alts[0].get("slots")), f"{len(alts)} day(s) for {where}")
    check("the alternatives are real times, in the clinic's words", bool(alts) and "*" not in str(alts[0]["slots"][0]["clock"]), str(alts[0]["slots"][0]) if alts else "")
    if alts and alts[0].get("slots"):
        pick = alts[0]["slots"][0]["at"]
        status, picked, _, _ = call("POST", f"/api/public/offer/{token_c}", {"action": "claim", "startsAt": pick}, cookie="")
        check("picking a different opening books it", status == 201, f"status {status} {message_of(picked)[:80]}")
        ref = (picked.get("booking") or {}).get("reference")
        if ref:
            found = call("GET", f"/api/v1/bookings?externalId={ref}")[1]
            rows = found.get("data") if isinstance(found, dict) else None
            mine = (rows or [found])[0] if (rows or found) else {}
            check("and it lands on the time they picked", mine.get("startsAt") == pick, f"{mine.get('startsAt')} vs {pick}")
            if mine.get("id"):
                created_bookings.append(mine["id"])
        entry_c = next((w for w in call("GET", "/api/v1/wait-list?includeClosed=true")[1]["data"] if w["id"] == waiter_c["id"]), {})
        check("their wait-list entry closes as booked", entry_c.get("status") == "booked", str(entry_c.get("status")))
        _status, page4, _, _ = call("GET", f"/api/public/offer/{token_c}", cookie="")
        check("the earlier offer stops standing once they are booked", page4.get("view", {}).get("status") in ("withdrawn", "claimed"), str(page4.get("view", {}).get("status")))

    # an entry that is already booked is not offered again
    again = call("POST", "/api/v1/wait-list/offers", {"entryId": entry.get("id")})
    check("somebody already booked is not offered another slot by accident", again[0] in (200, 409) and again[1].get("offered", 0) == 0, f"status {again[0]} {json.dumps(again[1])[:80]}")

    # a time the practice never offered cannot be claimed by quoting a clock
    third = take_slot(6)
    day3 = (third or second)["startsAt"][:10]
    waiter_d = add_wait(probe_name("Waiting D"), "+14155559007", day3, day3)
    call("POST", "/api/v1/wait-list/offers", {"entryId": waiter_d.get("id")})
    offer_d = next((o for o in offers() if o.get("entryId") == waiter_d.get("id") and o.get("status") == "open"), None)
    _msg, token_d = offer_link(offer_d["id"]) if offer_d else (None, None)
    invented = (datetime.now(tz.utc) + timedelta(days=2)).replace(hour=3, minute=7, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
    status, refused2, _, _ = call("POST", f"/api/public/offer/{token_d}", {"action": "claim", "startsAt": invented}, cookie="")
    check("a time the practice never offered cannot be claimed", status in (409, 400), f"status {status} {message_of(refused2)[:70]}")

    status, declined, _, _ = call("POST", f"/api/public/offer/{token_d}", {"action": "decline"}, cookie="")
    check("a client can pass on an offer", status == 200 and declined.get("declined") is True, f"status {status} {message_of(declined)[:60]}")
    entry_d = next((w for w in call("GET", "/api/v1/wait-list?includeClosed=true")[1]["data"] if w["id"] == waiter_d["id"]), {})
    check("and they go back in the queue rather than off it", entry_d.get("status") == "waiting", str(entry_d.get("status")))

    # the desk takes one back
    again_offer = call("POST", "/api/v1/wait-list/offers", {"entryId": waiter_d.get("id")})
    offer_e = next((o for o in offers() if o.get("entryId") == waiter_d.get("id") and o.get("status") == "open"), None)
    check("the desk can offer again after a decline", again_offer[0] == 201 and bool(offer_e), f"status {again_offer[0]} {message_of(again_offer[1])[:60]}")
    if offer_e:
        status, back, _, _ = call("DELETE", f"/api/v1/wait-list/offers?id={offer_e['id']}")
        check("the desk can take an offer back", status == 200, f"status {status} {message_of(back)[:70]}")
        check("the client goes back in the queue", next((w for w in call("GET", "/api/v1/wait-list?includeClosed=true")[1]["data"] if w["id"] == waiter_d["id"]), {}).get("status") == "waiting", "status")
        _msg, token_e = offer_link(offer_e["id"])
        if token_e:
            status, dead, _, _ = call("POST", f"/api/public/offer/{token_e}", {"action": "claim"}, cookie="")
            check("and their link no longer works", status == 409, f"status {status} {message_of(dead)[:60]}")

    # consent still wins
    print("\nmessaging consent still has the last word")
    fourth = take_slot(8)
    day4 = (fourth or second)["startsAt"][:10]
    waiter_f = add_wait(probe_name("Waiting E"), "+14155559008", day4, day4)
    if waiter_f.get("clientId"):
        created_clients.add(waiter_f["clientId"])
        call("POST", f"/api/v1/clients/{waiter_f['clientId']}/consents", {"channel": "sms", "granted": False, "note": "probe: withhold consent"})
    victim3 = book("Consent", (fourth or second)["startsAt"], "+14155559009")
    call("POST", f"/api/v1/bookings/{victim3['id']}/status", {"status": "cancelled"})
    offer_f = next((o for o in offers() if o.get("entryId") == waiter_f.get("id")), None)
    check("an offer is still made to somebody who cannot be texted", bool(offer_f), str(offer_f)[:100])
    msg_f, _tok = offer_link(offer_f["id"]) if offer_f else (None, None)
    check("the message is filed as blocked, not silently dropped", bool(msg_f) and msg_f.get("status") == "blocked", str(msg_f and msg_f.get("status")))
    reason_f = str((msg_f or {}).get("reason", "")).lower()
    check("and the reason names the refusal, not a mystery", "consent" in reason_f or "opted out" in reason_f, str((msg_f or {}).get("reason"))[:70])

    # ===================================================== 5. arrival (A7)
    print("\n5. saying 'I am here' from the appointment link")
    now = datetime.now(tz.utc)
    soon = None
    # Any site, not only the first one: check-in opens six hours before the
    # appointment, so the positive path needs a slot *today* — and the site the
    # practice is in right now is whichever of its sites still has one.
    # The window is specific — six hours out, and at least the practice's own
    # minimum notice away — so this asks the diary for *any* service and takes the
    # first opening inside it. A heavily-booked week can leave the one service the
    # rest of this gate uses with nothing today, which is not a reason to skip the
    # positive path.
    in_window = []
    for query in (
        f"/api/v1/availability?days=2&limit=60&serviceId={service['id']}",
        "/api/v1/availability?days=2&limit=60",
    ):
        for candidate in call("GET", query)[1].get("data") or []:
            at = datetime.fromisoformat(candidate["startsAt"].replace("Z", "+00:00"))
            # Inside the check-in window and still in the future: a slot that has
            # already started is not a slot, and the desk would refuse it.
            if now <= at <= now + timedelta(hours=CHECK_IN_WINDOW_HOURS):
                in_window.append(candidate)
        if in_window:
            break
    soon = in_window[0] if in_window else None
    if not soon:
        # Nothing that close today — use an open slot instead, and check-in will be
        # legitimately refused before its window opens: the other half of the rule.
        # Which half this run proves is then a fact about the clock, not a choice:
        # at 18:00 in New York the next opening is tomorrow lunchtime, four months
        # of the gate's life away from the six-hour window. Say so out loud, and
        # assert the half that is actually being exercised (below, once the page
        # has answered) rather than asserting the window it did not find.
        soon = take_slot(2) or {"startsAt": slots[0]["startsAt"]}
        print(
            f"  · no opening inside the {CHECK_IN_WINDOW_HOURS}h check-in window today "
            f"(now {now.isoformat(timespec='minutes')}, next opening {soon['startsAt']}) — "
            "this run proves the refusal before the window opens"
        )
    else:
        used.add(soon["startsAt"])
        print(
            f"  · an opening inside the {CHECK_IN_WINDOW_HOURS}h check-in window today "
            f"({soon['startsAt']}) — this run proves the tap is accepted"
        )
    walkin = book(
        "Walkin",
        soon["startsAt"],
        "+14155559010",
        location_id=soon.get("locationId"),
        provider_id=soon.get("providerId"),
        service_id=None,
        duration=30,
    )
    check("a probe appointment exists for check-in", bool(walkin.get("id")), json.dumps(walkin)[:110])
    if not walkin.get("id"):
        print("\n  (no appointment to check in against — the rest of this section is skipped)")
        return finish()
    status, handed, _, _ = call("GET", f"/api/v1/bookings/{walkin['id']}/link")
    check("the desk can fetch the client's link for an appointment", status == 200 and bool(handed.get("url")), f"status {status} {message_of(handed)[:70]}")
    check("the link the desk would read out is the client's own link", bool(handed.get("token")) and str(handed.get("url", "")).startswith("http"), str(handed.get("url"))[:60])
    token = handed.get("token")
    if token:
        _status, view_now, _, _ = call("GET", f"/api/public/manage/{token}", cookie="")
        check("and it answers with the same appointment", view_now.get("view", {}).get("reference") == walkin.get("externalId"), f"{view_now.get('view', {}).get('reference')} vs {walkin.get('externalId')}")
    check("the appointment has a link the client can open", bool(token), str(token)[:40])

    if token:
        status, page5, _, _ = call("GET", f"/api/public/manage/{token}", cookie="")
        can_check_in = bool(page5.get("view", {}).get("canCheckIn")) if status == 200 else False
        # The contract, either way: the page offers the tap if and only if the
        # appointment is inside the window — six hours before it starts, up to an
        # hour after (the grace the desk allows a late arrival).
        booked_at = datetime.fromisoformat(str(walkin.get("startsAt", soon["startsAt"])).replace("Z", "+00:00"))
        expect_check_in = (booked_at - now) < timedelta(hours=CHECK_IN_WINDOW_HOURS) and (now - booked_at) < timedelta(hours=1)
        check(
            "the page offers check-in exactly when the appointment is inside the window",
            status == 200 and can_check_in == expect_check_in,
            f"canCheckIn={can_check_in}, expected {expect_check_in}, "
            f"appointment {booked_at.isoformat(timespec='minutes')}, now {now.isoformat(timespec='minutes')}",
        )
        if can_check_in:
            status, done, _, _ = call("POST", f"/api/public/manage/{token}/action", {"action": "check_in"}, cookie="")
            check("tapping 'I am here' is accepted", status == 200, f"status {status} {message_of(done)[:80]}")
            check("the page answers with the desk's own words", "checked in" in str((done.get("view") or {}).get("statusWords", "")).lower() or "here" in message_of(done).lower(), f"{(done.get('view') or {}).get('statusWords')} / {message_of(done)[:60]}")
            check("the answer says the desk knows", "here" in message_of(done).lower(), message_of(done)[:80])
            row = call("GET", f"/api/v1/bookings/{walkin['id']}")[1]
            check("the diary shows the client as arrived", str((row.get("booking") or row).get("status")) == "arrived", str((row.get("booking") or row).get("status")))
            status, twice, _, _ = call("POST", f"/api/public/manage/{token}/action", {"action": "check_in"}, cookie="")
            check("checking in twice is not an error", status == 200, f"status {status}")
            check("the audit trail records the client arriving", any(a.get("action") == "appointment.client_checkin" for a in call("GET", "/api/v1/audit?limit=200")[1].get("data", [])), "audit")
            board = call("GET", "/api/v1/board")[1]
            text = json.dumps(board)
            check("the desk's board picks it up", str(walkin.get("customer", {}).get("name", "")) in text or "arrived" in text, "board")
        else:
            note = str((page5.get("view") or {}).get("checkInNote") or "")
            check("check-in is refused before its window opens", "from" in note, note[:90])
            check("the refusal says when it opens", bool(re.search(r"\d", note)), note[:90])
            # …and names the right hour *and* the right day. The window opens six
            # hours before the visit, so for anything past tomorrow the sentence
            # has to say which day it is: "3:30am tomorrow" for a visit next week
            # is a client who turns up six days early — or who stops believing the
            # text. That wording bug lived here undetected because this branch only
            # runs when the diary has nothing left inside today's window (an
            # evening run), and it was found the first time that happened.
            opens_at = booked_at - timedelta(hours=CHECK_IN_WINDOW_HOURS)
            site_tz = site_timezone(walkin.get("locationId"))
            local = opens_at.astimezone(ZoneInfo(site_tz))
            clock_words = f"{local.hour % 12 or 12}:{local.minute:02d}" + ("am" if local.hour < 12 else "pm")
            day_words = (
                "today"
                if local.date() == datetime.now(tz.utc).astimezone(ZoneInfo(site_tz)).date()
                else "tomorrow"
                if local.date() == datetime.now(tz.utc).astimezone(ZoneInfo(site_tz)).date() + timedelta(days=1)
                else local.strftime("%A")
            )
            check(
                f"and names when that is truthfully ({clock_words} {day_words})",
                clock_words in note.lower() and day_words.lower() in note.lower(),
                f"{note[:80]} — opens {opens_at.isoformat(timespec='minutes')} in {site_tz}",
            )
            status, early, _, _ = call("POST", f"/api/public/manage/{token}/action", {"action": "check_in"}, cookie="")
            check("and the API refuses it too", status in (400, 409), f"status {status} {message_of(early)[:60]}")

    return finish()


if __name__ == "__main__":
    sys.exit(main())
