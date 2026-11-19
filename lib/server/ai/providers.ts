/**
 * Model providers.
 *
 * Every voice agent is a transcriber → **model** → voice pipeline, and this is
 * the middle layer. Two wire formats cover the catalogue: Anthropic's Messages
 * API, and the OpenAI chat-completions shape that OpenAI itself, Groq, DeepSeek,
 * Mistral and Gemini's compatibility endpoint all speak.
 *
 * Each provider's base URL is overridable (`*_API_BASE`) — that is what makes the
 * whole engine testable against a local stub, and what lets a customer point a
 * provider at a gateway or a regional endpoint.
 *
 * The model catalogue itself lives in `lib/content.ts`, which the marketing site
 * also renders: one list, so a pricing page and a running agent can never
 * disagree about what a model costs.
 */

import { MODELS } from '../../content';

export type WireFormat = 'anthropic' | 'openai';

export type AiProvider = {
  id: string;
  label: string;
  wire: WireFormat;
  defaultBase: string;
  keyEnv: string;
  baseEnv: string;
  /** Env var that also works, for providers with a familiar old name. */
  altKeyEnv?: string;
  docs: string;
  /** True when the provider is used by the managed stack rather than BYO. */
  managed?: boolean;
  /**
   * True when the customer supplies the endpoint URL rather than us knowing it.
   * The workspace stores its own base URL, auth style and extra headers.
   */
  byo?: boolean;
};

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    wire: 'anthropic',
    defaultBase: 'https://api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseEnv: 'ANTHROPIC_API_BASE',
    docs: 'console.anthropic.com → API keys',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    wire: 'openai',
    defaultBase: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    baseEnv: 'OPENAI_API_BASE',
    docs: 'platform.openai.com → API keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    wire: 'openai',
    defaultBase: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    baseEnv: 'GROQ_API_BASE',
    docs: 'console.groq.com → API keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai',
    defaultBase: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseEnv: 'DEEPSEEK_API_BASE',
    docs: 'platform.deepseek.com → API keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    wire: 'openai',
    defaultBase: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    baseEnv: 'MISTRAL_API_BASE',
    docs: 'console.mistral.ai → API keys',
  },
  {
    id: 'google',
    label: 'Google (Gemini, OpenAI-compatible)',
    wire: 'openai',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    baseEnv: 'GEMINI_API_BASE',
    docs: 'aistudio.google.com → API keys',
  },
  {
    id: 'custom',
    label: 'Your own endpoint',
    wire: 'openai',
    defaultBase: '',
    keyEnv: 'CUSTOM_AI_API_KEY',
    baseEnv: 'CUSTOM_AI_BASE_URL',
    docs: 'any OpenAI-compatible URL: your own service, a gateway, vLLM, Ollama, LiteLLM, OpenRouter',
    byo: true,
  },
];

/** The one provider whose URL the customer supplies. */
export function customProvider() {
  return providerById('custom');
}

export function providerById(id: string) {
  return AI_PROVIDERS.find((p) => p.id === id);
}

/**
 * Base URL for a provider, honouring (in order) a customer-supplied endpoint,
 * the deployment's override, then the vendor's public URL.
 */
export function baseUrlFor(provider: AiProvider, override?: string) {
  const raw = (override ?? '').trim() || (process.env[provider.baseEnv] ?? provider.defaultBase);
  return raw.replace(/\/+$/, '');
}

/**
 * Joins a base URL to a path without ever producing `/v1/v1/…`.
 *
 * Customers paste endpoint URLs in every shape there is — with a trailing slash,
 * with `/v1` already on the end, sometimes with the full path to the resource.
 * A doubled segment is the most common way a "compatible" endpoint silently
 * 404s, so it is normalised here rather than trusted.
 */
export function joinUrl(base: string, path: string) {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (cleanBase.endsWith(cleanPath)) return cleanBase;
  if (cleanBase.endsWith('/v1') && cleanPath.startsWith('/v1/')) {
    return `${cleanBase}${cleanPath.slice(3)}`;
  }
  return `${cleanBase}${cleanPath}`;
}

/** OpenAI-style `POST {base}/chat/completions`, or the Messages API equivalent. */
export function completionUrl(provider: AiProvider | { wire: WireFormat }, base: string) {
  return provider.wire === 'anthropic' ? joinUrl(base, '/v1/messages') : joinUrl(base, '/chat/completions');
}

