#!/usr/bin/env python3
"""Find invalid HTML nesting in the prerendered output.

React warns about these in the browser and they cause hydration mismatches, so
they are worth catching at build time. Currently checks:
  * <a> inside <a>      — invalid, and the browser closes the outer anchor early
  * <button> inside <a> — invalid interactive nesting
  * <div> inside <p>    — invalid, reflows out of the paragraph

Usage: python3 scripts/nesting-check.py [--limit N]
Exits non-zero when anything is found.
"""
import glob
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, '.next', 'server', 'app')

VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}

# tag -> set of descendants that are not allowed anywhere inside it
FORBIDDEN = {
    'a': {'a', 'button'},
    'button': {'a', 'button'},
    'p': {'div', 'p', 'section', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4'},
}

SELF_CLOSING_ALLOWED = {'path','circle','rect','line','polyline','polygon','ellipse','use','stop','g','defs','svg','span','i','b'}

class NestingFinder(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.stack = []
        self.hits = []

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        for ancestor, banned in FORBIDDEN.items():
            if tag in banned:
                for anc_tag, anc_line, anc_href in self.stack:
                    if anc_tag == ancestor:
                        self.hits.append((ancestor, anc_line, anc_href, tag, self.getpos()[0]))
        href = ''
        for k, v in attrs:
            if k == 'href' and v:
                href = v
        self.stack.append((tag, self.getpos()[0], href))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return


def routes():
    out = []
    for path in glob.glob(os.path.join(BUILD_DIR, '**', '*.html'), recursive=True):
        route = '/' + os.path.relpath(path, BUILD_DIR)[:-5]
        route = route.replace('/index', '')
        if '[' in route:      # dynamic template source, not real output
            continue
        out.append((route.rstrip('/') or '/', path))
    return sorted(set(out))


def main():
    limit = 5
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])
    pages = routes()
    if not pages:
        print('! no prerendered HTML found — run `npm run build` first')
        return 1

    bad = []
    for route, path in pages:
        with open(path, 'r', errors='replace') as fh:
            html = fh.read()
        finder = NestingFinder(path)
        finder.feed(html)
        # collapse duplicates that come from repeated identical markup
        seen = set()
        for ancestor, aline, ahref, tag, line in finder.hits:
            key = (ancestor, tag, ahref)
            if key in seen:
                continue
            seen.add(key)
            bad.append((route, ancestor, tag, ahref, aline))

    print(f'scanned {len(pages)} prerendered pages')
    if not bad:
        print('no invalid nesting found')
        return 0

    print(f'\n{len(bad)} invalid nesting pattern(s):\n')
    for route, ancestor, tag, href, line in bad[:limit * 40]:
        print(f'  <{tag}> inside <{ancestor}>   {route}   ancestor href={href or "(none)"}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
