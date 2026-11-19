# Dokploy/VPS deployment and recovery runbook

This runbook deploys one controlled Voxera environment with PostgreSQL 17. It
does not by itself prove live provider delivery, card settlement, security review
or suitability for real patient data.

## 1. Host and network

- Use a maintained Linux VPS with Docker/Dokploy, at least **4 GB RAM for local
  image builds** (or build in CI and pull the image), adequate swap, and enough
  disk for PostgreSQL plus retained backups. Alert before disk reaches 80%.
- Point one DNS name at the VPS. Expose only 80/443 and administrative SSH;
  PostgreSQL has no published port in `docker-compose.yml`.
- In Dokploy, create a Compose application from this repository and route the
  `app` service's port **3000** through Traefik with TLS.
- Keep `/api/metrics` private to the monitoring network. `/api/health` contains
  only aggregate state but should also be restricted where practical.

## 2. Secrets and variables

Copy the names from `deploy/dokploy.env.example` into Dokploy's encrypted
variables or a configured Vault/OpenBao/Infisical provider. Do not upload a
filled `.env` to source control.

Generate distinct values:

```bash
openssl rand -hex 32  # PostgreSQL password; URL-safe
openssl rand -hex 32  # VOXERA_SECRET_KEY
openssl rand -hex 32  # VOXERA_MANAGE_SECRET
openssl rand -hex 32  # VOXERA_DEMO_SECRET
openssl rand -hex 32  # VOXERA_DOCUMENT_MASTER_KEY (separate custody; when documents are enabled)
```

Required before first boot:

- `POSTGRES_PASSWORD` (or a complete external `DATABASE_URL`)
- `VOXERA_PUBLIC_URL=https://the-exact-hostname`
- `VOXERA_OPERATOR_EMAILS`
- the three Voxera secrets above

`VOXERA_SECRET_KEY` decrypts stored provider credentials. Losing it means those
credentials must be cleared and entered again. Rotating it is not a normal env
change: disconnect/re-enter encrypted provider credentials in a maintenance
window, then retain the old key until verification finishes. Rotating manage or
demo secrets invalidates outstanding signed links/tokens.

`VOXERA_DOCUMENT_MASTER_KEY` is separate from those secrets and wraps per-version
document keys. Losing it makes encrypted document bytes unrecoverable. Retain its
recovery material outside the VPS and outside the object/database backups, under
the controller's access procedure. Do not set `VOXERA_CLINICAL_DATA_APPROVED=1`
until `docs/phase-1-implementation-status.md` has been completed for the target
environment. Strict startup refuses that final switch without PostgreSQL, a valid
document key, complete S3-compatible storage and a non-test scanner; workspace
readiness also requires recent clean/infected scan evidence, governance/recovery
records and current independent reviews.

Never set production test seams: `VOXERA_MEDIA_SIMULATE`,
`VOXERA_ALLOW_PRIVATE_OUTBOUND`, `VOXERA_ALLOW_UNSIGNED_TELEPHONY`, or
`VOXERA_ENABLE_TEST_ENDPOINTS`.

## 3. Preflight and first deploy

Use a fresh production database. Do not copy this repository's demo SQLite store
or its demo credentials into production.

```bash
# Renders the stack; review destinations without sharing the secret-filled output.
docker compose config --quiet

docker compose build app
docker compose run --rm --no-deps app npm run check:production-config
docker compose up -d
docker compose ps
```

Expected:

- `db` becomes healthy before `app` starts.
- `app` logs `config.production_valid`, `scheduler.owner`, then the ready line.
- `backup` waits for app health, creates a custom-format PostgreSQL archive and
  `.sha256` sidecar, then sleeps.

Verify through the real hostname:

```bash
curl --fail --show-error https://pilot.example.com/api/health
```

The response must say `status: ok`, `driver: postgres`, and writable/readable
true. Confirm the login response sets a `Secure` session cookie under HTTPS.
Verify that a forged left-most `X-Forwarded-For` value does not change the
rate-limit identity; `VOXERA_TRUST_PROXY_HOPS=1` assumes Traefik is the only
trusted hop. Change the hop count only from a documented proxy topology.

Run the retained public-boundary gate with a **synthetic staging owner**. Supply
credentials only through the operator shell/CI secret store, never source control:

```bash
VOXERA_STAGING_URL=https://pilot.example.com \
VOXERA_ACCEPTANCE_EMAIL=synthetic-owner@example.com \
VOXERA_ACCEPTANCE_PASSWORD='from-secret-store' \
npm run check:staging
```

It checks valid TLS, HTTP→HTTPS, security headers, PostgreSQL readiness, private
metrics, login redirect, cross-origin refusal, Secure/HttpOnly/SameSite cookies
and trusted-proxy limiter identity. Run it last: the X-Forwarded-For probe
intentionally consumes the caller IP's one-minute login budget.

## 4. Existing SQLite data (staging first)

For an existing installation, stop app traffic and follow `deploy/POSTGRES.md`.
Do not run `--replace` against production until:

1. SQLite and current PostgreSQL backups exist off-host.
2. The count + SHA-256 migration verification passes in staging.
3. Staging application/provider gates pass.
4. A maintenance window and rollback owner are recorded.

## 5. Release procedure

Before every release:

1. Record the immutable image tag/Git SHA in `VOXERA_BUILD_ID`.
2. Confirm the latest backup status and off-box copy.
3. Run CI (types, production build, PostgreSQL suite, static gates and container
   smoke) against that SHA.
