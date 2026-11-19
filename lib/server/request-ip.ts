import net from 'node:net';

/** Remove IPv4-mapped IPv6 notation while keeping real IPv6 addresses intact. */
export function normalizeIp(value: string | undefined | null): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const unwrapped = raw.startsWith('[') && raw.includes(']') ? raw.slice(1, raw.indexOf(']')) : raw;
  const mapped = unwrapped.startsWith('::ffff:') ? unwrapped.slice(7) : unwrapped;
  return net.isIP(mapped) ? mapped : undefined;
}

/**
 * Resolve a client address at the one boundary that can see the TCP peer.
 *
 * Forwarding headers are attacker-controlled unless the app port is reachable
 * only through a trusted proxy. When trust is disabled they are ignored. When it
 * is enabled, select from the right-hand side of X-Forwarded-For according to the
 * configured trusted proxy hop count; this prevents a client-prepended fake
 * address becoming the rate-limit identity.
 */
export function resolvedClientIp(input: {
  directAddress?: string | null;
  forwardedFor?: string | null;
  realIp?: string | null;
  trustProxy: boolean;
  trustedHops?: number;
}): string {
  const direct = normalizeIp(input.directAddress) ?? '127.0.0.1';
  if (!input.trustProxy) return direct;

  const chain = String(input.forwardedFor ?? '')
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part): part is string => Boolean(part));
  const hops = Math.max(1, Math.min(10, Math.floor(Number(input.trustedHops ?? 1) || 1)));
  const selected = chain[chain.length - hops];
  return selected ?? normalizeIp(input.realIp) ?? direct;
}
