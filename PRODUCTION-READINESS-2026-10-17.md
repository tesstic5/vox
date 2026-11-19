# Production readiness — what is true, what is fixed, what still blocks

**Date:** 2026-10-17
**Build:** `8UaFUWojWtKLWF8atCagq` · Next **15.5.28** · tsc 0 · node 20.20.2
**Question asked:** "check everything and see it is good so we can use it for production."

> **Update 2026-11-02 — this dated verdict is superseded for multi-customer use.**
> A fresh-store review found platform-operator, OAuth and generic collection-bridge
> failures that the configured single-workspace suite did not cover. The discovered
> paths are now closed and independently regressed in `scripts/tenant-security-check.py`
> (46/46 with no operator allowlist; 45/45 with an explicit allowlist), but real
> clinical/patient data still requires an independent security test and appropriate
> legal/provider review. Current build: `TUg22QouL4ycHn3gJdbGQ` (Next 16.4.3).
> Use `MULTI-BUSINESS-PLAN.md` and the updated security audit as the current plan;
> do not treat the 2026-10-17 wording below as a present production sign-off.

---

## 1. Verdict

**Go for a single-node pilot, including one that holds a small practice's real diary.** Still **not** a
multi-node, multi-tenant clinical service: that is a job-queue and replication change, not a setting.

The three things that made the first draft of this report say *pilot only* — a file store rewritten
wholesale, no off-box backup, and a scheduler that would double-send on two replicas — are closed, as is
the fabricated data every new signup used to receive. The store is now SQLite with WAL (one row per
document), backups run on a timer with a restore drill behind them, the scheduler refuses to run beside
itself, and a fresh production signup arrives with an empty diary. Sections 3 and 4 say what changed and
what is left; the remaining items are **deployment decisions** (TLS, a payment account, a delivery
provider), not code this repository can fabricate.

There is one correction to the first draft worth keeping: the migration exposed a store bug that **emptied
the database once**, during this pass. It was caught by the next read, the pre-change dump on disk was
restored in full, and the failure now has its own gate (§3(h)). It is recorded here rather than quietly
fixed, because "we broke it and proved it cannot happen silently again" is the more useful fact.

---

## 2. Scorecard

| Area | Result | Evidence |
| --- | --- | --- |
| Type check | **0 errors** | `tsc --noEmit` |
| Production build | **passes** | `.next/BUILD_ID = sI4p9gqDAOjdHEwZq-8gJ` |
| Live gate suite | **33 gates · 0 failed** (1,391–1,401 checks, varying with live state) | `python3 scripts/check.py --keep-going` |
| Browser walks | **125 checks · 0 failed** | console 48 · day 41 · calendar 13 · classes 23 |
| Offline gates | **2 gates · 18 checks · 0 failed** | `npm run check:offline` |
| Dependency audit (runtime) | **0 vulnerabilities** | `npm audit --omit=dev` |
| Dependency audit (dev tree) | 7 (5 high, 2 moderate) | Tailwind 3's build chain; fix = Tailwind 4 |
| Store | **SQLite + WAL**, 60 collections / 72,683 docs migrated | `VOXERA_STORE=sqlite` |
| Write cost | **2 ms** insert+flush (was 325 ms) | measured, same data |
| Backup | **off-box, on a timer, checksummed, restore drilled** | `scripts/backup-store.ts`, drill 338 → 339 |
| Single writer | second replica **disables its scheduler**, proven | `scripts` two-process run on :3100 |
| Health | `/api/health` → 200/503 with build id and store state | — |
| Metrics | `/api/metrics` → Prometheus text | counters + latency + store size |
| Seed on signup | **production default: empty diary** | fresh signup: 0 calls / 0 bookings / 0 clients |
| Container | runtime command + healthcheck proven; **`docker build` itself unverified** (no daemon here) | see §6 |
| Secrets | no shared fallback in production | fixed in the first pass |

---

## 3. What was wrong, and what changed

### (a) The deployed Next version was rated *critical* by `npm audit`

