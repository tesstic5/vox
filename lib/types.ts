export type ProviderKey = 'openai' | 'anthropic' | 'google' | 'groq' | 'deepseek' | 'mistral';
export type SttKey = 'deepgram';
export type TtsKey = 'elevenlabs' | 'cartesia' | 'openai-tts';
export type TelephonyKey = 'twilio' | 'sandbox';

export interface Voice {
  id: string;
  name: string;
  provider: TtsKey;
  gender: 'feminine' | 'masculine' | 'neutral';
  accent: string;
  age: 'young' | 'middle' | 'mature';
  description: string;
  tags: string[];
}

export interface ModelOption {
  id: string;
  label: string;
  provider: ProviderKey;
  context: string;
  latency: 'ultra-low' | 'low' | 'medium' | 'unknown';
  inputCost: number;
  outputCost: number;
  strengths: string[];
}

export interface TranscriberOption {
  id: string;
  label: string;
  provider: SttKey;
  languages: string;
  costPerMin: number;
  latencyMs: number;
  streaming: boolean;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  type: 'apiRequest' | 'transferCall' | 'endCall' | 'dtmf' | 'query' | 'handoff';
  parameters: { name: string; type: string; description: string; required: boolean }[];
  url?: string;
  /** Server-held tools describe themselves as `method` + `endpoint` instead. */
  endpoint?: string;
  method?: string;
}

export interface Assistant {
  id: string;
  name: string;
  firstMessage: string;
  systemPrompt: string;
  model: string;
  /**
   * Which provider serves `model`. `custom` means the workspace's own endpoint
   * (Dashboard → Providers → any OpenAI-compatible URL), resolved at call time.
   */
  provider?: string;
  temperature: number;
  transcriber: string;
  voiceId: string;
  language: string;
  maxTokens: number;
  tools: string[];
  /** Literal factual snippets searched by the runtime. */
  knowledge?: string[];
  analysisSummaryPrompt: string;
  analysisSuccessPrompt: string;
  analysisStructuredData: { key: string; type: 'string' | 'number' | 'boolean'; description: string }[];
  serverUrl: string;
  serverUrlSecret: string;
  backgroundSound: 'off' | 'office' | 'call-center';
  backchanneling: boolean;
  fillerInjection: boolean;
  voicemailDetection: boolean;
  endCallPhrases: string[];
  silenceTimeoutSeconds: number;
  responseDelaySeconds: number;
  interruptSensitivity: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
  status: 'published' | 'draft';
  template: string;
  /** Tool names this assistant may call, across every registered MCP server. */
  mcpAllowlist?: string[];
}

export interface TranscriptTurn {
  role: 'assistant' | 'user' | 'system' | 'tool';
  text: string;
  at: number;
  seconds: number;
}

export interface Call {
  id: string;
  assistantId: string;
  assistantName: string;
  type: 'inbound' | 'outbound' | 'web';
  status: 'ended' | 'in-progress' | 'queued' | 'failed';
  endedReason:
    | 'customer-ended-call'
    | 'assistant-ended-call'
    | 'assistant-forwarded-call'
    | 'silence-timeout'
    | 'max-duration-exceeded'
    | 'error'
    | 'voicemail'
    | 'customer-busy'
    | 'assistant-error';
  from: string;
  to: string;
  startedAt: string;
  durationSeconds: number;
  cost: { platform: number; stt: number; tts: number; llm: number; telephony: number; total: number };
  costSource?: 'provider_import' | 'operator';
  transcript: TranscriptTurn[];
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
    ms: number;
    status: 'ok' | 'error';
    source?: 'endpoint' | 'builtin';
  }>;
  recordingUrl: string | null;
  analysis: {
    summary: string;
    successEvaluation: 'true' | 'false' | 'not_evaluated';
    sentiment: 'positive' | 'neutral' | 'negative';
    intent: string;
    structuredData: Record<string, string | number | boolean>;
    score: number;
    evaluationSource?: 'rubric' | 'human';
  };
  metrics: { latencyMs: number; interruptions: number; turns: number };
  customer: { name: string; number: string; company?: string };
  source?: string;
  bookingId?: string;
}

