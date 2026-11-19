/**
 * Workspace AI credentials.
 *
 * A customer connects their own Anthropic or OpenAI key once, and every assistant
 * in that workspace runs on it. Keys are encrypted at rest (`lib/server/secrets`),
 * verified against the provider on connect, and never returned by a read — the
 * API hands back a masked hint and a `verified` flag.
 *
 * Resolution order for a turn:
 *
 *   1. the workspace's own key for the provider the assistant's model belongs to
 *   2. the deployment's env key for that provider
 *   3. nothing — and the deterministic rule engine answers instead
 *
 * Step 3 is why the platform works out of the box: a missing key degrades the
 * *quality* of the conversation, never the ability to have one.
 */

import { MODELS } from '../../content';
import { get, insert, list, nowIso, remove, update, type Doc } from '../db';
import { audit } from '../audit';
import { maskSecret, openSecret, sealSecret, type Sealed } from '../secrets';
import {
  AI_PROVIDERS,
  DEFAULT_MODEL,
  authHeaders,
  baseUrlFor,
  envKeyFor,
  joinUrl,
  modelInfo,
  modelsUrls,
  providerById,
  providerForModel,
  type AiProvider,
  type AuthStyle,
  type WireFormat,
} from './providers';

export type AiCredentialDoc = Doc &
  Sealed & {
    orgId: string;
    provider: string;
    label: string;
    keyHint: string;
    verified: boolean;
    verifiedAt?: string;
    /** Models the provider reported when the key was checked. */
    modelCount?: number;
    lastError?: string;
    lastUsedAt?: string;
    /* ---- bring-your-own endpoint (provider === 'custom') ---- */
    /** Where the endpoint lives. Stored as given, normalised on use. */
    baseUrl?: string;
    /** Which wire format the endpoint speaks. */
    wire?: WireFormat;
    /** How the key travels. `none` is legitimate for a server on your own network. */
    authStyle?: AuthStyle;
    /** Extra headers (a tenant id, an org header, a gateway token), sealed. */
    headersSealed?: Sealed;
    /** Model ids the endpoint reported last time it was asked. */
    models?: string[];
    /** Why a stored credential is not verified, when it is not. */
    note?: string;
  };

export type ResolvedModel = {
  providerId: string;
  providerLabel: string;
  wire: WireFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelLabel: string;
  source: 'workspace' | 'env';
  inputCost: number;
  outputCost: number;
  /** Extra headers to send (bring-your-own endpoints). */
  headers?: Record<string, string>;
  authStyle?: AuthStyle;
  /**
   * True when we cannot price this model — a self-hosted or contracted endpoint.
   * The turn is then recorded at zero provider cost instead of a made-up number.
   */
  unpriced?: boolean;
};

/* --------------------------------------------------------------------- store */

export function aiCredentialsFor(orgId: string) {
  return list<AiCredentialDoc>('aiCredentials', (c) => c.orgId === orgId);
}

export function aiCredentialFor(orgId: string, providerId: string) {
  return get<AiCredentialDoc>('aiCredentials', `ai_${orgId}_${providerId}`) ??
    aiCredentialsFor(orgId).find((c) => c.provider === providerId);
}

export function publicAiCredential(doc: AiCredentialDoc) {
  return {
    id: doc.id,
    provider: doc.provider,
    providerLabel: providerById(doc.provider)?.label ?? doc.provider,
    label: doc.label,
    keyHint: doc.keyHint,
    // Endpoint facts are safe to return: never the key, never the extra headers
    // (those can carry a second secret), only what a dashboard must display.
    baseUrl: doc.baseUrl,
    wire: doc.wire,
    authStyle: doc.authStyle,
    headerNames: doc.headersSealed ? Object.keys(extraHeaders(doc)) : [],
    models: doc.models,
    note: doc.note,
    verified: doc.verified,
    verifiedAt: doc.verifiedAt,
    modelCount: doc.modelCount,
    lastError: doc.lastError,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
  };
}

/**
 * Stores (or rotates) a workspace key. The provider is asked to list its models
 * first, which both proves the key works and tells the dashboard what it can run.
 */
