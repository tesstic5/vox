#!/usr/bin/env python3
"""Verify the sitemap against the prerendered route list.

Reads .next/prerender-manifest.json (every statically generated route) and the
generated sitemap, then reports:
  * indexable routes that the sitemap omits (coverage)
  * sitemap entries that do not correspond to a real route (ghosts)

Excluded from the coverage check: the dashboard, API routes, auth screens, feeds,
and metadata image routes — those are intentionally out of the sitemap.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, '.next', 'prerender-manifest.json')
ROUTES_MANIFEST = os.path.join(ROOT, '.next', 'routes-manifest.json')
SITEMAP_CANDIDATES = [
    os.path.join(ROOT, '.next', 'server', 'app', 'sitemap.xml.body'),
    os.path.join(ROOT, '.next', 'server', 'app', 'sitemap.xml'),
]

EXCLUDE_EXACT = {'/robots.txt', '/sitemap.xml', '/blog/feed.json'}

EXCLUDE_PREFIXES = (
    '/dashboard',
    # The operator console: session-gated, noindex (app/admin/layout.tsx), and
    # not something a search engine should ever be told about.
    '/admin',
    # A workspace's booking page is private to that practice: `noindex`, and the
    # slug belongs to the customer, not to our sitemap.
    '/book',
    '/onboarding',
    '/reset-password',
    '/magic-link',
    '/verify-email',
    '/invite',
    '/sso',
    '/api',
    '/login',
    '/signup',
    '/_next',
    '/opengraph-image',
    '/blog/feed.json',
)
EXCLUDE_SUFFIXES = ('/opengraph-image', '/rss.xml')


def is_excluded(path: str) -> bool:
    if path in EXCLUDE_EXACT:
        return True
    if path.startswith(EXCLUDE_PREFIXES):
        return True
    if path.endswith(EXCLUDE_SUFFIXES):
        return True
    return 'opengraph-image' in path


def load_routes():
    if not os.path.exists(MANIFEST):
        print('! run `npm run build` first: no prerender manifest at', MANIFEST)
        return None
    with open(MANIFEST) as fh:
        data = json.load(fh)
    # `/_not-found` (Next ≤15) and `/_global-error` (Next 16) are the
    # framework's own error pages, not indexable routes.
    routes = {p for p in data.get('routes', {}) if p not in ('/_not-found', '/_global-error')}
    routes |= {p for p in data.get('notFoundRoutes', {})}
    return routes


def redirected_routes(routes: set[str]) -> set[str]:
    """Routes covered by explicit deployment redirects are not indexable pages."""
    if not os.path.exists(ROUTES_MANIFEST):
        return set()
    with open(ROUTES_MANIFEST) as fh:
        manifest = json.load(fh)
    patterns = []
    for row in manifest.get('redirects', []):
        if row.get('internal') or not row.get('regex'):
            continue
        try:
            patterns.append(re.compile(row['regex']))
        except re.error:
            pass
    return {route for route in routes if any(pattern.match(route) for pattern in patterns)}


def load_sitemap():
    for cand in SITEMAP_CANDIDATES:
        if os.path.exists(cand):
            with open(cand, errors='replace') as fh:
                body = fh.read()
            locs = set(re.findall(r'<loc>https://voxera\.ai(/[^<]*)</loc>', body))
            if '<loc>https://voxera.ai</loc>' in body:
                locs.add('/')
            return locs
    print('! no sitemap output found; looked in:', *SITEMAP_CANDIDATES, sep='\n  ')
    return None


def main():
    routes = load_routes()
    listed = load_sitemap()
    if routes is None or listed is None:
        return 1

    redirects = redirected_routes(routes)
    missing = sorted(r for r in routes if r not in listed and r not in redirects and not is_excluded(r))
    ghost = sorted(l for l in listed if l not in routes)

    print(f'sitemap entries: {len(listed)}  ·  prerendered routes: {len(routes)}  ·  redirects: {len(redirects)}')
    if missing:
        print(f'\n{len(missing)} indexable route(s) missing from the sitemap:')
        for r in missing:
            print('  -', r)
    else:
        print('every indexable prerendered route is listed')
    if ghost:
        print(f'\n{len(ghost)} sitemap entr(ies) with no prerendered route:')
        for g in ghost:
            print('  -', g)
    return 1 if (missing or ghost) else 0


if __name__ == '__main__':
    sys.exit(main())