`next@15.1.11` sat inside the range of a long list of advisories: middleware bypass, RSC cache
poisoning, SSRF in rewrites, DoS on Server Components, and an image-optimiser RCE. Three of those do
not apply here — the app uses **no `next/image`, no Server Actions and no rewrites** (checked, all
zero) — but middleware and the App Router are the two things the app is made of, so middleware bypass
and RSC cache poisoning were live.

- **Changed to `15.5.28`**, the 15.x security backport line (dist-tag `backport`).
- Added `overrides` for `postcss` (inside next) and `source-map-js`, both build-time libraries, both
  flagged.
- **Result: `npm audit --omit=dev` → 0 vulnerabilities** (from 1 critical + 3 high).

### (b) Two hard-coded secrets signed real things

Both were literal fallbacks that a reader of this repository could use:

| File | Was | What it signed |
| --- | --- | --- |
| `lib/server/manage-links.ts` | `'voxera-unsafe-default-secret'` | **every client self-service link** (`/m/<token>`) and every freed-slot offer — a forged link confirms, moves or cancels somebody's appointment |
| `lib/server/demo-token.ts` | `'voxera-demo-secret'` | the homepage demo's turn tokens |

Neither could be caught by a gate, because every gate runs with the variable set and never exercises
the fallback. Both now resolve: configured secret → derived from `VOXERA_SECRET_KEY` → per-process
random (production) with a loud log line → the old constant only in development. New variables
`VOXERA_MANAGE_SECRET` and `VOXERA_DEMO_SECRET` are in `.env.example`.

The same audit found the **encryption key** fallback (`'voxera-ephemeral'`): a read-only filesystem with
no env key produced the *same* publicly known key on every deployment. Production now generates a random
per-process key and says so — that makes stored carrier credentials unreadable after a restart, which is
loud and fixable, rather than silently forgeable.

### (c) The store was atomic but not durable, and wrote 33% more bytes than it had to

*Superseded by (h): these changes were made to the JSON engine, which is now the fallback engine rather
than the one production runs. Kept because the reasoning applies to any durable write path.*

Two changes in `lib/server/db.ts`:

- **fsync before rename, and fsync the directory after it.** `rename` is atomic; atomic is not durable.
  A power cut could leave the rename committed with the data still in the page cache.
- **Compact JSON.** `JSON.stringify(db, null, 2)` → `JSON.stringify(db)`. Indentation cost a third of
  the bytes and a third of the time on *every* flush.

Measured on the live store:

| | Before | After |
| --- | --- | --- |
| File size | 38.7 MB | **25.2 MB** |
| `stringify` | 176 ms | 115 ms |
| write | 133 ms | 80 ms (with fsync) |

`npm run store:peek` prints the file readably when a human needs to; `npm run store:backup` copies it
with a checksum and prunes old copies.

### (d) Public booking had a limiter only on its failure path

`POST /api/public/workspaces/{slug}/booking` rate-limited *errors* and nothing else, so a stranger could
create unlimited appointments — each one a row, a client record and a confirmation text with real carrier
cost — by never failing. It now has a budget per IP and workspace (**120 / 10 min**), checked before
anything is written. Class joins, manage links, offers and the homepage demo were already limited; they
are unchanged.

### (e) There was no health endpoint

The container healthcheck probed `/`, which returns 200 whether or not the store is readable.
**`GET /api/health`** now reports build id, uptime and store readability, and answers **503** when the
store cannot be read, so an orchestrator takes the instance out of rotation. Dockerfile and Compose
healthchecks point at it.

### (f) The encryption key file could be world-readable

`data/.voxera-key` is the key that decrypts every stored carrier and model credential. It is written
0600, but a file restored from a volume, copied with `cp -a`, or written by an older build can be 0644.
The read path now repairs the mode.

### (g) `.gitignore`, `.dockerignore`, `Dockerfile`, Compose, `.env.example`

Added in the previous turn and re-verified: the image builds the app and runs it as `node`, the store is a
volume, `data/` never enters git or the build context, and `.env.example` documents every switch including
what happens when it is blank.

### (h) The store moved from one JSON document to SQLite — and the move had a bug