export async function connectAiCredential(input: {
  orgId: string;
  provider: string;
  apiKey: string;
  label?: string;
  actor?: string;
  /** Bring-your-own endpoint fields, ignored for the hosted providers. */
  baseUrl?: string;
  wire?: WireFormat;
  authStyle?: AuthStyle;
  headers?: Record<string, string>;
}): Promise<
  { ok: true; credential: AiCredentialDoc; check: { models: number; note: string; verified: boolean } } | { ok: false; error: string; status: number }
> {
  const provider = providerById(input.provider);
  if (!provider) return { ok: false, error: `Unknown provider "${input.provider}".`, status: 400 };

  const endpoint = provider.byo ? normaliseEndpoint(input) : undefined;
  if (endpoint && 'error' in endpoint) return { ok: false, error: String(endpoint.error), status: 400 };

  const apiKey = input.apiKey.trim();
  if (!provider.byo && !apiKey) return { ok: false, error: 'An API key is required.', status: 400 };
  if (provider.byo && endpoint?.authStyle !== 'none' && apiKey.length < 8) {
    return { ok: false, error: 'That does not look like an API key. Use auth style "none" if the endpoint needs no key.', status: 400 };
  }

  const check = await verifyKey(provider, apiKey, endpoint);
  if (!check.ok) return { ok: false, error: check.error, status: check.status };

  const sealed = sealSecret(apiKey);
  const existing = aiCredentialFor(input.orgId, provider.id);
  const patch = {
    ...sealed,
    keyHint: apiKey ? maskSecret(apiKey) : 'no key',
    verified: check.verified,
    verifiedAt: nowIso(),
    modelCount: check.models,
    lastError: undefined,
    note: check.note,
    ...(endpoint
      ? {
          baseUrl: endpoint.baseUrl,
          wire: endpoint.wire,
          authStyle: endpoint.authStyle,
          headersSealed:
            endpoint.headers && Object.keys(endpoint.headers).length ? (sealSecret(JSON.stringify(endpoint.headers)) as Sealed) : undefined,
          models: check.modelIds ?? existing?.models,
        }
      : {}),
  };

  const doc = existing
    ? (update<AiCredentialDoc>('aiCredentials', existing.id, patch) as AiCredentialDoc)
    : insert<AiCredentialDoc>('aiCredentials', {
        id: `ai_${input.orgId}_${provider.id}`,
        orgId: input.orgId,
        provider: provider.id,
        label: input.label ?? `${provider.label} key`,
        ...patch,
        createdAt: nowIso(),
      } as AiCredentialDoc);

  audit({
    orgId: input.orgId,
    actor: input.actor ?? 'dashboard',
    action: existing ? 'ai.credential_rotated' : 'ai.credential_connected',
    target: doc.id,
    detail: provider.byo
      ? `${doc.baseUrl} ${doc.keyHint} — ${check.models} models visible`
      : `${provider.id} ${doc.keyHint} — ${check.models} models visible`,
  });

  return { ok: true, credential: doc, check: { models: check.models, note: check.note, verified: check.verified } };
}

/**
 * Re-checks a stored key.
 *
 * Worth having as its own action: a key can be revoked at the provider without
 * anything changing here, and an operator wants to find that out from a button
 * rather than from a call that went badly.
 */
export async function verifyCredential(orgId: string, id: string): Promise<{ ok: true; models: number; note: string; verified: boolean } | { ok: false; error: string }> {
  const doc = get<AiCredentialDoc>('aiCredentials', id);
  if (!doc || doc.orgId !== orgId) return { ok: false, error: 'Unknown credential.' };
  const provider = providerById(doc.provider);
  if (!provider) return { ok: false, error: `Unknown provider "${doc.provider}".` };
  const apiKey = openSecret(doc) ?? '';
  if (!provider.byo && !apiKey) return { ok: false, error: 'The stored key could not be decrypted — reconnect the provider.' };

  const check = await verifyKey(provider, apiKey, endpointFromDoc(doc));
  if (!check.ok) {
    update<AiCredentialDoc>('aiCredentials', id, { verified: false, lastError: check.error });
    return { ok: false, error: check.error };
  }
  update<AiCredentialDoc>('aiCredentials', id, {
    verified: check.verified,
    verifiedAt: nowIso(),
    modelCount: check.models,
    lastError: undefined,
    note: check.note,
    ...(check.modelIds ? { models: check.modelIds } : {}),
  });
  return { ok: true, models: check.models, note: check.note, verified: check.verified };
}