export interface PhoneNumber {
  id: string;
  number: string;
  label: string;
  provider: TelephonyKey;
  assistantId: string | null;
  country: string;
  areaCode: string;
  status: 'active' | 'provisioning' | 'released' | 'sandbox';
  monthlyCost: number;
  monthlyCostSource?: 'carrier_response' | 'operator';
  inboundCalls30d: number;
  createdAt: string;
  squadId?: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  assistantId: string;
  phoneNumberId: string;
  status: 'running' | 'paused' | 'completed' | 'draft' | 'scheduled';
  totalCustomers: number;
  attempted: number;
  connected: number;
  interested: number;
  startedAt: string;
  schedule: string;
}

export interface Squad {
  id: string;
  name: string;
  members: { assistantId: string; role: string; condition: string }[];
  createdAt: string;
}

/**
 * An API key as the *page* sees it, from either of the two places a row can come
 * from: one created in this browser (the secret is in memory) or one read back
 * from `/api/v1/keys`, which returns a hash and its last four characters and
 * never the secret again. The optional fields are that second shape — they are
 * what stops a key read back from the server rendering as `undefined`.
 */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  /** Only ever populated for a key created in this browser session. */
  secret?: string;
  /** The four characters the server keeps in the clear, for display. */
  last4?: string;
  scope?: 'public' | 'private';
  /** What the server records instead of `scope`: the capabilities granted. */
  scopes?: string[];
  createdAt: string;
  lastUsed?: string | null;
  /** The server's name for the same fact `lastUsed` carries locally. */
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  orgId: string;
}

export interface SimulationRun {
  id: string;
  name: string;
  assistantId: string;
  assistantName: string;
  scenario: string;
  status: 'passed' | 'failed' | 'running' | 'queued';
  score: number;
  turns: number;
  durationSeconds: number;
  startedAt: string;
  persona: string;
  failureReason?: string;
  transcript: TranscriptTurn[];
}

export interface LogEntry {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  status: number;
  latencyMs: number;
  at: string;
  requestBody?: string;
  responseBody?: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  avatarColor: string;
  lastActive: string;
  status: 'active' | 'invited';
}

/* ------------------------------------------------------------- workflows */

export type WorkflowNodeKind =
  | 'start'
  | 'prompt'
  | 'dtmf'
  | 'api'
  | 'branch'
  | 'validate'
  | 'transfer'
  | 'end';

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  x: number;
  y: number;
  /** Prompt text, DTMF question, or API description depending on `kind`. */
  text: string;
  /** DTMF: digit count; validate: pattern; api: method. */
  config: {
    digits?: number;
    pattern?: string;
    method?: 'GET' | 'POST' | 'PATCH';
    url?: string;
    timeoutMs?: number;
    retry?: 'none' | 'once' | 'twice';
    /** What happens when this node fails — empty string means "not set". */
    onError?: string;
    /** Variable written by this node, readable downstream. */
    writes?: string;
  };
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  /** Branch condition, or '' for the default path. */
  label: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  assistantId: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  status: 'draft' | 'staged' | 'published';
  version: string;
  createdAt: string;
  updatedAt: string;
  /** Template it was created from, if any. */
  template?: string;
}

export type WorkflowIssue = {
  nodeId: string | null;
  severity: 'error' | 'warning';
  message: string;
};

/* ------------------------------------------------- providers & credentials */

export type Capability = 'llm' | 'stt' | 'tts' | 'telephony';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  capability: Capability;
  glyph: string;
  envVar: string;
  keyPrefix: string;
  docs: string;
  regions: string[];
  pricing: string;
  note: string;
}

