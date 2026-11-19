"""A shared sign-in for the check scripts.

Signing in on every run is what a person does once: these scripts run back to
back while a phase is being verified, and the login route rate-limits by design.
So the session is cached in /tmp and re-verified before use — a cookie that the
server has forgotten (an app restart) is thrown away and replaced.
"""

import json
import os
import urllib.error
import urllib.request

CACHE = os.environ.get("VOXERA_CHECK_SESSION", "/tmp/voxera-check-session.json")


def _read_cache():
    """The whole file: one cookie per (base, email), so a suite run that signs in
    as the owner and as the front desk keeps both instead of thrashing one slot —
    every needless sign-in is a hit against the sign-in limiter."""
    if not os.path.exists(CACHE):
        return {"sessions": {}}
    try:
        cached = json.load(open(CACHE))
    except (OSError, json.JSONDecodeError):
        return {"sessions": {}}
    if "sessions" not in cached and cached.get("cookie"):
        # Older files held a single session; keep it working.
        return {"sessions": {f"{cached.get('base')}|{cached.get('email')}": cached}}
    return cached


def _write_cache(data):
    try:
        with open(CACHE, "w") as fh:
            json.dump(data, fh)
    except OSError:
        pass


def _login(base, email, password):
    req = urllib.request.Request(
        f"{base}/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        method="POST",
    )
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            cookie = (res.headers.get("set-cookie") or "").split(";")[0]
            if cookie:
                data = _read_cache()
                data.setdefault("sessions", {})[f"{base}|{email}"] = {"cookie": cookie, "base": base, "email": email}
                _write_cache(data)
            return cookie
    except urllib.error.HTTPError:
        return ""


def session(base, email, password):
    """A cookie that works, from the cache if it still holds."""
    cached = _read_cache().get("sessions", {}).get(f"{base}|{email}") or {}
    if cached.get("cookie"):
        probe = urllib.request.Request(f"{base}/api/v1/clients?limit=1")
        probe.add_header("cookie", cached["cookie"])
        try:
            with urllib.request.urlopen(probe, timeout=30):
                return cached["cookie"]
        except urllib.error.HTTPError as err:
            if err.code not in (401, 403):
                return cached["cookie"]
        except OSError:
            return cached["cookie"]
    return _login(base, email, password)


def cached_cookie(base, email, password):
    """The cookie for a gate's own store, or '' when the sign-in did not take.

    Gates keep module-level `cookie` globals that their request helper reads; this
    is the one call they need so a suite run signs in once per identity rather
    than once per gate.
    """
    return session(base, email, password)


def drain_queue(deliver, is_done, *, runs=16, on_run=None):
    """Run the send queue until the row a gate cares about leaves `pending`.

    The queue drains oldest-first and is capped per run — the same cap the
    scheduler tick uses (25 rows). A busy workspace therefore needs more than one
    send before a freshly queued row is reached, and a gate that sends once and
    then asserts *its* row went out is asserting the size of the backlog rather
    than the behaviour of the code. This is the honest loop: send, re-read, stop
    the moment the row is done or the queue stops making progress.

    `deliver` is the gate's own callable, so each gate keeps its own auth and its
    own idea of what a message looks like; `is_done` re-reads the row and answers
    whether it is no longer pending. Returns `(runs_used, last_response)`.
    """
    last = None
    for n in range(1, runs + 1):
        status, body = deliver()
        last = (status, body)
        if on_run:
            on_run(n, status, body)
        if is_done():
            return n, last
        if not isinstance(body, dict):
            break
        moved = sum(int(body.get(k) or 0) for k in ("sent", "failed", "blocked"))
        if moved == 0:
            # Nothing sendable is left ahead of it — more runs would not help.
            break
    return runs, last
