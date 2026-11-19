import PgNative from 'pg-native';

export type PgValue = string | number | boolean | bigint | Date | null | undefined;
export type PgRow = Record<string, unknown>;
export type SyncPgClient = {
  query<T extends PgRow = PgRow>(sql: string, values?: PgValue[]): T[];
  close(): void;
};

type NativeClient = {
  connectSync(connectionString?: string): void;
  querySync<T extends PgRow = PgRow>(text: string, values?: Array<string | null>): T[];
  end(): void;
};
type SharedConnection = { url: string; client: NativeClient };
const GLOBAL_KEY = '__voxeraPostgresSync';

function connectionUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('VOXERA_STORE=postgres requires DATABASE_URL');
  return url;
}

function parameter(value: PgValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nativeClient(): NativeClient {
  // pg-native is listed in serverExternalPackages, so Next leaves the native
  // binding as a normal Node runtime dependency instead of bundling libpq.
  return new PgNative() as NativeClient;
}

function configure(client: NativeClient, applicationName: string) {
  const statementMs = Math.max(1_000, Math.min(120_000, Number(process.env.VOXERA_POSTGRES_STATEMENT_TIMEOUT_MS ?? 15_000) || 15_000));
  const lockMs = Math.max(500, Math.min(30_000, Number(process.env.VOXERA_POSTGRES_LOCK_TIMEOUT_MS ?? 5_000) || 5_000));
  client.querySync("SELECT set_config('application_name', $1, false)", [applicationName]);
  client.querySync("SELECT set_config('client_min_messages', 'warning', false)");
  client.querySync("SELECT set_config('statement_timeout', $1, false)", [String(statementMs)]);
  client.querySync("SELECT set_config('lock_timeout', $1, false)", [String(lockMs)]);
  client.querySync("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", ['30000']);
}

function open(applicationName: string): NativeClient {
  const client = nativeClient();
  client.connectSync(connectionUrl());
  configure(client, applicationName);
  return client;
}

/**
 * One synchronous libpq connection per Node process.
 *
 * The existing domain layer is intentionally synchronous. PostgreSQL support
 * preserves that API for the first production migration rather than changing
 * roughly 800 store calls at once. The same-VPS latency/performance gate is the
 * acceptance boundary; this client is not permission to add slow remote queries.
 */
function shared(): SharedConnection {
  const scope = globalThis as unknown as Record<string, SharedConnection | undefined>;
  const url = connectionUrl();
  if (scope[GLOBAL_KEY]?.url === url) return scope[GLOBAL_KEY]!;
  try {
    scope[GLOBAL_KEY]?.client.end();
  } catch {
    /* stale connection */
  }
  const connection = { url, client: open('voxera-app') };
  scope[GLOBAL_KEY] = connection;
  return connection;
}

export function pgQuery<T extends PgRow = PgRow>(sql: string, values: PgValue[] = []): T[] {
  return shared().client.querySync<T>(sql, values.map(parameter));
}

export function pgTransaction<T>(work: () => T): T {
  pgQuery('BEGIN');
  try {
    const result = work();
    pgQuery('COMMIT');
    return result;
  } catch (error) {
    try {
      pgQuery('ROLLBACK');
    } catch {
      /* preserve the original failure */
    }
    throw error;
  }
}

/** A dedicated connection for connection-scoped advisory locks. */
export function dedicatedPostgresClient(applicationName: string): SyncPgClient {
  const client = open(applicationName);
  return {
    query<T extends PgRow = PgRow>(sql: string, values: PgValue[] = []) {
      return client.querySync<T>(sql, values.map(parameter));
    },
    close() {
      client.end();
    },
  };
}

export function closeSharedPostgres() {
  const scope = globalThis as unknown as Record<string, SharedConnection | undefined>;
  const connection = scope[GLOBAL_KEY];
  if (!connection) return;
  try {
    connection.client.end();
  } finally {
    delete scope[GLOBAL_KEY];
  }
}

/** Redacted identity suitable for health/log output. */
export function postgresIdentity(): string {
  try {
    const url = new URL(connectionUrl());
    return `${url.hostname}:${url.port || '5432'}/${url.pathname.replace(/^\//, '')}`;
  } catch {
    return 'unconfigured';
  }
}
