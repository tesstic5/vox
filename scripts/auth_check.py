#!/usr/bin/env python3
"""Auth check — the four token flows and the gate they feed.

What this proves, in order, against a running app:

  1. **Invitations.** Inviting somebody emails a real link; the link shows the
     right workspace, inviter and role; accepting it sets a password, signs them
     in, verifies their address, and burns the link. The one-time password the
     inviter can read out still works as the fallback, and declining cancels the
     link instead of leaving it live.
  2. **Password reset.** The link is emailed, single-use, fifteen minutes, and
     ends every session on the account — asserted by testing a session taken
     *before* the reset against a real API route. An unknown address gets the
     same answer as a known one, and no mail.
  3. **Magic link.** Requested by mail, checked before use, spent on a POST (so a
     mail scanner cannot burn it), and refused on replay.
  4. **Email verification.** Six digits, wrong guesses counted, five wrong
     attempts lock the code for an hour, and a resend cannot clear the counter.
  5. **What verification gates.** Publishing an assistant, buying a number and
     creating an API key are refused with `EMAIL_NOT_VERIFIED` until the address
     is verified — the claim three screens have been making since the first
     build. Drafting still works, which is what the verify screen promises.
  6. **The seeded workspace.** The demo owner is verified by seed, so the demo
     can still publish and buy.

Probe accounts are fresh each run (`probe.<something>.<timestamp>@…`), so the
unverified paths are exercised for real rather than asserted. They are left
behind on purpose: `scripts/tidy-probe-orgs.ts` sweeps every workspace whose only
logins are probe addresses. Run it after a session with:

    python3 scripts/auth_check.py
    npx tsx scripts/tidy-probe-orgs.ts --apply

Needs the app running with the email relay pointed at the carrier stub (the app's
normal start line), because that is the record of what actually left the
building:

    VOXERA_EMAIL_API_BASE=http://127.0.0.1:4010 … npx tsx server.ts
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _session  # noqa: E402

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STUB = os.environ.get("VOXERA_EMAIL_STUB", "http://127.0.0.1:4010")
EMAIL = os.environ.get("VOXERA_EMAIL", "jordan@northwind.dev")
PASSWORD = os.environ.get("VOXERA_PASSWORD", "demo-password-2026")

PASS = 0
FAIL = 0
MADE = []          # probe members to deactivate at the end
STAMP = str(int(time.time()))
OWNER = ""         # the demo owner's cookie


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}" + (f"  — {detail}" if detail else ""))


# Every limiter in the app is counted per client address, so the gate takes an
# address of its own for the run: back-to-back runs then meet cold buckets, and a
# failure means the flow is wrong rather than that the last run used the budget.
RUN_IP = f"198.51.100.{int(time.time()) % 200}"


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


def login(email, password):
    """Sign in, waiting out the sign-in limiter once if it trips.

    The limiter is real (10 tries a minute per address) and a gate that hammers it
    would be testing the limiter rather than the flow — so one honest wait, then
    the answer is taken as the answer.
    """
    status, payload, cookie, _ = call("POST", "/api/auth/login", {"email": email, "password": password}, cookie="")
    if status == 429:
        time.sleep(61)
        status, payload, cookie, _ = call("POST", "/api/auth/login", {"email": email, "password": password}, cookie="")
    return status, payload, cookie, ""


def error_of(payload):
    return (payload.get("error") or {}) if isinstance(payload, dict) else {}


def message_of(payload):
    return error_of(payload).get("message", "") or str(payload)[:80]


def inbox():
    """Everything the relay accepted, newest first — the stub's own record."""
    try:
        with urllib.request.urlopen(f"{STUB}/__state", timeout=30) as res:
            return json.load(res).get("sentEmails") or []
    except (OSError, json.JSONDecodeError, urllib.error.URLError):
        return []


def link_from_mail(to, pattern):
    for mail in inbox():
        if mail.get("to") != to:
            continue
        found = re.search(pattern, mail.get("text") or "")
        if found:
            return found.group(0), mail
    return None, None


def code_from_mail(to):
    for mail in inbox():
        if mail.get("to") == to:
            found = re.search(r"code is (\d{6})", mail.get("text") or "")
            if found:
                return found.group(1)
    return None


def token_of(url, segment):
    return url.rstrip("/").split(f"/{segment}/")[-1]


# ---------------------------------------------------------------------------
# 1. invitations
# ---------------------------------------------------------------------------

