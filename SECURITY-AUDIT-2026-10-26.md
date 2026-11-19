# Voxera security audit — checklist vs actual code

**Date:** 2026-10-26 · **Scope:** the 22-section Node/Express security checklist the
team supplied, checked line-by-line against the Voxera codebase (Next.js 16 /
React 19, single-node SQLite store). Every "done" below names the file that
proves it; every gap names what to build. Nothing here is assumed.

**Update 2026-11-02 — correction to the original verdict:** the earlier suite
used a configured operator allowlist and missed an unsafe empty-allowlist
fallback. A clean production-mode test showed that a new workspace owner could
access the platform-wide console and suspend another workspace when that list
was absent. Platform admin, leads and growth now fail closed unless the user's
email is explicitly allowlisted. The same review found the Google/GitHub route
could issue a shared demo session and did not complete a configured callback;
those routes and buttons are disabled until a real OAuth flow is implemented
and tested. The same pass found that the legacy generic collection endpoint
could expose raw user documents (including password hashes), let a viewer write,
and let a colliding document ID cross workspace boundaries; its raw by-ID route
is retired and its remaining bridge is now session-only, allowlisted,
configuration-role protected, audit read-only and collision-safe. Assistant
creation/status editing and API-key management were tightened at the same time.
Proof: `scripts/tenant-security-check.py` against two fresh-store configurations
(46/46 empty allowlist; 45/45 explicit allowlist). Do not use the original verdict
below as a deployment sign-off.

**Original verdict (2026-10-26):** most of the checklist was assessed as
implemented, several sections did not apply, and four P1 gaps were identified.
The four P1 items were subsequently implemented; the later findings above show
why those tests did not establish complete production or multi-tenant safety.

---

## Already done (verified in code)

| Checklist area | State in Voxera |
|---|---|
| Password hashing | scrypt with per-user salt, `timingSafeEqual` comparison (`lib/server/auth.ts:83–99`) |
| Sessions | Server-side sessions, token stored **hashed** (sha256), `httpOnly`, `SameSite=Lax`, `Secure` when HTTPS (`auth.ts:138ff, 195ff`). No JWT — deliberately; see "Don't do" |
| Brute force | Login rate-limited 10/min per IP (`app/api/auth/login/route.ts:20`); global per-identity limiter with persisted buckets (`lib/server/ratelimit.ts`) |
| Password reset | 15-minute, single-use, one live token per person; **reset revokes every session** (`lib/server/auth-flows.ts:76ff`, `auth-tokens.ts`) |
| Magic links / invites | Same token machinery: expiring, single-use, revocable (`auth-tokens.ts:7ff`) |
| OAuth | **Unavailable**: the former demo fallback and incomplete callback were disabled on 2026-11-02 (`app/api/auth/oauth/[provider]/route.ts`). Use email/password until a verified OAuth implementation is delivered. |
| RBAC / least privilege | Roles (owner/admin/developer/viewer + receptionist/practitioner) with a 12-permission matrix, enforced server-side; operator tier above that (`VOXERA_OPERATOR_EMAILS`) |
| Tenant scoping | Workspace routes use the caller's `orgId`; platform-admin routes intentionally span workspaces and now require an explicit operator allowlist. The 2026-11-02 finding demonstrates that existing gates were not exhaustive; broader multi-tenant review remains necessary. |
| Injection | All SQL is parameterised (`lib/server/db.ts` — `?` placeholders throughout); documents are JSON bodies, never string-built queries. No `eval`, no `child_process` with user input anywhere in `lib/server`/`app/api` |
| XSS | React escaping + a same-origin CSP (`next.config.mjs:17ff`): `default-src 'self'`, `object-src 'none'`, external `script-src` origins blocked |
| SSRF | Dedicated guard (`lib/server/net.ts`): private/loopback destinations blocked, DNS-resolution and redirect re-checked, explicit opt-out env for stub carriers |
| HTTP headers | CSP, HSTS (180 days), `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera/geo/payment off), COOP (`next.config.mjs:41–49`). `frame-ancestors` in CSP covers clickjacking on modern browsers |
| Cookies | As above; session cookie is the only auth cookie |
| Secrets at rest | Provider/API secrets sealed with **AES-256-GCM** (`lib/server/secrets.ts:80ff`); config from env; `.env` gitignored (`.gitignore:17ff`) |
| Webhooks/telephony | Outbound deliveries HMAC-signed (`webhooks.ts:96`); inbound Twilio requests signature-verified before handling (`app/api/telephony/twilio/voice/route.ts:31ff`) |
| Errors/logging | Generic error envelope with request IDs (`lib/server/api.ts`); no stack traces to clients; structured logs that **redact** secret/token/password/cookie fields and strip query strings (`lib/server/log.ts:15,43`) |
| Audit trail | `audit()` on sensitive actions (`lib/server/audit.ts`); Observability/Logs + Audit pages in the dashboard |
| Dependencies | `npm audit` = **0 vulnerabilities** (2026-10-26); lockfile committed; versions pinned by `npm ci` |
| Infra basics | Docker runs as non-root (`Dockerfile:76 USER node`), `NODE_ENV=production`; health endpoint (`app/api/health`); encrypted-secret handling and backups already exist (backup encryption: see gaps) |
| Privacy | Retention policies and client erasure paths exist (`lib/server/maintenance.ts`, `clients.ts`); data-minimal public forms with honeypot + per-IP limits |

## Gaps worth fixing (priority order)

### P1 — before real customer/pilot data

> **Status 2026-10-26 (later): all four P1 items are implemented and gated.**
> TOTP enrolment + sign-in challenge + recovery codes (`lib/server/totp.ts`,
> verified against the RFC 6238 vectors by `scripts/totp-vectors.ts`),
> per-account failure throttling (`recordFailure`/`failureCount` in
> `lib/server/ratelimit.ts`, real accounts only), the Origin guard in
> `requireAuth` (`crossOriginRefusal` in `lib/server/api.ts`), and body caps
> in `readJson` (256 KB default, 5 MB CSV-import allowance). Proof:
> `scripts/security_check.py` (19 checks) and `scripts/mfa-probe.mjs`
> (browser enrolment + code-step sign-in), inside a green suite of
> 40 gates / 1,505 checks. The original findings are kept below as written.

1. **2FA is a flag, not a factor.** `twoFactorEnabled` is stored and shown in
   Team/Security (`lib/server/team.ts:84`, `auth.ts:23`) but nothing verifies a
   second factor at login — no TOTP/WebAuthn check exists anywhere. Either
   implement TOTP enrolment + login challenge (and recovery codes), or stop
   presenting it as protection until it exists. *This is the one item where the
   UI currently promises more than the server enforces.*
2. **No per-account login throttling.** Login is limited per IP only; a
   distributed password-spray against one account is not slowed. Add a
   per-account counter with progressive backoff (and keep the IP limit).
3. **No Origin check on cookie-authenticated mutations.** `SameSite=Lax`
   already stops cross-site POST cookies, so this is defence-in-depth, not an
   open hole — but a cheap server-side `Origin`/`Referer` match in
   `requireAuth` for cookie sessions closes the class properly. API-key routes
   are unaffected (no ambient credential).
4. **No request-body size caps.** `readJson` (`lib/server/api.ts:384`) parses
   whatever arrives. Add per-route caps (e.g. 256 KB JSON, a larger explicit
   cap for CSV import) returning 413.

### P2 — during pilot hardening

5. **Session lifetime policy.** Sessions are 30-day absolute with no idle
   timeout. Add an idle window (e.g. 7 days, sliding on activity) and keep the
   absolute cap; the Security page already lists/revokes sessions, and password
   reset/change already revokes all.
6. **CSP tightening for real deployments.** `script-src` allows
   `'unsafe-inline'` (Next.js RSC payload) and `frame-ancestors` allows the
   sandbox preview origin (`https://*.e2b.app`). Env-gate the preview origin out
   of production builds; nonce-based CSP is a larger, optional step.
