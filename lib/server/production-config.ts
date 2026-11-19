import fs from 'node:fs';
import net from 'node:net';
import { dataDir } from './paths';

export type ConfigFinding = { key: string; message: string };
export type ProductionConfigReport = {
  strict: boolean;
  profile: string;
  errors: ConfigFinding[];
  warnings: ConfigFinding[];
};

const enabled = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true';
const present = (value: string | undefined) => Boolean(value?.trim());

function privatePublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1' || host.endsWith('.local')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(host)) return /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host);
  return false;
}

function validEmailList(value: string | undefined): boolean {
  const emails = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return emails.length > 0 && emails.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function secretFinding(errors: ConfigFinding[], env: NodeJS.ProcessEnv, key: string, label: string, required = true) {
  const value = env[key]?.trim() ?? '';
  if (!value && !required) return;
  if (value.length < 32) errors.push({ key, message: `${label} must be set to at least 32 unpredictable characters.` });
}

function paired(errors: ConfigFinding[], env: NodeJS.ProcessEnv, left: string, right: string, label: string) {
  if (present(env[left]) !== present(env[right])) errors.push({ key: `${left}/${right}`, message: `${label} must be configured as a complete pair.` });
}

function validDocumentKey(value: string | undefined) {
  const raw = value?.trim() ?? '';
  if (/^[a-f0-9]{64}$/i.test(raw)) return true;
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch {
    return false;
  }
}

function safeOptionalRemote(errors: ConfigFinding[], env: NodeJS.ProcessEnv, key: string) {
  const raw = env[key]?.trim();
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || privatePublicHost(url.hostname)) {
      errors.push({ key, message: 'Production override URLs must use public HTTPS, never a local/private test stub.' });
    }
  } catch {
    errors.push({ key, message: 'Must be a valid HTTPS URL.' });
  }
}

