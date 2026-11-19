import * as React from 'react';
import { Logo } from '@/components/icons';
import { SITE } from '@/lib/content';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-cover bg-center opacity-[0.14]"
        style={{ backgroundImage: 'url(/hero-bg.jpg)' }}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/40 via-[#f5f8f6]/70 to-[#f5f8f6]" />
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40 mask-fade-b" />

      <header className="relative z-10 border-b border-slate-900/[0.04]">
        <div className="container-wide flex h-[62px] items-center gap-6">
          <a href="/" aria-label="Voxera home">
            <Logo />
          </a>
          <p className="ml-auto hidden text-[13px] text-slateink-400 sm:block">
            Need help?{' '}
            <a href="/support" className="text-brand-700 hover:underline">
              Open support guidance
            </a>
          </p>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center py-12">
        <div className="container-x w-full">{children}</div>
      </main>

      <footer className="relative z-10 py-6">
        <div className="container-wide flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-slateink-400">
          <span className="font-mono">{SITE.copyright}</span>
          <a href="/privacy" className="hover:text-slate-900">
            Privacy
          </a>
          <a href="/terms-of-service" className="hover:text-slate-900">
            Terms
          </a>
          <a href="/security" className="hover:text-slate-900">
            Security
          </a>
          <span className="ml-auto font-mono text-[11px] text-brand-700">Tenant-scoped application controls</span>
        </div>
      </footer>
    </div>
  );
}
