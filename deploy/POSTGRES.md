# PostgreSQL production store

PostgreSQL is the required store for the Dokploy profile. SQLite remains a
single-process development/recovery engine; JSON is migration recovery only.

## Architecture and honest boundary

The domain layer is synchronous. The first PostgreSQL implementation preserves
that API with `pg-native`/libpq rather than pretending an ~800-call async rewrite
is a small deployment change. Documents live in `voxera_docs` as JSONB with a
stable sequence, collection/id uniqueness, JSONB query indexes and partial
uniqueness for active phone-number ownership. `voxera_meta` carries the global
cache version.

This has two consequences:

- Same-VPS/database-network latency must be measured before pilot traffic. A
  synchronous remote query blocks that Node process's event loop.
- Horizontal app replicas are data-safe, but are not automatically faster.
  PostgreSQL advisory locking elects one scheduler owner and database-backed
  rate buckets are atomic; each process still needs latency/load acceptance.

Do not describe this as an accepted high-latency or high-scale architecture.
The later optimization is either an async store conversion or a dedicated store
worker, measured against the full gate suite.

## Configuration

```dotenv
VOXERA_STORE=postgres
DATABASE_URL=postgresql://voxera:URL_SAFE_PASSWORD@db:5432/voxera
```

Strict Dokploy startup refuses a missing/malformed URL. Do not publish the
PostgreSQL port; the app and backup service use the Compose network.

## Preflight integration suite

Use a disposable database: the check creates, replaces and deletes records.

```bash
createdb voxera_store_check
VOXERA_STORE=postgres \
DATABASE_URL=postgresql://localhost/voxera_store_check \
npm run check:postgres
```

The suite covers schema bootstrap, CRUD, ordering, paging, JSONB equality,
transactional replacement, database uniqueness, cross-process cache
invalidation, scheduler lease failover and concurrent atomic rate limiting.

## SQLite migration

Keep the app stopped. Take both a SQLite backup and a PostgreSQL backup before a
replacement migration. The target must be empty unless the destructive phrase
is supplied.

```bash
# Inspect source and target counts; changes nothing.
VOXERA_STORE=sqlite DATABASE_URL="$DATABASE_URL" \
  npm run migrate:postgres -- --check

# Empty target only.
VOXERA_STORE=sqlite DATABASE_URL="$DATABASE_URL" \
  npm run migrate:postgres -- --apply

# Deliberate replacement of a non-empty staging target.
VOXERA_STORE=sqlite DATABASE_URL="$DATABASE_URL" \
  npm run migrate:postgres -- --apply --replace \
  --confirm-replace=DELETE_POSTGRES_TARGET
```

Success means every collection count and canonical SHA-256 document-content
digest agrees. Keep the source SQLite store until staging acceptance passes.

## Backup and restore

The runtime image includes PostgreSQL 17 `pg_dump`/`pg_restore`; the tool refuses
an older client than the server.

```bash
VOXERA_STORE=postgres DATABASE_URL="$DATABASE_URL" \
  npm run store:backup -- /backups --keep 56

npm run store:restore -- /backups/voxera-postgres.TIMESTAMP.dump --check

# App stopped; creates a before-restore dump, then restores in one transaction.
VOXERA_STORE=postgres DATABASE_URL="$DATABASE_URL" \
  npm run store:restore -- /backups/voxera-postgres.TIMESTAMP.dump --apply \
  --confirm-postgres=REPLACE_POSTGRES_TARGET
```

Each scheduled archive has a `.sha256` sidecar. A successful local dump is not
disaster recovery until an independent job copies it off the VPS and a restore
drill proves that copy.

## Release gate

Before switching production:

1. Migration count + digest verification passes.
2. `/api/health` reports `driver: postgres`, readable and writable.
3. PostgreSQL integration and application/provider suites pass on staging.
4. Event-loop latency is measured under representative pilot traffic.
5. A backup from off-box storage restores into a fresh database and content
   digests match.
6. Rollback owner, maintenance window and source-store retention are recorded.