4. Deploy one app replica first. Do not scale during the physiotherapy pilot.
5. Watch health, 5xx count, request latency, scheduler failures, PostgreSQL
   connections/locks and provider error rates for at least 15 minutes.

The scheduler uses a PostgreSQL advisory lock: a standby may take ownership after
the old process exits. Duplicate scheduler owners are still an incident.

### Application rollback

If no incompatible data operation occurred, redeploy the previous immutable
image and verify health. The document schema bootstrap is idempotent, but do not
assume an arbitrary future release is downgrade-safe; every release note must say
whether database restore is required.

### Database rollback

Database rollback is a maintenance operation, not an automatic reaction:

1. Disable public traffic and stop `app` and `backup`.
2. Inspect the chosen archive with `store:restore -- --check`.
3. Restore with the explicit replacement phrase. The tool first creates a
   `before-restore` archive and then uses one PostgreSQL transaction.
4. Start the app, verify health, sign-in and the critical workflow, then reopen
   traffic. Preserve both archives.

## 6. Backup and restore drill

The backup service keeps 56 six-hour copies by default. `BACKUP_DIR` is still on
the VPS unless an external mount/agent copies it. For Cloudflare R2, the optional
`deploy/docker-compose.r2.yml` overlay performs client-side encrypted, copy-only
offsite transfer; configure and drill it with `deploy/CLOUDFLARE-R2-BACKUPS.md`.
Other restic/rclone or VPS-provider mechanisms remain valid if they provide the
same encryption, separate credentials, monitoring and scratch-restore evidence.
Alert on `voxera_backup_ok == 0`, backup age over the agreed interval, and a stale
or failed `r2-status.json` when that overlay is enabled.

Inspect an archive from the mounted backup directory:

```bash
docker compose run --rm --no-deps --entrypoint npm backup \
  run store:restore -- /backups/voxera-postgres.TIMESTAMP.dump --check
```

Monthly, restore an **off-box copy** into a scratch database:

```bash
docker compose exec db createdb -U "$POSTGRES_USER" voxera_restore_drill

docker compose run --rm --no-deps --entrypoint npm \
  -e VOXERA_STORE=postgres \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/voxera_restore_drill" \
  -e VOXERA_HEALTH_URL=http://app:3000/api/health \
  backup run store:restore -- /backups/voxera-postgres.TIMESTAMP.dump \
  --apply --confirm-postgres=REPLACE_POSTGRES_TARGET

# Inspect counts and a sample, then remove the drill database.
docker compose exec db dropdb -U "$POSTGRES_USER" voxera_restore_drill
```

Run this drill while the production app remains up: the target is the scratch
database. Record archive SHA-256, restore duration, counts and operator.

### Clinical document recovery is a separate gate

A PostgreSQL archive is **not** a document backup. Before clinical live mode can
be considered, configure a dedicated private S3-compatible/R2 bucket using the
`VOXERA_S3_*` variables and complete a controlled joint recovery exercise:

1. Keep `VOXERA_CLINICAL_DATA_APPROVED=0` and use synthetic records only.
2. Deploy the real scanner. Pass a clean file and a standard anti-malware test
   file through the ordinary quarantine workflow; retain the append-only clean
   and infected evidence from the same configured command.
3. Record the PostgreSQL archive SHA-256, object inventory/version or snapshot,
   bucket/prefix, document-key version and exact recovery cutover time. Never put
   the document master key in that evidence bundle.
4. Restore PostgreSQL into a scratch database and objects into an isolated test
   bucket/prefix. Start an isolated app with recovered key material and no live
   delivery providers.
5. Reconcile missing/orphan objects, then sample every document status class.
   For clean documents, verify controlled download bytes against the stored
   plaintext SHA-256; verify quarantined/infected/unavailable rows still cannot
   download.
6. Record counts, mismatches, duration, operators and corrective actions in the
   typed recovery-evidence record. Destroy plaintext scratch output and revoke
   temporary bucket credentials after review.

The optional `R2_*` variables in the backup overlay protect PostgreSQL archives;
they are deliberately different from the runtime `VOXERA_S3_*` document bucket.
Do not point both at one credential scope. An object-store decision, credentials,
key-recovery drill and independent review are still external work, not evidence
created by this repository.

## 7. Provider rollout and outage response

Enable one provider at a time and retain evidence from the corresponding pilot
checklist.

- **Twilio/SMS:** signed callback failures are 403. Pause outbound campaigns on
  elevated carrier errors; inbound routing can be moved in Twilio if needed.
- **Resend email:** API acceptance is not delivery. Watch signed delivery,
  bounce/complaint/suppression receipts; pause reminders on provider rejection,
  then replay only reviewed queue items.
- **Stripe:** never mark an invoice paid from a browser redirect. Only a verified
  webhook settles it. On webhook outage, leave links open and reconcile from
  Stripe before replaying events.
- **AI/STT/TTS:** fall back to bounded rules/gather mode or disable the assistant;
  do not silently substitute a different provider voice/model ID.

Provider base-URL overrides are for approved public HTTPS proxies only. Strict
production rejects private/local stub URLs.

## 8. Incident minimum

For any suspected breach, cross-tenant exposure, payment mismatch or clinical
safety issue:

1. Stop affected workflows and preserve logs/audit rows; do not bulk-delete.
2. Record build ID, UTC time, workspace, request/provider IDs and operator action.
3. Rotate exposed provider credentials; treat `VOXERA_SECRET_KEY` separately as
   described above.
4. Verify database and backup integrity before recovery.
5. Notify the designated security/privacy/legal owner. Real patient data remains
   prohibited until those independent reviews approve the deployment.