export function deleteAiCredential(orgId: string, id: string) {
  const doc = get<AiCredentialDoc>('aiCredentials', id);
  if (!doc || doc.orgId !== orgId) return undefined;
  remove('aiCredentials', id);
  audit({ orgId, actor: 'dashboard', action: 'ai.credential_deleted', target: id, detail: doc.provider });
  return doc;
}

/* ------------------------------------------------------- bring-your-own endpoint */

export type EndpointConfig = {
  baseUrl: string;
  wire: WireFormat;
  authStyle: AuthStyle;
  headers?: Record<string, string>;
};

/**
 * Headers for any request we make to a provider or an endpoint.
 *
 * The auth style decides the key header; the customer's extra headers ride along.
 * One function, so a verification call and a real turn can never disagree about
 * what the endpoint expects — which is exactly the bug that made an endpoint
 * refuse our own model check while accepting a test message.
 */
function callHeaders(wire: WireFormat, apiKey: string, endpoint?: EndpointConfig) {
  return {
    ...authHeaders(wire, apiKey, endpoint?.authStyle ?? (wire === 'anthropic' ? ('x-api-key' as AuthStyle) : ('bearer' as AuthStyle))),
    ...(endpoint?.headers ?? {}),
  };
}

export function extraHeaders(doc: AiCredentialDoc): Record<string, string> {
  if (!doc.headersSealed) return {};
  const json = openSecret(doc.headersSealed);
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && key.trim()) clean[key.trim()] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

function endpointFromDoc(doc: AiCredentialDoc): EndpointConfig | undefined {
  if (!doc.baseUrl) return undefined;
  return {
    baseUrl: doc.baseUrl,
    wire: doc.wire ?? 'openai',
    authStyle: doc.authStyle ?? 'bearer',
    headers: extraHeaders(doc),
  };
}

/**
 * Validates what a customer typed as their endpoint.
 *
 * Deliberately permissive about *where* it points — a LAN address, a gateway, a
 * tunnel — and strict about it being a real URL we can name in an error message.
 * The wire format and auth style are the customer's call because we cannot sniff
 * them; the resolved request URL is shown back to them so a mistake is visible
 * before a call is placed.
 */
export function normaliseEndpoint(input: { baseUrl?: string; wire?: WireFormat; authStyle?: AuthStyle; headers?: Record<string, string> }) {
  const raw = (input.baseUrl ?? '').trim();
  if (!raw) return { error: 'A base URL is required for your own endpoint, e.g. https://ai.yourcompany.com/v1.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `"${raw}" is not a URL. Include the scheme, e.g. https://ai.yourcompany.com/v1.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: `Only http and https endpoints are supported — got ${url.protocol}//.` };
  }
  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    wire: input.wire === 'anthropic' ? ('anthropic' as const) : ('openai' as const),
    authStyle: input.authStyle === 'x-api-key' || input.authStyle === 'none' ? input.authStyle : ('bearer' as const),
    headers: cleanHeaders(input.headers),
  };
}

/** Header names that would let a caller smuggle a request in a header of ours. */
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host', 'connection', 'transfer-encoding']);