7. **Backups are not encrypted.** Backup files inherit whatever the disk does.
   Encrypt at write time (env-supplied key) before any off-box `BACKUP_DIR`
   is used; document disk-encryption as the baseline in `PILOT-DEPLOYMENT.md`.

### P3 — process, not code

8. **Automated dependency/SAST scanning.** `npm audit` is clean today but
   nothing re-checks it. Turn on Dependabot (or equivalent) on the repo and run
   `npm audit` in CI alongside `scripts/check.py`.
9. **Breached-password screening** (optional): password policy is length-only
   (8+; flows use `MIN_PASSWORD`) — that matches current NIST guidance; an
   HIBP-style k-anonymity check at signup is a nice-to-have, not a requirement.
10. **Independent penetration test / DAST pass** before clinical data — a
    scheduling item for the pilot, not a code change.
11. **TLS/HSTS-preload/CDN-DDoS** are reverse-proxy duties, already recorded as
    external in the production-readiness notes; keep them there.

## Deliberately not applicable — do not "fix" these

- **JWT + refresh-token rotation (§1):** server-side hashed sessions are
  strictly stronger here (instant revocation, no token-theft window). JWT
  would be a downgrade, not an upgrade.
- **express-session/Redis, helmet, csurf, express-rate-limit (§§1,3,5,7):**
  Express-specific packages; the equivalents above are implemented natively in
  the Next.js layer.
- **CORS whitelist (§6):** the API sends no CORS headers at all — same-origin
  only, which is stricter than a whitelist. Only revisit if a third-party
  *browser* app must call the API (API keys are server-to-server today).
- **GraphQL hardening (§5):** there is no GraphQL surface.
- **Certificate pinning, Kubernetes, WAF/SIEM, bug bounty (§§4,14,20,21):**
  legitimate at multi-tenant scale; premature for the single-node pilot this
  deployment is packaged as.

---

*Method: every claim above was checked against the working tree on
2026-10-26 (`grep`/file reads), not against documentation. The functional
suite (38 gates, 1,477 checks) and browser walks (4/4) were green on the same
build (`pYATl-rwZjUjeqtQlfDrW`).*
