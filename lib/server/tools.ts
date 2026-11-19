/**
 * Tools: the functions an assistant may call.
 *
 * A tool is a name, a description (the model reads it to decide when to use the
 * tool), and — for tools that reach a customer's own system — an HTTP method and
 * endpoint. The runtime has two ways to run one:
 *
 *   1. the built-in executors in `agent.ts`, which cover the standard booking and
 *      support vocabulary and answer deterministically, and
 *   2. the customer's own endpoint, called for real when the tool has one.
 *
 * (2) is attempted first and (1) is the fallback, which is what makes the
 * `endpoint` field mean something instead of being stored and ignored. The same
 * `callEndpoint` powers `POST /v1/tools/{id}/test`, so "test" and a live call
 * cannot disagree about what your endpoint returns.
 */

import { guardUrl, safeFetch } from './net';
import { get, insert, newId, nowIso, list, update, type Doc } from './db';
import { audit } from './audit';
import { openSecret, sealSecret, type Sealed } from './secrets';

export type ToolDoc = Doc & {
  orgId: string;
  name: string;
  description?: string;
  /** HTTP method used when the tool calls `endpoint`. */
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  endpoint?: string;
  /** Legacy plaintext headers. Sealed at startup and never returned by the API. */
  headers?: Record<string, string>;
  headersSealed?: Sealed;
  headerNames?: string[];
  createdAt: string;
};

export type ToolCallOutcome = {
  ok: boolean;
  status: number | null;
  ms: number;
  body: string;
  error?: string;
  url: string;
  method: string;
};

const TIMEOUT_MS = 6000;

function cleanHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([name, header]) => /^[A-Za-z0-9-]{1,80}$/.test(name) && typeof header === 'string')
    .slice(0, 30)
    .map(([name, header]) => [name, String(header).slice(0, 4_000)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function toolHeaders(tool: ToolDoc): Record<string, string> | undefined {
  if (tool.headersSealed) {
    const opened = openSecret(tool.headersSealed);
    if (!opened) return undefined;
    try {
      return cleanHeaders(JSON.parse(opened));
    } catch {
      return undefined;
    }
  }
  return cleanHeaders(tool.headers);
}

/** API shape: secret header values and ciphertext never leave the server. */
export function toolForApi(tool: ToolDoc) {
  const { headers: _legacyHeaders, headersSealed: _headersSealed, ...safe } = tool;
  return { ...safe, headerNames: tool.headerNames ?? Object.keys(cleanHeaders(tool.headers) ?? {}) };
}

/** One-way startup repair for pre-encryption tool headers. */
export function normalizeLegacyToolHeaders() {
  let migrated = 0;
  for (const tool of list<ToolDoc>('tools')) {
    const headers = cleanHeaders(tool.headers);
    if (!headers || tool.headersSealed) continue;
    update<ToolDoc>('tools', tool.id, {
      headers: undefined,
      headersSealed: sealSecret(JSON.stringify(headers)),
      headerNames: Object.keys(headers),
    });
    migrated += 1;
  }
  return { migrated };
}

/** Fills `{placeholders}` in a tool URL from the arguments the model supplied. */
export function fillEndpoint(endpoint: string, args: Record<string, unknown>) {
  const withValues = endpoint.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => {
    const value = args[key];
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
  // Any argument the URL did not consume goes in the query string, so a GET tool
  // with `{ id }`-style args still receives them.
  const used = new Set([...endpoint.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]));
  const leftovers = Object.entries(args ?? {}).filter(([k, v]) => !used.has(k) && v !== undefined && v !== null);
  if (!leftovers.length) return { url: withValues, sent: [] as string[] };
  const url = new URL(withValues);
  for (const [k, v] of leftovers) url.searchParams.set(k, String(v));
  return { url: url.toString(), sent: leftovers.map(([k]) => k) };
}

/**
 * Calls a tool endpoint for real.
 *
 * The URL passes the outbound policy first, so a tool pointed at a private
 * address is refused with a reason rather than being dialled.
 */
export async function callEndpoint(input: {
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  args?: Record<string, unknown>;
  /** Body for non-GET calls. The model's arguments by default. */
  body?: unknown;
}): Promise<ToolCallOutcome> {
  const method = (input.method ?? 'POST').toUpperCase();
  const { url } = fillEndpoint(input.endpoint, input.args ?? {});
  const started = Date.now();
  const verdict = await guardUrl(url);
  if (verdict.policy === 'blocked') {
    return { ok: false, status: null, ms: 0, body: '', error: `blocked by URL policy: ${verdict.reason}`, url, method };
  }
  try {
    const response = await safeFetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(input.headers ?? {}),
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(input.body ?? input.args ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await response.response.text()).slice(0, 8000);
    return {
      ok: response.response.ok,
      status: response.response.status,
      ms: Date.now() - started,
      body: text,
      url: response.finalUrl,
      method,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      body: '',
      error: err instanceof Error ? err.message : 'request failed',
      url,
      method,
    };
  }
}

/* --------------------------------------------------------------- live tools */

/**
 * Looks for a tool the org owns and runs it against its endpoint.
 * Returns `undefined` when the tool has no endpoint or the call failed, which is
 * the signal for the caller to fall back to the built-in executor.
 */
export async function tryEndpointTool(input: {
  orgId: string;
  name: string;
  args: Record<string, unknown>;
  /** Booking/tool context, forwarded verbatim as the request body. */
  context?: Record<string, unknown>;
}): Promise<{ tool: ToolDoc; outcome: ToolCallOutcome } | undefined> {
  const tool = list<ToolDoc>('tools', (t) => t.orgId === input.orgId && t.name === input.name)[0];
  if (!tool?.endpoint) return undefined;
  const outcome = await callEndpoint({
    endpoint: tool.endpoint,
    method: tool.method,
    headers: toolHeaders(tool),
    args: input.args,
    body: { arguments: input.args, ...(input.context ?? {}) },
  });
  if (!outcome.ok) return undefined;
  return { tool, outcome };
}

/* ------------------------------------------------------------------ CRUD ops */

export function toolsFor(orgId: string) {
  return list<ToolDoc>('tools', (t) => t.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
}

export function toolById(orgId: string, id: string) {
  const tool = get<ToolDoc>('tools', id);
  return tool && tool.orgId === orgId ? tool : undefined;
}

export function createTool(orgId: string, input: Partial<ToolDoc>) {
  const headers = cleanHeaders(input.headers);
  const tool = insert<ToolDoc>('tools', {
    id: newId('tool_'),
    orgId,
    name: String(input.name),
    description: input.description ?? '',
    method: input.method ?? (input.endpoint ? 'POST' : undefined),
    endpoint: input.endpoint,
    headersSealed: headers ? sealSecret(JSON.stringify(headers)) : undefined,
    headerNames: headers ? Object.keys(headers) : [],
    createdAt: nowIso(),
  } as ToolDoc);
  audit({ orgId, actor: 'dashboard', action: 'tool.created', target: tool.id, detail: tool.name });
  return tool;
}

export function updateTool(orgId: string, id: string, patch: Partial<ToolDoc>) {
  const tool = toolById(orgId, id);
  if (!tool) return undefined;
  const next = { ...patch };
  if ('headers' in patch) {
    const headers = cleanHeaders(patch.headers);
    next.headers = undefined;
    next.headersSealed = headers ? sealSecret(JSON.stringify(headers)) : undefined;
    next.headerNames = headers ? Object.keys(headers) : [];
  }
  audit({ orgId, actor: 'dashboard', action: 'tool.updated', target: id, detail: Object.keys(patch).join(', ') });
  return update<ToolDoc>('tools', id, next);
}

export function removeTool(orgId: string, id: string) {
  const tool = toolById(orgId, id);
  if (!tool) return false;
  audit({ orgId, actor: 'dashboard', action: 'tool.deleted', target: id, detail: tool.name });
  return true;
}

/** Which assistants reference each tool — the docs promise `usedBy`. */
export function toolsUsedBy(orgId: string) {
  const assistants = list<Doc & { tools?: string[] }>('assistants', (a) => a.orgId === orgId);
  const map = new Map<string, string[]>();
  for (const assistant of assistants) {
    for (const name of assistant.tools ?? []) {
      map.set(name, [...(map.get(name) ?? []), String(assistant.id)]);
    }
  }
  return map;
}
