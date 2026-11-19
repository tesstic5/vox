'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiKey,
  Assistant,
  Call,
  Campaign,
  LogEntry,
  Member,
  PhoneNumber,
  SimulationRun,
  Squad,
  ToolDefinition,
  TranscriptTurn,
  Invoice,
  Org,
  Invite,
  RoleDefinition,
  PermissionId,
  AuditEvent,
  Notification,
  NotificationPrefs,
  OnboardingState,
  SecurityState,
  SsoConfig,
  TwoFactorMethod,
  AssetFile,
  NumberConfig,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  Capability,
  Credential,
  ProviderSettings,
  McpServer,
  McpTool,
  WidgetConfig,
  BatchJob,
  BatchRow,
  BatchDisposition,
  Rubric,
  EvalReview,
  CriterionScore,
  AlertRule,
} from './types';
import { MODELS, STARTER_TEMPLATES, TOOL_LIBRARY, TRANSCRIBERS, VOICES } from './content';
import { WORKFLOW_TEMPLATES } from './workflows';
import { pinLabelClock, pick, randInt, uid } from './utils';
import { MIRROR_KEYS, SETTINGS_KEYS, request, useResourceWrites, useServerSync, type Connection, type ResourceWrites } from './server-sync';

const KEY = 'voxera.store.v3';

/* ------------------------------------------------------- initial state clock */

/**
 * Server and browser share one clock while hydration finishes, so relative-time
 * labels reproduce the server HTML. Operational rows themselves start empty and
 * come from authenticated workspace APIs.
 */
let SEED_AT = Date.now();

function initialClock() {
  return SEED_AT;
}
const PERMISSION_IDS: PermissionId[] = [
  'assistants.write',
  'assistants.publish',
  'calls.read',
  'transcripts.read',
  'numbers.manage',
  'campaigns.launch',
  'keys.manage',
  'billing.read',
  'billing.manage',
  'members.manage',
  'audit.read',
  'settings.write',
];

function perms(level: 'owner' | 'admin' | 'developer' | 'viewer' | 'custom'): Record<PermissionId, boolean> {
  const base = Object.fromEntries(PERMISSION_IDS.map((p) => [p, false])) as Record<PermissionId, boolean>;
  if (level === 'owner') return Object.fromEntries(PERMISSION_IDS.map((p) => [p, true])) as Record<PermissionId, boolean>;
  if (level === 'admin') {
    return { ...base, ...Object.fromEntries(PERMISSION_IDS.map((p) => [p, p !== 'billing.manage'])) } as Record<PermissionId, boolean>;
  }
  if (level === 'developer') {
    return {
      ...base,
      'assistants.write': true,
      'assistants.publish': false,
      'calls.read': true,
      'transcripts.read': true,
      'keys.manage': true,
      'campaigns.launch': true,
    } as Record<PermissionId, boolean>;
  }
  if (level === 'viewer') {
    return { ...base, 'calls.read': true, 'transcripts.read': true } as Record<PermissionId, boolean>;
  }
  // "custom" is the compliance-officer shape: read everything, change nothing.
  return {
    ...base,
    'calls.read': true,
    'transcripts.read': true,
    'audit.read': true,
    'billing.read': true,
  } as Record<PermissionId, boolean>;
}
/**
 * Single source of truth for a number's default configuration.
 *
 * Both the lazy read (`numberConfig`) and the write path (`updateNumberConfig`)
 * build from here — they used to carry separate inline defaults, which meant a
 * number read before it was ever edited behaved differently from one that had
 * been saved once.
 */
function numberConfigDefaults(_numberId: string): NumberConfig {
  return {
    whisperMessage: '',
    recordingConsent: false,
    voicemailDetection: false,
    failoverNumberId: null,
    sipTrunkId: null,
    webhookUrl: '',
    webhookEvents: [],
    maxCallSeconds: 0,
    allowedCountries: [],
    notes: '',
  };
}
const EVAL_REASONS: Record<'pass' | 'warn' | 'fail', string[]> = {
  pass: ['No review reason recorded.', 'All configured criteria passed.'],
  warn: ['A configured criterion needs review.', 'The automated score was inconclusive.'],
  fail: ['A configured criterion failed.', 'The stored call evidence did not meet the rubric.'],
};

const INTENTS = ['appointment', 'order_status', 'billing_question', 'general_enquiry'] as const;

function makeTranscript(intent: string, turns: number, assistantName: string): TranscriptTurn[] {
  return Array.from({ length: Math.max(0, turns) }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: index % 2 === 0
      ? `[Simulated caller turn about ${intent.replace(/_/g, ' ')}]`
      : `[Simulated response from ${assistantName}]`,
    at: index * 3,
    seconds: 2,
  }));
}

function makeWorkflowNode(kind: WorkflowNode['kind'], x: number, y: number): WorkflowNode {
  const label: Record<WorkflowNode['kind'], string> = {
    start: 'Start', prompt: 'Prompt', dtmf: 'Collect digits', api: 'API request',
    branch: 'Branch', validate: 'Validate', transfer: 'Transfer', end: 'End',
  };
  return { id: uid('node_'), kind, label: label[kind], x, y, text: '', config: {} };
}

function bumpMinor(version: string) {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return `${major}.${minor + 1}.0`;
}

function buildInitial(seedAt?: number) {
  SEED_AT = seedAt ?? SEED_AT;
  // Pin only relative-time labels for hydration. User-created IDs must not be
  // produced from the old deterministic demo random stream.
  pinLabelClock(SEED_AT);
  // Authenticated dashboards start empty and are hydrated from workspace APIs.
  // Demo fixtures must never flash as if they were the signed-in tenant's data.
  const assistants: Assistant[] = [];
  const numbers: PhoneNumber[] = [];
  const calls: Call[] = [];
  const rubrics: Rubric[] = [];
  return {
    assistants,
    calls,
    numbers,
    tools: [] as ToolDefinition[],
    keys: [] as ApiKey[],
    simulations: [] as SimulationRun[],
    logs: [] as LogEntry[],
    members: [] as Member[],
    campaigns: [] as Campaign[],
    squads: [] as Squad[],
    workflows: [] as Workflow[],
    providerSettings: {
      credentials: [],
      modes: { llm: 'byok', stt: 'byok', tts: 'byok', telephony: 'byok' },
      chains: { llm: [], stt: [], tts: [], telephony: [] },
    } as ProviderSettings,
    mcpServers: [] as McpServer[],
    widget: {
      assistantId: '', mode: 'popup', position: 'bottom-right', launcherLabel: 'Start test call', greeting: '',
      brandColor: '#2BE38B', theme: 'dark', voiceEnabled: true, showTranscript: true, escalationCta: '',
    } as WidgetConfig,
    batches: [] as BatchJob[],
    rubrics,
    evals: [] as EvalReview[],
    alerts: [] as AlertRule[],
    invoices: [] as Invoice[],
    roles: [] as RoleDefinition[],
    orgs: [] as Org[],
    currentOrgId: '',
    invites: [] as Invite[],
    audit: [] as AuditEvent[],
    notifications: [] as Notification[],
    notificationPrefs: {
      emailAlerts: false, emailDailyDigest: false, emailWeeklySummary: false,
      inAppCallFailures: false, inAppEvalQueue: false, inAppProduct: false,
      quietHours: '', slackWebhook: '',
    } as NotificationPrefs,
    onboarding: { steps: {}, dismissed: false, startedAt: '' } as OnboardingState,
    security: {
      twoFactor: { enabled: false, method: null, enrolledAt: null, recoveryCodes: [], codesRemaining: 0, enforcedByOrg: false },
      sessions: [], sso: { enforced: false, provider: null, protocol: null, domains: [], scim: false, lastAssertionAt: null },
      passwordChangedAt: '', lastLogin: { at: '', ip: '', location: '' },
    } as SecurityState,
    files: [] as AssetFile[],
    numberConfigs: {} as Record<string, NumberConfig>,
    billing: { budgetMonthly: 0, alertAt: 0, hardStop: false, costCentre: '' },
    activity: [] as { id: string; label: string; at: string; kind: string }[],
    /**
     * Aggregates computed by the server over the org's real calls. Present only
     * while the dashboard is connected; null means the UI should fall back to
     * whatever it can compute from the local store.
     */
    serverMetrics: null as null | {
      windowDays: number;
      calls?: number;
      ended?: number;
      inProgress?: number;
      minutes: number;
      cost: number;
      containment: number | null;
      containmentSamples: number;
      latency: { p50: number; p90: number; p99: number; samples: number };
      guardrailHits: number;
      byIntent: { intent: string; count: number }[];
      syncedAt: string;
    },
  };
}