export function cleanHeaders(input?: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const name = key.trim();
    if (!name || RESERVED_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value !== 'string' || !value) continue;
    if (!/^[A-Za-z0-9-_.]+$/.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ verifying */

/**
 * Cheap, honest check: ask the provider for its model list.
 *
 * Listing models costs nothing and returns a 401 for a bad key, which is exactly
 * the signal wanted — verifying by generating text would bill the customer for
 * a typo check.
 */
export async function verifyKey(
  provider: AiProvider,
  apiKey: string,
  endpoint?: EndpointConfig
): Promise<
  | { ok: true; models: number; note: string; verified: boolean; modelIds?: string[] }
  | { ok: false; error: string; status: number }
> {
  const base = endpoint?.baseUrl ?? baseUrlFor(provider);
  const headers = endpoint ? callHeaders(endpoint.wire, apiKey, endpoint) : undefined;

  // A customer's own endpoint may not implement a model list. That is not a
  // failure — it means we cannot *verify* the key, and we say exactly that
  // rather than refusing a working endpoint or claiming we checked it.
  if (endpoint) return verifyEndpoint(provider, base, endpoint, apiKey);

  try {
    if (provider.wire === 'anthropic') {
      const res = await fetch(`${base}/v1/models?limit=20`, {
        headers: { ...headers, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: await describeFailure(res), status: res.status === 401 ? 401 : 400 };
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      return { ok: true, models: ids.length, note: `Claude is reachable — ${ids.length} model${ids.length === 1 ? '' : 's'} visible.`, verified: true, modelIds: ids };
    }

    const res = await fetch(`${base}/models`, {
      headers: { ...headers, authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: await describeFailure(res), status: res.status === 401 ? 401 : 400 };
    const json = (await res.json()) as { data?: { id?: string }[] };
    const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return { ok: true, models: ids.length, note: `${provider.label} is reachable — ${ids.length} model${ids.length === 1 ? '' : 's'} visible.`, verified: true, modelIds: ids };
  } catch (err) {
    return { ok: false, error: `Could not reach ${provider.label}: ${err instanceof Error ? err.message : 'network error'}`, status: 502 };
  }
}

/**
 * Verification for a customer-supplied endpoint.
 *
 * Tries the model-list paths the OpenAI and Anthropic shapes use. Outcomes, in
 * the order they matter to the customer:
 *
 *   - 401/403                → the key (or headers) are wrong: refuse the save.
 *   - 200 with a model list  → verified, and we now know the model ids.
 *   - 200/404/405 otherwise  → reachable but does not publish models: save it
 *                              *unverified*, which the dashboard shows honestly.
 *   - no answer at all       → refuse, with the network error in the message.
 */
export async function verifyEndpoint(
  provider: AiProvider,
  base: string,
  endpoint: EndpointConfig,
  apiKey: string
): Promise<
  | { ok: true; models: number; note: string; verified: boolean; modelIds?: string[] }
  | { ok: false; error: string; status: number }
> {
  const headers = callHeaders(endpoint.wire, apiKey, endpoint);
  const attempts: string[] = [];
  for (const url of modelsUrls(provider, base)) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `The endpoint rejected the credentials: ${await describeFailure(res)}`, status: 401 };
      }
      if (!res.ok) {
        attempts.push(`${url} → ${res.status}`);
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
      const ids = [
        ...(json.data ?? []).map((m) => m.id),
        // Ollama's native shape, and a couple of gateways, answer like this.
        ...(json.models ?? []).map((m) => m.name ?? m.id),
      ].filter((id): id is string => Boolean(id));
      if (!ids.length) {
        attempts.push(`${url} → 200 with no models`);
        continue;
      }
      return {
        ok: true,
        models: ids.length,
        verified: true,
        modelIds: ids.slice(0, 200),
        note: `Your endpoint answered — ${ids.length} model${ids.length === 1 ? '' : 's'} visible (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '…' : ''}).`,
      };
    } catch (err) {
      attempts.push(`${url} → ${err instanceof Error ? err.message : 'network error'}`);
    }
  }

  // Nothing answered at all is a hard no: a URL that cannot be reached will not
  // answer a phone call either.
  if (attempts.every((a) => a.includes('→') && (/network error|fetch failed|ECONNREFUSED|timed out|timeout|ENOTFOUND|aborted/i.test(a)))) {
    return { ok: false, error: `Could not reach ${base}: ${attempts[0]?.split('→')[1]?.trim() ?? 'network error'}`, status: 502 };
  }

  return {
    ok: true,
    models: 0,
    verified: false,
    note: `Reachable, but it does not publish a model list (${attempts.join('; ')}). Saved unverified — type the model id you want and use “Send a test message”, which is the real proof.`,
  };
}

/** The endpoint's live model list, for the assistant editor. */
export async function endpointModels(orgId: string): Promise<{ baseUrl: string; models: string[]; verified: boolean; error?: string } | undefined> {
  const doc = aiCredentialFor(orgId, 'custom');
  if (!doc?.baseUrl) return undefined;
  const provider = providerById('custom');
  if (!provider) return undefined;
  const endpoint = endpointFromDoc(doc);
  if (!endpoint) return undefined;
  const apiKey = openSecret(doc) ?? '';
  const res = await verifyEndpoint(provider, doc.baseUrl, endpoint, apiKey);
  if (!res.ok) return { baseUrl: doc.baseUrl, models: doc.models ?? [], verified: false, error: res.error };
  if (res.modelIds) update<AiCredentialDoc>('aiCredentials', doc.id, { models: res.modelIds, modelCount: res.models, verified: res.verified, note: res.note, verifiedAt: nowIso() });
  return { baseUrl: doc.baseUrl, models: res.modelIds ?? doc.models ?? [], verified: res.verified };
}

/**
 * A one-line completion against a stored credential.
 *
 * This is the honest end-to-end check: listing models proves a URL answers, but
 * only generating text proves the models, the auth and the wire format all fit
 * together — and it costs a fraction of a cent, on the customer's own key.
 */
export async function testAiCredential(
  orgId: string,
  id: string,
  prompt = 'Reply with exactly: voxera endpoint check ok'
): Promise<{ ok: true; reply: string; model: string; latencyMs: number } | { ok: false; error: string }> {
  const doc = get<AiCredentialDoc>('aiCredentials', id);
  if (!doc || doc.orgId !== orgId) return { ok: false, error: 'Unknown credential.' };
  const provider = providerById(doc.provider);
  if (!provider) return { ok: false, error: `Unknown provider "${doc.provider}".` };
  const apiKey = openSecret(doc) ?? '';
  const endpoint = endpointFromDoc(doc);
  const base = endpoint?.baseUrl ?? baseUrlFor(provider);
  const wire = endpoint?.wire ?? provider.wire;
  const headers = callHeaders(wire, apiKey, endpoint);
  const model =
    (endpoint ? doc.models?.[0] : undefined) ?? doc.models?.[0] ?? DEFAULT_MODEL[provider.id] ?? 'gpt-4o-mini';

  const url = wire === 'anthropic' ? joinUrl(base, '/v1/messages') : joinUrl(base, '/chat/completions');
  const body =
    wire === 'anthropic'
      ? { model, max_tokens: 32, stream: false, messages: [{ role: 'user', content: prompt }] }
      : { model, max_tokens: 32, messages: [{ role: 'user', content: prompt }], stream: false };

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const detail = await describeFailure(res);
      update<AiCredentialDoc>('aiCredentials', id, { lastError: detail });
      return { ok: false, error: `${wire === 'anthropic' ? 'Messages API' : 'chat completions'} at ${url} returned ${res.status}: ${detail}` };
    }
    const json = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      choices?: { message?: { content?: string } }[];
    };
    const reply =
      wire === 'anthropic'
        ? (json.content ?? []).map((c) => c.text ?? '').join(' ').trim()
        : (json.choices?.[0]?.message?.content ?? '').trim();
    update<AiCredentialDoc>('aiCredentials', id, { lastError: undefined, lastUsedAt: nowIso() });
    if (!reply) return { ok: false, error: `The endpoint answered ${res.status} but sent no text back (model "${model}").` };
    return { ok: true, reply: reply.slice(0, 400), model, latencyMs };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'network error';
    update<AiCredentialDoc>('aiCredentials', id, { lastError: detail });
    return { ok: false, error: `Could not reach ${url}: ${detail}` };
  }
}