/** Validate deployment invariants without ever returning a secret value. */
export function productionConfigReport(env: NodeJS.ProcessEnv = process.env): ProductionConfigReport {
  const strict = enabled(env.VOXERA_STRICT_CONFIG);
  const profile = env.VOXERA_PRODUCTION_PROFILE?.trim() || 'generic';
  const errors: ConfigFinding[] = [];
  const warnings: ConfigFinding[] = [];

  if (env.NODE_ENV !== 'production') warnings.push({ key: 'NODE_ENV', message: 'The process is not using production mode.' });

  try {
    const publicUrl = new URL(env.VOXERA_PUBLIC_URL ?? '');
    if (publicUrl.protocol !== 'https:' || privatePublicHost(publicUrl.hostname)) {
      errors.push({ key: 'VOXERA_PUBLIC_URL', message: 'Must be the externally reachable public HTTPS origin.' });
    }
    if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      errors.push({ key: 'VOXERA_PUBLIC_URL', message: 'Must be an origin only, without a path, query or fragment.' });
    }
  } catch {
    errors.push({ key: 'VOXERA_PUBLIC_URL', message: 'Must be a valid externally reachable HTTPS origin.' });
  }

  const store = env.VOXERA_STORE?.trim();
  if (!['postgres', 'sqlite'].includes(String(store))) {
    errors.push({ key: 'VOXERA_STORE', message: 'Set the production store explicitly to postgres or sqlite; JSON is single-process recovery only.' });
  }
  if (profile === 'dokploy' && store !== 'postgres') {
    errors.push({ key: 'VOXERA_STORE', message: 'The Dokploy production profile requires PostgreSQL.' });
  }
  if (store === 'postgres') {
    try {
      const database = new URL(env.DATABASE_URL ?? '');
      if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)) throw new Error('invalid');
    } catch {
      errors.push({ key: 'DATABASE_URL', message: 'PostgreSQL requires a valid postgresql:// connection URL with a host and database name.' });
    }
  }

  secretFinding(errors, env, 'VOXERA_SECRET_KEY', 'The credential-encryption key');
  secretFinding(errors, env, 'VOXERA_MANAGE_SECRET', 'The client-link signing key');
  secretFinding(errors, env, 'VOXERA_DEMO_SECRET', 'The demo-token signing key');
  secretFinding(errors, env, 'VOXERA_MEDIA_SECRET', 'The media-token signing key', enabled(env.VOXERA_REQUIRE_MEDIA));

  const clinicalApproval = env.VOXERA_CLINICAL_DATA_APPROVED?.trim() === '1';
  if (present(env.VOXERA_CLINICAL_DATA_APPROVED) && !['0', '1'].includes(String(env.VOXERA_CLINICAL_DATA_APPROVED).trim())) {
    errors.push({ key: 'VOXERA_CLINICAL_DATA_APPROVED', message: 'Use exactly 0 or 1. Keep 0 until every workspace and deployment readiness gate passes.' });
  }
  const documentKeyValid = validDocumentKey(env.VOXERA_DOCUMENT_MASTER_KEY);
  if (present(env.VOXERA_DOCUMENT_MASTER_KEY) && !documentKeyValid) {
    errors.push({ key: 'VOXERA_DOCUMENT_MASTER_KEY', message: 'The document master key must be exactly 32 bytes (64 hex characters or canonical base64).' });
  }
  const blobBackend = env.VOXERA_BLOB_BACKEND?.trim().toLowerCase() || 'filesystem';
  if (!['filesystem', 's3'].includes(blobBackend)) {
    errors.push({ key: 'VOXERA_BLOB_BACKEND', message: 'Supported document blob backends are `filesystem` and `s3`.' });
  }
  const s3Keys = ['VOXERA_S3_ENDPOINT', 'VOXERA_S3_BUCKET', 'VOXERA_S3_ACCESS_KEY_ID', 'VOXERA_S3_SECRET_ACCESS_KEY'] as const;
  const s3Present = s3Keys.filter((key) => present(env[key]));
  if ((s3Present.length > 0 || blobBackend === 's3') && s3Present.length !== s3Keys.length) {
    errors.push({ key: 'VOXERA_S3_*', message: 'S3-compatible document storage requires endpoint, bucket, access key and secret key together.' });
  }
  safeOptionalRemote(errors, env, 'VOXERA_S3_ENDPOINT');
  if (present(env.VOXERA_DOCUMENT_MAX_BYTES)) {
    const bytes = Number(env.VOXERA_DOCUMENT_MAX_BYTES);
    if (!Number.isInteger(bytes) || bytes < 1_048_576 || bytes > 100 * 1_048_576) {
      errors.push({ key: 'VOXERA_DOCUMENT_MAX_BYTES', message: 'Document maximum bytes must be an integer from 1 MiB through 100 MiB.' });
    }
  }
  if (present(env.VOXERA_MALWARE_SCAN_ARGS_JSON)) {
    try {
      const args = JSON.parse(String(env.VOXERA_MALWARE_SCAN_ARGS_JSON));
      if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) throw new Error('invalid');
    } catch {
      errors.push({ key: 'VOXERA_MALWARE_SCAN_ARGS_JSON', message: 'Scanner arguments must be a JSON string array.' });
    }
  }
  const scannerCommand = env.VOXERA_MALWARE_SCAN_COMMAND?.trim() ?? '';
  if (/\s/.test(scannerCommand)) {
    errors.push({ key: 'VOXERA_MALWARE_SCAN_COMMAND', message: 'Use one executable path/name without arguments; put arguments in VOXERA_MALWARE_SCAN_ARGS_JSON.' });
  }
  if (/(^|[/\\])(true|false)(\.exe)?$/i.test(scannerCommand)) {
    errors.push({ key: 'VOXERA_MALWARE_SCAN_COMMAND', message: 'A test binary is not a production malware scanner.' });
  }
  if (clinicalApproval) {
    if (store !== 'postgres') errors.push({ key: 'VOXERA_CLINICAL_DATA_APPROVED', message: 'Real clinical data requires PostgreSQL.' });
    if (!documentKeyValid && !present(env.VOXERA_DOCUMENT_MASTER_KEY)) errors.push({ key: 'VOXERA_DOCUMENT_MASTER_KEY', message: 'Real clinical data requires a separately managed 32-byte document key.' });
    if (blobBackend !== 's3' || s3Present.length !== s3Keys.length) {
      errors.push({ key: 'VOXERA_BLOB_BACKEND', message: 'Real clinical data requires complete S3-compatible encrypted object storage; filesystem is test-only.' });
    }
    if (!scannerCommand) errors.push({ key: 'VOXERA_MALWARE_SCAN_COMMAND', message: 'Real clinical data requires a deployed scanner; each workspace must also hold recent clean/infected scan evidence.' });
  }

  if (!validEmailList(env.VOXERA_OPERATOR_EMAILS)) {
    errors.push({ key: 'VOXERA_OPERATOR_EMAILS', message: 'Configure at least one valid, explicit platform-operator email.' });
  }
  if (!enabled(env.VOXERA_TRUST_PROXY)) {
    errors.push({ key: 'VOXERA_TRUST_PROXY', message: 'TLS-terminating Dokploy/Traefik deployments must explicitly trust their proxy.' });
  }
  const hops = Number(env.VOXERA_TRUST_PROXY_HOPS ?? 1);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    errors.push({ key: 'VOXERA_TRUST_PROXY_HOPS', message: 'Trusted proxy hops must be an integer from 1 to 10.' });
  }

  for (const key of ['VOXERA_MEDIA_SIMULATE', 'VOXERA_ALLOW_PRIVATE_OUTBOUND', 'VOXERA_ALLOW_UNSIGNED_TELEPHONY', 'VOXERA_ENABLE_TEST_ENDPOINTS']) {
    if (enabled(env[key])) errors.push({ key, message: 'This test/development switch must be disabled in production.' });
  }

  paired(errors, env, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'Twilio fallback credentials');
  paired(errors, env, 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'Stripe settlement and webhook verification');
  paired(errors, env, 'VOXERA_EMAIL_API_BASE', 'VOXERA_EMAIL_API_KEY', 'The email relay URL and key');
  const emailProvider = env.VOXERA_EMAIL_PROVIDER?.trim().toLowerCase();
  if (emailProvider && !['relay', 'resend'].includes(emailProvider)) {
    errors.push({ key: 'VOXERA_EMAIL_PROVIDER', message: 'Supported email providers are `relay` and `resend`.' });
  }
  if (emailProvider && (!present(env.VOXERA_EMAIL_API_BASE) || !present(env.VOXERA_EMAIL_API_KEY))) {
    errors.push({ key: 'VOXERA_EMAIL_PROVIDER', message: 'Selecting an email provider requires its API base and key.' });
  }
  if (emailProvider === 'resend') {
    secretFinding(errors, env, 'RESEND_WEBHOOK_SECRET', 'The Resend webhook signing secret');
  }
  if (present(env.VOXERA_EMAIL_API_KEY) && !present(env.VOXERA_EMAIL_FROM)) {
    errors.push({ key: 'VOXERA_EMAIL_FROM', message: 'A configured email relay requires an explicit From address.' });
  }
  if (present(env.VOXERA_EMAIL_API_BASE)) {
    try {
      const emailBase = new URL(String(env.VOXERA_EMAIL_API_BASE));
      if (emailBase.hostname === 'api.resend.com' && emailProvider !== 'resend') {
        errors.push({ key: 'VOXERA_EMAIL_PROVIDER', message: 'The Resend API requires VOXERA_EMAIL_PROVIDER=resend so metadata is translated to supported tags.' });
      }
      if (emailProvider === 'resend' && (emailBase.origin !== 'https://api.resend.com' || emailBase.pathname !== '/')) {
        errors.push({ key: 'VOXERA_EMAIL_API_BASE', message: 'The direct Resend adapter requires exactly https://api.resend.com.' });
      }
    } catch {
      // safeOptionalRemote below reports malformed URLs once.
    }
  }
  for (const key of ['TWILIO_API_BASE', 'ANTHROPIC_API_BASE', 'STRIPE_API_BASE', 'VOXERA_EMAIL_API_BASE']) safeOptionalRemote(errors, env, key);

  if (
    enabled(env.VOXERA_REQUIRE_AI) &&
    !['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GEMINI_API_KEY'].some((key) => present(env[key]))
  ) {
    errors.push({ key: 'VOXERA_REQUIRE_AI', message: 'The deployment requires AI but no implemented model-provider key is configured.' });
  }
  if (enabled(env.VOXERA_REQUIRE_MEDIA)) {
    if (!present(env.DEEPGRAM_API_KEY)) {
      errors.push({ key: 'VOXERA_REQUIRE_MEDIA', message: 'Required live carrier media needs DEEPGRAM_API_KEY for streaming speech-to-text. Batch transcription keys do not satisfy this check.' });
    }
    if (!['ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY'].some((key) => present(env[key]))) {
      errors.push({ key: 'VOXERA_REQUIRE_MEDIA', message: 'Required live media needs a supported text-to-speech key (ElevenLabs, OpenAI or Cartesia).' });
    }
  }

  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.accessSync(dataDir(), fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    errors.push({ key: 'VOXERA_DATA_DIR', message: 'The operational data directory must exist and be readable/writable by the app user.' });
  }

  if (!strict) warnings.push({ key: 'VOXERA_STRICT_CONFIG', message: 'Strict production startup validation is disabled.' });
  return { strict, profile, errors, warnings };
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfigReport {
  const report = productionConfigReport(env);
  if (!report.strict) return report;
  if (report.errors.length) {
    const detail = report.errors.map((finding) => `  - ${finding.key}: ${finding.message}`).join('\n');
    throw new Error(`strict production configuration refused startup:\n${detail}`);
  }
  return report;
}
