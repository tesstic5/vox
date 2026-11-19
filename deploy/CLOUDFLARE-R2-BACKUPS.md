# Encrypted off-box PostgreSQL backups with Cloudflare R2

This is the optional off-box layer for the Dokploy stack. The base `backup`
service first creates a PostgreSQL 17 custom archive and `.sha256` sidecar on the
VPS. `deploy/docker-compose.r2.yml` then encrypts file contents **and filenames**
with `rclone crypt`, copies completed files to a private R2 bucket, and verifies
that every eligible local source file exists remotely.

A successful upload is not a restore drill. Production acceptance still requires
downloading one off-box copy into a scratch location, verifying its checksum,
restoring it to a fresh PostgreSQL database, comparing content digests, and
recording elapsed time.

## Important R2 boundary

Cloudflare documents the S3 endpoint as
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and documents rclone with the
`Cloudflare` S3 provider:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/examples/rclone/

Cloudflare's current S3 compatibility table marks S3 Object Locking during bucket
creation as unsupported. Treat this design as encrypted off-box redundancy, **not
immutable/WORM evidence**. The sidecar intentionally never deletes remote files,
but a sufficiently privileged Cloudflare credential could. Use a dedicated
bucket, a bucket-scoped key, Cloudflare account protections, a lifecycle policy,
and an independently controlled credential. Consider a second immutable provider
if the risk assessment requires deletion resistance.

R2 lifecycle rules are documented at:
https://developers.cloudflare.com/r2/buckets/object-lifecycles/

## 1. Create the bucket and key

In Cloudflare:

1. Create a dedicated private bucket, for example `voxera-postgres-backups`.
2. Keep public development URLs and custom public domains disabled.
3. Create a dedicated R2 API token scoped only to this bucket with object read and
   write access. Do not reuse a broad Cloudflare account token.
4. Record the Account ID, Access Key ID and Secret Access Key in Dokploy's secret
   store, never in the repository or a committed `.env`.
5. Configure the agreed lifecycle in the bucket. The overlay uses copy-only
   semantics, so local retention never silently deletes off-box history.

The initial pilot suggestion is to retain at least the stated recovery window in
Standard storage, then transition/delete only according to the approved privacy
and recovery policy. A reviewer must choose the actual period; this repository
must not invent a healthcare retention rule.

## 2. Create independent crypt material

Run this on an operator-controlled machine with rclone 1.75.2. Generate two
independent random values, obscure each with rclone, and place the **obscured**
outputs in the password manager and Dokploy as `R2_CRYPT_PASSWORD` and
`R2_CRYPT_PASSWORD2`.

Example with Docker:

```bash
raw_one="$(openssl rand -base64 48)"
raw_two="$(openssl rand -base64 48)"
docker run --rm rclone/rclone:1.75.2 obscure "$raw_one"
docker run --rm rclone/rclone:1.75.2 obscure "$raw_two"
unset raw_one raw_two
```

Do not lose these values. R2 credentials can be rotated; lost crypt material
makes the encrypted backup unrecoverable. Keep a recovery copy outside both the
VPS and the Cloudflare account.

## 3. Dokploy variables

Add the following through Dokploy's encrypted variable/secret UI:

```text
R2_ACCOUNT_ID=<Cloudflare account id>
R2_BUCKET=voxera-postgres-backups
R2_PREFIX=voxera-postgres
R2_ACCESS_KEY_ID=<bucket-scoped key id>
R2_SECRET_ACCESS_KEY=<bucket-scoped secret>
R2_CRYPT_PASSWORD=<first rclone-obscured value>
R2_CRYPT_PASSWORD2=<second rclone-obscured value>
R2_SYNC_INTERVAL_SECONDS=900
R2_MIN_AGE=2m
```

Deploy the base file plus the overlay:

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.r2.yml \
  config --quiet

docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.r2.yml \
  up -d
```

If Dokploy accepts only one Compose document, merge the `r2-backup` service into
its Compose editor without changing the base service names or volume mappings.
Never expose the R2 variables to browser-side build arguments.

## 4. Upload acceptance

Wait for the base backup and R2 loops, then check:

```bash
docker compose logs --tail=200 backup r2-backup
docker compose exec r2-backup cat /app/data/backups/r2-status.json

docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.r2.yml \
  run --rm --entrypoint rclone r2-backup lsf r2crypt:
```

Expected evidence:

- base backup status has a fresh `lastSuccessAt`;
- every archive has a `.sha256` sidecar;
- `r2-status.json` says `ok: true` with a fresh `lastSuccessAt`;
- `rclone lsf r2crypt:` shows decrypted logical filenames through the crypt
  remote (the R2 dashboard itself should show encrypted names);
- disabling network/R2 credentials makes the offsite status fail without making
  the base backup falsely successful.

## 5. Off-box restore drill

Use a scratch host directory and a fresh scratch database. Never restore over the
live target.

```bash
mkdir -p restore-r2

docker compose \
  -f docker-compose.yml \
  -f deploy/docker-compose.r2.yml \
  run --rm \
  -v "$(pwd)/restore-r2:/restore" \
  --entrypoint rclone r2-backup \
  copy r2crypt: /restore

(cd restore-r2 && sha256sum --check voxera-postgres.TIMESTAMP.dump.sha256)
```

Then follow the scratch-target restore procedure in `deploy/DOKPLOY-RUNBOOK.md`
and `deploy/POSTGRES.md`. Record:

- archive filename, byte size and SHA-256;
- backup creation, offsite upload, download and restore UTC times;
- scratch database name and source/target document counts/digests;
- measured RPO and RTO;
- operator and reviewer;
- deletion of the scratch database and local restore directory.

Only that completed drill closes the off-box recovery gate.
