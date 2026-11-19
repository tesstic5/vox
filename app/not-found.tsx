import * as React from 'react';
import { Icons, Logo } from '@/components/icons';
import { LinkButton } from '@/components/ui';

export const metadata = { title: 'Page not found' };

const LINKS = [
  { t: 'Platform', d: 'Implemented business records and provider boundaries.', href: '/platform' },
  { t: 'Solutions', d: 'Contractor, dental, physiotherapy and other workflows.', href: '/solutions' },
  { t: 'Implementation guide', d: 'Verified scope and release checks.', href: '/docs' },
  { t: 'Security', d: 'Application controls and external review work.', href: '/security' },
];

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] grid-bg opacity-40 mask-fade-b" />
      <header className="relative border-b border-slate-900/[0.04]">
        <div className="container-wide flex h-[62px] items-center">
          <a href="/" aria-label="Voxera home">
            <Logo />
          </a>
          <a href="/support" className="ml-auto text-[13px] text-slateink-400 hover:text-slate-900">
            Support
          </a>
        </div>
      </header>

      <main className="relative flex flex-1 items-center">
        <div className="container-x w-full py-20">
          <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-center">
            <div>
              <div className="eyebrow mb-4">Error 404</div>
              <h1 className="h1 text-balance">
                This line is not <span className="text-brand-700">connected</span>.
              </h1>
              <p className="lede mt-6 max-w-[46ch]">
                The page you asked for does not exist or has moved. Use one of the current, verified destinations below.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <LinkButton href="/" variant="brand" className="px-6 py-3 text-[14px]">
                  Back to home <Icons.arrowRight size={16} />
                </LinkButton>
                <LinkButton href="/support" variant="ghost" className="px-6 py-3 text-[14px]">
                  Report a broken link
                </LinkButton>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-900/[0.035] bg-ink-850/60 p-6">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-slateink-400">
                Popular destinations
              </div>
              <div className="mt-4 grid gap-2">
                {LINKS.map((l) => (
                  <a
                    key={l.t}
                    href={l.href}
                    className="group flex items-center gap-4 rounded-xl border border-slate-900/[0.04] bg-ink-900/50 p-4 transition-colors hover:border-brand-500/30"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium text-slate-900">{l.t}</span>
                      <span className="mt-0.5 block text-[12px] text-slateink-400">{l.d}</span>
                    </span>
                    <Icons.arrowRight size={15} className="shrink-0 text-slateink-400 group-hover:text-brand-700" />
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="relative border-t border-slate-900/[0.04] py-6">
        <div className="container-wide flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-slateink-400">
          <span className="font-mono">© {new Date().getFullYear()} Voxera</span>
          <a href="/privacy" className="hover:text-slate-900">
            Privacy
          </a>
          <a href="/terms-of-service" className="hover:text-slate-900">
            Terms
          </a>
          <a href="/security" className="hover:text-slate-900">
            Security
          </a>
          <a href="/status" className="ml-auto font-mono text-[11px] hover:text-slate-900">
            Check current deployment status
          </a>
        </div>
      </footer>
    </div>
  );
}
