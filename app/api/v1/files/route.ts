import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { list, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type LegacyFile = Doc & {
  orgId: string;
  name?: string;
  bytes?: number;
  purpose?: string;
  sha256?: string | null;
  createdAt?: string;
};

function metadataOnly(file: LegacyFile) {
  return {
    id: file.id,
    name: file.name ?? 'Unnamed file record',
    bytes: Number(file.bytes ?? 0),
    purpose: file.purpose ?? 'unknown',
    sha256: file.sha256 ?? null,
    createdAt: file.createdAt,
    capability: 'metadata_only' as const,
    status: 'unavailable' as const,
    note: 'No uploaded bytes or retrieval index are present for this legacy metadata record.',
  };
}

/** Lists legacy metadata without claiming that file bytes or an index exist. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const url = new URL(req.url);
  const purpose = url.searchParams.get('purpose');
  let items = list<LegacyFile>('files', (file) => file.orgId === ctx.orgId);
  if (purpose) items = items.filter((file) => file.purpose === purpose);
  const data = items.map(metadataOnly);
  return ok({ object: 'list', data, total: data.length, has_more: false }, { requestId: ctx.requestId });
}

/**
 * The former endpoint registered metadata and then pretended polling had indexed
 * bytes that were never uploaded. Refuse new writes until a real blob/index lane
 * exists; assistant knowledge can still use its explicit saved text snippets.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  return fail(
    'VALIDATION_ERROR',
    'File upload and retrieval indexing are not available in this deployment; no metadata record was created.',
    { requestId: ctx.requestId }
  );
}
