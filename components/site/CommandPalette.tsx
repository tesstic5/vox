'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';
import type { SearchEntry } from '@/lib/search-index';

const KIND_META: Record<SearchEntry['kind'], { label: string; tone: string }> = {
  doc: { label: 'Docs', tone: 'text-brand-700 border-brand-500/30 bg-brand-500/10' },
  blog: { label: 'Blog', tone: 'text-lime-800 border-lime-400/30 bg-lime-400/10' },
  page: { label: 'Page', tone: 'text-sky-800 border-sky-400/30 bg-sky-400/10' },
};

let CACHE: SearchEntry[] | null = null;
let INFLIGHT: Promise<SearchEntry[]> | null = null;

function loadIndex(): Promise<SearchEntry[]> {
  if (CACHE) return Promise.resolve(CACHE);
  if (!INFLIGHT) {
    INFLIGHT = fetch('/api/search')
      .then((r) => r.json())
      .then((d: { entries: SearchEntry[] }) => {
        CACHE = d.entries;
        return d.entries;
      })
      .catch(() => [] as SearchEntry[])
      .finally(() => {
        INFLIGHT = null;
      });
  }
  return INFLIGHT;
}

/** Score an entry against a query. Higher is better; 0 means no match. */
function score(e: SearchEntry, terms: string[]) {
  const title = e.title.toLowerCase();
  const href = e.href.toLowerCase();
  let total = 0;
  for (const t of terms) {
    const inTitle = title.indexOf(t);
    if (inTitle === 0) total += 60;
    else if (inTitle > 0) total += 34;
    if (href.includes(t)) total += 14;
    if (e.desc.toLowerCase().includes(t)) total += 8;
    if (e.section.toLowerCase().includes(t)) total += 6;
    if (e.text.includes(t)) total += 4;
    if (!inTitle && !href.includes(t) && !e.desc.toLowerCase().includes(t) && !e.text.includes(t)) return 0;
  }
  if (e.kind === 'doc') total += 6;
  return total;
}

export function useCommandPalette() {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('voxera:palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('voxera:palette', onOpen);
    };
  }, []);
  return { open, setOpen, openPalette: () => setOpen(true) };
}

export function CommandPalette() {
  const router = useRouter();
  const { open, setOpen } = useCommandPalette();

  const [entries, setEntries] = React.useState<SearchEntry[]>(CACHE ?? []);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    let alive = true;
    loadIndex().then((e) => alive && setEntries(e));
    return () => {
      alive = false;
    };
  }, [open]);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return entries.filter((e) => e.kind === 'doc').slice(0, 7);
    }
    const terms = q.split(/\s+/).filter(Boolean);
    return entries
      .map((e) => ({ e, s: score(e, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 24)
      .map((x) => x.e);
  }, [entries, query]);

  React.useEffect(() => setActive(0), [query]);

  const go = React.useCallback(
    (entry: SearchEntry) => {
      setOpen(false);
      router.push(entry.href);
    },
    [router, setOpen]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  };

  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[10vh] sm:pt-[14vh]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div
        className="relative w-full max-w-[620px] overflow-hidden rounded-2xl border border-slate-900/[0.04] bg-ink-900/95 shadow-panel"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-slate-900/[0.045] px-4 py-3.5">
          <Icons.search size={16} className="shrink-0 text-slateink-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs, guides, and posts…"
            spellCheck={false}
            className="w-full bg-transparent text-[14px] text-slate-900 placeholder:text-slateink-400 focus:outline-none"
          />
          <button
            onClick={() => setOpen(false)}
            className="rounded-md border border-slate-900/[0.035] px-1.5 py-0.5 font-mono text-[9.5px] text-slateink-400 hover:text-slate-900"
          >
            esc
          </button>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {!entries.length && (
            <div className="px-3 py-8 text-center text-[13px] text-slateink-400">Loading index…</div>
          )}

          {!!entries.length && !results.length && (
            <div className="px-3 py-8 text-center text-[13px] text-slateink-400">
              Nothing matches “{query}”. Try <span className="text-slate-900">webhooks</span>,{' '}
              <span className="text-slate-900">latency</span>, or <span className="text-slate-900">campaigns</span>.
            </div>
          )}

          {!query && !!results.length && (
            <div className="px-3 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-[0.16em] text-slateink-400">
              Start reading
            </div>
          )}

          <ul>
            {results.map((r, i) => {
              const meta = KIND_META[r.kind];
              return (
                <li key={r.kind + r.href}>
                  <button
                    data-active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                      i === active ? 'bg-slate-900/[0.07]' : 'hover:bg-slate-900/[0.04]'
                    )}
                  >
                    <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider', meta.tone)}>
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-slate-900">{r.title}</span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-slateink-400">
                        {r.section} · <span className="font-mono">{r.href}</span>
                      </span>
                    </span>
                    {i === active && <Icons.arrowRight size={13} className="shrink-0 text-slateink-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-center gap-4 border-t border-slate-900/[0.045] px-4 py-2.5 font-mono text-[10px] text-slateink-400">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-slate-900/[0.04] px-1.5 py-0.5">↑</kbd>
            <kbd className="rounded border border-slate-900/[0.04] px-1.5 py-0.5">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-slate-900/[0.04] px-1.5 py-0.5">↵</kbd> open
          </span>
          <span className="ml-auto">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}

/** Button + hint used in the site nav and docs header to open the palette. */
export function SearchTrigger({ className, compact = false }: { className?: string; compact?: boolean }) {
  const open = () => window.dispatchEvent(new CustomEvent('voxera:palette'));
  if (compact) {
    return (
      <button onClick={open} className={cn('btn-quiet p-2', className)} aria-label="Search">
        <Icons.search size={16} />
      </button>
    );
  }
  return (
    <button
      onClick={open}
      className={cn(
        'inline-flex items-center gap-2 rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.02] px-3 py-2 text-[13px] text-slateink-400 transition-colors hover:border-slate-900/[0.045] hover:text-slate-900',
        className
      )}
    >
      <Icons.search size={14} />
      Search
      <span className="rounded-md border border-slate-900/[0.035] px-1.5 py-0.5 font-mono text-[9.5px]">⌘K</span>
    </button>
  );
}