type State = ReturnType<typeof buildInitial>;

/* ------------------------------------------------------------------ context */

type Ctx = State & {
  ready: boolean;
  /**
   * Where the workspace is living: `live` when the REST API is answering for
   * this session, `local` when the dashboard is running on the browser cache.
   */
  connection: Connection;
  refreshFromServer: () => void;
  /**
   * The most recent write the API rejected, if any. A failed save used to be a
   * line in the activity log and nothing else; the shell renders this so the
   * dashboard cannot keep showing a change that never reached the server.
   */
  writeError: { message: string; path: string; at: string } | null;
  dismissWriteError: () => void;
  noteWriteError: (message: string, path: string) => void;
  /** Direct access to the REST calls a live test-call session makes. */
  serverWrites: ResourceWrites;
  reset: () => void;
  createAssistant: (partial?: Partial<Assistant>) => Assistant;
  updateAssistant: (id: string, patch: Partial<Assistant>) => void;
  deleteAssistant: (id: string) => void;
  duplicateAssistant: (id: string) => Assistant | undefined;
  addCall: (call: Call) => void;
  deleteCall: (id: string) => void;
  buyNumber: (data: { areaCode: string; country: string; label: string; provider: PhoneNumber['provider'] }) => PhoneNumber;
  updateNumber: (id: string, patch: Partial<PhoneNumber>) => void;
  releaseNumber: (id: string) => void;
  createKey: (name: string, scope: ApiKey['scope']) => ApiKey;
  revokeKey: (id: string) => void;
  runSimulation: (assistantId: string, scenario: string, persona?: string) => SimulationRun;
  inviteMember: (name: string, email: string, role: Member['role']) => void;
  removeMember: (id: string) => void;
  updateMember: (id: string, patch: Partial<Member>) => void;
  toggleCampaign: (id: string) => void;
  createCampaign: (data: Partial<Campaign> & { name: string }) => Campaign;
  updateTool: (name: string, patch: Partial<ToolDefinition>) => void;
  createWorkflow: (data: { name: string; description?: string; assistantId?: string | null; templateSlug?: string }) => Workflow;
  updateWorkflow: (id: string, patch: Partial<Workflow>) => void;
  deleteWorkflow: (id: string) => void;
  duplicateWorkflow: (id: string) => Workflow | undefined;
  addWorkflowNode: (workflowId: string, kind: WorkflowNode['kind'], x: number, y: number) => WorkflowNode | undefined;
  updateWorkflowNode: (workflowId: string, nodeId: string, patch: Partial<WorkflowNode>) => void;
  removeWorkflowNode: (workflowId: string, nodeId: string) => void;
  addWorkflowEdge: (workflowId: string, edge: Omit<WorkflowEdge, 'id'> & { id?: string }) => void;
  updateWorkflowEdge: (workflowId: string, edgeId: string, patch: Partial<WorkflowEdge>) => void;
  removeWorkflowEdge: (workflowId: string, edgeId: string) => void;
  publishWorkflow: (id: string, status: Workflow['status']) => void;
  attachCredential: (data: { providerId: string; label: string; key: string; region: string }) => Credential;
  testCredential: (id: string) => Promise<{ ok: boolean; latencyMs: number }>;
  setCredentialRegion: (id: string, region: string) => void;
  removeCredential: (id: string) => void;
  setCapabilityMode: (capability: Capability, mode: 'managed' | 'byok') => void;
  moveInChain: (capability: Capability, providerId: string, direction: -1 | 1) => void;
  registerMcpServer: (data: { name: string; transport: McpServer['transport']; url: string; authType: string }) => McpServer;
  removeMcpServer: (id: string) => void;
  refreshMcpServer: (id: string) => void;
  setServerError: (id: string, note: string) => void;
  toggleAssistantTool: (assistantId: string, toolName: string) => void;
  allowAllTools: (assistantId: string, toolNames: string[]) => void;
  updateWidget: (patch: Partial<WidgetConfig>) => void;
  createBatch: (data: { name: string; rows: BatchRow[]; assistantId: string; phoneNumberId: string; settings?: Partial<BatchJob['settings']> }) => BatchJob;
  deleteBatch: (id: string) => void;
  updateBatch: (id: string, patch: Partial<BatchJob>) => void;
  dialBatch: (id: string, count: number) => void;
  addCriterion: (rubricId: string) => void;
  updateCriterion: (rubricId: string, criterionId: string, patch: Partial<Rubric['criteria'][number]>) => void;
  removeCriterion: (rubricId: string, criterionId: string) => void;
  resolveReview: (reviewId: string, verdict: 'pass' | 'fail', note: string) => void;
  confirmReview: (reviewId: string) => void;
  runEvalOnCalls: (count: number) => void;
  toggleAlertMute: (id: string) => void;
  addAlert: (data: Partial<AlertRule> & { name: string }) => AlertRule;
  removeAlert: (id: string) => void;
  updateBilling: (patch: Partial<{ budgetMonthly: number; alertAt: number; hardStop: boolean; costCentre: string }>) => void;
  switchOrg: (id: string) => void;
  sendInvite: (email: string, role: Invite['role']) => Invite;
  revokeInvite: (id: string) => void;
  resendInvite: (id: string) => void;
  togglePermission: (roleId: RoleDefinition['id'], permission: PermissionId) => void;
  addRole: (name: string, basedOn: RoleDefinition['id']) => void;
  appendAudit: (event: Omit<AuditEvent, 'id' | 'at' | 'ip' | 'actor' | 'actorEmail'>) => void;
  markNotificationRead: (id: string) => void;
  readAllNotifications: () => void;
  clearNotifications: () => void;
  updateNotificationPrefs: (patch: Partial<NotificationPrefs>) => void;
  completeOnboardingStep: (id: string) => void;
  resetOnboarding: () => void;
  dismissOnboarding: (dismissed: boolean) => void;
  uploadAsset: (data: { name: string; kind: AssetFile['kind']; sizeBytes: number }) => AssetFile;
  deleteAsset: (id: string) => void;
  extendAssetRetention: (id: string, days: number) => void;
  numberConfig: (numberId: string) => NumberConfig;

  /* account security */
  enableTwoFactor: (method: TwoFactorMethod) => void;
  disableTwoFactor: () => void;
  regenerateRecoveryCodes: () => string[];
  revokeSession: (id: string) => void;
  revokeOtherSessions: () => void;
  setSsoConfig: (patch: Partial<SsoConfig>) => void;
  addSsoDomain: (domain: string) => void;
  verifySsoDomain: (domain: string) => void;
  removeSsoDomain: (domain: string) => void;
  changePassword: () => void;
  updateNumberConfig: (numberId: string, patch: Partial<NumberConfig>) => void;
  log: (label: string, kind?: string) => void;
  assistantById: (id: string) => Assistant | undefined;
  voiceById: (id: string) => (typeof VOICES)[number] | undefined;
  modelById: (id: string) => (typeof MODELS)[number];
  transcriberById: (id: string) => (typeof TRANSCRIBERS)[number];
};

const StoreContext = createContext<Ctx | null>(null);

