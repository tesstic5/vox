import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, update, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Knowledge attached to an assistant.
 *
 * Retrieval in this deployment works on text snippets: the assistant's
 * `knowledge` array is what `retrieve()` searches, and what the transcript cites
 * when an answer came from it. So this endpoint attaches two things:
 *
 *   - `snippets`: literal text the assistant may quote — policy lines, opening
 *     hours, escalation rules. This is the part retrieval actually uses.
 *   - `fileIds`: any uploaded files the answers should be credited to. They are
 *     recorded on the assistant (so a call can cite them) rather than parsed —
 *     file text extraction is not part of this deployment.
 *
 * Attaching is separate from uploading, as the docs describe, and `replace`
 * makes the request the complete set instead of an addition.
 */
type AssistantDoc = Doc & {
  orgId: string;
  name?: string;
  knowledge?: string[];
  knowledgeFiles?: string[];
};

async function load(req: NextRequest, id: string) {
  const write = !['GET', 'HEAD'].includes(req.method.toUpperCase());
  const ctx = await requireAuth(req, { scopes: [write ? 'assistants:write' : 'assistants:read'] });
  if (ctx instanceof NextResponse) return ctx;
  if (write) {
    const denied = requireConfigRole(ctx);
    if (denied) return denied;
  }
  const assistant = get<AssistantDoc>('assistants', id);
  if (!assistant || assistant.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No assistant with id ${id}.`, { requestId: ctx.requestId });
  }
  return { ctx, assistant };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  const { ctx, assistant } = res;
  return ok(
    {
      assistantId: assistant.id,
      snippets: listBody(assistant.knowledge ?? []),
      fileIds: assistant.knowledgeFiles ?? [],
      note: 'Retrieval searches `snippets`; `fileIds` are citations recorded against the assistant.',
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  const { ctx, assistant } = res;

  const body = await readJson<{ snippets?: string[]; fileIds?: string[]; replace?: boolean }>(req);
  if (body instanceof NextResponse) return body;

  const snippets = (body.snippets ?? []).map((s) => String(s).trim()).filter(Boolean);
  const fileIds = (body.fileIds ?? []).map(String);
  if (!snippets.length && !fileIds.length) {
    return fail('VALIDATION_ERROR', 'Send `snippets` (text the assistant may quote) and/or `fileIds` to attach.', {
      param: 'snippets',
      requestId: ctx.requestId,
    });
  }
  for (const fileId of fileIds) {
    const file = get<Doc>('files', fileId);
    if (!file || file.orgId !== ctx.orgId) {
      return fail('VALIDATION_ERROR', `Unknown file: ${fileId}.`, { param: 'fileIds', requestId: ctx.requestId });
    }
  }

  const nextSnippets = body.replace ? snippets : [...(assistant.knowledge ?? []), ...snippets];
  const nextFiles = body.replace ? fileIds : Array.from(new Set([...(assistant.knowledgeFiles ?? []), ...fileIds]));
  const updated = update<AssistantDoc>('assistants', id, {
    knowledge: nextSnippets,
    knowledgeFiles: nextFiles,
  } as Partial<AssistantDoc>);

  audit({
    orgId: ctx.orgId,
    actor: 'dashboard',
    action: 'assistant.knowledge_attached',
    target: id,
    detail: `${snippets.length} snippet(s), ${fileIds.length} file(s)${body.replace ? ' · replaced' : ''}`,
  });

  return ok(
    {
      assistantId: id,
      knowledge: {
        snippets: nextSnippets.length,
        characters: nextSnippets.join(' ').length,
        fileIds: nextFiles,
      },
    },
    { requestId: ctx.requestId }
  );
}
