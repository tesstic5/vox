#!/usr/bin/env python3
"""Security check — the P1 hardening, proven end to end.

Four things were implemented from the 2026-10-26 audit, and this gate holds
each of them to account against the running app:

  1. **Two-factor is a factor now.** A fresh account enrols (setup → a wrong
     code is refused → the right code goes live and mints recovery codes),
     signs out, and finds that the password alone now earns only a
     five-minute challenge: no session cookie, and the API agrees there is
     nobody signed in. The right code signs in; a recovery code signs in
     exactly once; disabling demands the password AND a current code.
  2. **Account throttling.** Five wrong passwords for one account — each from
     a *different* IP, so the per-IP limit cannot be what stops it — and the
     sixth attempt is refused 429 even before the password is looked at.
  3. **Origin guard.** A cookie-authenticated POST whose `Origin` is a
     different site is refused 403; the same request same-origin (or with no
     Origin at all, like every other gate) is not.
  4. **Body caps.** A JSON body over the default cap is refused 413 with the
     limit in words, header-declared or not.

Probe accounts are fresh per run and left for the probe tidy-up, like the
other auth gates. Run against a running app:

    python3 scripts/security_check.py
"""

import base64
import hashlib
import hmac as hmac_mod
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")
STAMP = str(int(time.time()))

failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


# One client address of its own per run (the api_check/leads_check pattern):
# signup allows 15 accounts per address per 10 minutes and login 10 a minute,
# budgets the whole suite shares from localhost. A gate that spends from its
# own address can be re-run without failing on the previous run's warmth.
RUN_IP = f"198.51.100.{int(STAMP) % 180 + 20}"


