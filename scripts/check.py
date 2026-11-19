#!/usr/bin/env python3
"""
One command that proves the whole thing.

The suite grew a gate per phase and every phase ended the same way: build it,
prove it against a **running** workspace, put the workspace back, write down what
changed. What was missing was the single command — `package.json` had no `check`,
so "is it green?" meant a person remembering thirty-two scripts in the right
order, with the right pauses, against the right build.

This is that command.

    npm run check              # everything that can run against the live app
    npm run check:offline      # the gates that need the app STOPPED
    npm run check -- --list    # what the plan is, without running it
    npm run check -- --only money
    npm run check -- --pause 30 --keep-going

What it does, in order:

  1. **Types first.** `tsc --noEmit` — a type error is a cheaper failure than a
     gate that half-runs.
  2. **The app.** Every HTTP gate talks to a real deployment on `:3000`; if
     nothing is listening the run stops and says how to start it, because a suite
     that "passes" against a stopped server proves nothing.
  3. **The gates**, in an order chosen for two reasons: cheapest first, and the
     sign-in-heavy ones spaced apart from each other so the login rate limiter is
     not what fails. Each gate's full output lands in `/tmp/gates/<name>.txt`;
     this prints one line per gate.
  4. **One verdict.** Pass counts are summed where the gates state them, failures
     are listed by name with their last line, and the exit code is the answer.

Gates the runner **skips on purpose** (and says so, rather than letting them fail
on the state of the machine):

  * `media-check` needs the app started with `VOXERA_MEDIA_SIMULATE=1` — a
    property of how the server was launched, not of the code.
  * `offer_expiry_probe` ages a real row and runs the real sweeper, so it needs
    the app **stopped** — it lives in `check:offline`.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE_LOGS = os.environ.get("VOXERA_GATE_LOGS", "/tmp/gates")
BASE = os.environ.get("VOXERA_BASE", "http://127.0.0.1:3000")

# ----------------------------------------------------------------- the plan

# (name, runner, pause-after, note). `pause` is the wait *after* a gate, for the
# ones that sign in enough times to matter against the login limiter.
GATES: list[tuple[str, str, int, str]] = [
    # Fast and broad first: if the app is up at all, these say how up it is.
    ("smoke", "py", 3, "the whole thing, shallowly"),
    ("api_check", "py", 25, "the public API surface, including a signup"),
    ("admin_check", "py", 8, "the operator console: cross-workspace view, suspend and reactivate"),
    ("totp-vectors", "ts", 0, "TOTP against the RFC 6238 vectors"),
    ("security_check", "py", 8, "2FA enforced at sign-in, account throttling, origin guard, body caps"),
    ("auth_check", "py", 30, "sign-in, reset, magic link, verify, invites — the heaviest for the limiter"),
    ("onboard_check", "py", 30, "a stranger signs up and provisions a number"),
    ("practice_check", "py", 8, "rota, availability, buffers, timezones, the agent's answers"),
    ("practice_team_check", "py", 8, "hiring, scoping and removing people across two sites"),
    ("client_check", "py", 8, "records, moves, series, consent, the access log"),
    ("booking-client-auth-check", "py", 8, "booking/client scopes, desk roles, atomic sync and non-destructive cancellation"),
    ("notes_check", "py", 8, "clinical notes: finalise, amend, roles"),
    ("book_check", "py", 8, "the public booking page"),
    ("booking_check", "py", 8, "a stranger books end to end, confirmation and all"),
    ("booking_status_regression_check", "py", 4, "an omitted upsert status preserves lifecycle and cannot bypass conflicts"),
    ("manage_check", "py", 8, "the client's own link: confirm, move, cancel, check in"),
    ("day_check", "py", 8, "the practitioner's own day: mine, free, bookable, one tap on"),
    ("mirror_check", "py", 4, "the dashboard's server mirror: every name answers, a settings slice round-trips"),
    ("waitlist_check", "py", 8, "the freed slot, the offer, the claim"),
    ("class_check", "py", 9, "one slot, several people, and never one too many"),
    ("messaging_check", "py", 8, "templates, reminders, no-shows, delivery receipts"),
    ("carrier_check", "py", 8, "carriers and numbers"),
    ("ai_check", "py", 8, "the assistant: tools, transcripts, the stub model"),
    ("money_check", "py", 8, "invoice → payment → statement reconciles"),
    ("money_loop_check", "py", 8, "receipts and the overdue chase"),
    ("reports_check", "py", 8, "who earns what, what it costs, who does not turn up"),
    ("report_tool_check", "py", 8, "the assistant reporting on the practice, and refusing to"),
    ("recall_check", "py", 8, "the recall window, and recalls that act"),
    ("leads_check", "py", 8, "the sales enquiry: form, inbox, pipeline — the lead that used to vanish"),
    ("workspace_export_check", "py", 8, "the whole workspace in one file — complete, and no secret travels"),
    ("growth_check", "py", 8, "signup to value: the funnel moves by one when a workspace arrives"),
    ("pack_check", "py", 8, "class packs: hold, spend, burn, release, refund — the money follows the places"),
    ("demo_check", "py", 8, "the demo reads as a practice that has been running for a month"),
    ("privacy_check", "ts", 4, "practice records stay on the server"),
    ("guard-check", "ts", 4, "outbound request policy (SSRF guard)"),
    ("race-check", "ts", 4, "concurrent writes do not lose a flush"),
    ("number-ownership-check", "ts", 4, "cross-process number reservations, expiry, compensation and uniqueness"),
    ("endpoint-probe --mode=live", "ts", 4, "customer endpoints execute when allowed, or state the locked-down skip"),
    ("room_window_check", "ts", 4, "the room picker and the clash check agree, window by window"),
    ("media-check", "ts", 4, "the Twilio media WebSocket (needs the simulated pipeline)"),
    # Release-claim boundary plus gates that read the last production build.
    ("marketing-claims-check", "py", 0, "retired catalogues stay retired; unsupported claims cannot re-enter public source"),
    ("nesting-check", "py", 4, "no invalid HTML nesting in any prerendered page"),
    ("linkcheck", "py", 4, "every internal link resolves"),
    ("sitemap-check", "py", 4, "every indexable route is in the sitemap"),
]

OFFLINE_GATES: list[tuple[str, str, int, str]] = [
    ("offer_expiry_probe --apply", "ts", 0, "offer expiry, proved by ageing a real row and running the real sweeper"),
    (
        "store-replace-check",
        "ts",
        0,
        "a full store replace keeps every document it was handed — the bug that emptied the store once",
    ),
]

# Gates that need something the runner cannot supply. A skip is stated, never
# silent, and it names the command that would have run it.
SKIP_IF = {
    "media-check": (
        lambda _text: media_pipeline_ready() is False,
        "the app's media pipeline is not live — its status endpoint reports no transcriber. Start the app with "
        "VOXERA_MEDIA_SECRET=<secret> VOXERA_MEDIA_SIMULATE=1 and run `npm run check -- --only media`.",
    ),
}

# The gates state their tally in one of two ways: "62 PASS / 0 FAIL" (the older
# style), or a sentence like "521 checks passed". Read the *last* one, from the
# last lines of the run — an earlier line mentioning a count is not the verdict.
# `\s` is deliberately not used between the number and the word: it matches
# newlines, and a phone number ending a line is not a pass count.
# `media-check` drives the Twilio media socket, which only carries audio when the
# app was started with the simulated pipeline. That is a fact the app publishes —
# `/api/telephony/media/status` answers `ready` and, when it is not, says why — so
# the runner asks the app instead of grepping the gate's output for the symptom.
# A real failure in a live pipeline is then reported as a failure.
MEDIA: dict[str, object] = {}


def media_pipeline_ready() -> bool | None:
    if "ready" in MEDIA:
        return MEDIA["ready"]  # type: ignore[return-value]
    try:
        with urllib.request.urlopen(f"{BASE}/api/telephony/media/status", timeout=8) as res:
            state = json.load(res)
        MEDIA["ready"] = bool(state.get("ready"))
        MEDIA["why"] = ((state.get("providers") or {}).get("transcriber") or {}).get("detail") or ""
    except Exception:
        MEDIA["ready"] = None
    return MEDIA["ready"]  # type: ignore[return-value]


TALLY_RE = re.compile(r"(\d+)[ \t]+(?:checks[ \t]+)?(PASS|passed|FAIL|failed)\b", re.IGNORECASE)
PAIR_RE = re.compile(r"(\d+)[ \t]+PASS[ \t]*/[ \t]*(\d+)[ \t]+FAIL", re.IGNORECASE)


# ------------------------------------------------------------------ helpers


def colour(code: str, text: str) -> str:
    if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
        return text
    return f"\033[{code}m{text}\033[0m"


def green(text: str) -> str:
    return colour("32", text)


def red(text: str) -> str:
    return colour("31", text)


def amber(text: str) -> str:
    return colour("33", text)


def dim(text: str) -> str:
    return colour("2", text)


def command_for(name: str) -> list[str]:
    """`smoke` → the thing that runs it. A name may carry its own flags."""
    parts = name.split()
    script, extra = parts[0], parts[1:]
    if shutil.which("python3") is None:
        raise SystemExit("python3 is not on PATH")
    path = ROOT / "scripts" / f"{script}.py"
    if path.exists():
        return ["python3", str(path), *extra]
    ts = ROOT / "scripts" / f"{script}.ts"
    if ts.exists():
        return [str(ROOT / "node_modules/.bin/tsx"), str(ts), *extra]
    raise SystemExit(f"no gate called {script} under scripts/")


LOCK = Path(os.environ.get("VOXERA_CHECK_LOCK", "/tmp/voxera-check.lock"))


def take_lock() -> tuple[bool, str]:
    """One suite at a time — two at once prove nothing.

    The gates are not read-only. They book, cancel, text and void rows in one
    shared workspace, and `race-check` writes the database file directly. Two
    suites against the same app therefore eat each other's evidence, and the
    symptom looks like flaky gates (a recall with no carrier, a socket that
    answers nothing, a connection refused) rather than what it is. The pid in the
    lock file makes the second run stop and name the first.
    """
    try:
        if LOCK.exists():
            holder = LOCK.read_text().strip()
            if holder.isdigit() and holder != str(os.getpid()) and Path(f"/proc/{holder}").exists():
                try:
                    cmdline = Path(f"/proc/{holder}/cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
                except Exception:
                    cmdline = "another run"
                return False, f"pid {holder} ({cmdline[:80]})"
    except Exception:
        pass
    LOCK.write_text(str(os.getpid()))
    return True, ""


def available_memory_mb() -> int | None:
    """What the box has left, because the gates are memory-hungry."""
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except Exception:
        return None
    return None


def app_up() -> bool:
    try:
        with urllib.request.urlopen(f"{BASE}/api/v1/clients", timeout=10) as res:
            return res.status in (200, 401, 403)
    except urllib.error.HTTPError:
        return True  # an HTTP answer is an answer
    except (urllib.error.URLError, OSError):
        return False


def stub_up(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=4):
            return True
    except urllib.error.HTTPError:
        return True
    except (urllib.error.URLError, OSError):
        return False


def counts(text: str) -> tuple[int, int]:
    """What the gate said it did, read from the end of its output.

    Three shapes, in order of authority: a stated `N PASS / M FAIL`, a stated
    `N checks passed` (with an optional `M failed`), and — for the gates that
    state nothing — the count of the one-line-per-check output they print. A
    stated tally is read from the last lines only: a gate may print one mid-run
    as well as at the end, and the earlier one is not the verdict.
    """
    tail = "\n".join([line for line in text.strip().splitlines() if line.strip()][-15:])
    pairs = PAIR_RE.findall(tail)
    if pairs:
        return int(pairs[-1][0]), int(pairs[-1][1])
    stated = TALLY_RE.findall(tail)
    if stated:
        passes = fails = 0
        for number, word in stated:
            if word.lower() in ("pass", "passed"):
                passes = int(number)
            else:
                fails = int(number)
        return passes, fails
    # No stated tally — most gates print one line per check instead, which is the
    # same number counted a different way.
    return (
        len(re.findall(r"(?m)^[ \t]*PASS\b", text)),
        len(re.findall(r"(?m)^[ \t]*FAIL\b", text)),
    )


def verdict_line(text: str) -> str:
    # Lines with no letters are noise for a verdict — a trailing `}` from a JSON
    # dump is not a summary of anything.
    lines = [line.strip() for line in text.strip().splitlines() if line.strip() and any(c.isalpha() for c in line)]
    for line in reversed(lines[-6:]):
        if re.search(r"ALL .*PASS|FAILED|PASS /|passed|FAIL ", line, re.IGNORECASE):
            return re.sub(r"\s+—\s+", " — ", line)[:150]
    return lines[-1][:150] if lines else "no output"


def run_gate(name: str, pause: int, keep_going: bool) -> dict:
    cmd = command_for(name)
    slug = name.split()[0]
    log_path = Path(GATE_LOGS) / f"{slug}.txt"
    Path(GATE_LOGS).mkdir(parents=True, exist_ok=True)
    started = time.time()
    try:
        gate_env = os.environ.copy()
        if slug == "store-replace-check":
            # This gate is the one intentional full-store replacement. Give only
            # its throwaway child the explicit non-production maintenance switch.
            gate_env["VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE"] = "1"
        proc = subprocess.run(cmd, cwd=ROOT, env=gate_env, capture_output=True, text=True, timeout=1200)
        output = (proc.stdout or "") + (proc.stderr or "")
        code = proc.returncode
    except subprocess.TimeoutExpired as expired:
        output = ((expired.stdout or b"").decode(errors="replace") if isinstance(expired.stdout, bytes) else (expired.stdout or "")) + "\n• timed out after 20 minutes"
        code = 124
    except FileNotFoundError as error:
        output = f"• could not run {cmd[0]}: {error}"
        code = 127
    log_path.write_text(output)
    seconds = time.time() - started

    text = output
    skip = SKIP_IF.get(slug)
    skipped = False
    if skip and skip[0](text):
        skipped = True
    passes, fails = counts(text)
    ok = code == 0 and fails == 0 and not skipped
    if not ok and fails == 0 and code != 0 and not skipped:
        # Some gates print a verdict and exit non-zero; some print nothing useful.
        fails = 1

    return {
        "name": name,
        "slug": slug,
        "ok": ok,
        "skipped": skipped,
        "skip_reason": skip[1] if skipped and skip else "",
        "passes": passes,
        "fails": fails,
        "seconds": seconds,
        "verdict": verdict_line(text),
        "log": str(log_path),
        "text": text,
    }


def print_result(result: dict, keep_going: bool) -> None:
    mark = dim("•") if result["skipped"] else (green("✔") if result["ok"] else red("✘"))
    seconds = f"{result['seconds']:.1f}s"
    if result["skipped"]:
        print(f"  {mark} {result['name']:<24} {dim('not run'):<22} {dim(seconds):<20} {amber('skipped')}")
        print(f"      {dim(result['skip_reason'])}")
        return
    if result["passes"]:
        tally = f"{result['passes']} passed" + (f", {result['fails']} failed" if result["fails"] else "")
        line = f"  {mark} {result['name']:<24} {tally:<22} {dim(seconds)}"
    elif result["ok"]:
        # No stated count: print the gate's own summary sentence rather than
        # inventing one. "528 static routes · 0 unresolvable link targets" is
        # more use than "all checks".
        line = f"  {mark} {result['name']:<24} {dim(result['verdict'])}"
    else:
        line = f"  {mark} {result['name']:<24} {result['fails'] or 1} failed"
    print(line)
    if not result["ok"]:
        print(f"      {red(result['verdict'])}")
        if not keep_going:
            tail = [l for l in result["text"].strip().splitlines() if l.strip()][-6:]
            for l in tail:
                print(f"      {dim(l[:150])}")


def main() -> int:
    # Line-buffered, so `npm run check | tee log` shows gates as they finish
    # rather than all at once — a suite that takes minutes is one people watch.
    try:
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Run the Voxera check suite.")
    parser.add_argument("--only", default="", help="run the gates whose name matches this substring")
    parser.add_argument("--list", action="store_true", help="print the plan and stop")
    parser.add_argument("--pause", type=int, default=None, help="seconds between gates (default: per-gate)")
    parser.add_argument("--keep-going", action="store_true", help="do not stop at the first failure")
    parser.add_argument("--fast", action="store_true", help="no pauses at all (expect the login limiter to bite)")
    parser.add_argument("--offline", action="store_true", help="the gates that need the app stopped")
    parser.add_argument("--force", action="store_true", help="run even if another run holds the lock")
    args = parser.parse_args()

    mine, holder = take_lock()
    if not mine and not args.force:
        print(red("\n  Another check run is already going: " + holder))
        print(dim("  The gates share one workspace, so two runs at once produce failures that are not real."))
        print(dim("  Wait for it (or run it with --only <gate> afterwards); --force overrides if you are sure."))
        return 2

    plan = OFFLINE_GATES if args.offline else GATES
    if args.only:
        needle = args.only.lower()
        plan = [g for g in plan if needle in g[0].lower()]
        if not plan:
            print(red(f"No gate in this suite matches “{args.only}”."))
            print(dim("  The plan is: " + ", ".join(g[0] for g in (OFFLINE_GATES if args.offline else GATES))))
            return 2

    if args.list:
        print(f"\n{'offline suite' if args.offline else 'live suite'} — {len(plan)} gate(s)\n")
        for name, _runner, pause, note in plan:
            spacing = f"+{pause}s" if pause else "no pause"
            print(f"  {name:<24} {dim(spacing):<10} {note}")
        print()
        if not args.offline:
            print(dim("  Offline (the app stopped): " + ", ".join(g[0] for g in OFFLINE_GATES)))
        return 0

    print()
    print(colour("1", f"Voxera check — {'offline' if args.offline else 'live'} suite, {len(plan)} gate(s) against {BASE}"))

    # ---- the app, and what it was started with ----------------------------
    if args.offline:
        if app_up():
            print(red("\n  The app is running on :3000 — these gates edit the database file directly."))
            print(dim("  Stop it first, or run the live suite: npm run check"))
            return 2
    else:
        if not app_up():
            print(red(f"\n  Nothing is answering on {BASE}."))
            print(dim("  Start the app first, in another shell:"))
            print(dim("      NODE_ENV=production TWILIO_API_BASE=http://127.0.0.1:4010 \\"))
            print(dim("      VOXERA_EMAIL_API_BASE=http://127.0.0.1:4010 ANTHROPIC_API_BASE=http://127.0.0.1:4020 \\"))
            print(dim("      ANTHROPIC_API_KEY=stub-anthropic-key npm start"))
            print(dim("  …with the stubs up (`tsx scripts/twilio-stub.ts`, `tsx scripts/ai-stub.ts`)."))
            return 2
        missing = [port for port in (4010, 4020) if not stub_up(port)]
        if missing:
            print(amber(f"\n  note: nothing is answering on {', '.join(f':{p}' for p in missing)} — "
                        "the delivery and model stubs. Gates that need them will fail on that, not on the code."))

    free_mb = available_memory_mb()
    if free_mb is not None and free_mb < 500:
        print(amber(f"\n  note: only {free_mb} MB of memory is available. These gates are memory-hungry "
                    "(several run their own node processes), so the app can be killed mid-run on a small box."))

    # ---- types, before anything expensive ---------------------------------
    if not args.offline:
        started = time.time()
        typed = subprocess.run([str(ROOT / "node_modules/.bin/tsc"), "--noEmit"], cwd=ROOT, capture_output=True, text=True)
        print(f"  {'✔' if typed.returncode == 0 else red('✘')} {'tsc --noEmit':<24} "
              f"{dim(f'{time.time() - started:.1f}s')}")
        if typed.returncode != 0:
            for line in (typed.stdout or "").strip().splitlines()[:12]:
                print(f"      {red(line[:150])}")
            print(red("\n  Types failed — nothing else was run."))
            return 1

    # ---- the gates --------------------------------------------------------
    print()
    results: list[dict] = []
    for index, (name, _runner, pause, _note) in enumerate(plan):
        if args.pause is not None:
            pause = args.pause
        if args.fast:
            pause = 0
        skip = SKIP_IF.get(name.split()[0])
        if skip and skip[0](""):
            # Ask first, run later: when the reason a gate cannot pass is knowable,
            # finding it out costs one request, not a minute of failing checks.
            result = {
                "name": name,
                "slug": name.split()[0],
                "ok": False,
                "skipped": True,
                "skip_reason": skip[1],
                "passes": 0,
                "fails": 0,
                "seconds": 0.0,
                "verdict": "",
                "log": "",
                "text": "",
            }
        else:
            result = run_gate(name, pause, args.keep_going)
        results.append(result)
        print_result(result, args.keep_going)
        # Did the thing we are all talking to survive that gate? If it did not,
        # every gate after this one fails for that reason and not its own — which
        # is how three unrelated failures appeared in one run on a 2 GB box where
        # the kernel had killed the app. Say so, and stop.
        if not args.offline and not app_up():
            print(red(f"\n  The app is no longer answering on {BASE} — it died during {result['slug']}."))
            print(dim("  Every gate after this one would fail for that reason rather than its own, so the run stops here."))
            print(dim("  A container this size (≈2 GB) can OOM-kill the server under the memory-heavy gates:"))
            print(dim("  the reply is to restart it and run the remaining gates, not to chase the failures that follow."))
            results.append({
                "name": "the app died", "slug": "app-died", "ok": False, "skipped": False, "skip_reason": "",
                "passes": 0, "fails": 1, "seconds": 0.0,
                "verdict": f"the app stopped answering after {result['slug']}",
                "log": "", "text": "",
            })
            break
        if not result["ok"] and not result["skipped"] and not args.keep_going:
            print(red("\n  Stopped at the first failure. Re-run with --keep-going for the whole picture."))
            break
        if pause and index < len(plan) - 1:
            time.sleep(pause)

    # ---- one verdict ------------------------------------------------------
    ran = [r for r in results if not r["skipped"]]
    skipped = [r for r in results if r["skipped"]]
    failed = [r for r in ran if not r["ok"]]
    passes = sum(r["passes"] for r in ran)
    fails = sum(r["fails"] for r in ran)

    print()
    print(dim(f"  logs: {GATE_LOGS}/<gate>.txt"))
    if failed:
        print(red(f"  {len(failed)} of {len(ran)} gate(s) FAILED: " + ", ".join(r["slug"] for r in failed)))
        for r in failed:
            print(f"    · {r['slug']}: {r['verdict']}")
    else:
        counted = f" — {passes} checks passed, 0 failed" if passes else ""
        print(green(f"  {len(ran)} gate(s) green{counted}." + (f" {len(skipped)} skipped." if skipped else "")))
    if skipped:
        for r in skipped:
            print(f"    {amber('skipped')} {r['slug']}: {r['skip_reason']}")

    if not args.offline and not failed:
        print(dim(f"\n  Offline gates are separate — with the app stopped: npm run check:offline"))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        # Only remove a lock this process took: a refused run must not free
        # somebody else's.
        try:
            if LOCK.exists() and LOCK.read_text().strip() == str(os.getpid()):
                LOCK.unlink()
        except Exception:
            pass
    sys.exit(code)