def invitations():
    print("\n1. invitations — the way a new colleague gets in")
    invited = f"probe.auth.{STAMP}@northwind.test"
    status, made, _, _ = call(
        "POST",
        "/api/v1/team",
        {"action": "invite", "name": "Probe Auth", "email": invited, "role": "receptionist"},
    )
    member = made.get("member") or {}
    check("inviting somebody creates the login", status == 201 and bool(member.get("id")), f"status {status} {message_of(made)}")
    check("the inviter is told the link went out", made.get("inviteSent") is True, str(made.get("inviteError") or "no inviteSent flag"))
    check("a one-time password is still issued as the fallback", bool(made.get("temporaryPassword")), str(made.get("temporaryPassword"))[:6] + "…")
    if member.get("id"):
        MADE.append((member["id"], invited))

    link, mail = link_from_mail(invited, r"https?://[^\s]*/invite/[A-Za-z0-9_\-]+")
    check("the invitation email carries an /invite/ link", bool(link), mail.get("subject", "no mail") if mail else "no mail for that address")
    check("the invitation email names the workspace", bool(mail) and "Northwind Labs" in (mail.get("body") or mail.get("text") or ""), "workspace not named")
    if not link:
        return None
    invite_token = token_of(link, "invite")

    status, state, _, _ = call("GET", f"/api/auth/invite/state?token={urllib.parse.quote(invite_token)}", cookie="")
    check("the invitation screen can read the link", status == 200 and state.get("valid") is True, f"status {status} {state.get('reason')}")
    check("it names the invited address", state.get("email") == invited, str(state.get("email")))
    check("it names the workspace and the inviter", state.get("org") == "Northwind Labs" and state.get("inviter") == "Jordan Reyes", f"{state.get('org')} / {state.get('inviter')}")
    check("the role comes from the invitation, not the invitee", state.get("role") == "receptionist", str(state.get("role")))

    status, weak, _, _ = call("POST", "/api/auth/invite/accept", {"token": invite_token, "name": "Probe Auth", "password": "short"}, cookie="")
    check("a too-short password is refused before anything is spent", status == 400 and "8 characters" in message_of(weak), message_of(weak)[:70])

    status, accepted, cookie, _ = call(
        "POST", "/api/auth/invite/accept", {"token": invite_token, "name": "Probe Auth", "password": "probe-accepted-2026"}, cookie=""
    )
    check("accepting joins the workspace and signs them in", status == 201 and accepted.get("joined") is True and bool(cookie), f"status {status} {message_of(accepted)}")
    status, me, _, _ = call("GET", "/api/auth/me", cookie=cookie)
    check("they arrive signed in as themselves", (me.get("user") or {}).get("email") == invited, str((me.get("user") or {}).get("email")))
    check("accepting verifies the address they proved they can read", (me.get("user") or {}).get("emailVerified") is True, "still unverified")
    check("they hold the role the inviter chose", (me.get("user") or {}).get("role") == "receptionist", str((me.get("user") or {}).get("role")))

    temp = made.get("temporaryPassword")
    status, _, _, _ = login(invited, temp)
    check("the one-time password stops working once a real one is chosen", status == 401, f"status {status}")

    status, replay, _, _ = call("POST", "/api/auth/invite/accept", {"token": invite_token, "password": "another-pass-2026"}, cookie="")
    check("the invitation works exactly once", status == 409 and error_of(replay).get("code") == "CONFLICT", f"status {status}")

    # the read-it-out fallback, on somebody who has not accepted yet
    fallback = f"probe.fallback.{STAMP}@northwind.test"
    status, made2, _, _ = call("POST", "/api/v1/team", {"action": "invite", "name": "Probe Fallback", "email": fallback, "role": "practitioner"})
    member2 = made2.get("member") or {}
    if member2.get("id"):
        MADE.append((member2["id"], fallback))
    link2, _ = link_from_mail(fallback, r"https?://[^\s]*/invite/[A-Za-z0-9_\-]+")
    status, login2, _, _ = login(fallback, made2.get("temporaryPassword"))
    check("the temporary password signs them in when the email has not been opened", status == 200, f"status {status}")
    check("that account is unverified until they accept the invitation", (login2.get("user") or {}).get("emailVerified") is False, str((login2.get("user") or {}).get("emailVerified")))
    if link2:
        token2 = token_of(link2, "invite")
        status, declined, _, _ = call("POST", "/api/auth/invite/decline", {"token": token2}, cookie="")
        check("declining cancels the link", status == 200 and declined.get("declined") is True, f"status {status} {message_of(declined)}")
        status, after, _, _ = call("GET", f"/api/auth/invite/state?token={urllib.parse.quote(token2)}", cookie="")
        check("a declined invitation cannot be accepted", after.get("valid") is False and after.get("reason") == "revoked", str(after.get("reason")))

    # the pending list is the tokens themselves
    pending_email = f"probe.pending.{STAMP}@northwind.test"
    status, made3, _, _ = call("POST", "/api/v1/team", {"action": "invite", "name": "Probe Pending", "email": pending_email, "role": "developer"})
    member3 = made3.get("member") or {}
    if member3.get("id"):
        MADE.append((member3["id"], pending_email))
    status, listed, _, _ = call("GET", "/api/v1/team?view=invites")
    rows = listed.get("invites") or []
    mine = next((r for r in rows if r.get("email") == pending_email), None)
    check("the dashboard's pending list shows the live link", status == 200 and mine is not None, f"{len(rows)} pending")
    check("it says who invited them and when it lapses", bool(mine) and bool(mine.get("invitedBy")) and (mine.get("expiresInHours") or 0) > 24, json.dumps(mine)[:90] if mine else "no row")

    status, revoked, _, _ = call("POST", "/api/v1/team", {"action": "revoke_invite", "id": member3.get("id")})
    check("cancelling a link takes it off the list", status == 200, f"status {status} {message_of(revoked)}")
    _status, listed2, _, _ = call("GET", "/api/v1/team?view=invites")
    check("and the list agrees", all(r.get("email") != pending_email for r in listed2.get("invites") or []), "still listed")
    status, resent, _, _ = call("POST", "/api/v1/team", {"action": "resend_invite", "id": member3.get("id")})
    check("sending it again mints a fresh link", status == 200 and bool(resent.get("expiresAt")), f"status {status} {message_of(resent)}")
    link3, _ = link_from_mail(pending_email, r"https?://[^\s]*/invite/[A-Za-z0-9_\-]+")
    check("and the new link is the one in the inbox", bool(link3), "no second email")
    return {"email": invited, "cookie": cookie}