/**
 * Where to ask an endpoint for its model list.
 *
 * Both shapes are returned in preference order because a compatible server may
 * expose either: `{base}/models` (OpenAI, most gateways) or `{base}/v1/models`.
 */
export function modelsUrls(provider: AiProvider, base: string) {
  const candidates =
    provider.wire === 'anthropic'
      ? [joinUrl(base, '/v1/models'), joinUrl(base, '/models')]
      : [joinUrl(base, '/models'), joinUrl(base, '/v1/models')];
  return [...new Set(candidates)];
}

/** The deployment-level key for a provider, if this install has one. */
export function envKeyFor(provider: AiProvider) {
  return process.env[provider.keyEnv] ?? (provider.altKeyEnv ? process.env[provider.altKeyEnv] : undefined);
}

/**
 * Which provider serves a model.
 *
 * The catalogue is authoritative; the prefix heuristic is the fallback for a
 * model id the catalogue does not know yet (a customer pinning a fresh release,
 * or a self-hosted name), so a new model works before anyone updates a list.
 */
export function providerForModel(modelId: string): AiProvider | undefined {
  const known = MODELS.find((m) => m.id === modelId);
  if (known) {
    const byCatalogue = providerById(known.provider) ?? providerById(known.provider === 'google' ? 'google' : '');
    if (byCatalogue) return byCatalogue;
  }
  const id = modelId.toLowerCase();
  if (id.startsWith('claude')) return providerById('anthropic');
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('text-')) return providerById('openai');
  if (id.startsWith('gemini')) return providerById('google');
  if (id.startsWith('llama') || id.includes('-groq') || id.includes('gpt-oss')) return providerById('groq');
  if (id.startsWith('deepseek')) return providerById('deepseek');
  if (id.startsWith('mistral') || id.startsWith('open-mistral') || id.startsWith('codestral')) return providerById('mistral');
  return undefined;
}

/** Catalogue entry for a model, with a sane default when it is unknown. */
export function modelInfo(modelId: string) {
  const known = MODELS.find((m) => m.id === modelId);
  if (known) {
    return { id: known.id, label: known.label, context: known.context, inputCost: 0, outputCost: 0, latency: known.latency, priced: false };
  }
  // Unknown ids get no invented price. For a self-hosted endpoint there is no
  // per-token cost for us to pass through at all, and guessing would put a
  // fictional number on a real invoice.
  return { id: modelId, label: modelId, context: 'unknown', inputCost: 0, outputCost: 0, latency: 'unknown', priced: false };
}

/**
 * No catalogue price is treated as billing truth. A future provider-usage import
 * can populate call costs from receipts; until then model turns record no cost.
 */
export function costFor(modelId: string, tokensIn: number, tokensOut: number) {
  void modelId;
  void tokensIn;
  void tokensOut;
  return 0;
}

/** Default model for a provider when an assistant does not name one. */
export const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4.5',
  openai: 'gpt-5-mini',
  groq: 'llama-4-scout',
  deepseek: 'deepseek-v3.2',
  mistral: 'mistral-large',
  google: 'gemini-2.5-flash',
};

/**
 * What this deployment can run without any customer action.
 *
 * Used by `/api/v1/ai/models`, the dashboard, and the "rules fallback" notice —
 * an operator can always tell whether a model is actually behind a turn.
 */
export function deploymentProviders() {
  return AI_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    wire: p.wire,
    docs: p.docs,
    envKey: p.keyEnv,
    configured: Boolean(envKeyFor(p)),
    models: MODELS.filter((m) => m.provider === p.id).map((m) => m.id),
  }));
}

/** Auth styles a bring-your-own endpoint can use. */
export type AuthStyle = 'bearer' | 'x-api-key' | 'none';

export const AUTH_STYLES: { id: AuthStyle; label: string }[] = [
  { id: 'bearer', label: 'Authorization: Bearer <key>' },
  { id: 'x-api-key', label: 'x-api-key: <key>' },
  { id: 'none', label: 'No key (a local server on your own network)' },
];

/** Header set for a request to a provider — one place, used by every call out. */
export function authHeaders(wire: WireFormat, apiKey: string | undefined, style: AuthStyle = wire === 'anthropic' ? 'x-api-key' : 'bearer') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (style === 'none') return headers;
  const key = apiKey ?? '';
  if (style === 'x-api-key') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  // Anthropic's API requires a version header, and Anthropic-compatible
  // gateways expect to see one too. Harmless to anything that ignores it.
  if (wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
}