export interface Credential {
  id: string;
  providerId: string;
  label: string;
  /** Masked on the server; the dashboard only ever sees this form. */
  maskedKey: string;
  region: string;
  status: 'active' | 'untested' | 'failing';
  lastTested: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface ProviderSettings {
  credentials: Credential[];
  /** Managed (we bill at cost + platform) or byok (you pay the provider). */
  modes: Record<Capability, 'managed' | 'byok'>;
  /** Failover order per capability, by provider id. */
  chains: Record<Capability, string[]>;
}

/* ---------------------------------------------------------------- MCP */

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpRisk = 'read' | 'write' | 'destructive';

export interface McpTool {
  name: string;
  description: string;
  risk: McpRisk;
  args: number;
  /** Schema freshness, in seconds, as the runtime caches it. */
  cacheSeconds?: number;
}

export interface McpServerSeed {
  slug: string;
  name: string;
  transport: McpTransport;
  url: string;
  authType: string;
  note: string;
  tools: McpTool[];
}

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  url: string;
  authType: string;
  status: 'connected' | 'connecting' | 'error';
  tools: McpTool[];
  lastSync: string;
  latencyMs: number;
  /** Optional per-server health note, shown when status is error. */
  healthNote?: string;
}

/* --------------------------------------------------------------- widget */

export interface WidgetConfig {
  assistantId: string;
  mode: 'popup' | 'inline';
  position: 'bottom-right' | 'bottom-left';
  launcherLabel: string;
  greeting: string;
  brandColor: string;
  theme: 'dark' | 'light';
  voiceEnabled: boolean;
  showTranscript: boolean;
  escalationCta: string;
}

/* --------------------------------------------------------------- batches */

export type BatchDisposition =
  | 'pending'
  | 'connected'
  | 'no-answer'
  | 'voicemail'
  | 'completed'
  | 'skipped'
  | 'dnc'
  | 'failed';

export interface BatchRow {
  id: string;
  phone: string;
  name: string;
  fields: Record<string, string>;
  disposition: BatchDisposition;
  outcome?: string;
  durationSeconds?: number;
  at?: string;
}

export interface BatchJob {
  id: string;
  name: string;
  assistantId: string;
  phoneNumberId: string;
  status: 'draft' | 'running' | 'paused' | 'completed';
  rows: BatchRow[];
  /** Campaign-level guardrails, enforced by the dialler rather than the prompt. */
  settings: {
    concurrency: number;
    attemptBudget: number;
    quietHours: string;
    timeZoneMode: 'contact-local' | 'account-timezone';
    dncCheck: boolean;
    voicemailAction: 'hang-up' | 'leave-message';
  };
  createdAt: string;
  startedAt: string | null;
}

/* ----------------------------------------------------------------- evals */

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  /** Relative weight; normalised to 100 when scoring. */
  weight: number;
  passCondition: string;
}

export interface Rubric {
  id: string;
  name: string;
  assistantId: string | null;
  version: string;
  criteria: RubricCriterion[];
  createdAt: string;
  updatedAt: string;
}

export interface CriterionScore {
  criterionId: string;
  name: string;
  score: number;
  passed: boolean;
  reasoning: string;
}

export interface EvalReview {
  id: string;
  callId: string;
  assistantName: string;
  rubricId: string;
  rubricVersion: string;
  summary: string;
  overall: number;
  status: 'auto' | 'needs-review' | 'confirmed' | 'overridden';
  criteria: CriterionScore[];
  humanVerdict?: 'pass' | 'fail';
  humanNote?: string;
  reviewer?: string;
  reviewedAt?: string;
  flaggedReason?: string;
}

/* --------------------------------------------------------- observability */

export interface AlertRule {
  id: string;
  name: string;
  metric: 'latency-p90' | 'error-rate' | 'containment' | 'cost-per-call' | 'concurrency' | 'stt-confidence';
  /** Burn-rate style window, e.g. '1h @ 14.4x'. */
  window: string;
  threshold: string;
  severity: 'critical' | 'warning' | 'info';
  channels: string[];
  muted: boolean;
  lastFired: string | null;
  fires30d: number;
}