`lib/server/db.ts` kept its public surface and gained an engine: `VOXERA_STORE=sqlite` writes one row per
document — `(collection, id, pos, body)` — in WAL mode, through `better-sqlite3` 12.11.1. The public
functions (`list`, `get`, `insert`, `update`, `remove`, `count`) did not change, so no route, page or gate
needed rewriting; the migration was a scripted read of the old file and a write of 72,683 documents into
**60 collections**, with the JSON file preserved under `data/backups/` rather than deleted.

The measured difference on the same data: **insert + flush 2 ms against 325 ms**, and the cost no longer
grows with the size of the store. Backups became a 35.0 MB file (sha256 `b207b3a4…`) instead of a
serialise-the-world operation.

**The bug, because it matters.** The maintenance path `replaceAll()` sets the cache, clears the dirty-id
list, and flushes with `replace: true`. The SQLite flush read that as *delete every row, then write the
pending ids* — and the pending list had just been cleared. It deleted the store and wrote nothing. The
tidy script that drove it did exactly what it was supposed to do first: it wrote a full 28.6 MB dump of the
store it was about to change. The next read saw an empty table, the dump was restored in full
(79,656 documents), and the deliberate sweep then ran again — 14 probe workspaces and 116 abandoned calls
removed, 60 collections and the demo workspace intact.

The flush now writes **the whole cache** on a replace, and a replace is a returning transaction. It also
has a gate of its own: `store-replace-check` builds a six-document store in a temp directory, hands
`replaceAll` a modified copy, and asserts the documents that should survive are still on disk — 10 checks,
run offline, unable to touch `data/` because it re-executes itself inside a `mktemp -d`.

### (i) Backups: scheduled, off-box, checksummed, and restored once

- `scripts/backup-store.ts` — SQLite's own backup API, so it is consistent while the app runs; writes
  `voxera-store-<stamp>.sqlite` plus a `.sha256`, and prunes to `--keep`.
- `scripts/restore-store.ts` — refuses while `/api/health` answers (a running process would overwrite the
  restore), takes a safety copy, and verifies checksum before replacing.
- The drill: a 338-document fixture restored into a scratch directory, one more document written through
  the store, **339 read back**. A restore that has been performed, not a copy that has been made.
- Compose grows a `backup` sidecar under the `backup` profile, sharing the volume and writing to
  `${BACKUP_DIR:-./backups}` hourly with `BACKUP_KEEP=14`. On a bare host the cron line is in the README.
- `Dockerfile`'s deps stage now installs `python3 make g++` so `better-sqlite3` can fall back to a source
  build on a platform with no prebuilt binary.

### (j) One scheduler, proven by running two of it

`lib/server/instance-lock.ts` puts a heartbeat row in the store; the scheduler claims it at boot, renews it,
and stands down if a live owner exists. Proven on this box, not in prose: a second replica started on
:3100 against the same database logged *"scheduler: DISABLED — another live instance owns the scheduler
(pid 2747 on e2b.local)"* and emitted `{"event":"scheduler.not_owner"}`. Both processes served reads. The
limit is stated rather than hidden: this protects a single machine and a shared volume, not a cluster.

### (k) New signups no longer receive fabricated calls

`seedOrg()` still gives a new workspace its tools, assistants, services, rotas and templates. Its scripted
history — three assistants, two numbers, **168 generated calls** — is now gated on `VOXERA_SEED_DEMO`, and
the flag's default follows the environment: **on in development, off in production**. There were two seed
paths, not one; the second (`upgradeBookingTools`, which added six campaign calls after bootstrap) was
found by probing a real signup and gated the same way. Re-probed with production semantics and no flag:
`bootstrap 201`, assistants 3, services 4, **calls 0, bookings 0, clients 0, invoices 0**.
`.env.example` documents the flag as `0`, and the Compose stack passes `NODE_ENV=production`, so the safe
path is the default path.

### (l) The audit table has a ceiling

Rows older than `VOXERA_AUDIT_RETENTION_DAYS` (90) are folded into `auditRollups` as
`{orgId, action, month, count}` before the detail rows are deleted, on the scheduler's maintenance tick.
The log keeps a reportable shape instead of growing until it is the write-cost driver it was at 60,316
rows.