# ---------------------------------------------------------------------------
# 2. password reset
# ---------------------------------------------------------------------------

def password_reset(account):
    print("\n2. password reset — a link that works once and ends every session")
    email = account["email"]
    before = len(inbox())
    status, asked, _, raw = call("POST", "/api/auth/password/request", {"email": email}, cookie="")
    check("a reset can be requested without a session", status == 200 and asked.get("requested") is True, f"status {status} {message_of(asked)}")
    check("the answer says how long the link lasts", asked.get("expiresInMinutes") == 15, str(asked.get("expiresInMinutes")))
    check("the response never contains the token", "rt_" not in raw, raw[:120])

    link, mail = link_from_mail(email, r"https?://[^\s]*/reset-password/[A-Za-z0-9_\-]+")
    check("the reset link is emailed", bool(link), mail.get("subject", "") if mail else "no mail")
    check("the email explains the session rule", bool(mail) and "session" in (mail.get("text") or "").lower(), "not mentioned")
    if not link:
        return
    token = token_of(link, "reset-password")

    status, state, _, _ = call("GET", f"/api/auth/password/state?token={urllib.parse.quote(token)}", cookie="")
    check("the reset screen reads the link", status == 200 and state.get("valid") is True, str(state.get("reason")))
    check("and knows whose password this is", state.get("email") == email, str(state.get("email")))

    status, weak, _, _ = call("POST", "/api/auth/password/reset", {"token": token, "password": "short"}, cookie="")
    check("a short password is refused", status == 400 and "8 characters" in message_of(weak), message_of(weak)[:70])
    _status, still, _, _ = call("GET", f"/api/auth/password/state?token={urllib.parse.quote(token)}", cookie="")
    check("and the link survives a failed attempt", still.get("valid") is True, "link was spent by a validation error")

    # A session taken before the reset, to prove the reset kills it.
    status, _, earlier, _ = login(email, "probe-accepted-2026")
    check("a session taken before the reset works", status == 200 and bool(earlier), f"status {status}")

    status, done, fresh, _ = call("POST", "/api/auth/password/reset", {"token": token, "password": "probe-reset-2026"}, cookie="")
    check("the reset is accepted", status == 200 and done.get("reset") is True, f"status {status} {message_of(done)}")
    check("it reports the sessions it ended", (done.get("sessionsEnded") or 0) >= 1, str(done.get("sessionsEnded")))
    check("the browser doing the reset gets a fresh session", bool(fresh), "no cookie returned")

    status, _, _, _ = call("GET", "/api/v1/clients?limit=1", cookie=earlier)
    check("the session from before the reset is dead on a real route", status == 401, f"status {status}")

    status, _, _, _ = login(email, "probe-accepted-2026")
    check("the old password stops working", status == 401, f"status {status}")
    status, _, _, _ = login(email, "probe-reset-2026")
    check("the new password works", status == 200, f"status {status}")

    status, replay, _, _ = call("POST", "/api/auth/password/reset", {"token": token, "password": "whatever-2026"}, cookie="")
    check("the link cannot be used twice", status == 409 and error_of(replay).get("code") == "CONFLICT", f"status {status}")
    _status, spent, _, _ = call("GET", f"/api/auth/password/state?token={urllib.parse.quote(token)}", cookie="")
    check("and the screen says so in a sentence", spent.get("valid") is False and spent.get("reason") == "used", str(spent.get("reason")))

    # No accounts to enumerate.
    unknown = f"probe.nobody.{STAMP}@northwind.test"
    mails_before = len(inbox())
    status, unknown_answer, _, _ = call("POST", "/api/auth/password/request", {"email": unknown}, cookie="")
    check("an unknown address gets the same answer", status == 200 and unknown_answer.get("requested") is True, f"status {status}")
    check("with the same shape as a real one", set(unknown_answer.keys()) == {"requested", "expiresInMinutes", "email"}, str(sorted(unknown_answer.keys())))
    check("and nothing is sent to it", len(inbox()) == mails_before, f"{len(inbox()) - mails_before} extra mail")
    check("the known-address request did send one", before < mails_before, "no mail at all")


