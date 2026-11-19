/**
 * The secret behind media-stream handshake tokens.
 *
 * `mintMediaToken` signs a call id for the carrier's WebSocket, and the worker
 * verifies the signature before it accepts audio. If that secret falls back to a
 * well-known default on a public deployment, anyone who can reach the media path
 * can forge a token for any call id and inject audio into a live call.
 *
 * So the fallback exists only outside production. In production the secret must
 * be set (`VOXERA_MEDIA_SECRET`); when it is missing the deployment does not
 * pretend otherwise — no tokens are minted, the worker rejects every handshake,
 * and call answering falls back to the carrier's own speech recognition, which
 * needs no secret. The boot log says so explicitly.
 */

const DEV_FALLBACK = 'dev-media-secret';

export function mediaSecret(): string | null {
  const configured = process.env.VOXERA_MEDIA_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV !== 'production') return DEV_FALLBACK;
  return null;
}

export function mediaSigningAvailable(): boolean {
  return mediaSecret() !== null;
}
