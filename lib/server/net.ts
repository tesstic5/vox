/**
 * Outbound URL policy.
 *
 * Webhook subscriptions and a few other places accept a URL from a customer and
 * then make the server fetch it. That is the classic SSRF shape: `http://127.0.0.1`
 * reaches our own API, `http://169.254.169.254` reaches cloud metadata, and a
 * hostname that resolves to a private address does the same thing without
 * looking like it. A redirect can turn an allowed public URL into a private one
 * after the check has already passed.
 *
 * So there is exactly one gate — `guardUrl` — and one fetch that uses it per
 * hop: `safeFetch`. Every delivery path goes through it.
 *
 * Local development needs loopback (the demo webhook receiver, the stub
 * carriers), so `VOXERA_ALLOW_PRIVATE_OUTBOUND=1` opts out of the private-address
 * rule for a self-hosted demo. Protocol, credential-in-URL and redirect rules
 * still apply. Never set it on a public deployment.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export type UrlPolicy = 'allowed' | 'blocked';

export type UrlVerdict = {
  policy: UrlPolicy;
  /** Why it was blocked, in words a customer can act on. */
  reason?: string;
};

function allowPrivate() {
  return process.env.VOXERA_ALLOW_PRIVATE_OUTBOUND === '1';
}

function isIpLiteral(hostname: string) {
  return net.isIP(hostname) !== 0;
}

/** Private, loopback, link-local, CGNAT, multicast, reserved — everything a public endpoint is not. */
export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return false;
}

/**
 * Decides whether this deployment may POST to `raw`.
 *
 * Resolution is part of the check: a public-looking hostname that resolves to
 * 10.0.0.5 is blocked. DNS failures are treated as blocked — an endpoint that
 * does not resolve is not a deliverable endpoint.
 */
export async function guardUrl(raw: string): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { policy: 'blocked', reason: 'not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { policy: 'blocked', reason: `unsupported protocol ${url.protocol.replace(':', '')} — use http or https` };
  }
  if (url.username || url.password) {
    return { policy: 'blocked', reason: 'credentials in the URL are not accepted' };
  }
  if (allowPrivate()) return { policy: 'allowed' };

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(hostname)) {
    return isPrivateAddress(hostname)
      ? { policy: 'blocked', reason: `${hostname} is a private or loopback address` }
      : { policy: 'allowed' };
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname)) {
    return { policy: 'blocked', reason: `${hostname} resolves locally` };
  }
  let addresses: string[];
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch {
    return { policy: 'blocked', reason: `${hostname} does not resolve` };
  }
  if (!addresses.length) return { policy: 'blocked', reason: `${hostname} does not resolve` };
  const privateOne = addresses.find((a) => isPrivateAddress(a));
  if (privateOne) return { policy: 'blocked', reason: `${hostname} resolves to a private address (${privateOne})` };
  return { policy: 'allowed' };
}

export class UrlBlockedError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`Outbound request blocked: ${reason}`);
    this.reason = reason;
  }
}

/**
 * `fetch` that validates the URL, follows redirects by hand, and validates each
 * hop — so a 302 into the private network is refused rather than followed.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { maxRedirects?: number } = {}
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = init.maxRedirects ?? 3;
  let url = raw;
  let init2 = init;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const verdict = await guardUrl(url);
    if (verdict.policy === 'blocked') throw new UrlBlockedError(verdict.reason ?? 'blocked by URL policy');
    const response = await fetch(url, { ...init2, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, finalUrl: url };
    }
    // A 303 (and 301/302 in practice) becomes a GET.
    url = new URL(location, url).toString();
    if (response.status === 303) init2 = { ...init2, method: 'GET', body: undefined };
    await response.arrayBuffer().catch(() => undefined); // drain before leaving the hop
  }
  throw new UrlBlockedError('too many redirects');
}
