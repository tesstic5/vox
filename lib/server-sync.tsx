'use client';

/**
 * Dashboard ⇄ server bridge.
 *
 * The dashboard was built on a local store. This module keeps that store as the
 * UI's source of truth while making the server authoritative underneath:
 *
 *   1. On load, if a session exists, the workspace is bootstrapped and the store
 *      is hydrated from the server (assistants, calls, numbers, keys, metering).
 *   2. Mutations to real resources go through the REST API.
 *   3. Every other collection the dashboard owns is mirrored to the server with a
 *      debounced bulk write, so a reload — or another browser — sees the same
 *      workspace.
 *   4. If the API is unreachable, nothing breaks: the store keeps working from
 *      localStorage and the connection badge says so.
 */

import * as React from 'react';
import type { ApiKey, Assistant, Call, PhoneNumber, ToolDefinition } from './types';
import type { EffectiveBusinessProfile } from './business';

/* ------------------------------------------------------------------ transport */

export class ApiError extends Error {
  code: string;
  status: number;
  param?: string;
  requestId?: string;
  constructor(status: number, body: { error?: { code?: string; message?: string; param?: string; request_id?: string } }) {
    super(body?.error?.message ?? `Request failed with ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? 'INTERNAL_ERROR';
    this.param = body?.error?.param;
    this.requestId = body?.error?.request_id;
  }
}

export async function request<T>(method: string, path: string, body?: unknown, options: { headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined && !options.headers ? undefined : { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

/* ------------------------------------------------------------------ shapes */

export type Connection = {
  status: 'local' | 'live' | 'error';
  /**
   * `emailVerified` rides along because three things now refuse an unverified
   * account (publishing, buying a number, API keys) and a dashboard that only
   * finds out when a button fails is a worse teacher than a banner.
   */
  user?: { id: string; name: string; email: string; role?: string; emailVerified?: boolean; platformOperator?: boolean };
  org?: { id: string; name: string; plan?: string; region?: string; business?: EffectiveBusinessProfile };
  /** Metadata for the same authenticated session returned by /api/auth/me. */
  session?: { id: string; expiresAt: string };
  lastSyncAt?: string;
  error?: string;
  /**
   * Set when a mirrored collection could not be written back. The dashboard
   * keeps working (the change is in localStorage) but the server no longer has
   * it — worth saying out loud rather than swallowing, because a reload on
   * another machine would silently lose it.
   */
  mirrorError?: { name: string; message: string; at: string };
};

type ServerCall = Call & {
  numberId?: string;
  source?: string;
  toolCalls?: { name: string; args: Record<string, unknown>; result: string; ms: number; status: string }[];
  guardrails?: { kind: string; action: string; note: string }[];
};

type Snapshot = {
  assistants: Assistant[];
  calls: ServerCall[];
  numbers: PhoneNumber[];
  keys: ApiKey[];
  metrics?: {
    calls: number;
    ended: number;
    inProgress: number;
    minutes: number;
    cost: number;
    containment: number | null;
    containmentSamples: number;
    latency: { p50: number; p90: number; p99: number; samples: number };
    guardrailHits: number;
    byIntent: { intent: string; count: number }[];
    byAssistant?: { assistantId: string; assistantName: string; calls: number; minutes: number; containment: number }[];
  };
  usage?: { days: number; minutes: number; cost: number; daily: { date: string; calls: number; minutes: number; cost: number }[] };
  webhookDeliveries?: { id: string; event: string; url: string; status: string; attempts: number; at: string; statusCode?: number }[];
  tools?: ToolDefinition[];
  audit?: { id: string; action: string; actor: string; target?: string; detail?: string; at: string }[];
};

/* --------------------------------------------------------- server → store */

// Legacy rows may omit newer fields. Keep their absence visible and safe rather
// than silently turning on behaviour or inventing provider/model configuration.
const ASSISTANT_DEFAULTS = {
  temperature: 0,
  transcriber: '',
  language: '',
  maxTokens: 0,
  analysisSummaryPrompt: '',
  analysisSuccessPrompt: '',
  analysisStructuredData: [] as Assistant['analysisStructuredData'],
  serverUrlSecret: '',
  backgroundSound: 'off' as const,
  backchanneling: false,
  fillerInjection: false,
  voicemailDetection: false,
  endCallPhrases: [] as string[],
  silenceTimeoutSeconds: 0,
  responseDelaySeconds: 0,
  interruptSensitivity: 'medium' as const,
  mcpAllowlist: [] as string[],
};

export function assistantFromServer(doc: Record<string, unknown>): Assistant {
  const a = doc as unknown as Partial<Assistant> & Record<string, unknown>;
  return {
    ...ASSISTANT_DEFAULTS,
    id: String(a.id),
    name: String(a.name ?? 'Untitled Assistant'),
    firstMessage: String(a.firstMessage ?? ''),
    systemPrompt: String(a.systemPrompt ?? ''),
    model: String(a.model ?? ''),
    voiceId: String(a.voiceId ?? ''),
    tools: Array.isArray(a.tools) ? (a.tools as string[]) : [],
    serverUrl: String(a.serverUrl ?? ''),
    createdAt: String(a.createdAt ?? ''),
    updatedAt: String(a.updatedAt ?? ''),
    status: a.status === 'published' ? 'published' : 'draft',
    template: String(a.template ?? 'blank'),
    ...a,
  } as Assistant;
}

export function callFromServer(doc: Record<string, unknown>): ServerCall {
  return doc as unknown as ServerCall;
}

/* ------------------------------------------------------------------ hook */

/**
 * Slices the dashboard mirrors to the server as **row collections**: the server
 * stores one document per row, the client writes them with `{docs, mode:'replace'}`
 * and adopts them back when they come home.
 *
 * Every name here must be a slice the server has no native lane for, and must be
 * an array. A name the server owns natively does not belong in this list: a local
 * copy of a server-owned slice is a second, staler truth.
 */
/**
 * One deliberate absence: `invoices`.
 *
 * The store's slice is the *platform's* own billing invoices — platform fee,
 * provider cost, telephony, concurrency lines. The server's `invoices` collection
 * is the *practice's* money lane — subtotal, tax, amount paid, lines. Same name,
 * different document, and mirroring them put practice invoices into the platform
 * billing page, where the row it could not read (`platformMinutes`,
 * `platformAmount`) came out as `undefined.toLocaleString()`. The practice lane is
 * served by `/api/v1/invoices`, which `/dashboard/money` already uses; the
 * platform route now reads its dedicated API and this generic bridge owns neither lane.
 */
// Native resources hydrate through their dedicated APIs. This list remains
// explicit (and empty) so no server-owned collection can drift back into the
// generic mirror lane.
export const HYDRATE_COLLECTION_KEYS = [] as const;

// Workspace notices still use the generic row lane for read/clear persistence.
// Every retired demo-only slice was removed: loading it on every dashboard route
// cost sixteen requests and risked writing seeded browser data back to the store.
export const MIRROR_KEYS = ['notifications'] as const;

/**
 * Singleton preference documents with no dedicated server lane.
 *
 * Empty deliberately: the retired notification delivery toggles were not
 * consumed by a delivery workflow, so fetching them on every dashboard page was
 * both misleading and an unnecessary request. Provider, onboarding, billing and
 * security state continue to use their authoritative APIs.
 */
export const SETTINGS_KEYS = [] as const;

/** Every slice the dashboard expects to persist through the server. */
export const SYNCED_KEYS = [...MIRROR_KEYS, ...SETTINGS_KEYS] as const;

export function useServerSync(options: {
  /** Called with everything the server owns; the provider merges it into state. */
  onSnapshot: (snap: Snapshot) => void;
  /** Local-only slices, returned fresh on demand for the mirror writer. */
  selectMirrors: () => Record<string, unknown>;
  /** Bumping this value schedules a mirror write. */
  mirrorSource: unknown;
  enabled: boolean;
}) {
  const { onSnapshot, selectMirrors, mirrorSource, enabled } = options;
  const [connection, setConnection] = React.useState<Connection>({ status: 'local' });
  const [refreshToken, setRefreshToken] = React.useState(0);
  const pushed = React.useRef<Record<string, string>>({});
  const booted = React.useRef(false);
  const mayConfigure = React.useRef(false);
  const cbRef = React.useRef(onSnapshot);
  cbRef.current = onSnapshot;

  // ── boot: who am I, seed if new, then hydrate
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      try {
        const me = await request<{
          authenticated: boolean;
          user?: { id: string; name: string; email: string; role?: string; emailVerified?: boolean; platformOperator?: boolean };
          org?: { id: string; name: string; plan?: string; region?: string; business?: EffectiveBusinessProfile };
          session?: { id: string; expiresAt: string };
        }>('GET', '/api/auth/me');
        if (cancelled) return;
        if (!me.authenticated || !me.user) {
          // Anonymous visitor (the marketing site mounts this provider too):
          // no session, nothing to hydrate — the local store stands alone.
          setConnection({ status: 'local' });
          return;
        }
        mayConfigure.current = ['owner', 'admin', 'developer'].includes(me.user.role ?? '');
        setConnection({ status: 'live', user: me.user, org: me.org, session: me.session });

        // Setup and shared configuration writes belong to workspace admins.
        // Read-only and frontline team members can still load the existing data.
        if (mayConfigure.current) {
          const seeded = await request<{ seeded: boolean }>('POST', '/api/bootstrap');
          if (cancelled) return;
          if (seeded.seeded) pushed.current = {};
        }

        const [assistants, calls, numbers, keys, metrics, usage, webhooks, tools, audit] = await Promise.all([
          request<{ data: Record<string, unknown>[] }>('GET', '/api/v1/assistants?limit=200'),
          request<{ data: Record<string, unknown>[] }>('GET', '/api/v1/calls?limit=200'),
          request<{ data: Record<string, unknown>[] }>('GET', '/api/v1/numbers'),
          request<{ data: Record<string, unknown>[] }>('GET', '/api/v1/keys'),
          request<Snapshot['metrics']>('GET', '/api/v1/metrics?days=14').catch(() => undefined),
          request<{ window_days: number; minutes: number; cost: { total_usd: number }; daily: { date: string; calls: number; minutes: number; cost: number }[] }>(
            'GET',
            '/api/v1/usage?days=30'
          ).catch(() => undefined),
          request<{ deliveries?: Snapshot['webhookDeliveries'] }>('GET', '/api/v1/webhooks').catch(() => undefined),
          request<{ data: ToolDefinition[] }>('GET', '/api/v1/tools?limit=500').catch(() => undefined),
          request<{ data: Snapshot['audit'] }>('GET', '/api/v1/audit?limit=500').catch(() => undefined),
        ]);
        if (cancelled) return;

        // Local-only slices round-trip through the generic collections endpoint.
        const mirrors = await Promise.all(
          [...HYDRATE_COLLECTION_KEYS, ...SYNCED_KEYS].map(async (name) => {
            try {
              const res = await request<{ data: { id: string; value?: unknown }[] }>('GET', `/api/v1/collections/${name}`);
              return [name, res.data] as const;
            } catch {
              return [name, null] as const;
            }
          })
        );
        if (cancelled) return;

        const mirrored: Record<string, unknown> = {};
        for (const [name, docs] of mirrors) {
          if (!docs) continue;
          const settings = (SETTINGS_KEYS as readonly string[]).includes(name);
          if (settings) {
            const value = docs.find((doc) => doc.id === 'settings')?.value;
            if (value === undefined || value === null) continue;
            mirrored[name] = value;
            pushed.current[name] = JSON.stringify(value);
            continue;
          }
          // Empty is authoritative too. Without this, a new production tenant
          // retained the browser seed and immediately tried to mirror another
          // business's sample workflows, roles and files into its workspace.
          mirrored[name] = docs;
          pushed.current[name] = JSON.stringify(docs);
        }

        cbRef.current({
          assistants: assistants.data.map(assistantFromServer),
          calls: calls.data.map(callFromServer),
          numbers: numbers.data as unknown as PhoneNumber[],
          keys: keys.data as unknown as ApiKey[],
          metrics,
          usage: usage ? { days: usage.window_days, minutes: usage.minutes, cost: usage.cost?.total_usd ?? 0, daily: usage.daily } : undefined,
          webhookDeliveries: webhooks?.deliveries,
          tools: tools?.data,
          audit: audit?.data ?? undefined,
          ...(mirrored as object),
        });
        booted.current = true;
        setConnection((c) => ({ ...c, status: 'live', lastSyncAt: new Date().toISOString() }));
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        // 401 simply means "not signed in" — the dashboard is still usable.
        setConnection(status === 401 ? { status: 'local' } : { status: 'error', error: (err as Error).message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshToken]);

  // ── mirror: debounced bulk write of everything the server does not own natively
  React.useEffect(() => {
    if (!enabled || connection.status !== 'live' || !booted.current || !mayConfigure.current) return;
    const handle = setTimeout(async () => {
      let slices: Record<string, unknown>;
      try {
        slices = selectMirrors();
      } catch {
        return;
      }
      for (const name of SYNCED_KEYS) {
        const value = slices[name];
        const settings = (SETTINGS_KEYS as readonly string[]).includes(name);
        // A settings slice is an object written as one document; a collection
        // slice is a list written as rows. Anything else is a programming error
        // here, and is skipped rather than sent as the wrong shape.
        if (settings ? typeof value !== 'object' || value === null || Array.isArray(value) : !Array.isArray(value)) continue;
        const json = JSON.stringify(value);
        if (pushed.current[name] === json) continue;
        const payload = settings
          ? { docs: [{ id: 'settings', value }], mode: 'replace' }
          : { docs: value, mode: 'replace' };
        try {
          await request('POST', `/api/v1/collections/${name}`, payload);
          pushed.current[name] = json;
          setConnection((c) => (c.mirrorError?.name === name ? { ...c, mirrorError: undefined } : c));
        } catch (err) {
          // Kept locally and retried on the next change, but never hidden: a
          // workspace that half-syncs is a workspace that will surprise someone.
          const message = (err as Error).message;
          setConnection((c) => (c.mirrorError?.name === name && c.mirrorError.message === message ? c : { ...c, mirrorError: { name, message, at: new Date().toISOString() } }));
        }
      }
    }, 900);
    return () => clearTimeout(handle);
  }, [mirrorSource, enabled, connection.status, selectMirrors]);

  const refresh = React.useCallback(() => {
    pushed.current = {};
    setRefreshToken((n) => n + 1);
  }, []);

  return { connection, refresh };
}

/* ------------------------------------------------- resource write-through */

export type ResourceWrites = ReturnType<typeof useResourceWrites>;

/** Fire-and-forget writes to the real endpoints, with the result reconciled back. */
export function useResourceWrites(onCall: (call: ServerCall) => void, onError: (message: string) => void) {
  return React.useMemo(
    () => ({
      async createCall(input: { assistantId: string; from: string; to: string; type?: string; source?: string }) {
        const call = await request<Record<string, unknown>>('POST', '/api/v1/calls', { ...input, type: input.type ?? 'web' });
        const mapped = callFromServer(call);
        onCall(mapped);
        return mapped;
      },
      async turn(callId: string, text: string) {
        try {
          return await request<{
            call: Record<string, unknown>;
            turn: {
              reply: string;
              intent: string;
              confidence: number;
              latencyMs: number;
              model: string;
              toolCalls: { name: string; args: Record<string, unknown>; result: string; ms: number; status: string }[];
              guardrail: { kind: string; action: string; note: string } | null;
              knowledgeUsed: string[];
            };
          }>('POST', `/api/v1/calls/${callId}/turn`, { text });
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Turn failed');
          throw err;
        }
      },
      async end(callId: string, endedReason: string) {
        const call = await request<Record<string, unknown>>('PATCH', `/api/v1/calls/${callId}`, { status: 'ended', endedReason });
        const mapped = callFromServer(call);
        onCall(mapped);
        return mapped;
      },
    }),
    [onCall, onError]
  );
}