# ---------------------------------------------------------------------------
# 3. magic link
# ---------------------------------------------------------------------------

def magic_link(account):
    print("\n3. magic link — requested by mail, spent on a click")
    email = account["email"]
    status, asked, _, raw = call("POST", "/api/auth/magic/request", {"email": email}, cookie="")
    check("a sign-in link can be requested", status == 200 and asked.get("requested") is True, f"status {status} {message_of(asked)}")
    check("the response never contains the token", "ml_" not in raw, raw[:120])

    link, mail = link_from_mail(email, r"https?://[^\s]*/magic-link/[A-Za-z0-9_\-]+")
    check("the link is emailed", bool(link), mail.get("subject", "") if mail else "no mail")
    check("the email promises the click, not the open", bool(mail) and "press the button" in (mail.get("text") or ""), "not explained")
    if not link:
        return
    token = token_of(link, "magic-link")

    status, state, _, _ = call("GET", f"/api/auth/magic/state?token={urllib.parse.quote(token)}", cookie="")
    check("the landing page can check it without spending it", status == 200 and state.get("valid") is True, str(state.get("reason")))
    _status, again, _, _ = call("GET", f"/api/auth/magic/state?token={urllib.parse.quote(token)}", cookie="")
    check("checking twice does not use it up", again.get("valid") is True, "the second read spent it")

    status, used, cookie, _ = call("POST", "/api/auth/magic/consume", {"token": token}, cookie="")
    check("pressing the button signs in", status == 200 and used.get("signedIn") is True and bool(cookie), f"status {status} {message_of(used)}")
    status, me, _, _ = call("GET", "/api/auth/me", cookie=cookie)
    check("as the right person", (me.get("user") or {}).get("email") == email, str((me.get("user") or {}).get("email")))

    status, replay, _, _ = call("POST", "/api/auth/magic/consume", {"token": token}, cookie="")
    check("the link cannot be used twice", status == 409, f"status {status}")
    status, anon, _, _ = call("GET", "/api/auth/me", cookie="")
    check("an anonymous visitor is told they are anonymous", anon.get("authenticated") is False, str(anon)[:60])


# ---------------------------------------------------------------------------
# 4. email verification
# ---------------------------------------------------------------------------

def signup(email, name, org):
    return call(
        "POST",
        "/api/auth/signup",
        {"email": email, "password": "probe-signup-2026", "name": name, "orgName": org, "region": "us-east-1"},
        cookie="",
    )