async function describeFailure(res: Response) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message ?? `Provider returned ${res.status}`;
  } catch {
    return text.slice(0, 200) || `Provider returned ${res.status}`;
  }
}

/* ------------------------------------------------------------------ resolving */

/**
 * The model that should answer a turn, or `undefined` for the rule engine.
 *
 * `model` comes from the assistant; `provider` is an explicit pin the customer
 * can set when a model id is ambiguous or they want a specific gateway.
 */
export function resolveModel(input: { orgId: string; model?: string; provider?: string }): ResolvedModel | undefined {
  // An unconfigured draft uses the deterministic rule engine. Do not silently
  // spend a deployment-level provider key just because one happens to exist.
  if (!input.model?.trim() && !input.provider?.trim()) return undefined;
  if (input.provider === 'rules') return undefined;
  const customDoc = aiCredentialFor(input.orgId, 'custom');
  const catalogueHit = input.model ? Boolean(MODELS_KNOWN.has(input.model)) : false;

  /**
   * When does an assistant run on the customer's own endpoint?
   *
   *   1. it is pinned there (`model.provider: 'custom'`), or
   *   2. it names a model no catalogue knows and the workspace has an endpoint —
   *      which is the common case for `llama3.1:8b`, an internal model name, or a
   *      gateway alias. Nothing is guessed: this only fires when the customer has
   *      actually connected one.
   */
  const useCustom =
    Boolean(customDoc?.baseUrl) &&
    (input.provider === 'custom' || (!input.provider && Boolean(input.model) && !catalogueHit));

  if (useCustom && customDoc) {
    const endpoint = endpointFromDoc(customDoc);
    if (endpoint) {
      const apiKey = openSecret(customDoc) ?? '';
      if (endpoint.authStyle === 'none' || apiKey) {
        const model = input.model?.trim() || customDoc.models?.[0] || 'default';
        return {
          providerId: 'custom',
          providerLabel: customDoc.label || 'Your endpoint',
          wire: endpoint.wire,
          baseUrl: endpoint.baseUrl,
          apiKey,
          model,
          modelLabel: model,
          source: 'workspace',
          headers: endpoint.headers,
          authStyle: endpoint.authStyle,
          // We cannot know what a self-hosted model costs, so we do not pretend:
          // no per-token provider cost is recorded for these turns.
          unpriced: true,
          inputCost: 0,
          outputCost: 0,
        };
      }
    }
  }

  const provider =
    (input.provider ? providerById(input.provider) : undefined) ??
    (input.model ? providerForModel(input.model) : undefined) ??
    providerById('openai');

  if (!provider) return undefined;
  const model = input.model && (!input.provider || providerForModel(input.model)?.id === provider.id) ? input.model : DEFAULT_MODEL[provider.id] ?? 'gpt-4o-mini';

  const workspace = aiCredentialFor(input.orgId, provider.id);
  const workspaceKey = workspace ? openSecret(workspace) : undefined;
  const envKey = envKeyFor(provider);
  const apiKey = workspaceKey ?? envKey;
  if (!apiKey) return undefined;

  const info = modelInfo(model);
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    wire: provider.wire,
    baseUrl: baseUrlFor(provider),
    apiKey,
    model,
    modelLabel: info.label,
    source: workspaceKey ? 'workspace' : 'env',
    inputCost: info.inputCost,
    outputCost: info.outputCost,
  };
}