### (m) Logs and metrics

`server.ts` emits one JSON line per request when `VOXERA_LOG_REQUESTS=1` (off by default under load), and
`GET /api/metrics` serves Prometheus text: `voxera_up`, uptime, scheduler runs and errors, HTTP counts by
class, request duration p50/p99, and store documents/collections. Enough for one box to be watched without
a vendor.

---

## 4. What still blocks production — in the order it bites

### Closed in this pass

| # | Was | Now |
| --- | --- | --- |
| 1 | File-backed store, whole-document rewrite per flush | **SQLite + WAL**, one row per document; 2 ms vs 325 ms; single-node, not replicated |
| 2 | No automatic, off-box backup | **`store:backup` + Compose `backup` sidecar + cron line**, checksummed, with a **restore drill** (338 → 339) |
| 3 | Single instance only, silently | **Instance lock**: the second replica disables its scheduler and says so in the log |
| 4 | Every signup seeded with fake activity | **`VOXERA_SEED_DEMO`**, on in dev, **off in production** — proven on a fresh signup |
| 10 | Audit table grows without an archive tier | **Monthly rollups** into `auditRollups` past `VOXERA_AUDIT_RETENTION_DAYS` |
| 9 | No logs or metrics | **JSON request logs** and **`/api/metrics`** (counts, latency, scheduler, store) |

### P0 — before real patients' records or real money

Nothing left in this tier *in the code*. What remains is a deployment decision:

| # | Item | Why it is the deployment's, not the repository's |
| --- | --- | --- |
| A | **TLS termination** | The app speaks HTTP and trusts `x-forwarded-proto`; certificates belong to the proxy. Also set `VOXERA_PUBLIC_URL` or every link in a text points at the wrong host. |
| B | **A real payment account** | Sandbox is the honest default with no Stripe key. Set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`; the webhook verifies signatures and is idempotent (checked in code), but no real charge was ever made here. |
| C | **A delivery provider** | SMS and email go through the carrier and the email API. With neither configured the scheduler logs failures and messages stay queued — correct behaviour, and it means "reminders work" is proved by the deployment, not by this repository. |
| D | **Do not deploy this repository's `data/`** | It holds the demo workspace with a published password (`jordan@northwind.dev` / `demo-password-2026`). `data/` is gitignored and Compose mounts a fresh volume, so the default is safe; a bind mount of the checkout is not. |

### P1 — before opening it to the public as a product

| # | Issue | Detail |
| --- | --- | --- |
| 1 | **Multi-node is a redesign** | The store is one SQLite file and the scheduler is one lock. Two *machines* need Postgres and a shared job queue; two *containers on one machine* are already safe for the scheduler but would still contend on the file. Pin replicas to 1 until then. |
| 2 | **Backups are only as good as their destination** | The sidecar writes to a host directory. Point `BACKUP_DIR` at a mounted object store or a second disk, and keep the `.sha256` with the copy. |

### P2 — hardening, not launch blockers

- **Dev-dependency advisories** (7, all Tailwind 3's glob/watch chain). Build-time only; the fix is
  Tailwind 4, a breaking change. Runtime tree is clean.
- **Session lifetime** is 30 days with no rotation on password change beyond the documented
  "sign out everywhere" — acceptable, worth revisiting with real users.
- **Password reset and invite links need a working email provider** (same as C).
- **`/api/health` and `/api/metrics` are unauthenticated.** Aggregate only — build id, counts, sizes, no
  ids — but they do reveal that the box is a Voxera instance. Put them behind the proxy's allowlist if that
  matters.
- **`docker build` itself has never run here** (no daemon in this sandbox). The runtime command, the
  healthcheck and the Compose schema were exercised individually; the first real `docker compose up --build`
  will be the deployment's.

---

## 5. Go-live checklist

```bash
# 1. secrets — set all of these, keep them out of the volume
VOXERA_SECRET_KEY=$(openssl rand -hex 32)
VOXERA_MANAGE_SECRET=$(openssl rand -hex 32)
VOXERA_MEDIA_SECRET=$(openssl rand -hex 32)
VOXERA_PUBLIC_URL=https://app.example.com
VOXERA_SEED_DEMO=0                 # the default in production; keep it explicit