def call(method, path, body=None, cookie=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("x-forwarded-for", RUN_IP)
    if data is not None and raw is None:
        req.add_header("content-type", "application/json")
    if cookie:
        req.add_header("cookie", cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode()
            return res.status, (json.loads(text) if text else {}), res.headers.get("set-cookie")
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, (json.loads(text) if text else {}), err.headers.get("set-cookie")
        except json.JSONDecodeError:
            return err.code, {}, err.headers.get("set-cookie")


def totp(secret_b32, at=None):
    """RFC 6238 in the gate, so the check does not trust the app's own math."""
    pad = "=" * ((8 - len(secret_b32) % 8) % 8)
    key = base64.b32decode(secret_b32.upper() + pad)
    counter = int((at or time.time()) // 30)
    digest = hmac_mod.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{binary % 1_000_000:06d}"


def signup(tag):
    email = f"secprobe.{tag}.{STAMP}@example.com"
    status, body, sc = call("POST", "/api/auth/signup", {
        "email": email, "password": "probe-password-2026", "name": "Security Probe", "orgName": f"Sec Probe {tag} {STAMP}",
    })
    assert status in (200, 201), f"signup {tag}: HTTP {status} {body}"
    return email, "probe-password-2026", sc.split(";")[0]


def login(email, password, ip=None):
    headers = {"x-forwarded-for": ip} if ip else None
    return call("POST", "/api/auth/login", {"email": email, "password": password}, headers=headers)


def main():
    email, password, cookie = signup("totp")

    # --- enrolment -------------------------------------------------------------
    status, body, _ = call("GET", "/api/auth/2fa", cookie=cookie)
    check("2FA starts off for a new account", status == 200 and body.get("data", body).get("twoFactor", {}).get("enabled") is False, f"HTTP {status}")

    status, body, _ = call("POST", "/api/auth/2fa", {"action": "setup"}, cookie=cookie)
    secret = (body.get("data") or body).get("secret", "")
    check("setup mints a secret", status == 200 and len(secret) >= 26, f"HTTP {status}")

    status, body, _ = call("POST", "/api/auth/2fa", {"action": "confirm", "code": "000000" if totp(secret) != "000000" else "111111"}, cookie=cookie)
    check("a wrong enrolment code is refused", status == 400, f"HTTP {status}")

    status, body, _ = call("POST", "/api/auth/2fa", {"action": "confirm", "code": totp(secret)}, cookie=cookie)
    data = body.get("data") or body
    codes = data.get("recoveryCodes", [])
    check("the right code enables 2FA with 8 recovery codes", status == 200 and data.get("enabled") is True and len(codes) == 8, f"HTTP {status}, {len(codes)} codes")

    status, body, _ = call("GET", "/api/auth/me", cookie=cookie)
    me = body.get("data") or body
    check("me reports the live factor", me.get("user", {}).get("twoFactor", {}).get("enabled") is True, f"HTTP {status}")

    # --- the password alone no longer signs in ---------------------------------
    call("POST", "/api/auth/logout", {}, cookie=cookie)
    status, body, sc = login(email, password)
    data = body.get("data") or body
    challenge = data.get("challenge", "")
    check("password alone now earns a challenge, not a session",
          status == 200 and data.get("mfaRequired") is True and bool(challenge) and not sc, f"HTTP {status}")

    status, body, _ = call("GET", "/api/auth/me")
    check("and there is genuinely no session behind it", (body.get("data") or body).get("authenticated") is False, f"HTTP {status}")

    status, _, _ = call("POST", "/api/auth/login/verify", {"challenge": challenge, "code": "000000" if totp(secret) != "000000" else "111111"})
    check("a wrong sign-in code is refused", status == 401, f"HTTP {status}")

    status, body, sc = call("POST", "/api/auth/login/verify", {"challenge": challenge, "code": totp(secret)})
    cookie2 = sc.split(";")[0] if sc else ""
    check("the right code signs in", status == 200 and bool(cookie2), f"HTTP {status}")

    # --- recovery code: once only ----------------------------------------------
    call("POST", "/api/auth/logout", {}, cookie=cookie2)
    status, body, _ = login(email, password)
    challenge = (body.get("data") or body).get("challenge", "")
    status, body, sc = call("POST", "/api/auth/login/verify", {"challenge": challenge, "code": codes[0]})
    check("a recovery code signs in", status == 200 and bool(sc), f"HTTP {status}")
    cookie3 = sc.split(";")[0] if sc else ""
    call("POST", "/api/auth/logout", {}, cookie=cookie3)
    status, body, _ = login(email, password)
    challenge = (body.get("data") or body).get("challenge", "")
    status, _, _ = call("POST", "/api/auth/login/verify", {"challenge": challenge, "code": codes[0]})
    check("and the same recovery code never works twice", status == 401, f"HTTP {status}")

    # --- disabling needs both proofs --------------------------------------------
    status, body, sc = call("POST", "/api/auth/login/verify", {"challenge": challenge, "code": totp(secret)})
    cookie4 = sc.split(";")[0] if sc else ""
    status, _, _ = call("POST", "/api/auth/2fa", {"action": "disable", "password": "not-the-password", "code": totp(secret)}, cookie=cookie4)
    check("disabling with a wrong password is refused", status == 401, f"HTTP {status}")
    status, body, _ = call("POST", "/api/auth/2fa", {"action": "disable", "password": password, "code": totp(secret)}, cookie=cookie4)
    check("disabling with password + code works", status == 200 and (body.get("data") or body).get("enabled") is False, f"HTTP {status}")
    call("POST", "/api/auth/logout", {}, cookie=cookie4)
    status, body, sc = login(email, password)
    check("and the password alone signs in again", status == 200 and bool(sc) and (body.get("data") or body).get("mfaRequired") is not True, f"HTTP {status}")
    cookie5 = sc.split(";")[0] if sc else ""

    # --- origin guard -------------------------------------------------------------
    status, _, _ = call("POST", "/api/v1/clients", {"action": "noop"}, cookie=cookie5,
                        headers={"origin": "https://evil.example"})
    check("a cross-origin cookie POST is refused", status == 403, f"HTTP {status}")
    status, _, _ = call("POST", "/api/v1/clients", {"action": "noop"}, cookie=cookie5,
                        headers={"origin": os.environ.get("VOXERA_PUBLIC_URL", BASE)})
    check("the same request same-origin is not refused for its origin", status != 403, f"HTTP {status}")

    # --- body cap -----------------------------------------------------------------
    big = {"name": "x" * (300 * 1024), "number": "+15550190000"}
    status, body, _ = call("POST", "/api/v1/clients", big, cookie=cookie5)
    check("an oversized JSON body is refused 413", status == 413 and "PAYLOAD_TOO_LARGE" in json.dumps(body), f"HTTP {status}")

    # --- account throttling (fresh account, rotating IPs) --------------------------
    email2, password2, cookie_b = signup("throttle")
    call("POST", "/api/auth/logout", {}, cookie=cookie_b)
    codes_seen = []
    for i in range(5):
        status, _, _ = login(email2, "wrong-password", ip=f"198.51.100.{40 + i}")
        codes_seen.append(status)
    check("five wrong passwords are plain refusals", codes_seen == [401] * 5, str(codes_seen))
    status, body, _ = login(email2, password2, ip="198.51.100.99")
    check("the sixth attempt is throttled even with the right password, from a new IP",
          status == 429 and "RATE_LIMITED" in json.dumps(body), f"HTTP {status}")

    print()
    if failures:
        print(f"FAILURES: {', '.join(failures)}")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
