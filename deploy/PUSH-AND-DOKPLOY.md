# Push and deploy handoff

This is the external action boundary for an operator who will push and operate
Dokploy. It does not turn missing CI, VPS, provider, restore or independent-review
evidence into a pass.

## 1. Push the source

The repository rules already exclude local databases, backups, dependencies,
build caches and `.env` files. Verify before the first commit:

```bash
git init
git status --short --ignored
# Confirm data/, node_modules/, .next/, .cache/ and every filled .env are ignored.
git add --all
git status --short
# The staged list must not contain data/voxera-db.sqlite, backup archives or secrets.
git commit -m "Production candidate: Dokploy PostgreSQL pilot"
git branch -M main
git remote add origin YOUR_PRIVATE_REPOSITORY_URL
git push -u origin main
```

Do not force-add ignored data. The production image intentionally starts without
the demo database or demo credentials.

## 2. Require CI before deploy

The pushed `.github/workflows/ci.yml` has four independent jobs:

1. `SQLite baseline and static gates`
2. `Full PostgreSQL and provider acceptance`
3. `PostgreSQL browser and WCAG routes`
4. `Shipped container and Compose smoke`

Every data-dependent job restores the checksum-verified fictional fixture; it is
excluded from the production image and must never be copied into staging. The
baseline also gates high/critical production dependency audit findings and strict
Dokploy/Resend configuration. The PostgreSQL job runs the optimized build, full
live suite, Resend payload/signature route checks and dedicated Stripe contract
gate. Browser tools are installed in an isolated CI directory, not shipped as
product dependencies. The container job builds the Dockerfile, validates Compose,
boots the built image against PostgreSQL 17, checks health, creates an in-container
backup, verifies its checksum sidecar and inspects it with the shipped restore
tool.

Protect `main` so all four jobs must pass. Record the immutable commit SHA and
retain the CI artifacts. A green local artifact is not a substitute for these
remote results.

## 3. Create a synthetic staging application in Dokploy

1. Create a **Compose** application from the private repository, branch `main`,
   using `docker-compose.yml`.
2. Give the app a staging hostname and route Traefik to service `app`, port 3000.
3. Keep PostgreSQL private; do not publish service `db`.
4. Add the variables from `deploy/dokploy.env.example` through Dokploy's encrypted
   environment/secret UI. Generate every required secret independently.
5. Set `VOXERA_BUILD_ID` to the exact green commit SHA.
6. Leave Twilio, Resend, Stripe and AI/STT/TTS values blank for the first boot.
   Keep `VOXERA_REQUIRE_AI=0` and `VOXERA_REQUIRE_MEDIA=0`.
7. Configure a Traefik rule so `/api/metrics` is not public. Restrict health detail
   where practical while preserving the service healthcheck.
8. Deploy one app replica. Do not scale during the controlled pilot.

Expected app log: `config.production_valid`, one scheduler owner and the ready
line. Expected health: `status=ok`, `store.driver=postgres`, readable/writable
true, and a build id matching the release.

Create only a synthetic staging owner/workspace. Do not copy the repository's demo
SQLite database into production.

## 4. Run the public boundary gate

From an operator machine with the source checkout:

```bash
VOXERA_STAGING_URL=https://staging.example.com \
VOXERA_ACCEPTANCE_EMAIL=synthetic-owner@example.com \
VOXERA_ACCEPTANCE_PASSWORD='from-a-secret-store' \
npm run check:staging
```

Run it last because its trusted-proxy check deliberately consumes the source IP's
one-minute login budget. Retain `screenshots/public-staging-check.json`.

Then repeat the browser/load gates against the public staging origin and record
VPS CPU, memory, disk, PostgreSQL and Traefik observations. The loopback result is
not the public-host result.

## 5. Enable off-box backup

If Cloudflare R2 is selected, create the private bucket and restricted key, then
follow `deploy/CLOUDFLARE-R2-BACKUPS.md` and deploy
`deploy/docker-compose.r2.yml` with the base Compose file. Do not close recovery
acceptance until an encrypted off-box copy has been downloaded, checksum-verified,
restored into a fresh scratch database and digest-compared.

## 6. Enable providers one at a time

- **Resend:** follow `deploy/RESEND.md`, including domain authentication and the
  signed `/api/webhooks/resend` endpoint.
- **Twilio:** connect a controlled account/number, verify all callback signatures,
  then call and message only consented test destinations.
- **Stripe:** start in test mode. For the eventual approved low-value live check,
  Stripe-hosted Checkout takes payment. Voxera does not initiate provider refunds;
  an authorised operator refunds in Stripe and records/reconciles the reference.
- **AI/STT/TTS:** keep disabled until provider accounts, data terms, model/voice
  identifiers, timeout/fallback and clinical boundaries are approved.

Provider keys belong only in Dokploy secrets. Never put them in GitHub variables
unless a specific CI job genuinely needs that provider; current CI uses stubs.

## 7. Production promotion boundary

Promote the immutable green image/SHA into a separate production project with a
fresh database and production hostname. Before real patient data, all of the
following still require retained external evidence:

- public staging/Dokploy/TLS/proxy/load pass;
- off-box restore drill;
- controlled live-provider acceptance;
- the signed independent reviews in `deploy/INDEPENDENT-REVIEW-PACK.md`;
- completed pilot charter and named stop/on-call owners in `PILOT-DEPLOYMENT.md`.

Until then the deployment is suitable only for synthetic/staff rehearsal.