export function StoreProvider({ children, seedAt }: { children: React.ReactNode; seedAt?: number }) {
  const [state, setState] = useState<State>(() => buildInitial(seedAt));
  const [ready, setReady] = useState(false);
  // The instant this page was rendered, for `<Ago>` to label against until its
  // own hydration is through. It is never released: a subtree that hydrates late
  // (React can finish hydrating in pieces) must still be able to reproduce the
  // string the server wrote, and `<Ago>` switches to the real clock itself.
  pinLabelClock(initialClock());

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // Older demo builds cached whole dashboard slices in the browser. The
    // authenticated product is server-authoritative, so clear that legacy blob
    // instead of flashing one tenant's stale configuration into another login.
    try { localStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
    setReady(true);
  }, []);

  const log = useCallback((label: string, kind = 'info') => {
    setState((s) => ({
      ...s,
      activity: [{ id: uid('act_'), label, at: new Date().toISOString(), kind }, ...s.activity].slice(0, 40),
    }));
  }, []);

  /* ------------------------------------------------- server bridge */

  const applySnapshot = useCallback((snap: Record<string, unknown>) => {
    setState((s) => {
      const next: State = { ...s };
      // Server-owned resources replace the local guess wholesale. Empty is a
      // real server answer: preserving the browser seed on an empty production
      // workspace would display invented assistants, calls, numbers and keys.
      if (Array.isArray(snap.assistants)) next.assistants = snap.assistants as Assistant[];
      if (Array.isArray(snap.calls)) next.calls = snap.calls as Call[];
      if (Array.isArray(snap.numbers)) next.numbers = snap.numbers as PhoneNumber[];
      if (Array.isArray(snap.keys)) next.keys = snap.keys as ApiKey[];
      // The small server-hydrated collection set comes back as row lists. The
      // settings branch remains generic for compatibility, although no unwired
      // singleton preference is active in the current sync contract.
      for (const key of Object.keys(snap)) {
        if (['assistants', 'calls', 'numbers', 'keys', 'metrics', 'usage'].includes(key)) continue;
        const value = snap[key];
        if ((SETTINGS_KEYS as readonly string[]).includes(key)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) (next as Record<string, unknown>)[key] = value;
          continue;
        }
        if (Array.isArray(value)) {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      if (Array.isArray(snap.audit)) next.audit = snap.audit as AuditEvent[];
      const metrics = snap.metrics as {
        minutes: number;
        cost: number;
        containment: number | null;
        containmentSamples: number;
        latency: { p50: number; p90: number; p99: number; samples: number };
        guardrailHits: number;
        byIntent: { intent: string; count: number }[];
      } | undefined;
      next.serverMetrics = metrics
        ? {
            ...metrics,
            windowDays: 14,
            syncedAt: new Date().toISOString(),
          }
        : s.serverMetrics;
      return next;
    });
  }, []);

  const selectMirrors = useCallback(() => {
    const bag: Record<string, unknown> = {};
    for (const key of [...MIRROR_KEYS, ...SETTINGS_KEYS]) bag[key] = (stateRef.current as Record<string, unknown>)[key];
    return bag;
  }, []);

  const { connection, refresh: refreshFromServer } = useServerSync({
    onSnapshot: applySnapshot,
    selectMirrors,
    mirrorSource: state,
    enabled: true,
  });

  const onServerCall = useCallback((call: Call) => {
    setState((s) => {
      const exists = s.calls.some((c) => c.id === call.id);
      return { ...s, calls: exists ? s.calls.map((c) => (c.id === call.id ? call : c)) : [call, ...s.calls] };
    });
  }, []);

  const [writeError, setWriteError] = useState<{ message: string; path: string; at: string } | null>(null);

  const noteWriteError = useCallback(
    (message: string, path: string) => setWriteError({ message, path, at: new Date().toISOString() }),
    []
  );
  const onWriteError = useCallback(
    (message: string) => {
      log(`API write failed: ${message}`, 'error');
      noteWriteError(message, 'live session');
    },
    [log, noteWriteError]
  );
  const writes = useResourceWrites(onServerCall, onWriteError);

  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  /**
   * Optimistic UI with a real write behind it. The mutation has already been
   * applied locally; this pushes it to the API and answers for it if the server
   * disagrees.
   *
   * Two things happen on failure, in order. `rollback` undoes the local edit when
   * the caller provided one, and then the workspace is re-synced from the server
   * — which is the general fix: whatever the optimistic edit was, the server's
   * version replaces it instead of leaving the UI showing a change that was never
   * saved. The failure is surfaced in the shell rather than only in the log.
   *
   * Offline (no session) it is a no-op, which is what keeps the dashboard usable
   * without a server.
   */
  const push = useCallback(
    (method: string, path: string, body?: unknown, rollback?: () => void) => {
      if (connectionRef.current.status !== 'live') return;
      request(method, path, body).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'network error';
        log(`API ${method} ${path} — ${message}`, 'error');
        noteWriteError(message, `${method} ${path}`);
        rollback?.();
        // The server is authoritative: pull its state back over the optimistic
        // one rather than guessing which fields to undo.
        refreshFromServer();
      });
    },
    [log, noteWriteError, refreshFromServer]
  );

  const value: Ctx = useMemo(() => {
    const api: Ctx = {
      ...state,
      ready,
      connection,
      refreshFromServer,
      writeError,
      dismissWriteError: () => setWriteError(null),
      noteWriteError,
      serverWrites: writes,
      reset: () => {
        localStorage.removeItem(KEY);
        setState(buildInitial());
      },
      log,
      assistantById: (id) => state.assistants.find((a) => a.id === id),
      voiceById: (id) => VOICES.find((v) => v.id === id),
      modelById: (id) => MODELS.find((m) => m.id === id) ?? MODELS[0],
      transcriberById: (id) => TRANSCRIBERS.find((t) => t.id === id) ?? TRANSCRIBERS[0],
      createAssistant: (partial) => {
        const now = new Date().toISOString();
        const tpl = partial?.template ? STARTER_TEMPLATES.find((t) => t.name === partial.template || t.id === partial.template) : undefined;
        const a: Assistant = {
          id: uid('asst_'),
          name: partial?.name ?? tpl?.name ?? 'Untitled Assistant',
          firstMessage: partial?.firstMessage ?? tpl?.firstMessage ?? '',
          systemPrompt: partial?.systemPrompt ?? tpl?.prompt ?? '',
          model: partial?.model ?? tpl?.model ?? '',
          temperature: partial?.temperature ?? 0,
          transcriber: partial?.transcriber ?? '',
          voiceId: partial?.voiceId ?? '',
          language: partial?.language ?? '',
          maxTokens: partial?.maxTokens ?? 0,
          tools: partial?.tools ?? [],
          analysisSummaryPrompt: partial?.analysisSummaryPrompt ?? '',
          analysisSuccessPrompt: partial?.analysisSuccessPrompt ?? '',
          analysisStructuredData: partial?.analysisStructuredData ?? [],
          serverUrl: partial?.serverUrl ?? '',
          serverUrlSecret: partial?.serverUrlSecret ?? '',
          backgroundSound: partial?.backgroundSound ?? 'off',
          backchanneling: partial?.backchanneling ?? false,
          fillerInjection: partial?.fillerInjection ?? false,
          voicemailDetection: partial?.voicemailDetection ?? false,
          endCallPhrases: partial?.endCallPhrases ?? [],
          silenceTimeoutSeconds: partial?.silenceTimeoutSeconds ?? 0,
          responseDelaySeconds: partial?.responseDelaySeconds ?? 0,
          interruptSensitivity: partial?.interruptSensitivity ?? 'medium',
          createdAt: now,
          updatedAt: now,
          status: partial?.status ?? 'draft',
          template: partial?.template ?? 'Blank',
        };
        setState((s) => ({ ...s, assistants: [a, ...s.assistants] }));
        // Real assistants live on the server; the id is ours so references hold.
        push('POST', '/api/v1/assistants', a, () =>
          setState((s) => ({ ...s, assistants: s.assistants.filter((x) => x.id !== a.id) }))
        );
        log(`Assistant created — ${a.name}`, 'create');
        return a;
      },
      updateAssistant: (id, patch) => {
        setState((s) => ({
          ...s,
          assistants: s.assistants.map((a) =>
            a.id === id ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a
          ),
        }));
        push('PATCH', `/api/v1/assistants/${id}`, patch);
        if (patch.name) log(`Assistant updated — ${patch.name}`, 'update');
      },
      deleteAssistant: (id) => {
        setState((s) => ({
          ...s,
          assistants: s.assistants.filter((a) => a.id !== id),
          numbers: s.numbers.map((n) => (n.assistantId === id ? { ...n, assistantId: null } : n)),
        }));
        push('DELETE', `/api/v1/assistants/${id}`);
        log('Assistant deleted', 'delete');
      },
      duplicateAssistant: (id) => {
        const src = state.assistants.find((a) => a.id === id);
        if (!src) return undefined;
        const copy: Assistant = {
          ...src,
          id: uid('asst_'),
          name: `${src.name} (copy)`,
          status: 'draft',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setState((s) => ({ ...s, assistants: [copy, ...s.assistants] }));
        push('POST', '/api/v1/assistants', copy);
        log(`Assistant duplicated — ${copy.name}`, 'create');
        return copy;
      },
      addCall: (call) => {
        setState((s) => ({ ...s, calls: [call, ...s.calls] }));
        log(`Call completed — ${call.customer.name}`, 'call');
      },
      deleteCall: (id) => {
        setState((s) => ({ ...s, calls: s.calls.filter((c) => c.id !== id) }));
        log('Call log deleted', 'delete');
      },
      buyNumber: ({ areaCode, country, label, provider }) => {
        const dial = country === 'GB' ? '+44 20 ' : country === 'PK' ? '+92 42 ' : country === 'AU' ? '+61 2 ' : `+1 (${areaCode}) `;
        const n: PhoneNumber = {
          id: uid('pn_'),
          number: `${dial}${randInt(200, 999)}-${randInt(1000, 9999)}`,
          label: label || 'Untitled',
          provider,
          assistantId: null,
          country,
          areaCode,
          status: 'active',
          monthlyCost: country === 'US' ? 1.15 : 3.4,
          inboundCalls30d: 0,
          createdAt: new Date().toISOString(),
          squadId: null,
        };
        setState((s) => ({ ...s, numbers: [n, ...s.numbers] }));
        push('POST', '/api/v1/numbers', n, () =>
          setState((s) => ({ ...s, numbers: s.numbers.filter((x) => x.id !== n.id) }))
        );
        log(`Number provisioned — ${n.number}`, 'create');
        return n;
      },
      updateNumber: (id, patch) => {
        setState((s) => ({ ...s, numbers: s.numbers.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
        push('PATCH', `/api/v1/numbers/${id}`, patch);
      },
      releaseNumber: (id) => {
        setState((s) => ({ ...s, numbers: s.numbers.filter((n) => n.id !== id) }));
        push('DELETE', `/api/v1/numbers/${id}`);
        log('Number released', 'delete');
      },
      createKey: (name, scope) => {
        const prefix = scope === 'public' ? 'pk_live_' : 'vk_live_';
        const local: ApiKey = {
          id: uid('key_'),
          name,
          prefix,
          secret: '',
          scope,
          createdAt: new Date().toISOString(),
          lastUsed: null,
          orgId: 'org_northwind',
        };
        setState((s) => ({ ...s, keys: [local, ...s.keys] }));

        // Keys are minted server-side: only the hash is stored, and the secret is
        // shown once. The placeholder is replaced with the real key on response.
        if (connectionRef.current.status === 'live') {
          request<ApiKey>('POST', '/api/v1/keys', { name, scopes: ['*'], type: scope })
            .then((created) => {
              setState((s) => ({
                ...s,
                keys: s.keys.map((k) => (k.id === local.id ? { ...created, scope: k.scope } : k)),
              }));
              log(`API key minted — ${created.prefix}…${String((created as { last4?: string }).last4 ?? '')}`, 'create');
            })
            .catch((err: unknown) => {
              setState((s) => ({ ...s, keys: s.keys.filter((k) => k.id !== local.id) }));
              log(`Key creation failed — ${err instanceof Error ? err.message : 'network error'}`, 'error');
            });
        }
        log(`API key created — ${name}`, 'create');
        return local;
      },
      revokeKey: (id) => {
        setState((s) => ({ ...s, keys: s.keys.filter((k) => k.id !== id) }));
        push('DELETE', `/api/v1/keys/${id}`);
        log('API key revoked', 'delete');
      },
      runSimulation: (assistantId, scenario, persona) => {
        const a = state.assistants.find((x) => x.id === assistantId);
        const passed = Math.random() > 0.25;
        const run: SimulationRun = {
          id: uid('sim_'),
          name: `${scenario} · run ${randInt(100, 999)}`,
          assistantId,
          assistantName: a?.name ?? 'Unknown',
          scenario,
          status: passed ? 'passed' : 'failed',
          score: passed ? randInt(80, 100) : randInt(31, 74),
          turns: randInt(6, 24),
          durationSeconds: randInt(45, 280),
          startedAt: new Date().toISOString(),
          persona: persona ?? 'en-US · 175 wpm · interrupts sometimes',
          failureReason: passed
            ? undefined
            : 'Agent confirmed a policy exception without escalating to a human reviewer.',
          transcript: makeTranscript(pick(INTENTS), randInt(6, 16), a?.name ?? 'Agent'),
        };
        setState((s) => ({ ...s, simulations: [run, ...s.simulations] }));
        log(`Simulation ${run.status} — ${scenario}`, 'sim');
        return run;
      },
      inviteMember: (name, email, role) => {
        setState((s) => ({
          ...s,
          members: [
            ...s.members,
            {
              id: uid('usr_'),
              name,
              email,
              role,
              avatarColor: pick(['#2BE38B', '#6EA8FE', '#F2A65A', '#C77DFF']),
              lastActive: new Date().toISOString(),
              status: 'invited',
            },
          ],
        }));
        log(`Invitation sent to ${email}`, 'create');
      },
      removeMember: (id) => {
        setState((s) => ({ ...s, members: s.members.filter((m) => m.id !== id) }));
        log('Member removed', 'delete');
      },
      updateMember: (id, patch) => {
        setState((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
      },
      toggleCampaign: (id) => {
        setState((s) => ({
          ...s,
          campaigns: s.campaigns.map((c) =>
            c.id === id
              ? { ...c, status: c.status === 'running' ? 'paused' : c.status === 'paused' ? 'running' : c.status }
              : c
          ),
        }));
        log('Campaign status changed', 'update');
      },
      createCampaign: (data) => {
        const c: Campaign = {
          id: uid('cmp_'),
          name: data.name,
          assistantId: data.assistantId ?? state.assistants[0]?.id ?? '',
          phoneNumberId: data.phoneNumberId ?? state.numbers[0]?.id ?? '',
          status: 'draft',
          totalCustomers: data.totalCustomers ?? 1000,
          attempted: 0,
          connected: 0,
          interested: 0,
          startedAt: new Date().toISOString(),
          schedule: data.schedule ?? '09:00–17:00 local, Mon–Fri',
        };
        setState((s) => ({ ...s, campaigns: [c, ...s.campaigns] }));
        log(`Campaign created — ${c.name}`, 'create');
        return c;
      },
      completeOnboardingStep: (id) => {
        setState((s) => ({ ...s, onboarding: { ...s.onboarding, steps: { ...s.onboarding.steps, [id]: true } } }));
        log(`Onboarding step complete — ${id}`, 'update');
      },
      resetOnboarding: () => {
        setState((s) => ({
          ...s,
          onboarding: {
            steps: Object.fromEntries(Object.keys(s.onboarding.steps).map((k) => [k, false])),
            dismissed: false,
            startedAt: new Date().toISOString(),
          },
        }));
        log('Onboarding restarted', 'update');
      },
      dismissOnboarding: (dismissed) => {
        setState((s) => ({ ...s, onboarding: { ...s.onboarding, dismissed } }));
      },
      uploadAsset: (data) => {
        const file: AssetFile = {
          id: uid('file_'),
          name: data.name,
          kind: data.kind,
          sizeBytes: data.sizeBytes,
          createdAt: new Date().toISOString(),
          expiresAt: data.kind === 'recording' ? new Date(Date.now() + 90 * 86400000).toISOString() : null,
          status: data.kind === 'knowledge' ? 'processing' : 'ready',
          uploadedBy: 'jordan@northwind.dev',
        };
        setState((s) => ({ ...s, files: [file, ...s.files] }));
        log(`File uploaded — ${file.name}`, 'create');
        return file;
      },
      deleteAsset: (id) => {
        setState((s) => ({ ...s, files: s.files.filter((f) => f.id !== id) }));
        log('File deleted', 'delete');
      },
      extendAssetRetention: (id, days) => {
        setState((s) => ({
          ...s,
          files: s.files.map((f) =>
            f.id === id ? { ...f, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), status: 'ready' } : f
          ),
        }));
        log('Retention extended', 'update');
      },
      numberConfig: (numberId) => state.numberConfigs[numberId] ?? numberConfigDefaults(numberId),
      updateNumberConfig: (numberId, patch) => {
        const current = state.numberConfigs[numberId] ?? numberConfigDefaults(numberId);
        setState((s) => ({ ...s, numberConfigs: { ...s.numberConfigs, [numberId]: { ...current, ...patch } } }));
        log('Number configuration updated', 'update');
      },
      enableTwoFactor: (method) => {
        const codes = Array.from({ length: 8 }, (_, i) =>
          `${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 9)
        );
        setState((s) => ({
          ...s,
          security: {
            ...s.security,
            twoFactor: {
              enabled: true,
              method,
              enrolledAt: new Date().toISOString(),
              recoveryCodes: codes,
              codesRemaining: codes.length,
              enforcedByOrg: s.security.twoFactor.enforcedByOrg,
            },
          },
        }));
        log(`Two-factor authentication enabled (${method})`, 'update');
      },
      disableTwoFactor: () => {
        setState((s) => ({
          ...s,
          security: {
            ...s.security,
            twoFactor: { ...s.security.twoFactor, enabled: false, method: null, enrolledAt: null, recoveryCodes: [], codesRemaining: 0 },
          },
        }));
        log('Two-factor authentication disabled', 'update');
      },
      regenerateRecoveryCodes: () => {
        const codes = Array.from({ length: 8 }, () =>
          `${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 9)
        );
        setState((s) => ({
          ...s,
          security: {
            ...s.security,
            twoFactor: { ...s.security.twoFactor, recoveryCodes: codes, codesRemaining: codes.length },
          },
        }));
        log('Recovery codes regenerated', 'update');
        return codes;
      },
      revokeSession: (id) => {
        setState((s) => ({ ...s, security: { ...s.security, sessions: s.security.sessions.filter((x) => x.id !== id) } }));
        log('Session revoked', 'delete');
      },
      revokeOtherSessions: () => {
        setState((s) => ({
          ...s,
          security: { ...s.security, sessions: s.security.sessions.filter((x) => x.current) },
        }));
        log('All other sessions revoked', 'delete');
      },
      setSsoConfig: (patch) => {
        setState((s) => ({ ...s, security: { ...s.security, sso: { ...s.security.sso, ...patch } } }));
        log('SSO configuration updated', 'update');
      },
      addSsoDomain: (domain) => {
        setState((s) => ({
          ...s,
          security: {
            ...s.security,
            sso: {
              ...s.security.sso,
              domains: [...s.security.sso.domains, { domain, verified: false, addedAt: new Date().toISOString() }],
            },
          },
        }));
        log(`SSO domain added: ${domain}`, 'create');
      },
      verifySsoDomain: (domain) => {
        setState((s) => ({
          ...s,
          security: {
            ...s.security,
            sso: {
              ...s.security.sso,
              domains: s.security.sso.domains.map((d) => (d.domain === domain ? { ...d, verified: true } : d)),
            },
          },
        }));
        log(`SSO domain verified: ${domain}`, 'update');
      },
      removeSsoDomain: (domain) => {
        setState((s) => ({
          ...s,
          security: { ...s.security, sso: { ...s.security.sso, domains: s.security.sso.domains.filter((d) => d.domain !== domain) } },
        }));
        log(`SSO domain removed: ${domain}`, 'delete');
      },
      changePassword: () => {
        setState((s) => ({ ...s, security: { ...s.security, passwordChangedAt: new Date().toISOString() } }));
        log('Password changed', 'update');
      },
      markNotificationRead: (id) => {
        setState((s) => ({ ...s, notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) }));
      },
      readAllNotifications: () => {
        setState((s) => ({ ...s, notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
        log('Notifications marked read', 'update');
      },
      clearNotifications: () => {
        setState((s) => ({ ...s, notifications: [] }));
        log('Notification centre cleared', 'delete');
      },
      updateNotificationPrefs: (patch) => {
        setState((s) => ({ ...s, notificationPrefs: { ...s.notificationPrefs, ...patch } }));
        log('Notification preferences updated', 'update');
      },
      switchOrg: (id) => {
        setState((s) => ({ ...s, currentOrgId: id }));
        log('Organisation switched', 'update');
      },
      sendInvite: (email, role) => {
        const invite: Invite = {
          id: uid('inv_'),
          email,
          role,
          invitedBy: 'Jordan Reyes',
          sentAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          status: 'pending',
        };
        setState((s) => ({ ...s, invites: [invite, ...s.invites] }));
        log(`Invitation sent to ${email}`, 'create');
        return invite;
      },
      revokeInvite: (id) => {
        setState((s) => ({ ...s, invites: s.invites.map((i) => (i.id === id ? { ...i, status: 'revoked' } : i)) }));
        log('Invitation revoked', 'delete');
      },
      resendInvite: (id) => {
        setState((s) => ({
          ...s,
          invites: s.invites.map((i) =>
            i.id === id
              ? { ...i, sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), status: 'pending' }
              : i
          ),
        }));
        log('Invitation resent', 'update');
      },
      togglePermission: (roleId, permission) => {
        setState((s) => ({
          ...s,
          roles: s.roles.map((r) =>
            r.id === roleId && !r.system
              ? { ...r, permissions: { ...r.permissions, [permission]: !r.permissions[permission] } }
              : r
          ),
        }));
        log(`Role permissions updated — ${roleId}`, 'update');
      },
      addRole: (name, basedOn) => {
        const source = state.roles.find((r) => r.id === basedOn);
        setState((s) => ({
          ...s,
          roles: [
            ...s.roles,
            {
              id: 'custom' as const,
              name,
              description: `Custom role based on ${source?.name ?? basedOn}.`,
              permissions: { ...(source?.permissions ?? perms('viewer')) },
              system: false,
            },
          ],
        }));
        log(`Custom role created — ${name}`, 'create');
      },
      appendAudit: (event) => {
        setState((s) => ({
          ...s,
          audit: [
            {
              id: uid('aud_'),
              at: new Date().toISOString(),
              actor: 'Jordan Reyes',
              actorEmail: 'jordan@northwind.dev',
              ip: '203.0.113.24',
              ...event,
            },
            ...s.audit,
          ],
        }));
      },
      updateBilling: (patch) => {
        setState((s) => ({ ...s, billing: { ...s.billing, ...patch } }));
        log('Budget settings updated', 'update');
      },
      toggleAlertMute: (id) => {
        setState((s) => ({ ...s, alerts: s.alerts.map((a) => (a.id === id ? { ...a, muted: !a.muted } : a)) }));
        log('Alert rule updated', 'update');
      },
      addAlert: (data) => {
        const rule: AlertRule = {
          id: uid('alrt_'),
          name: data.name,
          metric: data.metric ?? 'latency-p90',
          window: data.window ?? '1h @ 14.4×',
          threshold: data.threshold ?? 'p90 > 900ms',
          severity: data.severity ?? 'warning',
          channels: data.channels ?? ['slack'],
          muted: false,
          lastFired: null,
          fires30d: 0,
        };
        setState((s) => ({ ...s, alerts: [rule, ...s.alerts] }));
        log(`Alert created — ${rule.name}`, 'create');
        return rule;
      },
      removeAlert: (id) => {
        setState((s) => ({ ...s, alerts: s.alerts.filter((a) => a.id !== id) }));
        log('Alert deleted', 'delete');
      },
      addCriterion: (rubricId) => {
        setState((s) => ({
          ...s,
          rubrics: s.rubrics.map((r) =>
            r.id === rubricId
              ? {
                  ...r,
                  criteria: [
                    ...r.criteria,
                    {
                      id: uid('crit_'),
                      name: 'New criterion',
                      description: 'What must be true for this to pass.',
                      weight: 10,
                      passCondition: 'Write the condition an evaluator can check.',
                    },
                  ],
                  updatedAt: new Date().toISOString(),
                }
              : r
          ),
        }));
        log('Rubric criterion added', 'create');
      },
      updateCriterion: (rubricId, criterionId, patch) => {
        setState((s) => ({
          ...s,
          rubrics: s.rubrics.map((r) =>
            r.id === rubricId
              ? {
                  ...r,
                  criteria: r.criteria.map((cr) => (cr.id === criterionId ? { ...cr, ...patch } : cr)),
                  updatedAt: new Date().toISOString(),
                }
              : r
          ),
        }));
      },
      removeCriterion: (rubricId, criterionId) => {
        setState((s) => ({
          ...s,
          rubrics: s.rubrics.map((r) =>
            r.id === rubricId
              ? { ...r, criteria: r.criteria.filter((cr) => cr.id !== criterionId), updatedAt: new Date().toISOString() }
              : r
          ),
        }));
      },
      resolveReview: (reviewId, verdict, note) => {
        setState((s) => ({
          ...s,
          evals: s.evals.map((e) =>
            e.id === reviewId
              ? {
                  ...e,
                  status: 'overridden',
                  humanVerdict: verdict,
                  humanNote: note || 'Reviewed without a note.',
                  reviewer: 'Jordan Reyes',
                  reviewedAt: new Date().toISOString(),
                }
              : e
          ),
        }));
        log(`Eval review resolved — ${verdict}`, 'update');
      },
      confirmReview: (reviewId) => {
        setState((s) => ({
          ...s,
          evals: s.evals.map((e) =>
            e.id === reviewId
              ? { ...e, status: 'confirmed', reviewer: 'Jordan Reyes', reviewedAt: new Date().toISOString() }
              : e
          ),
        }));
        log('Eval score confirmed', 'update');
      },
      runEvalOnCalls: (count) => {
        if (state.rubrics.length === 0) {
          log('No evaluation rubric is configured.', 'info');
          return;
        }
        const fresh = state.calls.slice(0, count).map((c, i) => {
          const rubric = state.rubrics[i % state.rubrics.length];
          const mode = i % 4 === 0 ? 'fail' : i % 5 === 0 ? 'warn' : 'pass';
          const pool = EVAL_REASONS[mode];
          const criteria: CriterionScore[] = rubric.criteria.map((cr, idx) => {
            const passed = mode === 'pass' ? true : mode === 'warn' ? idx !== 2 : idx > 1;
            return {
              criterionId: cr.id,
              name: cr.name,
              score: passed ? randInt(80, 100) : randInt(22, 60),
              passed,
              reasoning: passed
                ? 'Evidence found in the transcript and the tool trace.'
                : 'No evidence found: ' + cr.description.toLowerCase(),
            };
          });
          return {
            id: uid('ev_'),
            callId: c.id,
            assistantName: c.assistantName,
            rubricId: rubric.id,
            rubricVersion: rubric.version,
            summary: c.analysis.summary,
            overall: mode === 'fail' ? randInt(40, 64) : mode === 'warn' ? randInt(70, 79) : randInt(85, 98),
            status: (mode === 'pass' ? 'auto' : 'needs-review') as EvalReview['status'],
            criteria,
            flaggedReason: mode === 'pass' ? undefined : pool[1],
          };
        });
        setState((s) => ({ ...s, evals: [...fresh, ...s.evals] }));
        log(`Evals run on ${count} calls`, 'sim');
      },
      createBatch: (data) => {
        const job: BatchJob = {
          id: uid('batch_'),
          name: data.name,
          assistantId: data.assistantId,
          phoneNumberId: data.phoneNumberId,
          status: 'draft',
          rows: data.rows,
          settings: {
            concurrency: 120,
            attemptBudget: 3,
            quietHours: '08:00–21:00 contact local time',
            timeZoneMode: 'contact-local',
            dncCheck: true,
            voicemailAction: 'leave-message',
            ...(data.settings ?? {}),
          },
          createdAt: new Date().toISOString(),
          startedAt: null,
        };
        setState((s) => ({ ...s, batches: [job, ...s.batches] }));
        log(`Batch imported — ${job.name} (${job.rows.length} rows)`, 'create');
        return job;
      },
      deleteBatch: (id) => {
        setState((s) => ({ ...s, batches: s.batches.filter((b) => b.id !== id) }));
        log('Batch deleted', 'delete');
      },
      updateBatch: (id, patch) => {
        setState((s) => ({ ...s, batches: s.batches.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
      },
      dialBatch: (id, count) => {
        setState((s) => ({
          ...s,
          batches: s.batches.map((b) => {
            if (b.id !== id) return b;
            const pool: BatchDisposition[] = ['completed', 'connected', 'voicemail', 'no-answer', 'completed', 'failed'];
            let dialed = 0;
            const rows = b.rows.map((r) => {
              if (r.disposition !== 'pending' || dialed >= count) return r;
              dialed += 1;
              const d = pick(pool);
              return {
                ...r,
                disposition: d,
                outcome:
                  d === 'completed'
                    ? pick(['Payment link sent', 'Appointment confirmed', 'Callback scheduled', 'Address updated'])
                    : d === 'connected'
                      ? 'Call in progress — will re-dial after attempt budget'
                      : d === 'voicemail'
                        ? b.settings.voicemailAction === 'leave-message'
                          ? 'Message left with reference number'
                          : 'Hung up on answering machine'
                        : d === 'no-answer'
                          ? 'No answer — attempt 1 of ' + b.settings.attemptBudget
                          : d === 'failed'
                            ? 'Carrier rejected the call'
                            : r.outcome,
                durationSeconds: randInt(14, 260),
                at: new Date().toISOString(),
              };
            });
            const pending = rows.filter((r) => r.disposition === 'pending').length;
            return {
              ...b,
              rows,
              status: pending === 0 ? 'completed' : 'running',
              startedAt: b.startedAt ?? new Date().toISOString(),
            };
          }),
        }));
        log('Batch dialling advanced', 'call');
      },
      updateWidget: (patch) => {
        setState((s) => ({ ...s, widget: { ...s.widget, ...patch } }));
        log('Widget configuration updated', 'update');
      },
      registerMcpServer: (data) => {
        const server: McpServer = {
          id: uid('mcp_'),
          name: data.name,
          transport: data.transport,
          url: data.url,
          authType: data.authType || 'Not connected',
          status: 'error',
          tools: [],
          lastSync: new Date().toISOString(),
          latencyMs: 0,
          healthNote: 'MCP transport and tool discovery are unavailable in this build. Register a tested HTTP tool instead.',
        };
        setState((s) => ({ ...s, mcpServers: [server, ...s.mcpServers] }));
        log(`Unavailable MCP registration recorded — ${data.name}`, 'create');
        return server;
      },
      removeMcpServer: (id) => {
        setState((s) => ({ ...s, mcpServers: s.mcpServers.filter((x) => x.id !== id) }));
        log('MCP server removed', 'delete');
      },
      refreshMcpServer: (id) => {
        setState((s) => ({
          ...s,
          mcpServers: s.mcpServers.map((x) =>
            x.id === id
              ? {
                  ...x,
                  status: 'error',
                  tools: [],
                  healthNote: 'MCP transport and tool discovery are unavailable in this build.',
                  latencyMs: 0,
                  lastSync: new Date().toISOString(),
                }
              : x
          ),
        }));
        log('Unavailable MCP discovery request recorded', 'update');
      },
      setServerError: (id, note) => {
        setState((s) => ({
          ...s,
          mcpServers: s.mcpServers.map((x) => (x.id === id ? { ...x, status: 'error', healthNote: note } : x)),
        }));
      },
      toggleAssistantTool: (assistantId, toolName) => {
        setState((s) => ({
          ...s,
          assistants: s.assistants.map((a) => {
            if (a.id !== assistantId) return a;
            const list = a.mcpAllowlist ?? [];
            const next = list.includes(toolName) ? list.filter((t) => t !== toolName) : [...list, toolName];
            return { ...a, mcpAllowlist: next, updatedAt: new Date().toISOString() };
          }),
        }));
      },
      allowAllTools: (assistantId, toolNames) => {
        setState((s) => ({
          ...s,
          assistants: s.assistants.map((a) =>
            a.id === assistantId ? { ...a, mcpAllowlist: [...toolNames], updatedAt: new Date().toISOString() } : a
          ),
        }));
        log('Tool allowlist updated', 'update');
      },
      attachCredential: (data) => {
        const raw = data.key.trim();
        const tail = raw.slice(-4) || '0000';
        const cred: Credential = {
          id: uid('cred_'),
          providerId: data.providerId,
          label: data.label || 'Untitled credential',
          maskedKey: `${raw.slice(0, Math.min(3, raw.length))}••••••••••••••••${tail}`,
          region: data.region,
          status: 'untested',
          lastTested: null,
          latencyMs: null,
          createdAt: new Date().toISOString(),
        };
        setState((s) => ({
          ...s,
          providerSettings: { ...s.providerSettings, credentials: [cred, ...s.providerSettings.credentials] },
        }));
        log(`Credential attached — ${data.providerId}`, 'create');
        return cred;
      },
      testCredential: async (id) => {
        await new Promise((r) => setTimeout(r, 700));
        const ok = true;
        const latencyMs = randInt(70, 320);
        setState((s) => ({
          ...s,
          providerSettings: {
            ...s.providerSettings,
            credentials: s.providerSettings.credentials.map((c) =>
              c.id === id ? { ...c, status: ok ? 'active' : 'failing', lastTested: new Date().toISOString(), latencyMs } : c
            ),
          },
        }));
        log(`Credential tested — ${ok ? 'healthy' : 'failed'}`, 'update');
        return { ok, latencyMs };
      },
      setCredentialRegion: (id, region) => {
        setState((s) => ({
          ...s,
          providerSettings: {
            ...s.providerSettings,
            credentials: s.providerSettings.credentials.map((c) => (c.id === id ? { ...c, region } : c)),
          },
        }));
      },
      removeCredential: (id) => {
        setState((s) => ({
          ...s,
          providerSettings: {
            ...s.providerSettings,
            credentials: s.providerSettings.credentials.filter((c) => c.id !== id),
          },
        }));
        log('Credential removed', 'delete');
      },
      setCapabilityMode: (capability, mode) => {
        setState((s) => ({
          ...s,
          providerSettings: { ...s.providerSettings, modes: { ...s.providerSettings.modes, [capability]: mode } },
        }));
        log(`${capability} routing set to ${mode}`, 'update');
      },
      moveInChain: (capability, providerId, direction) => {
        setState((s) => {
          const chain = [...s.providerSettings.chains[capability]];
          const i = chain.indexOf(providerId);
          const j = i + direction;
          if (i < 0 || j < 0 || j >= chain.length) return s;
          [chain[i], chain[j]] = [chain[j], chain[i]];
          return {
            ...s,
            providerSettings: { ...s.providerSettings, chains: { ...s.providerSettings.chains, [capability]: chain } },
          };
        });
      },
      createWorkflow: (data) => {
        const tpl = data.templateSlug ? WORKFLOW_TEMPLATES.find((t) => t.slug === data.templateSlug) : undefined;
        const wf: Workflow = {
          id: uid('wf_'),
          name: data.name,
          description: data.description ?? tpl?.purpose ?? '',
          assistantId: data.assistantId ?? state.assistants[0]?.id ?? null,
          nodes: tpl
            ? tpl.nodes.map((n) => ({ ...n, config: { ...n.config } }))
            : [makeWorkflowNode('start', 40, 200)],
          edges: tpl ? tpl.edges.map((e) => ({ ...e })) : [],
          status: 'draft',
          version: '0.1.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          template: data.templateSlug,
        };
        setState((s) => ({ ...s, workflows: [wf, ...s.workflows] }));
        log(`Workflow created — ${wf.name}`, 'create');
        return wf;
      },
      updateWorkflow: (id, patch) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) => (w.id === id ? { ...w, ...patch, updatedAt: new Date().toISOString() } : w)),
        }));
      },
      deleteWorkflow: (id) => {
        setState((s) => ({ ...s, workflows: s.workflows.filter((w) => w.id !== id) }));
        log('Workflow deleted', 'delete');
      },
      duplicateWorkflow: (id) => {
        const src = state.workflows.find((w) => w.id === id);
        if (!src) return undefined;
        const copy: Workflow = {
          ...src,
          id: uid('wf_'),
          name: `${src.name} (copy)`,
          status: 'draft',
          version: '0.1.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setState((s) => ({ ...s, workflows: [copy, ...s.workflows] }));
        log(`Workflow duplicated — ${copy.name}`, 'create');
        return copy;
      },
      addWorkflowNode: (workflowId, kind, x, y) => {
        const node = makeWorkflowNode(kind, x, y);
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) =>
            w.id === workflowId ? { ...w, nodes: [...w.nodes, node], updatedAt: new Date().toISOString() } : w
          ),
        }));
        log(`Node added — ${node.label}`, 'create');
        return node;
      },
      updateWorkflowNode: (workflowId, nodeId, patch) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) =>
            w.id === workflowId
              ? {
                  ...w,
                  nodes: w.nodes.map((n) =>
                    n.id === nodeId ? { ...n, ...patch, config: { ...n.config, ...(patch.config ?? {}) } } : n
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : w
          ),
        }));
      },
      removeWorkflowNode: (workflowId, nodeId) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) =>
            w.id === workflowId
              ? {
                  ...w,
                  nodes: w.nodes.filter((n) => n.id !== nodeId),
                  edges: w.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
                  updatedAt: new Date().toISOString(),
                }
              : w
          ),
        }));
        log('Node removed', 'delete');
      },
      addWorkflowEdge: (workflowId, edge) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) => {
            if (w.id !== workflowId) return w;
            if (w.edges.some((e) => e.from === edge.from && e.to === edge.to)) return w;
            return {
              ...w,
              edges: [...w.edges, { ...edge, id: edge.id ?? uid('ed_') }],
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },
      updateWorkflowEdge: (workflowId, edgeId, patch) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) =>
            w.id === workflowId
              ? { ...w, edges: w.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)), updatedAt: new Date().toISOString() }
              : w
          ),
        }));
      },
      removeWorkflowEdge: (workflowId, edgeId) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) =>
            w.id === workflowId
              ? { ...w, edges: w.edges.filter((e) => e.id !== edgeId), updatedAt: new Date().toISOString() }
              : w
          ),
        }));
      },
      publishWorkflow: (id, status) => {
        setState((s) => ({
          ...s,
          workflows: s.workflows.map((w) =>
            w.id === id
              ? {
                  ...w,
                  status,
                  version: status === 'published' ? bumpMinor(w.version) : w.version,
                  updatedAt: new Date().toISOString(),
                }
              : w
          ),
        }));
        log(`Workflow ${status}`, 'update');
      },
      updateTool: (name, patch) => {
        setState((s) => ({ ...s, tools: s.tools.map((t) => (t.name === name ? { ...t, ...patch } : t)) }));
      },
    };
    return api;
  }, [state, ready, log]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}

