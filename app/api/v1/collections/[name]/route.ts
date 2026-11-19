import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, insert, insertMany, list, listPage, newId, nowIso, remove, update, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A private, session-only compatibility bridge for workspace notifications.
 * It is not a general database API: native resources use dedicated validated
 * endpoints, and API keys cannot enter this lane.
 *
 * Physical IDs are unique per collection, not per workspace. Every supplied ID
 * is preflighted so a crafted collision cannot replace another tenant's row.
 */
// One bounded compatibility lane remains: workspace notifications have no
// dedicated resource API yet. Native resources (tools, calls, assistants,
// numbers, audit, files, roles, and so on) must use their validated endpoints.
const MIRROR_WRITABLE = new Set(['notifications']);
const READABLE = new Set(MIRROR_WRITABLE);

function bridgeGuard(name: string, ctx: { auth: string; requestId: string }, write = false) {
  if (ctx.auth !== 'session') {
    return fail('FORBIDDEN', 'The dashboard collection bridge requires a signed-in person, not an API key.', { requestId: ctx.requestId });
  }
  if (!READABLE.has(name)) return fail('NOT_FOUND', `Unknown collection "${name}".`, { requestId: ctx.requestId });
  if (write && !MIRROR_WRITABLE.has(name)) {
    return fail('FORBIDDEN', 'This collection is server-owned. Use its dedicated API.', { requestId: ctx.requestId });
  }
  return null;
}

function storedId(name: string, orgId: string, id: string): string {
  return name === 'notificationPrefs' && id === 'settings' ? `settings:${orgId}` : id;
}

function publicDoc(name: string, orgId: string, doc: Doc): Doc {
  return name === 'notificationPrefs' && doc.id === storedId(name, orgId, 'settings')
    ? { ...doc, id: 'settings' }
    : doc;
}