/** Catalogue ids, for the "do we even know this model?" test above. */
const MODELS_KNOWN = new Set(MODELS.map((m) => m.id));

/** Records that a stored key was actually used, so the dashboard can show it. */
export function markAiUse(orgId: string, providerId: string) {
  const doc = aiCredentialFor(orgId, providerId);
  if (doc) update<AiCredentialDoc>('aiCredentials', doc.id, { lastUsedAt: nowIso() });
}

/**
 * Every provider a workspace could run right now, with the reason when it cannot.
 * This is what the dashboard and `/api/v1/ai/models` render.
 */
export function aiReadiness(orgId: string) {
  const credentials = aiCredentialsFor(orgId);
  return AI_PROVIDERS.map((p) => {
    const stored = credentials.find((c) => c.provider === p.id);
    const fromEnv = Boolean(envKeyFor(p));
    const resolved = p.byo ? resolveModel({ orgId, provider: 'custom' }) : resolveModel({ orgId, provider: p.id });
    return {
      id: p.id,
      label: p.label,
      wire: stored?.wire ?? p.wire,
      byo: p.byo,
      docs: p.docs,
      keyEnv: p.keyEnv,
      // For a BYO provider the URL is the customer's, so report theirs.
      baseUrl: p.byo ? stored?.baseUrl ?? '' : baseUrlFor(p),
      authStyle: p.byo ? stored?.authStyle ?? 'bearer' : undefined,
      endpointModels: p.byo ? stored?.models : undefined,
      headerNames: p.byo && stored ? Object.keys(extraHeaders(stored)) : undefined,
      note: p.byo ? stored?.note : undefined,
      hasWorkspaceKey: Boolean(stored),
      hasEnvKey: fromEnv,
      keyHint: stored?.keyHint,
      verified: stored?.verified ?? false,
      verifiedAt: stored?.verifiedAt,
      lastError: stored?.lastError,
      lastUsedAt: stored?.lastUsedAt,
      ready: Boolean(resolved),
      source: resolved?.source,
      defaultModel: p.byo ? stored?.models?.[0] : DEFAULT_MODEL[p.id],
    };
  });
}