/* ------------------------------------------------- live call simulation hook */

export type LiveTurn = {
  id: string;
  role: 'assistant' | 'user' | 'system';
  text: string;
  final: boolean;
  /** Tool invocation or guardrail notice rendered inline in the transcript. */
  notice?: 'tool' | 'guardrail' | 'knowledge';
};

/**
 * Places a real call.
 *
 * When the dashboard has a session, this is not a simulation: a call record is
 * created through the API, every line the caller "speaks" runs through the agent
 * runtime, and the reply, tool invocations, guardrail trips and latency you see
 * on screen are what the server actually produced. Ending the call writes it to
 * the call log with its transcript, analysis and cost.
 *
 * With no session it degrades to a scripted local conversation so the widget
 * still works offline.
 */
export function useCallSimulator(opts: {
  assistant?: Assistant | null;
  onEnd?: (call: Call) => void;
  /** Passed to the API so the call log shows where it came from. */
  source?: string;
}) {
  const { assistant, onEnd, source } = opts;
  const store = useStore();
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'ending'>('idle');
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [speaking, setSpeaking] = useState<'agent' | 'user' | null>(null);
  const [latency, setLatency] = useState(0);
  const [muted, setMuted] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ints = useRef<ReturnType<typeof setInterval>[]>([]);
  const callIdRef = useRef<string | null>(null);
  const turnsRef = useRef<LiveTurn[]>([]);
  const scriptIdx = useRef(0);
  const live = store.connection.status === 'live';

  turnsRef.current = turns;

  const clearAll = useCallback(() => {
    timers.current.forEach(clearTimeout);
    ints.current.forEach(clearInterval);
    timers.current = [];
    ints.current = [];
  }, []);

  const say = useCallback((turn: Omit<LiveTurn, 'id' | 'final'>) => {
    const id = uid('t_');
    setTurns((prev) => [...prev, { ...turn, id, final: true }]);
    return id;
  }, []);

  /* -------------------------------------------------- server-backed path */

  /** Sends one caller utterance to the real runtime and renders the response. */
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      say({ role: 'user', text: trimmed });

      let id = callIdRef.current;
      try {
        if (!id) {
          const call = await store.serverWrites.createCall({
            assistantId: assistant?.id ?? '',
            from: 'Web widget',
            to: assistant?.name ?? 'Voice agent',
            type: 'web',
            source: source ?? 'dashboard',
          });
          id = call.id;
          callIdRef.current = id;
          setCallId(id);
        }
        setSpeaking('agent');
        const res = await store.serverWrites.turn(id, trimmed);
        setLatency(res.turn.latencyMs);
        for (const tool of res.turn.toolCalls ?? []) {
          say({
            role: 'system',
            text: `${tool.name}(${JSON.stringify(tool.args)}) → ${String(tool.result).slice(0, 160)} · ${tool.ms}ms`,
            notice: 'tool',
          });
        }
        const guard = res.turn.guardrail as { kind: string; action: string; note: string } | null;
        if (guard) {
          say({ role: 'system', text: `Guardrail · ${guard.kind} · ${guard.action} — ${guard.note}`, notice: 'guardrail' });
        }
        say({ role: 'assistant', text: res.turn.reply });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'The agent did not answer.';
        setError(message);
        say({ role: 'system', text: `Call failed — ${message}`, notice: 'guardrail' });
      } finally {
        setSpeaking(null);
      }
    },
    [assistant?.id, assistant?.name, say, source, store.serverWrites]
  );

  /* -------------------------------------------------- offline path */

  const runLocalScript = useCallback(() => {
    const script: { role: 'assistant' | 'user'; text: string }[] = [
      { role: 'assistant', text: assistant?.firstMessage ?? 'Hi, thanks for calling. How can I help you today?' },
      { role: 'user', text: 'Hi — I wanted to check on an order I placed last week.' },
      { role: 'assistant', text: 'Of course. Let me pull it up. Could you confirm the ZIP code on the order for me?' },
      { role: 'user', text: 'Sure, it is 94107.' },
      { role: 'assistant', text: 'Thanks. I can see the order shipped Tuesday and it is out for delivery today — you will have it before 8pm.' },
      { role: 'user', text: 'Great. Can you text me the tracking link?' },
      { role: 'assistant', text: 'Just sent it to the number you are calling from. Anything else I can help with?' },
      { role: 'user', text: 'No, that is everything. Thanks!' },
      { role: 'assistant', text: 'Happy to help. Have a great rest of your day.' },
    ];
    let delay = 1200;
    const step = () => {
      const turn = script[scriptIdx.current];
      if (!turn) return;
      scriptIdx.current += 1;
      const id = uid('t_');
      setSpeaking(turn.role === 'assistant' ? 'agent' : 'user');
      setTurns((prev) => [...prev, { id, role: turn.role, text: '', final: false }]);
      const words = turn.text.split(' ');
      let w = 0;
      const typing = setInterval(() => {
        w += 1;
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, text: words.slice(0, w).join(' ') } : t)));
        if (w >= words.length) {
          clearInterval(typing);
          setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, final: true } : t)));
          setSpeaking(null);
          delay = turn.role === 'assistant' ? 1500 : 1300;
          timers.current.push(setTimeout(step, delay));
        }
      }, Math.max(38, 900 / Math.max(3, words.length)));
      ints.current.push(typing);
    };
    timers.current.push(setTimeout(step, 1100));
  }, [assistant?.firstMessage]);

  /* -------------------------------------------------- lifecycle */

  const stop = useCallback(
    async (reason: Call['endedReason'] = 'customer-ended-call') => {
      setStatus('ending');
      clearAll();
      setSpeaking(null);
      setLevel(0);

      const id = callIdRef.current;
      if (id && live) {
        try {
          const ended = await store.serverWrites.end(id, reason);
          onEnd?.(ended);
        } catch {
          /* the call stays in the log as in-progress; nothing is lost */
        }
      } else {
        const captured = turnsRef.current.filter((t) => !t.notice);
        const dur = seconds || 12;
        const base: Call = {
          id: `call_local_${Math.random().toString(36).slice(2, 8)}`,
          assistantId: assistant?.id ?? 'asst_simulated',
          assistantName: assistant?.name ?? 'Simulated Agent',
          type: 'web',
          status: 'ended',
          endedReason: reason,
          from: 'Web widget',
          to: assistant?.name ?? 'Simulated Agent',
          startedAt: new Date(Date.now() - dur * 1000).toISOString(),
          durationSeconds: dur,
          // A local browser fallback has no provider receipt or platform tariff.
          cost: { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 },
          transcript: captured.map((t, i) => ({
            role: t.role,
            text: t.text,
            at: i * 2.4,
            seconds: Math.max(1.4, t.text.length / 15),
          })),
          recordingUrl: null,
          analysis: {
            summary: `Offline test call with ${assistant?.name ?? 'the agent'}. This transcript was generated locally and was not metered.`,
            successEvaluation: 'not_evaluated',
            sentiment: 'neutral',
            intent: 'browser_test',
            structuredData: { offline: true, evaluation: 'not_run' },
            score: 0,
          },
          metrics: { latencyMs: latency > 0 ? latency : 0, interruptions: 0, turns: Math.floor(captured.length / 2) },
          customer: { name: 'Browser tester', number: 'WebRTC session' },
        };
        onEnd?.(base);
      }

      callIdRef.current = null;
      setCallId(null);
      setStatus('idle');
      setTurns([]);
      setSeconds(0);
      scriptIdx.current = 0;
    },
    [assistant?.id, assistant?.name, clearAll, latency, live, onEnd, seconds, store.serverWrites]
  );

  const start = useCallback(() => {
    clearAll();
    setTurns([]);
    setSeconds(0);
    setError(null);
    scriptIdx.current = 0;
    setStatus('connecting');
    setLatency(randInt(300, 520));

    timers.current.push(
      setTimeout(() => {
        setStatus('live');
        if (live && assistant?.id) {
          // The agent's greeting comes from the assistant, not a script.
          const greeting = assistant?.firstMessage;
          if (greeting) say({ role: 'assistant', text: greeting });
        } else {
          // Marketing demo, or a dashboard running without a session.
          runLocalScript();
        }
      }, 700)
    );

    const lvl = setInterval(() => setLevel(Math.random() * 0.85 + 0.12), 110);
    const clk = setInterval(() => setSeconds((s) => s + 1), 1000);
    ints.current.push(lvl, clk);
  }, [assistant?.firstMessage, clearAll, live, runLocalScript, say]);

  useEffect(() => () => clearAll(), [clearAll]);

  return {
    status,
    turns,
    level,
    seconds,
    speaking,
    latency,
    muted,
    setMuted,
    start,
    stop,
    send,
    callId,
    error,
    /** True when this session is talking to the real agent runtime. */
    live,
  };
}