function validDoc(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestedId(name: string, doc: Record<string, unknown>): string | null {
  if (doc.id === undefined || doc.id === null) return newId(`${name.slice(0, 3)}_`);
  if (typeof doc.id !== 'string' || !doc.id.trim() || doc.id.length > 200) return null;
  return doc.id;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const bad = bridgeGuard(name, ctx);
  if (bad) return bad;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 2000);
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
  const page = listPage<Doc>(name, ctx.orgId, { limit, offset });
  return ok({ collection: name, data: page.docs.map((d) => publicDoc(name, ctx.orgId, d)), total: page.total, limit, offset }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const bad = bridgeGuard(name, ctx, true) ?? requireConfigRole(ctx);
  if (bad) return bad;

  const body = await readJson<{ doc?: unknown; docs?: unknown; mode?: string }>(req);
  if (body instanceof NextResponse) return body;
  const bulk = Array.isArray(body.docs);
  const raw = bulk ? body.docs as unknown[] : [body.doc];
  if (!bulk && !validDoc(body.doc)) {
    return fail('VALIDATION_ERROR', 'Send `doc` for a single write, or `docs` for a bulk write.', { param: 'doc', requestId: ctx.requestId });
  }
  if (!raw.every(validDoc)) return fail('VALIDATION_ERROR', 'Every document must be an object.', { param: 'docs', requestId: ctx.requestId });
  if (body.mode !== undefined && body.mode !== 'replace' && body.mode !== 'append') {
    return fail('VALIDATION_ERROR', '`mode` must be replace or append.', { param: 'mode', requestId: ctx.requestId });
  }
  const replace = bulk && body.mode !== 'append';
  if (name === 'notificationPrefs' && (raw.length > 1 || raw.some((d) => (d as Record<string, unknown>).id !== 'settings'))) {
    return fail('VALIDATION_ERROR', 'Notification preferences are one settings document per workspace.', { param: 'docs', requestId: ctx.requestId });
  }

  const docs: Doc[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    const doc = value as Record<string, unknown>;
    const logicalId = requestedId(name, doc);
    if (!logicalId) return fail('VALIDATION_ERROR', 'Document IDs must be non-empty strings of at most 200 characters.', { param: 'id', requestId: ctx.requestId });
    const id = storedId(name, ctx.orgId, logicalId);
    if (ids.has(id)) return fail('CONFLICT', 'The same document ID was sent more than once.', { param: 'id', requestId: ctx.requestId });
    ids.add(id);
    docs.push({ ...doc, id, orgId: ctx.orgId } as Doc);
  }

  // Preflight the entire batch before removing anything. IDs are physically
  // global within a collection, so even a foreign row hidden by org scoping is
  // still a collision. Refuse ambiguous legacy duplicates too, rather than
  // risking a deletion of a different workspace's data.
  const all = list<Doc>(name);
  const existing = all.filter((d) => d.orgId === ctx.orgId);
  if (replace && existing.some((d) => all.some((other) => other.id === d.id && other.orgId !== ctx.orgId))) {
    return fail('CONFLICT', 'This collection has an ambiguous document ID. Contact an administrator before replacing it.', { requestId: ctx.requestId });
  }
  for (const doc of docs) {
    const collisions = all.filter((d) => d.id === doc.id);
    if (collisions.some((d) => d.orgId !== ctx.orgId) || (!replace && collisions.length)) {
      return fail('CONFLICT', 'A document with that ID already exists. Choose another ID.', { param: 'id', requestId: ctx.requestId });
    }
  }

  if (replace) existing.forEach((d) => remove(name, d.id));
  if (bulk) {
    const inserted = insertMany<Doc>(name, docs);
    audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? 'dashboard', action: `${name}.bulk_write`, detail: `${inserted.length} documents` });
    return ok({ collection: name, written: inserted.length, mode: body.mode ?? 'replace' }, { requestId: ctx.requestId });
  }
  const doc = insert<Doc>(name, docs[0]);
  audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? 'dashboard', action: `${name}.created`, target: doc.id });
  return ok({ collection: name, doc: publicDoc(name, ctx.orgId, doc) }, { requestId: ctx.requestId, status: 201 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const bad = bridgeGuard(name, ctx, true) ?? requireConfigRole(ctx);
  if (bad) return bad;
  const body = await readJson<{ id?: string; patch?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.id !== 'string' || !body.id || !validDoc(body.patch)) {
    return fail('VALIDATION_ERROR', 'Send `id` and a `patch` object.', { requestId: ctx.requestId });
  }
  if (['id', 'orgId', 'createdAt', 'updatedAt'].some((key) => key in (body.patch as Record<string, unknown>))) {
    return fail('VALIDATION_ERROR', 'A document ID, workspace and server timestamps cannot be changed.', { param: 'patch', requestId: ctx.requestId });
  }
  if (name === 'notificationPrefs' && body.id !== 'settings') {
    return fail('NOT_FOUND', 'No notification preferences with that ID.', { requestId: ctx.requestId });
  }

  const physicalId = storedId(name, ctx.orgId, body.id);
  // A pre-fix settings document can still be read and edited by its own tenant;
  // the next bulk save migrates it to the workspace-specific ID.
  const doc = get<Doc>(name, physicalId) ?? (name === 'notificationPrefs' ? get<Doc>(name, body.id) : undefined);
  if (!doc || doc.orgId !== ctx.orgId) return fail('NOT_FOUND', `No ${name} document with id ${body.id}.`, { requestId: ctx.requestId });
  if (list<Doc>(name).some((other) => other.id === doc.id && other.orgId !== ctx.orgId)) {
    return fail('CONFLICT', 'This document ID is ambiguous. Contact an administrator.', { requestId: ctx.requestId });
  }
  const next = update<Doc>(name, doc.id, { ...(body.patch as Record<string, unknown>), orgId: ctx.orgId, updatedAt: nowIso() });
  audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? 'dashboard', action: `${name}.updated`, target: doc.id });
  return ok({ collection: name, doc: next ? publicDoc(name, ctx.orgId, next) : next }, { requestId: ctx.requestId });
}
