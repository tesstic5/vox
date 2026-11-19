'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { NAV } from '@/lib/content';
import { cn } from '@/lib/utils';
import { Icons, Logo } from '../icons';
import { Button } from '../ui';
import { SearchTrigger } from './CommandPalette';

// Lead with the questions a business owner has, rather than a builder-only menu.
const SIMPLE_NAV: typeof NAV = [
  { label: 'What we do', href: '/#what-it-does' },
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'For your business', href: '/#businesses' },
  { label: 'Docs', href: '/docs' },
];

function useScrolled(threshold = 8) {
  const [v, setV] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setV(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return v;
}

export function AnnouncementBar() {
  const [open, setOpen] = React.useState(true);
  if (!open) return null;
  return (
    <div className="relative z-50 overflow-hidden border-b border-slate-900/[0.045] bg-gradient-to-r from-ink-900 via-ink-850 to-ink-900">
      <div className="container-x flex items-center justify-center gap-3 py-2 text-center">
        <span className="hidden h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400 sm:block" />
        <p className="truncate text-[12.5px] text-slateink-300">
          <span className="font-medium text-slate-900">VoxCon</span> returns Nov 11–12 in San Francisco — 3,000 voice AI builders.
          <a href="/hackathon" className="ml-2 whitespace-nowrap font-medium text-brand-700 underline decoration-brand-500/40 underline-offset-4 hover:decoration-brand-300">
            Get tickets
          </a>
        </p>
        <button
          onClick={() => setOpen(false)}
          aria-label="Dismiss"
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slateink-400 transition-colors hover:bg-slate-900/[0.06] hover:text-slate-900 sm:right-6"
        >
          <Icons.close size={13} />
        </button>
      </div>
    </div>
  );
}

function MegaMenu({ item, onClose }: { item: (typeof NAV)[number]; onClose: () => void }) {
  if (!item.columns) return null;
  return (
    // Width only — positioning lives with the caller. This used to centre
    // itself on the nav *link* (`left-1/2 -translate-x-1/2` inside a
    // `relative` item as wide as the word "Platform"), which put half the
    // 1080px menu off the left edge of the screen for the first items.
    <div className="w-[min(92vw,1080px)] pt-3">
      <div className="overflow-hidden rounded-2xl border border-slate-900/[0.035] bg-ink-850/97 shadow-panel backdrop-blur-xl">
        <div className="grid gap-8 p-6 lg:grid-cols-[repeat(3,minmax(0,1fr))_260px]">
          {item.columns.map((col) => (
            <div key={col.title}>
              <div className="mb-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.18em] text-slateink-400">
                {col.title}
              </div>
              <ul className="space-y-1">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      onClick={onClose}
                      className="group block rounded-xl px-3 py-2.5 transition-colors hover:bg-slate-900/[0.045]"
                    >
                      <span className="flex items-center gap-2 text-[13.5px] font-medium text-slate-900">
                        {l.label}
                        {l.badge && (
                          <span className="rounded-full bg-brand-500/15 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-brand-700">
                            {l.badge}
                          </span>
                        )}
                      </span>
                      {l.desc && <span className="mt-0.5 block text-[12px] leading-snug text-slateink-400">{l.desc}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {item.featured && (
            <a
              href={item.featured.href}
              onClick={onClose}
              className="group relative flex flex-col justify-end overflow-hidden rounded-xl border border-brand-500/20 bg-gradient-to-br from-brand-500/[0.14] via-ink-800 to-ink-850 p-5"
            >
              <div className="absolute inset-0 grid-bg opacity-[0.35]" />
              <div className="relative">
                <span className="grid h-9 w-9 place-items-center rounded-xl border border-brand-500/25 bg-ink-900/70 text-brand-700">
                  <Icons.bolt size={17} />
                </span>
                <h4 className="mt-4 text-[15px] font-semibold text-slate-900">{item.featured.title}</h4>
                <p className="mt-1.5 text-[12.5px] leading-snug text-slateink-300">{item.featured.desc}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-700">
                  Explore <Icons.arrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function Nav() {
  const [open, setOpen] = React.useState<string | null>(null);
  const [mobile, setMobile] = React.useState(false);
  const [mobileSection, setMobileSection] = React.useState<string | null>(null);
  const scrolled = useScrolled();
  const pathname = usePathname();
  const timeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    setOpen(null);
    setMobile(false);
  }, [pathname]);

  React.useEffect(() => {
    document.body.style.overflow = mobile ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobile]);

  const enter = (label: string) => {
    if (timeout.current) clearTimeout(timeout.current);
    setOpen(label);
  };
  const leave = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setOpen(null), 140);
  };

  // A menu that only a mouse can dismiss traps everyone else: close on
  // Escape, and on a pointer-down anywhere outside the header.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open ]);

  React.useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    []
  );

  return (
    <>
      <header
        ref={headerRef}
        onMouseLeave={leave}
        className={cn(
          'sticky top-0 z-40 transition-all duration-300',
          scrolled ? 'border-b border-slate-900/[0.045] bg-white/85 backdrop-blur-xl' : 'border-b border-transparent'
        )}
      >
        <div className="container-wide">
          <div className="relative flex h-[62px] items-center gap-6">
            <a href="/" className="shrink-0" aria-label="Voxera home">
              <Logo />
            </a>

            <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
              {SIMPLE_NAV.map((item) => (
                <div key={item.label} onMouseEnter={() => item.columns && enter(item.label)}>
                  <a
                    href={item.href}
                    aria-current={pathname === item.href ? 'page' : undefined}
                    aria-haspopup={item.columns ? 'true' : undefined}
                    aria-expanded={item.columns ? open === item.label : undefined}
                    onFocus={() => item.columns && enter(item.label)}
                    onClick={(e) => {
                      // Touch and keyboard have no hover: the first tap on a
                      // menu item opens it instead of navigating past it.
                      // The second tap (menu already open) follows the link.
                      if (item.columns && open !== item.label) {
                        e.preventDefault();
                        enter(item.label);
                      }
                    }}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-medium transition-colors',
                      pathname === item.href ? 'text-slate-900' : 'text-slateink-400 hover:text-slate-900'
                    )}
                  >
                    {item.label}
                    {item.columns && (
                      <Icons.chevronDown
                        size={12}
                        className={cn('transition-transform duration-200', open === item.label && 'rotate-180')}
                      />
                    )}
                  </a>
                </div>
              ))}
            </nav>

            {SIMPLE_NAV.filter((item) => item.columns && open === item.label).map((item) => (
              <div
                key={item.label}
                className="absolute inset-x-0 top-full z-50 hidden justify-center lg:flex"
                onMouseEnter={() => enter(item.label)}
              >
                <MegaMenu item={item} onClose={() => setOpen(null)} />
              </div>
            ))}

            <div className="ml-auto hidden items-center gap-2 lg:flex">
              <SearchTrigger className="mr-1" />
              <a href="/support" className="btn-quiet text-[13.5px]">Help</a>
              <a href="/login" className="btn-quiet text-[13.5px]">
                Log in
              </a>
              <a href="/signup" className="btn-primary btn-sm">
                Get started
              </a>
            </div>

            <SearchTrigger compact className="ml-auto lg:hidden" />

            <button
              onClick={() => setMobile((v) => !v)}
              className="grid h-9 w-9 place-items-center rounded-lg border border-slate-900/[0.04] text-slate-900 lg:hidden"
              aria-label="Menu"
              aria-expanded={mobile}
              aria-controls="mobile-menu"
            >
              {mobile ? <Icons.close size={17} /> : <Icons.menu size={18} />}
            </button>
          </div>
        </div>
      </header>

      {mobile && (
        <div id="mobile-menu" className="fixed inset-0 top-[62px] z-40 overflow-y-auto bg-white/98 backdrop-blur-xl lg:hidden">
          <div className="container-x py-4">
            {SIMPLE_NAV.map((item) => (
              <div key={item.label} className="border-b border-slate-900/[0.04]">
                {item.columns ? (
                  <>
                    <button
                      onClick={() => setMobileSection(mobileSection === item.label ? null : item.label)}
                      aria-expanded={mobileSection === item.label}
                      className="flex w-full items-center justify-between py-3.5 text-left text-[16px] font-medium text-slate-900"
                    >
                      {item.label}
                      <Icons.chevronDown
                        size={15}
                        className={cn('text-slateink-400 transition-transform', mobileSection === item.label && 'rotate-180')}
                      />
                    </button>
                    {mobileSection === item.label && (
                      <div className="pb-3">
                        {item.columns.map((col) => (
                          <div key={col.title} className="mb-3">
                            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slateink-400">
                              {col.title}
                            </div>
                            {col.links.map((l) => (
                              <a key={l.label} href={l.href} className="block rounded-lg px-3 py-2.5 text-[14px] text-slateink-300 hover:bg-slate-900/[0.05] hover:text-slate-900">
                                {l.label}
                              </a>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <a href={item.href} className="block py-3.5 text-[16px] font-medium text-slate-900">
                    {item.label}
                  </a>
                )}
              </div>
            ))}
            <div className="mt-6 flex flex-col gap-2.5">
              <a href="/signup" className="btn-brand w-full py-3">
                Get started
              </a>
              <a href="/sales" className="btn-ghost w-full py-3">
                Contact sales
              </a>
              <a href="/login" className="btn-quiet w-full justify-center py-3">
                Log in
              </a>
            </div>
            <p className="mt-6 pb-8 text-center font-mono text-[11px] text-slateink-400">
              Calls, bookings and customer care
            </p>
          </div>
        </div>
      )}
    </>
  );
}
