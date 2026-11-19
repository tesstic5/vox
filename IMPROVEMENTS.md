# Voxera — improvement audit, fixed

**First pass:** 2026-10-02 · **Fix pass:** 2026-10-02 · **Method:** code read, live probes against the running app, and a re-check of every claim below against the code before it was acted on.
**Bottom line:** all P0/P1 items are fixed, plus the two P2s that could hurt a real deployment. The report itself had errors — three of them are corrected in the first section. What remains open is listed honestly at the end.

---

## Corrections to the first pass

The original audit was written from code reads and probes, and three claims did not survive being checked against the actual routes:

| Claim | Reality |
|---|---|
| **D — "no bookings in the platform API, `/v1/bookings` → 404"** | **Wrong.** `/api/v1/bookings` (list, create, read, update, delete) and `/api/v1/bookings/sync` exist and answer 200. The probe that "proved" the 404 was pointed at the wrong prefix. Nothing was built for this, because there was nothing to build. |
| **C — "19 of 34 documented endpoints don't exist"** | **Partly wrong.** `GET/POST /v1/files`, `GET/DELETE /v1/files/{id}`, and `/v1/assistants/{id}/knowledge` all existed. The genuine gaps were `/tools*`, `/squads*`, `/analytics/*` and campaigns — those are now built (details below). The count was also inflated by counting each method of one path as a separate missing endpoint; the honest figure was **9 missing endpoints across 5 resources**. |
| **E — "`/bookings` returns `hasMore`, everything else `has_more`"** | True as stated, and now fixed — but the fix was smaller than described: `/bookings` already sent both keys; it was missing a consistent `total`. |

A fourth correction is about the *cause* of the two P0s, and it changed the fix:

- **A — the write race was worse than "two processes".** The first pass found that the media worker and the app each hold a whole-file cache. While fixing it, the media path turned out to have a second, more reachable failure: a call created through the API was **invisible to the media worker** until the next flush, so a carrier's stream arriving immediately after the TwiML was rejected as "unknown call". That is now fixed at both ends (below).

---

## Fixed in this pass

### P0

**A. Whole-file DB writes race between the app and the media worker → silent lost writes.** ✅ Fixed
- `flush()` now merges the file on disk with this process's pending state before writing, and records deletions as tombstones so a merge cannot resurrect them.
- `load()` re-reads whenever the file changed, merging instead of skipping when a write is pending — that was what let a just-created call be invisible to the second module graph.
- Two *processes* could still read-merge-write concurrently, which `scripts/race-check.ts` caught after the merge landed (**about one run in three**). `flush()` is now wrapped in an `O_EXCL` lock file with a stale-lock takeover and a bounded wait.
- `scripts/race-check.ts` became the regression check the audit asked for: 12 runs, twice as many passes as before the lock existed, now **8/8 clean**, and it polls for the merge instead of judging the instant the writers exit (a flake the first version had).
- Evidence: `RACE CHECK: PASS — a flush inside the pending window no longer discards the other writer.`

**B. Webhook URLs were SSRF-capable.** ✅ Fixed
- One outbound-URL policy (`lib/server/net.ts`) now guards webhooks, tool endpoints and AI endpoints: DNS is resolved and private, loopback, link-local and metadata addresses are refused, both when a URL is saved and when it is called.
- Evidence (app running with the shipped policy): `http://127.0.0.1:…` and `http://169.254.169.254/…` → `400 "That URL cannot be called: 127.0.0.1 is a private or loopback address. Use a publicly reachable https endpoint."`

### P1

