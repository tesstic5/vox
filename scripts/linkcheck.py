#!/usr/bin/env python3
"""
Internal link checker for the Voxera site.

Runs against a production build rather than a dev server: every statically
generated page is already on disk, so the route table and the hrefs it renders
can be compared directly, with no crawling and no network.

    npm run build && python3 scripts/linkcheck.py

Exits non-zero when a page links to a route that will not resolve. Dynamic
routes that exist without being pre-rendered are listed in DYNAMIC_PATTERNS.
"""
import collections
import glob
import os
import re
import sys

ROOT = os.path.join('.next', 'server', 'app')

DYNAMIC_PATTERNS = [
    r'^/dashboard/assistants/[^/]+$',
    # number detail pages are keyed by runtime ids the browser generates (pn_…),
    # so they cannot appear in the prerendered HTML that this audit reads.
    r'^/dashboard/numbers/[^/]+$',
        '^/invite/[^/]+$',
    r'^/dashboard/workflows/[^/]+$',
    r'^/dashboard/calls/[^/]+$',
    # the setup wizard is rendered per request (it reads the session's workspace
    # state server-side), so unlike the rest of the dashboard it has no prerendered
    # HTML for this audit to compare against.
    r'^/dashboard/setup$',
    # every workspace's booking page is rendered per request (it reads its own
    # settings), so there is no prerendered HTML to compare against.
    r'^/book/[^/]+$',
    r'^/api/.*$',
    # feed and metadata route handlers live at any depth (/blog/rss.xml, /sitemap.xml)
    r'^/.*(rss\.xml|feed\.json|sitemap\.xml|robots\.txt)$',
]


def static_routes():
    routes = set()
    for path in glob.glob(os.path.join(ROOT, '**', '*.html'), recursive=True):
        route = path[len(ROOT):-len('.html')]
        if route.endswith('/index'):
            route = route[: -len('/index')]
        routes.add(route or '/')
    return routes


def main():
    if not os.path.isdir(ROOT):
        print('no build found — run `npm run build` first')
        return 1

    routes = static_routes()
    dynamic = [re.compile(p) for p in DYNAMIC_PATTERNS]

    def resolves(href):
        return href in routes or any(d.match(href) for d in dynamic)

    broken = collections.defaultdict(set)
    for path in glob.glob(os.path.join(ROOT, '**', '*.html'), recursive=True):
        source = path[len(ROOT):-len('.html')].replace('/index', '') or '/'
        html = open(path, encoding='utf-8', errors='ignore').read()
        for href in re.findall(r'href="(/[^"#?]*)', html):
            if href.startswith('/_next/'):
                continue  # build assets
            target = href.rstrip('/') or '/'
            if not resolves(target):
                broken[target].add(source)

    print(f'{len(routes)} static routes · {len(broken)} unresolvable link targets')
    for target, sources in sorted(broken.items()):
        shown = sorted(sources)[:4]
        more = '' if len(sources) <= 4 else f' (+{len(sources) - 4} more)'
        print(f'  {target}  ← {shown}{more}')
    return 1 if broken else 0


if __name__ == '__main__':
    sys.exit(main())
