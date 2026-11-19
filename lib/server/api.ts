/**
 * Shared plumbing for every route handler: JSON responses, the error envelope,
 * authentication (session cookie or bearer API key), request ids, and rate
 * limiting.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { find, insert, newId, nowIso, type Doc } from './db';
import { rateLimit, rateHeaders, type RateLimitInfo } from './ratelimit';
import { currentUser, keyByPlaintext, type ApiKeyDoc, type OrgDoc, type UserDoc } from './auth';
import { isPlatformOperator } from './operator';
import {
  permissionDecision,
  permissionForHttpRequest,
  shadowPermissionDecision,
  type Permission,
  type PermissionResource,
} from './permissions';

export type ApiContext = {
  orgId: string;
  userId: string;
  user?: UserDoc;
  org?: OrgDoc;
  auth: 'session' | 'key';
  key?: ApiKeyDoc;
  requestId: string;
};

export const API_VERSION = '2026-09-21';

export function requestId() {
  return `req_${newId('').slice(1, 15)}`;
}

export function ok<T>(data: T, ctx?: { requestId?: string; status?: number; headers?: Record<string, string> }) {
  return NextResponse.json(data as object, {
    status: ctx?.status ?? 200,
    headers: {
      'x-request-id': ctx?.requestId ?? requestId(),
      'x-voxera-version': API_VERSION,
      ...(ctx?.headers ?? {}),
    },
  });
}

/**
 * The canonical list envelope: `{ object: 'list', data, total, has_more }`.
 *
 * Resources that paginate pass their own `total`/`has_more`; the rest get
 * `has_more: false` from here. A client should be able to read `total` and
 * `has_more` on any list response without knowing which endpoint it called —
 * `hasMore` vs `has_more` on bookings was exactly that trap.
 */
export function listBody<T>(data: T[], extra: Record<string, unknown> = {}) {
  return { object: 'list', data, total: data.length, has_more: false, ...extra };
}

/**
 * Query operators for list endpoints.
 *
 * The API reference and the interactive playground both show the review-queue
 * query — "calls that failed or went to voicemail, longer than five minutes,
 * worst first" — as `endedReason=in:error,customer-busy&durationSecondsGt=300&sort=score:asc`.
 * The route ignored those parameters, so a caller received an unfiltered page
 * that *looked* filtered. This is the parser that makes the documented query
 * real, and it refuses a field it does not know about rather than quietly
 * returning the wrong rows.
 *
 * Supported: `field=value`, `field=in:a,b`, `fieldNe=value`,
 * `fieldGt/fieldGte/fieldLt/fieldLte=value`, `sort=field:asc|desc`.
 * Dotted paths reach into nested objects; aliases keep the common ones short
 * (`score` → `analysis.score`).
 *
 * Everything else is refused. A caller who asks for a field this resource does
 * not have gets a 400 naming the field and listing the ones that exist — never a
 * silently unfiltered page. `passthrough` is the escape hatch for the few
 * parameters a route handles itself (`limit`, `cursor`, `since`).
 */
export type ListQueryPolicy = {
  /** Fields a caller may filter on, in `field` or `parent.child` form. */
  fields: string[];
  /** Aliases: `score` → `analysis.score`. */
  aliases?: Record<string, string>;
  /** Fields `sort=` may name, with the default when `sort` is absent. */
  sortable?: string[];
  defaultSort?: { field: string; dir: 'asc' | 'desc' };
  /** Parameters the route owns and this parser should leave alone. */
  passthrough?: string[];
};

const DEFAULT_PASSTHROUGH = ['limit', 'cursor', 't', 'format'];

const OP = /^(.*?)(Gt|Gte|Lt|Lte|Ne)$/;

function valueAt(row: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), row);
}

function comparable(value: unknown): number | string {
  if (typeof value === 'number') return value;
  const asNumber = Number(value);
  if (String(value).trim() !== '' && !Number.isNaN(asNumber)) return asNumber;
  const asDate = Date.parse(String(value));
  return Number.isNaN(asDate) ? String(value ?? '') : asDate;
}

export type ListQueryResult<T> = { rows: T[]; applied: string[]; error?: { field: string; known: string[] } };

/**
 * Applies `params` to `rows`. Unknown *filter-shaped* parameters are reported as
 * an error so the route can answer 400; anything that does not look like a
 * filter (`limit`, `t`, a cache-buster) is left to the route.
 */