/* --------------------------------------------------------------- billing */

export interface Invoice {
  id: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueAt: string;
  status: 'paid' | 'open' | 'draft' | 'overdue';
  platformMinutes: number;
  platformAmount: number;
  providerAmount: number;
  telephonyAmount: number;
  concurrencyLines: number;
  addons: { name: string; amount: number; note: string }[];
  total: number;
}

/* --------------------------------------------------- orgs, roles, audit */

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  region: string;
  members: number;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}

export interface Invite {
  id: string;
  email: string;
  role: 'admin' | 'developer' | 'viewer';
  invitedBy: string;
  sentAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
}

export type PermissionId =
  | 'assistants.write'
  | 'assistants.publish'
  | 'calls.read'
  | 'transcripts.read'
  | 'numbers.manage'
  | 'campaigns.launch'
  | 'keys.manage'
  | 'billing.read'
  | 'billing.manage'
  | 'members.manage'
  | 'audit.read'
  | 'settings.write';

export interface RoleDefinition {
  id: 'owner' | 'admin' | 'developer' | 'viewer' | 'custom';
  name: string;
  description: string;
  permissions: Record<PermissionId, boolean>;
  system: boolean;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  actorEmail: string;
  action: string;
  kind: 'auth' | 'config' | 'data' | 'billing' | 'security' | 'export';
  target: string;
  ip: string;
  detail: string;
}

/* --------------------------------------------------------- notifications */

export interface Notification {
  id: string;
  title: string;
  body: string;
  kind: 'call' | 'alert' | 'billing' | 'security' | 'product' | 'review';
  at: string;
  read: boolean;
  href?: string;
}

export interface NotificationPrefs {
  emailAlerts: boolean;
  emailDailyDigest: boolean;
  emailWeeklySummary: boolean;
  inAppCallFailures: boolean;
  inAppEvalQueue: boolean;
  inAppProduct: boolean;
  quietHours: string;
  slackWebhook: string;
}

/* ------------------------------------------------- onboarding & assets */

export interface OnboardingState {
  steps: Record<string, boolean>;
  dismissed: boolean;
  startedAt: string;
}

export interface AssetFile {
  id: string;
  name: string;
  kind: 'recording' | 'knowledge' | 'export' | 'document';
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
  status: 'ready' | 'processing' | 'expired';
  callId?: string;
  uploadedBy: string;
}

/* ------------------------------------------------- auth & account security */

export type TwoFactorMethod = 'totp' | 'sms' | 'webauthn';

export interface TwoFactorState {
  enabled: boolean;
  method: TwoFactorMethod | null;
  enrolledAt: string | null;
  recoveryCodes: string[];
  codesRemaining: number;
  enforcedByOrg: boolean;
}

export interface AuthSession {
  id: string;
  device: string;
  browser: string;
  ip: string;
  location: string;
  /** ISO timestamp of the last request from this session. */
  lastActive: string;
  current: boolean;
}

export interface SsoDomain {
  domain: string;
  verified: boolean;
  addedAt: string;
}

export interface SsoConfig {
  enforced: boolean;
  provider: string | null;
  protocol: 'saml' | 'oidc' | null;
  domains: SsoDomain[];
  scim: boolean;
  /** ISO timestamp of the last successful assertion. */
  lastAssertionAt: string | null;
}

export interface SecurityState {
  twoFactor: TwoFactorState;
  sessions: AuthSession[];
  sso: SsoConfig;
  passwordChangedAt: string;
  lastLogin: { at: string; ip: string; location: string };
}

export interface NumberConfig {
  whisperMessage: string;
  recordingConsent: boolean;
  voicemailDetection: boolean;
  failoverNumberId: string | null;
  sipTrunkId: string | null;
  webhookUrl: string;
  webhookEvents: string[];
  maxCallSeconds: number;
  allowedCountries: string[];
  notes: string;
}