# 2. bring it up (one instance), behind TLS
docker compose up --build -d
curl -fsS localhost:3000/api/health     # status, build, engine, store

# 3. backups, on a timer, off the box
docker compose --profile backup up -d   # hourly, keep 14, BACKUP_DIR on the host
# or, without Compose:
# 0 * * * * cd /srv/voxera && npm run store:backup -- /mnt/backups --keep 72

# 4. prove a restore before you need one
docker compose stop app
npm run store:restore -- /backups/voxera-store-<stamp>.sqlite
docker compose start app
```

Then: connect a carrier, connect Stripe (or leave it explicitly in sandbox), set the email provider, and
**start from an empty volume** — not from this repository's `data/`.

---

## 6. What this pass could and could not verify

**Verified by running it:** the build and type check; **33 live gates, 0 failed**; **four browser walks
/ 125 checks**; **the offline suite, 2 gates / 18 checks**, including the new replace guard; a production
boot; `/api/health` and `/api/metrics`; a **store migration of 72,683 documents** and the per-write cost
before and after; a **backup with a matching sha256** and a **restore that read back one more document than
it restored**; a **second replica standing down its scheduler** against the same database; a **fresh
production signup with an empty diary**; and `npm audit` before and after.

**Not verified here:** `docker build` / `docker compose up` themselves — there is no Docker daemon in this
sandbox (the runtime command, the healthcheck one-liner and the Compose schema were exercised individually
instead); a real Stripe charge, a real Twilio call and a real email delivery (all three have stubs and
gates, not live accounts); anything about multi-**node** behaviour, because the design does not support it;
and the durability of the host disk behind the volume, which is the one thing no application code can
prove.

**And one failure, kept on the record:** the migration's `replaceAll()` emptied the store during this pass.
The pre-change dump was restored in full within minutes, and the path now has both a fix and a gate (h).

---

## 7. One-line answer

**A single-node deployment of this repository can hold a small practice's real diary and real money
tomorrow**, provided the operator terminates TLS, supplies a payment account and a delivery provider, and
points the backup sidecar somewhere off the box. Making it a multi-tenant service across machines is the
next architectural job, and it is the only one left that is about the code.

---

## 8. Addendum — the hardening pass (same day, after the verdict)

Three things the verdict left as "worth doing next", done and verified:

1. **Paged collection reads.** The dashboard's generic collection API loaded
   the whole collection, filtered, then sliced. `limit`/`offset` now become a
   real SQL window and `total` is the collection's true size — a page costs
   the page, not the practice. Ordering moved to an explicit `seq` age column
   (migrated once, transactionally, 88,213 rows): `pos` is rewritten only for
   dirty rows at flush, so it could not order anything — 1,656 audit rows once
   shared `pos` 0. The flush now upserts (`ON CONFLICT DO UPDATE`), so editing
   a document no longer moves it to the top of the feed. Four gates that read
   the audit trail caught the first attempt at this (ordering by `pos`); they
   are why the fix is rowid-based rather than index-based.
2. **Backups report themselves.** Every backup writes `status.json` beside its
   copies and into the app's shared volume; `/api/metrics` exposes
   `voxera_backup_last_success_timestamp_seconds`, `..._age_seconds`,
   `..._bytes`, `..._copies`, `..._ok`. A sidecar that quietly stops is now a
   charted line, not a discovery.
3. **Alert rules ship with the repo.** `deploy/prometheus.yml` (scrape config)
   and `deploy/alerts.yml`: app down, health failing, backup older than 2
   hours, no backup ever reported, scheduler errors, 5xx over 5%, p99 over
   1.5 s. Each rule says why its threshold is worth paging.

Verified after the changes: `tsc` clean, **33 gates / 1,391 checks · 0
failed**, offline **2 gates / 18 checks**, store integrity check `ok`, file
reclaimed to 46 MB after the migration's copy pass.