export function applyListQuery<T extends Record<string, unknown>>(rows: T[], params: URLSearchParams, policy: ListQueryPolicy): ListQueryResult<T> {
  const known = new Set(policy.fields);
  const passthrough = new Set(policy.passthrough ?? DEFAULT_PASSTHROUGH);
  const resolve = (field: string) => (policy.aliases?.[field] ?? field);
  const applied: string[] = [];
  let out = rows;

  for (const [rawKey, rawValue] of params.entries()) {
    const value = rawValue.trim();
    if (rawKey === 'sort' || passthrough.has(rawKey)) continue;
    const match = OP.exec(rawKey);
    const base = match ? match[1] : rawKey;
    if (!known.has(base)) {
      return { rows, applied, error: { field: rawKey, known: [...known].sort() } };
    }
    const field = resolve(base);
    if (match) {
      const op = match[2];
      out = out.filter((row) => {
        const mine = comparable(valueAt(row, field));
        const theirs = comparable(value);
        if (op === 'Gt') return mine > theirs;
        if (op === 'Gte') return mine >= theirs;
        if (op === 'Lt') return mine < theirs;
        if (op === 'Lte') return mine <= theirs;
        return String(valueAt(row, field) ?? '') !== value;
      });
    } else if (value.startsWith('in:')) {
      const wanted = value.slice(3).split(',').map((v) => v.trim()).filter(Boolean);
      out = out.filter((row) => wanted.includes(String(valueAt(row, field) ?? '')));
    } else {
      out = out.filter((row) => String(valueAt(row, field) ?? '') === value);
    }
    applied.push(`${rawKey}=${value}`);
  }

  const sortRaw = params.get('sort');
  let sort = policy.defaultSort;
  if (sortRaw) {
    const [field, dir] = sortRaw.split(':');
    const target = resolve(field);
    if (policy.sortable && !policy.sortable.includes(field) && !policy.sortable.includes(target)) {
      return { rows: out, applied, error: { field: `sort=${sortRaw}`, known: [...(policy.sortable ?? [])].sort() } };
    }
    sort = { field: target, dir: dir === 'asc' ? 'asc' : 'desc' };
    applied.push(`sort=${sortRaw}`);
  }
  if (sort) {
    const { field, dir } = sort;
    out = [...out].sort((a, b) => {
      const left = comparable(valueAt(a, field));
      const right = comparable(valueAt(b, field));
      if (left === right) return 0;
      return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1);
    });
  }

  return { rows: out, applied };
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'EMAIL_NOT_VERIFIED'
  | 'ORG_SUSPENDED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'EMAIL_UNAVAILABLE'
  | 'SCHEDULE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  // Its own code so a client can offer the verify screen instead of a dead end,
  // and its own status because the request was understood and refused on purpose.
  EMAIL_NOT_VERIFIED: 403,
  // The workspace exists and the caller is known; the operator has switched it off.
  ORG_SUSPENDED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  // The request was well-formed but bigger than this surface accepts.
  PAYLOAD_TOO_LARGE: 413,
  // 503: the deployment cannot send mail, which is not the caller's fault.
  EMAIL_UNAVAILABLE: 503,
  SCHEDULE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function fail(
  code: ErrorCode,
  message: string,
  extra?: { param?: string; detail?: string; requestId?: string; headers?: Record<string, string> }
) {
  const body = {
    error: {
      type: code === 'VALIDATION_ERROR' ? 'invalid_request_error' : code === 'NOT_FOUND' ? 'not_found_error' : 'api_error',
      code,
      message,
      param: extra?.param,
      detail: extra?.detail,
      request_id: extra?.requestId ?? requestId(),
    },
  };
  return NextResponse.json(body, {
    status: STATUS[code],
    headers: { 'x-request-id': body.error.request_id, ...(extra?.headers ?? {}) },
  });
}

/* ------------------------------------------------------------- rate limits */

/**
 * The limiter itself lives in `ratelimit.ts` (database-backed, so it survives a
 * restart and is shared by every process). Re-exported here because every route
 * that needs it already imports from this module.
 */
export { rateLimit, rateHeaders };
export type { RateLimitInfo };

/* ------------------------------------------------------------ authenticate */

