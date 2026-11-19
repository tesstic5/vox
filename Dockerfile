# syntax=docker/dockerfile:1
#
# Voxera in one image.
#
# Three stages, and one thing worth knowing before reading them: this app is
# served by a **custom Node server** (`server.ts`), not `next start`, because the
# media-stream path needs a WebSocket upgrade that `next start` cannot accept.
# The server is TypeScript and runs through `tsx`, which is why the runtime stage
# keeps the dev dependencies — `npm start` would fail without them.
#
#   docker build -t voxera .
#   docker run --rm -p 3000:3000 -v voxera-data:/app/data voxera
#
# Node 22 is the maintained LTS line used by the image. Next 16 requires Node
# 20.9 or newer.
#
# Debian slim, not Alpine: `next` ships a prebuilt SWC binary for glibc, and a
# musl image would have to fall back to a slower path. The build needs roughly
# 2 GB of RAM — that is the size of the app, not a knob in this file.
#
# PostgreSQL is the production store; SQLite remains a local/recovery fallback.
# Both database bindings are native. The dependency stage therefore carries the
# compilers and libpq headers, while the runtime carries libpq plus PostgreSQL 17
# client tools for version-safe backup and restore operations.

# ---- PostgreSQL client tools --------------------------------------------------
# Debian bookworm's default pg_dump is older than the PostgreSQL 17 service. A
# dump client must never be older than its server, so copy the matching official
# client binaries and libpq into the final image rather than silently using 15.
FROM postgres:17-bookworm AS pgtools

# ---- dependencies ------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Only needed if a native module has to build from source; harmless otherwise and
# confined to this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ libpq-dev \
 && rm -rf /var/lib/apt/lists/*

# Copy the manifests first: they change rarely, so the install layer survives a
# source edit. The install is a full one — see the note above about `tsx`.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build -------------------------------------------------------------------
FROM deps AS build
COPY . .

# The store is a file under `data/`. The build should not need it — no dashboard
# route is prerendered — but an empty directory here means a build-time read of
# the store, if one ever appears, sees an empty practice instead of a crash.
RUN mkdir -p data && npm run build

# ---- runtime ------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# pg-native is compiled in the dependency stage and links to libpq at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 liblz4-1 libzstd1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=pgtools /usr/lib/postgresql/17/bin/ /usr/local/lib/postgresql/17/bin/
COPY --from=pgtools /usr/lib/*/libpq.so.5* /usr/local/lib/
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    PATH=/usr/local/lib/postgresql/17/bin:$PATH \
    LD_LIBRARY_PATH=/usr/local/lib

# Everything the server needs at run time: the built app, the source it imports
# (`server.ts`, `lib/`), and the dependencies. `next()` loads `next.config.ts`
# for the CSP and security headers, so it travels too.
COPY --from=build /app ./

# Slim the runtime tree: the build stage installs everything (TypeScript, the
# type packages, Tailwind's toolchain), but the running server only needs the
# production dependencies — `tsx` among them, which is why it is a runtime
# dependency in `package.json` rather than a dev one. Pruning here, in the
# final stage, keeps the shipped image to what actually serves requests, and
# dropping the build cache and gate screenshots (regenerable, and excluded
# from the build context anyway) keeps them out of the image too.
RUN npm prune --omit=dev --no-audit --no-fund \
 && rm -rf .next/cache screenshots coverage test-results playwright-report

# The operational mount stays writable by the unprivileged server user. With
# PostgreSQL it holds backup status and any local operational artifacts (not the
# database itself); SQLite recovery mode also places its WAL sidecars here.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
VOLUME ["/app/data"]

# Docker sets HOSTNAME to the container id, which `server.ts` reads as its bind
# address, so the command sets it explicitly — the difference between "reachable
# on :3000" and "listening on a name Docker invented".
# `/api/health` answers 503 when the store cannot be read, so an orchestrator
# takes the container out of rotation instead of leaving it answering half a
# workspace. The root page would return 200 either way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node_modules/.bin/tsx server.ts"]