def verification():
    print("\n4. email verification — six digits, five tries, then an hour")
    email = f"probe.lock.{STAMP}@northwind.test"
    status, made, cookie, _ = signup(email, "Probe Lock", f"Probe Lock {STAMP}")
    check("a new account starts unverified", status == 201 and (made.get("user") or {}).get("emailVerified") is False, f"status {status}")
    if not cookie:
        return None

    status, state, _, _ = call("GET", "/api/auth/verify", cookie=cookie)
    check("the verify screen reads its own state", status == 200 and state.get("verified") is False and state.get("code", {}).get("outstanding") is False, json.dumps(state)[:90])
    check("it knows the address the code goes to", state.get("email") == email, str(state.get("email")))

    status, sent, _, _ = call("POST", "/api/auth/verify", cookie=cookie)
    check("a code is sent", status == 200 and sent.get("sent") is True, f"status {status} {message_of(sent)}")
    check("the response says how many tries are allowed", sent.get("attemptsLeft") == 5, str(sent.get("attemptsLeft")))
    code = code_from_mail(email)
    check("the code reaches the inbox", bool(code) and len(code) == 6, "no six-digit code in the mail")
    check("the email says what verifying unlocks", any("publish" in (m.get("text") or "") for m in inbox() if m.get("to") == email), "not mentioned")

    for expected in (4, 3, 2, 1):
        _status, wrong, _, _ = call("POST", "/api/auth/verify/confirm", {"code": "000000"}, cookie=cookie)
        if f"{expected} attempt" not in message_of(wrong):
            break
    check("a wrong code reports the attempts left", expected == 1 and "1 attempt left" in message_of(wrong), message_of(wrong)[:70])

    status, locked, _, _ = call("POST", "/api/auth/verify/confirm", {"code": "000000"}, cookie=cookie)
    check("the fifth wrong guess locks the code", status == 409 and error_of(locked).get("code") == "CONFLICT", f"status {status} {message_of(locked)}")
    status, resend, _, _ = call("POST", "/api/auth/verify", cookie=cookie)
    check("re-sending cannot clear the counter", status == 409 and "locked" in message_of(resend), f"status {status} {message_of(resend)}")
    status, state, _, _ = call("GET", "/api/auth/verify", cookie=cookie)
    check("the screen reports the lock and when it ends", state.get("code", {}).get("locked") is True and bool(state.get("code", {}).get("retryAt")), json.dumps(state.get("code"))[:90])
    if code:
        status, _right_but_locked, _, _ = call("POST", "/api/auth/verify/confirm", {"code": code}, cookie=cookie)
        check("even the right code is refused while locked", status in (400, 409), f"status {status}")
    return {"email": email, "cookie": cookie}


def verification_gate():
    print("\n5. what verification gates — publish, numbers, keys")
    email = f"probe.gate.{STAMP}@northwind.test"
    status, made, cookie, _ = signup(email, "Probe Gate", f"Probe Gate {STAMP}")
    check("a second account starts unverified", status == 201 and bool(cookie), f"status {status}")
    if not cookie:
        return

    status, drafted, _, _ = call("POST", "/api/v1/onboarding/assistant", {"useCase": "booking-confirmation", "business": "Probe Gate"}, cookie=cookie)
    draft = drafted.get("assistant") or {}
    check("drafting an agent still works unverified", status == 201 and draft.get("status") == "draft", f"status {status} agent={draft.get('status')}")
    check("and the answer says why it is a draft", "verif" in str(drafted.get("note", "")).lower(), str(drafted.get("note"))[:80])

    status, refused, _, _ = call("POST", f"/api/v1/assistants/{draft.get('id')}/publish", {}, cookie=cookie)
    check("publishing is refused", status == 403 and error_of(refused).get("code") == "EMAIL_NOT_VERIFIED", f"status {status} {error_of(refused).get('code')}")
    check("the refusal names the address to verify", email in message_of(refused), message_of(refused)[:80])
    status, refused_buy, _, _ = call("POST", "/api/v1/numbers", {"areaCode": "415"}, cookie=cookie)
    check("buying a number is refused", status == 403, f"status {status}")
    status, refused_key, _, _ = call("POST", "/api/v1/keys", {"name": "probe"}, cookie=cookie)
    check("creating an API key is refused", status == 403, f"status {status}")
    status, _, _, _ = call("GET", "/api/v1/clients?limit=1", cookie=cookie)
    check("everything that is not gated still works", status == 200, f"status {status}")

    status, sent, _, _ = call("POST", "/api/auth/verify", cookie=cookie)
    code = code_from_mail(email)
    check("the code for this account is emailed", status == 200 and bool(code), f"status {status}")
    status, confirmed, _, _ = call("POST", "/api/auth/verify/confirm", {"code": code or "000000"}, cookie=cookie)
    check("the code verifies the account", status == 200 and confirmed.get("verified") is True, f"status {status} {message_of(confirmed)}")
    check("the answer lists what just unlocked", len(confirmed.get("unlocks") or []) >= 3, str(confirmed.get("unlocks")))

    status, published, _, _ = call("POST", f"/api/v1/assistants/{draft.get('id')}/publish", {}, cookie=cookie)
    check("publishing works the moment it is verified", status == 200 and published.get("status") == "published", f"status {status}")
    status, key, _, _ = call("POST", "/api/v1/keys", {"name": "probe key"}, cookie=cookie)
    check("and so does creating a key", status in (200, 201) and bool(key.get("last4")), f"status {status} {message_of(key)}")

    status, again, _, _ = call("POST", "/api/auth/verify", cookie=cookie)
    check("a verified account is not sent another code", status == 200 and again.get("alreadyVerified") is True, f"status {status} {message_of(again)}")
    return {"email": email, "cookie": cookie}