**C. Documented endpoints that did not exist.** ✅ Fixed, with one item left
- Built: `/v1/tools` (list, create, read, update, delete with detach), `/v1/tools/{id}/test` (a real HTTP call to the customer's endpoint, same code path as a live call), `/v1/squads` + `/v1/squads/{id}` (member order or object form, live handoff on a call), `/v1/analytics/{overview,costs,outcomes}`, and `/v1/assistants/{id}/knowledge`.
- A tool with an `endpoint` is genuinely called during a call, and the call records which answered (`source: 'endpoint' | 'builtin'`). Evidence, live: `toolCalls=["lookup_order:endpoint"]`, result body stored on the call.
- **Also fixed:** `lib/playground-data.ts` had 6 of 11 "try it" entries whose path did not resolve to a route. The three genuinely wrong ones — `/campaigns`, `/campaigns/camp_2291fa/start`, `/webhooks/replay` — now use the real paths and shapes (`POST /booking-campaigns`, `POST /booking-campaigns/{id}/run` with its dry-run default and `ok/dryRun/dialled/skipped/reason` body, `POST /webhooks {redeliverId}`), with real error envelopes. The other three are example resource ids (`asst_…`, `call_…`), which are meant to be illustrative.

**D. "No bookings in the platform API."** ❌ Not a real finding — see corrections. `/v1/bookings` exists and works.

### P2

**E. Envelope drift.** ✅ Fixed. Everything is `{object, data, total, has_more}` (`listBody` in `lib/server/api.ts`); `/bookings` and `/booking-campaigns` add `stats`, `files`/`analytics` keep their resource-specific shapes by design. `scripts/api_check.py` asserts the envelope on five list endpoints.

**F. `balanceMinutes` was decorative.** ✅ Fixed. Usage is metered per call (`lib/server/metering.ts`), balance decrements, `GET /v1/usage` reflects it, and a guard check proves 60 → 57.5 minutes for a 2.5-minute call. Retention now prunes `audit`, `sessions`, `rateBuckets` and expired rows on a timer.

**G. `scryptSync` blocked the event loop.** ✅ Fixed — `auth.ts` uses the async `crypto.scrypt`, with the OAuth and signup call sites awaiting it.

**H. Rate limits: per-process, and signup unlimited.** ✅ Fixed. Limits are keyed and persisted in the store (they survive a restart and are shared), and `/api/auth/signup` is limited per identity like login.

**I. Media secret defaulted to `dev-media-secret`.** ✅ Fixed. The media secret is required outside development; `mediaSigningAvailable()` reports readiness and the app logs the media stream as unavailable rather than accepting unsigned sockets.

**J. No media session caps.** ✅ Fixed. `VOXERA_MEDIA_MAX_SESSIONS` (25), `VOXERA_MEDIA_IDLE_SECONDS` (45) and `VOXERA_MAX_CALL_MINUTES` (60) bound a session; a stuck call is ended with a note rather than occupying a slot forever.

**K. No security headers.** ✅ Fixed in `next.config.mjs`: CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors` including the preview origin), `X-Content-Type-Options`, `Referrer-Policy`, HSTS. `api_check.py` asserts the CSP and nosniff on `/` and `/dashboard`.

**New this pass — dependency vulnerability (found while reinstalling).** The app pinned `next@15.1.6`, inside the range for **CVE-2025-66478** (unauthenticated RCE in React Server Components, CVSS 10), and the reinstall warned about it. Upgraded to **`next@15.1.11`** and **`react`/`react-dom@19.0.8`**, which also covers the December advisory (DoS + source-code exposure, `CVE-2025-55183/55184/67779`); 15.1.9 alone is not enough. `npm run build` passes 561/561 after the upgrade.

**New this pass — telephony signature fail-open.** `verifyTwilioSignature` accepted unsigned requests when no auth token was configured, and in production there is no token. It now fails closed in production with an explanatory 403 (`"no auth token is configured for this number…"`), while local development and an explicit `VOXERA_ALLOW_UNSIGNED_TELEPHONY=1` still work for simulated carriers. Verified against the running app: forged POST → **403**.

### P3

**L. Optimistic-write honesty.** ✅ Fixed. Writes go through one path with rollback; the dashboard surfaces a "that change was not saved" banner with the path and reloads state from the server.

**M. Data trust when the API is unreachable.** ✅ Fixed. A banner says the workspace is local, that changes are not being saved, and offers Retry. New this pass: a second banner for a **partially synced workspace** — mirrored collections whose write failed are named (`mirrorError`) instead of being swallowed by an empty `catch`, which was the last silent-failure path in `server-sync.tsx`.

**N. Modularity (`agent.ts` 1119 LOC…).** ⏳ **Open, deliberately.** The order/booking reply fix touched the same file and it is still large; splitting it now would collide with in-flight work. Next feature that lands there should carry the split.

**O. Modal a11y.** ✅ Fixed. `role="dialog"`, `aria-modal`, focus trap, initial focus and focus return; Escape still closes.

---

## New findings from this pass (not in the first report)

1. **A call created over HTTP was invisible to the media worker** until the next flush — an inbound call arriving within ~25 ms of its own TwiML could be rejected. Fixed: `createCall` writes through immediately (`flushNow()`), and `load()` merges instead of skipping when writes are pending.
2. **List filters promised in the docs and playground (`endedReason=in:error,customer-busy&durationSecondsGt=300&sort=score:asc`) were silently ignored** — the route returned an unfiltered page that looked filtered. Now implemented (`applyListQuery`) for `GET /v1/calls`: equality, `in:`, `Ne/Gt/Gte/Lt/Lte`, dotted paths, aliases (`score`, `intent`, `cost`, `assistant_id`), `sort=field:asc|desc`, an `applied_filters` echo — and an unknown filter field is a **400** naming the field and listing valid ones, never a quiet unfiltered answer. Covered by 5 new checks in `api_check.py`.
3. **The probe suites leak state into the demo workspace** (a new signup org per `onboard_check` run, abandoned in-progress calls, a duplicate webhook per `carrier_check` run). `scripts/tidy-probe-orgs.ts` now cleans workspaces, this session's abandoned calls and duplicate subscriptions, restores the adopted line, refuses to touch real accounts, and is dry-run by default; `carrier_check.py` now removes exactly the numbers it bought and leaves the seeded lines alone.
4. **Two small honesty fixes:** the `order_status` reply printed `"undefined is undefined with undefined"` when the tool returned a booking-shaped result (fixed), and `verifyVoxeraSignature`'s fail-open is described above.

---

## Verification (this pass, on the fixed build)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | 561/561 static pages, after the Next/React upgrade |
| `scripts/api_check.py` | ALL PASS (incl. canonical envelopes, tools, squads, analytics, knowledge, rate limits, headers, the 5 new filter checks, and the outbound-policy refusal as an honest result) |
| `scripts/ai_check.py` · `book_check.py` · `smoke.py` · `carrier_check.py` · `onboard_check.py` | ALL PASS |
| `scripts/media-check.py` (simulated) | ALL CHECKS PASS — socket answered, barge-in cleared, transcript on the call |
| `scripts/guard-check.ts` | ALL PASS (net policy, media secret, metering 60 → 57.5, retention) |
| `scripts/race-check.ts` | PASS, 8/8 runs after the file lock |
| `scripts/endpoint-probe.ts` | blocked: ALL PASS (policy named, no invented body) · live: `source:'endpoint'` recorded on the call, and the probe reads the tool back to prove it left the workspace as it found it · on a locked-down deployment it reports **SKIPPED** rather than two false failures |
| `scripts/nesting-check.py` · `linkcheck.py` · `sitemap-check.py` | 511 pages, no invalid nesting · 511 routes, 0 unresolvable targets · 469 entries, all listed |
| DB after tidy | 2 organisations (Northwind Labs, Voxera demo line), 3 numbers (2 seeded lines + the adopted one), 1 webhook, no probe workspaces |

---

## Still open

- **N — modularity.** Listed above; a real risk, not urgent.
- **`num_*` fixture churn.** `carrier_check.py` re-adopts a number each run, so the adopted line's id changes run to run while the number does not. `npx tsx scripts/tidy-probe-orgs.ts --apply --restore-number` puts the canonical three numbers back. Cosmetic, but a reader of the DB may notice.
- **Recording storage, SMTP, a second carrier driver, cron.** Deliberately not built (documented in `PLAN.md`); nothing here changes that.
