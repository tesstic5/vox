import { productionConfigReport } from '../lib/server/production-config';

const report = productionConfigReport();
console.log(`production profile: ${report.profile}`);
console.log(`strict validation: ${report.strict ? 'enabled' : 'disabled'}`);
for (const finding of report.warnings) console.log(`warning ${finding.key}: ${finding.message}`);
for (const finding of report.errors) console.error(`error ${finding.key}: ${finding.message}`);
if (!report.strict) {
  console.error('error VOXERA_STRICT_CONFIG: set VOXERA_STRICT_CONFIG=1 for a production release check.');
  process.exit(1);
}
if (report.errors.length) process.exit(1);
console.log('production configuration is valid');

/** The final real-clinical-data switch may never turn incomplete document
 * infrastructure into an accepted production configuration. Workspace-level
 * readiness still separately requires recent scanner and independent evidence. */
const clinicalBase: NodeJS.ProcessEnv = { ...process.env, VOXERA_CLINICAL_DATA_APPROVED: '1' };
for (const key of [
  'VOXERA_DOCUMENT_MASTER_KEY', 'VOXERA_BLOB_BACKEND', 'VOXERA_S3_ENDPOINT', 'VOXERA_S3_BUCKET',
  'VOXERA_S3_ACCESS_KEY_ID', 'VOXERA_S3_SECRET_ACCESS_KEY', 'VOXERA_MALWARE_SCAN_COMMAND', 'VOXERA_MALWARE_SCAN_ARGS_JSON',
]) delete clinicalBase[key];
const incompleteClinical = productionConfigReport(clinicalBase);
const blockedClinicalKeys = new Set(incompleteClinical.errors.map((finding) => finding.key));
if (!['VOXERA_DOCUMENT_MASTER_KEY', 'VOXERA_BLOB_BACKEND', 'VOXERA_MALWARE_SCAN_COMMAND'].every((key) => blockedClinicalKeys.has(key))) {
  console.error('error clinical config: the final clinical-data switch accepted incomplete document infrastructure.');
  process.exit(1);
}
console.log('clinical config: incomplete live document infrastructure is refused');

const completeClinicalEnv: NodeJS.ProcessEnv = {
  ...clinicalBase,
  VOXERA_DOCUMENT_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  VOXERA_BLOB_BACKEND: 's3',
  VOXERA_S3_ENDPOINT: 'https://synthetic-account.r2.cloudflarestorage.com',
  VOXERA_S3_REGION: 'auto',
  VOXERA_S3_BUCKET: 'synthetic-private-clinical-documents',
  VOXERA_S3_ACCESS_KEY_ID: 'synthetic-access-key',
  VOXERA_S3_SECRET_ACCESS_KEY: 'synthetic-secret-key',
  VOXERA_MALWARE_SCAN_COMMAND: '/usr/bin/clamscan',
  VOXERA_MALWARE_SCAN_ARGS_JSON: '["--no-summary","{file}"]',
};
const completeClinical = productionConfigReport(completeClinicalEnv);
const clinicalKeys = new Set([
  'VOXERA_CLINICAL_DATA_APPROVED', 'VOXERA_DOCUMENT_MASTER_KEY', 'VOXERA_BLOB_BACKEND', 'VOXERA_S3_*',
  'VOXERA_S3_ENDPOINT', 'VOXERA_DOCUMENT_MAX_BYTES', 'VOXERA_MALWARE_SCAN_COMMAND', 'VOXERA_MALWARE_SCAN_ARGS_JSON',
]);
const completeClinicalErrors = completeClinical.errors.filter((finding) => clinicalKeys.has(finding.key));
if (completeClinicalErrors.length) {
  console.error(`error clinical config: complete live document configuration was refused: ${completeClinicalErrors.map((finding) => `${finding.key}: ${finding.message}`).join('; ')}`);
  process.exit(1);
}
console.log('clinical config: complete S3/key/scanner settings pass the deployment-level contract');

const fakeScanner = productionConfigReport({ ...completeClinicalEnv, VOXERA_MALWARE_SCAN_COMMAND: '/bin/true' });
if (!fakeScanner.errors.some((finding) => finding.key === 'VOXERA_MALWARE_SCAN_COMMAND' && finding.message.includes('test binary'))) {
  console.error('error clinical config: a test binary was accepted as a production malware scanner.');
  process.exit(1);
}
console.log('clinical config: test binaries cannot satisfy scanner configuration');

/**
 * Guard the live-media distinction that is easy to regress: OpenAI/Groq batch
 * transcription cannot make the bidirectional carrier stream ready. These
 * probes reuse the otherwise-valid environment supplied to this command.
 */
const mediaBase: NodeJS.ProcessEnv = {
  ...process.env,
  VOXERA_REQUIRE_MEDIA: '1',
  VOXERA_MEDIA_SECRET: 'ci-media-contract-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
};
for (const key of ['DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'CARTESIA_API_KEY']) {
  delete mediaBase[key];
}

const batchOnly = productionConfigReport({ ...mediaBase, OPENAI_API_KEY: 'sk-ci-batch-and-tts-key' });
const batchRefused = batchOnly.errors.some(
  (finding) => finding.key === 'VOXERA_REQUIRE_MEDIA' && finding.message.includes('DEEPGRAM_API_KEY'),
);
if (!batchRefused) {
  console.error('error media contract: a batch transcription key incorrectly satisfied live streaming STT.');
  process.exit(1);
}
console.log('media contract: batch transcription does not satisfy live STT');

const noVoice = productionConfigReport({ ...mediaBase, DEEPGRAM_API_KEY: 'dg-ci-streaming-key' });
const voiceRequired = noVoice.errors.some(
  (finding) => finding.key === 'VOXERA_REQUIRE_MEDIA' && finding.message.includes('text-to-speech'),
);
if (!voiceRequired) {
  console.error('error media contract: required media accepted no text-to-speech provider.');
  process.exit(1);
}
console.log('media contract: required live media also requires TTS');

const completeMedia = productionConfigReport({
  ...mediaBase,
  DEEPGRAM_API_KEY: 'dg-ci-streaming-key',
  OPENAI_API_KEY: 'sk-ci-model-and-tts-key',
});
const completeMediaErrors = completeMedia.errors.filter((finding) => finding.key === 'VOXERA_REQUIRE_MEDIA');
if (completeMediaErrors.length) {
  console.error(`error media contract: complete STT/TTS configuration was refused: ${completeMediaErrors.map((finding) => finding.message).join('; ')}`);
  process.exit(1);
}
console.log('media contract: Deepgram streaming plus an implemented TTS path is accepted');