# ---------------------------------------------------------------------------
# 6. the seeded workspace, the trail, and the pages
# ---------------------------------------------------------------------------

def seeded_and_trail(verified_account):
    print("\n6. the seeded workspace, the audit trail, and the screens")
    status, me, _, _ = call("GET", "/api/auth/me")
    check("the demo owner is signed in and verified", status == 200 and (me.get("user") or {}).get("emailVerified") is True, json.dumps(me.get("user") or {})[:80])

    status, audit_rows, _, _ = call("GET", "/api/v1/audit")
    actions = {r.get("action") for r in (audit_rows.get("data") or [])}
    for action in ("auth.reset_requested", "auth.password_reset", "auth.magic_link_used", "team.invite_sent", "team.invite_accepted", "team.invite_declined"):
        check(f"the trail records {action}", action in actions, "missing")

    if verified_account and verified_account.get("cookie"):
        # The workspace that actually completed verification — the account that
        # locked itself out never reaches `auth.email_verified`, which is correct.
        _status, own, _, _ = call("GET", "/api/v1/audit", cookie=verified_account["cookie"])
        own_actions = {r.get("action") for r in (own.get("data") or [])}
        for action in ("auth.verification_sent", "auth.email_verified"):
            check(f"the new workspace's trail records {action}", action in own_actions, "missing")

    for path, label in (
        ("/reset-password", "the reset request screen"),
        ("/magic-link", "the magic-link screen"),
        ("/verify-email", "the verify screen"),
        ("/login", "the sign-in screen"),
    ):
        status, payload, _, raw = call("GET", path, cookie="")
        check(f"{label} renders", status == 200 and "<html" in raw.lower(), f"status {status}")

    # The invitation screen is a client component, so its verdict arrives after a
    # fetch: the page itself is checked for rendering, the *token* is checked at
    # the endpoint the screen actually calls.
    status, payload, _, raw = call("GET", "/invite/inv_7c2f91ab", cookie="")
    check("the old hard-coded invitation link still renders", status == 200 and "<html" in raw.lower(), f"status {status}")
    status, gone, _, _ = call("GET", "/api/auth/invite/state?token=inv_7c2f91ab", cookie="")
    check("and that link is genuinely not valid", status == 200 and gone.get("valid") is False, json.dumps(gone)[:80])
    check("no screen offers a demo link that skips the flow", "rt_9f42c1ab" not in raw, "the seeded demo token is still on a page")


def clean_up():
    """Deactivate the probe members. Their workspaces go with tidy."""
    print("\nsweep")
    for member_id, email in MADE:
        status, _, _, _ = call("POST", "/api/v1/team", {"action": "deactivate", "id": member_id})
        if status == 200:
            print(f"  deactivated probe login {email}")
        else:
            print(f"  could not deactivate {email} (status {status}) — tidy will remove it")
    print(
        "\nProbe workspaces from the signup paths are left for the standing sweep:\n"
        "  npx tsx scripts/tidy-probe-orgs.ts --apply   (stop the app first; dry run without --apply)"
    )


def main():
    global OWNER
    print(f"auth check against {BASE}")
    OWNER = _session.cached_cookie(BASE, EMAIL, PASSWORD)
    if not OWNER:
        print(f"FAIL  could not sign in as {EMAIL} — is the app running?")
        return 1
    check("the demo owner can sign in", True)

    account = invitations()
    if account:
        password_reset(account)
        magic_link(account)
    verification()
    verified_account = verification_gate()
    seeded_and_trail(verified_account)
    clean_up()

    print(f"\n{PASS} PASS / {FAIL} FAIL")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