/**
 * The origin a *patient* should be sent to, which is not always the origin the
 * request arrived on.
 *
 * Two real cases make this messy and both have to work: the app binds `0.0.0.0`
 * (so `request.url` says `0.0.0.0:3000`, which is a fine address to bind and a
 * useless one to click), and in a proxied deployment the public host is in
 * `x-forwarded-host` while the internal one is in `host`. A payment link that
 * points at `0.0.0.0` is a link that never opens, so the order here is: an
 * explicit public URL for the deployment, the forwarding headers, the request's
 * own host — and `localhost` as the last honest fallback.
 */
export function publicOrigin(req: NextRequest): string {
  const configured = process.env.VOXERA_PUBLIC_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const trustProxy = process.env.VOXERA_TRUST_PROXY === '1';
  const forwardedHost = trustProxy ? req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
  const host = forwardedHost || req.headers.get('host') || '';
  const forwardedProto = trustProxy ? req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() : undefined;
  const proto = forwardedProto || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  if (host && !host.startsWith('0.0.0.0')) return `${proto}://${host}`;
  const url = new URL(req.url);
  if (url.host && !url.host.startsWith('0.0.0.0')) return `${url.protocol}//${url.host}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

/**
 * Carrier webhooks must use an operator-controlled address in production.
 * Request Host/X-Forwarded-Host is useful for local tests, but trusting it while
 * programming a live carrier would turn host-header spoofing into call routing.
 */
export function externalPublicOrigin(req: NextRequest): string | undefined {
  const configured = process.env.VOXERA_PUBLIC_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol)) return undefined;
      if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  }
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    return new URL(publicOrigin(req)).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence-in-depth for cookie-authenticated writes.
 *
 * The session cookie is `SameSite=Lax`, so a cross-site POST already arrives
 * without it and fails as "missing credentials". This check closes the class
 * properly rather than relying on one cookie attribute: when a browser sends
 * an `Origin` on a state-changing request and it does not match the host the
 * request was addressed to, the request is refused before any handler runs.
 *
 * Requests with no `Origin` (curl, server-to-server calls presenting a
 * cookie, the platform's own gates) are unaffected — there is no ambient
 * browser authority to confuse in those cases. API keys never reach this
 * branch; they carry no ambient credential at all.
 */
export function crossOriginRefusal(req: NextRequest): NextResponse | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return fail('FORBIDDEN', 'Cross-origin request refused.', { requestId: requestId() });
  }
  const expectedHost = new URL(publicOrigin(req)).host;
  if (originHost && expectedHost && originHost !== expectedHost) {
    return fail('FORBIDDEN', 'Cross-origin request refused.', { requestId: requestId() });
  }
  return null;
}

export function clientIp(req: NextRequest) {
  // `server.ts` derives this from the TCP peer and the explicitly configured
  // trusted-proxy hop count, then overwrites any client-supplied value. Route
  // handlers deliberately never consume X-Forwarded-For directly.
  return req.headers.get('x-voxera-client-ip') || '127.0.0.1';
}

/**
 * Resolves the caller: an `Authorization: Bearer vk_live_…` key first, then the
 * session cookie. Returns an error response when neither resolves, so handlers
 * read as `const ctx = await requireAuth(req); if (ctx instanceof NextResponse) return ctx;`.
 */
export async function requireAuth(req: NextRequest, opts?: { scopes?: string[]; limit?: number }): Promise<ApiContext | NextResponse> {
  const rid = requestId();
  const header = req.headers.get('authorization') ?? '';
  const presented = header || req.headers.get('x-api-key') || '';

  if (presented) {
    const key = keyByPlaintext(presented);
    if (!key) return fail('UNAUTHORIZED', 'The API key is invalid or has been revoked.', { requestId: rid });
    const required = opts?.scopes;
    // A narrow key must never inherit access merely because a route forgot to
    // declare its API scope. Only an explicit `*` key may use such a route;
    // scoped keys are fail-closed until the handler names the required scope.
    if (!required?.length && !key.scopes.includes('*')) {
      return fail('FORBIDDEN', 'This endpoint does not accept narrow API keys. Use a session or an explicitly supported scope.', { requestId: rid });
    }
    if (required?.length && !key.scopes.includes('*') && !required.every((s) => key.scopes.includes(s))) {
      return fail('FORBIDDEN', `This key is missing the required scope: ${required.join(', ')}`, { requestId: rid });
    }
    const limit = rateLimit(`key:${key.id}`, opts?.limit ?? 120);
    if (!limit.allowed) {
      return fail('RATE_LIMITED', 'Rate limit exceeded. Slow down or request a higher limit.', {
        requestId: rid,
        headers: { 'retry-after': String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))), ...rateHeaders(limit) },
      });
    }
    const keyOrg = find<OrgDoc>('orgs', (o) => o.id === key.orgId);
    if (keyOrg?.suspended) {
      return fail('ORG_SUSPENDED', 'This workspace has been suspended by the platform operator. Contact support.', { requestId: rid });
    }
    insert<Doc>('apiRequests', {
      id: newId('arq_'),
      orgId: key.orgId,
      keyId: key.id,
      method: req.method,
      path: new URL(req.url).pathname,
      at: nowIso(),
      ip: clientIp(req),
    } as Doc);
    return { orgId: key.orgId, userId: key.createdBy, auth: 'key', key, requestId: rid };
  }

  const session = await currentUser();
  if (!session) {
    return fail('UNAUTHORIZED', 'Missing credentials. Send an API key in the Authorization header, or sign in.', {
      requestId: rid,
    });
  }
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;
  // `viewer` means read-only everywhere, including routes that forgot to call
  // the narrower write helper. Enforce that invariant once at authentication.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) && session.user.role === 'viewer') {
    return fail('FORBIDDEN', 'This account is read-only. Ask an owner or admin for permission to make changes.', {
      requestId: rid,
    });
  }
  // Granular roles run in shadow for legacy users. Once a user has an explicit
  // roleId, the coarse route policy becomes a fail-closed backstop for legacy
  // handlers as well as the typed resource checks inside new clinical routes.
  const routePermission = permissionForHttpRequest(new URL(req.url).pathname, req.method);
  const routeDecision = shadowPermissionDecision(session.user, routePermission);
  if (session.user.roleId && !routeDecision.allowed) {
    return fail('FORBIDDEN', routeDecision.reason ?? `This role does not include ${routePermission}.`, { requestId: rid });
  }
  // A suspended workspace loses API access until the operator reactivates it.
  // The operator is exempt so they can still inspect and undo the suspension.
  if (session.org.suspended && !isPlatformOperator(session.user)) {
    return fail('ORG_SUSPENDED', 'This workspace has been suspended by the platform operator. Contact support.', {
      requestId: rid,
    });
  }
  return {
    orgId: session.org.id,
    userId: session.user.id,
    user: session.user,
    org: session.org,
    auth: 'session',
    requestId: rid,
  };
}

/**
 * Guards a write.
 *
 * `viewer` is the one role that may not change anything — it exists so a
 * practice can hand someone a login that can look and not touch. A receptionist
 * and a practitioner both *can* write here (the diary and client records); what
 * they may not do is change practice configuration, which is `requireConfigRole`.
 * API keys are scoped separately (`scopes`), so a key is accepted here and
 * checked by its own scopes.
 */
/**
 * Configuration writes — providers, services, sites, rotas, booking policy.
 *
 * A receptionist needs to run a day's diary and client records; changing what
 * the practice *is* (who works here, what it sells, when it opens) is an
 * owner/admin/developer job. API keys are scoped separately, so they pass here
 * and are checked by their own scopes.
 */
/**
 * The gate on everything that leaves the platform's own four walls.
 *
 * Three screens have promised since the first build that an unverified account
 * "can build agents but cannot publish or provision a number". That sentence is
 * only worth printing if something enforces it, so publishing an assistant,
 * buying or importing a number and minting an API key all pass through here.
 *
 * It reads the acting user, which for an API key is the person who created it —
 * a key is a delegation of *their* account, so it inherits their verification
 * state. A key whose creator has since been deleted has nobody to check and is
 * left to its scopes.
 */
export function requireVerifiedEmail(ctx: ApiContext): NextResponse | null {
  const user = ctx.user ?? (ctx.userId ? find<UserDoc>('users', (u) => u.id === ctx.userId) : undefined);
  if (!user || user.emailVerified) return null;
  return fail(
    'EMAIL_NOT_VERIFIED',
    `Verify ${user.email} before this: open Dashboard → Verify email, or the link we sent when the account was created. We check because a live number nobody can administer is worse than no number.`,
    { requestId: ctx.requestId, param: 'email' }
  );
}

export function requireApiKeyScopes(ctx: ApiContext, scopes: string[]): NextResponse | null {
  if (ctx.auth !== 'key' || !ctx.key || ctx.key.scopes.includes('*')) return null;
  const missing = scopes.filter((scope) => !ctx.key!.scopes.includes(scope));
  if (!missing.length) return null;
  return fail('FORBIDDEN', `This key is missing the required scope: ${missing.join(', ')}`, {
    requestId: ctx.requestId,
    detail: `Required API key scope: ${missing.join(', ')}`,
  });
}

export function requirePermission(
  ctx: ApiContext,
  permission: Permission,
  resource?: PermissionResource,
): NextResponse | null {
  // API keys are authorised by the explicit scope passed to `requireAuth`.
  if (ctx.auth !== 'session' || !ctx.user) return null;
  const decision = shadowPermissionDecision(ctx.user, permission, resource);
  if (decision.allowed) return null;
  return fail('FORBIDDEN', decision.reason ?? `This role does not include ${permission}.`, {
    requestId: ctx.requestId,
    detail: `Required permission: ${permission}`,
  });
}

export function requireConfigRole(ctx: ApiContext): NextResponse | null {
  if (ctx.auth === 'session' && ctx.user?.roleId) return requirePermission(ctx, 'workspace.configure');
  if (ctx.auth === 'session' && ctx.user?.role && !['owner', 'admin', 'developer'].includes(ctx.user.role)) {
    return fail('FORBIDDEN', 'This account can run the diary but not change practice configuration. Ask an owner or admin.', {
      requestId: ctx.requestId,
    });
  }
  return null;
}

export function requireWriteRole(ctx: ApiContext): NextResponse | null {
  if (ctx.auth === 'session' && ctx.user?.roleId) return requirePermission(ctx, 'workspace.write');
  if (ctx.auth === 'session' && ctx.user?.role === 'viewer') {
    return fail('FORBIDDEN', 'This account is read-only. Ask an owner or admin for permission to make changes.', {
      requestId: ctx.requestId,
    });
  }
  return null;
}

/** Diary and client-record writes match the role table shown in Team & roles. */
export function requireDeskRole(ctx: ApiContext): NextResponse | null {
  if (ctx.auth === 'session' && ctx.user?.roleId && ctx.user) {
    const clients = permissionDecision(ctx.user, 'clients.write').allowed;
    const schedule = permissionDecision(ctx.user, 'schedule.write').allowed;
    if (clients || schedule) return null;
    return fail('FORBIDDEN', 'This role cannot change client or diary records.', { requestId: ctx.requestId });
  }
  if (ctx.auth === 'session' && ctx.user?.role && !['owner', 'admin', 'developer', 'receptionist'].includes(ctx.user.role)) {
    return fail('FORBIDDEN', 'This account cannot change client or diary records. Ask an owner, admin or receptionist.', {
      requestId: ctx.requestId,
    });
  }
  return null;
}

export const DEFAULT_BODY_CAP = 256 * 1024;
/** CSV imports ride in a JSON field today; they get a larger, explicit cap. */
export const IMPORT_BODY_CAP = 5 * 1024 * 1024;

/**
 * Reads a JSON body under a byte cap.
 *
 * Without a cap, "send a 2 GB body" is a memory question the platform never
 * agreed to answer. The `content-length` header is checked first (cheap), and
 * the actual bytes second (a lying header does not help). Over the cap is a
 * 413 with words, not a hung connection.
 */
export async function readJson<T>(req: NextRequest, maxBytes: number = DEFAULT_BODY_CAP): Promise<T | NextResponse> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail('PAYLOAD_TOO_LARGE', `Request body is too large (limit ${Math.round(maxBytes / 1024)} KB).`, { param: 'body' });
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return fail('VALIDATION_ERROR', 'Request body must be valid JSON.', { param: 'body' });
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return fail('PAYLOAD_TOO_LARGE', `Request body is too large (limit ${Math.round(maxBytes / 1024)} KB).`, { param: 'body' });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail('VALIDATION_ERROR', 'Request body must be valid JSON.', { param: 'body' });
  }
}
