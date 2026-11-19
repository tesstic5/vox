/**
 * Security headers.
 *
 * The dashboard is a same-origin app: it loads no third-party scripts, styles or
 * fonts, and it talks to its own API. The policy below says exactly that, so an
 * injected `<script src="https://evil.example">` (or a data: document, or a
 * plugin) has nothing to load even if it reaches the HTML.
 *
 * Two deliberate allowances:
 *   - `'unsafe-inline'` on script-src: Next.js ships the RSC payload in inline
 *     script tags, and nonces would mean threading one through every render. The
 *     policy still blocks external and data: script origins, which is the part
 *     that matters for an injected tag.
 *   - `frame-ancestors` is same-origin in an ordinary deployment. The Arena
 *     sandbox adds its preview parent only while building inside that sandbox;
 *     other parents require an explicit validated deployment allowlist.
 */

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Who may frame the application.
 *
 * Ordinary production defaults to same-origin only. Arena's sandbox viewer needs
 * its own e2b.app parent while this repository is being reviewed, but that broad
 * development allowance must never travel into an unrelated deployment. Extra
 * parents are an explicit, whitespace-separated deployment setting and are
 * restricted to HTTPS origins (with an optional wildcard host).
 */
const configuredFrameAncestors = String(process.env.VOXERA_FRAME_ANCESTORS ?? '')
  .split(/\s+/)
  .map((value) => value.trim())
  .filter((value) => /^https:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(value));
const frameAncestors = ["'self'", ...(process.env.E2B_SANDBOX ? ['https://*.e2b.app'] : []), ...configuredFrameAncestors];

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The dashboard fetches its own API; the media path and HMR use websockets.
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${[...new Set(frameAncestors)].join(' ')}`,
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Ignored over plain HTTP, so the LAN demo on http://host:3000 is unaffected.
  { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
];
const publicFormPrivacyHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
  { key: 'Cache-Control', value: 'no-store, private' },
];
// Download/image responses must not inherit the app-shell policy, whose
// unsafe-inline allowance exists only for Next's RSC boot scripts. These paths
// are inert bytes or data and carry their own stricter route headers too.
const inertClinicalHeaders = [
  ...securityHeaders.filter((header) => !['Content-Security-Policy', 'Referrer-Policy'].includes(header.key)),
  { key: 'Content-Security-Policy', value: "default-src 'none'; style-src 'none'; sandbox" },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Constrained CI may run the same full `tsc --noEmit` gate immediately before
  // the build and then skip Next's duplicate checker. Production/default builds
  // remain fail-closed unless that explicit one-shot flag is present.
  typescript: { ignoreBuildErrors: process.env.VOXERA_BUILD_SKIP_TYPECHECK === '1' },
  // Keep production builds inside the 2 GB Dokploy/sandbox memory floor. The app
  // has many routes; unconstrained workers duplicate the compiler graph and can
  // be OOM-killed before compilation completes.
  experimental: {
    cpus: Math.max(1, Number(process.env.VOXERA_BUILD_CPUS ?? 1) || 1),
    staticGenerationMaxConcurrency: 1,
    staticGenerationMinPagesPerWorker: 1000,
    webpackMemoryOptimizations: true,
  },
  // The dev/preview proxy and local browser probes may use a host other than
  // localhost. This affects development assets/HMR only; production CSP and
  // frame-ancestor controls remain authoritative.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '*.e2b.app'],
  images: { unoptimized: true },
  // `better-sqlite3` is a native module: Next must require it at run time rather
  // than try to bundle the .node binary into the server chunks.
  serverExternalPackages: ['better-sqlite3', 'pg-native', 'libpq'],
  async headers() {
    // Duplicate response-header keys do not override reliably across a catch-all
    // and a specific Next rule. Exclude bearer/public clinical paths from the
    // ordinary referrer rule entirely, then give those paths one unambiguous
    // no-referrer policy.
    const privatePublicHeaders = [...securityHeaders.filter((header) => header.key !== 'Referrer-Policy'), ...publicFormPrivacyHeaders];
    return [
      { source: '/forms/:path*', headers: privatePublicHeaders },
      { source: '/refer/:path*', headers: privatePublicHeaders },
      { source: '/api/public/forms/:path*', headers: privatePublicHeaders },
      { source: '/api/public/referrals/:path*', headers: privatePublicHeaders },
      { source: '/api/v1/notes/:id/body-charts', headers: inertClinicalHeaders },
      { source: '/api/v1/body-chart-templates/:id/source', headers: inertClinicalHeaders },
      { source: '/:path((?!forms(?:/|$)|refer(?:/|$)|api/public/forms(?:/|$)|api/public/referrals(?:/|$)|api/v1/notes/[^/]+/body-charts(?:/|$)|api/v1/body-chart-templates/[^/]+/source(?:/|$)).*)', headers: securityHeaders },
    ];
  },
  // Keep retired marketing URLs useful without rendering a 200 page whose only
  // content is an RSC redirect. HTTP redirects are clearer to browsers, search
  // engines, link checkers and caches.
  async redirects() {
    const retired = [
      ['/ai-voice-agents', '/platform'],
      ['/blog', '/docs'],
      ['/blog/authors', '/docs'],
      ['/changelog', '/docs'],
      ['/cli', '/docs'],
      ['/compare', '/platform'],
      ['/creators', '/contact'],
      ['/custom-agents', '/platform'],
      ['/enhanced-security', '/security'],
      ['/glossary', '/docs'],
      ['/gpt-live-waitlist', '/platform'],
      ['/hackathon', '/contact'],
      ['/industries', '/solutions'],
      ['/integrations', '/platform'],
      ['/library', '/docs'],
      ['/partnerships', '/contact'],
      ['/playbook', '/docs'],
      ['/sales', '/contact'],
      ['/single-prompt', '/platform'],
      ['/startups', '/pricing'],
      ['/templates', '/dashboard/assistants/new'],
      ['/trust', '/security'],
      ['/trust/questionnaire', '/security'],
      ['/twist', '/platform'],
      ['/vapicon', '/'],
      ['/vapicon-2026-speaker-submissions', '/'],
      ['/vapicon/speakers', '/'],
      ['/blog/:path+', '/docs'],
      ['/careers/:path+', '/careers'],
      ['/changelog/:path+', '/docs'],
      ['/compare/:path+', '/platform'],
      ['/customers/:path+', '/customers'],
      ['/docs/:path+', '/docs'],
      ['/glossary/:path+', '/docs'],
      ['/industries/:path+', '/solutions'],
      ['/integrations/:path+', '/platform'],
      ['/legal/:path+', '/legal'],
      ['/solutions/:path+', '/solutions'],
      ['/templates/:path+', '/dashboard/assistants/new'],
    ];
    return retired.map(([source, destination]) => ({ source, destination, permanent: true }));
  },
};

export default nextConfig;
