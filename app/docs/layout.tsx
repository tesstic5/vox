import * as React from 'react';
import { Logo } from '@/components/icons';

export const metadata = {
  title: { default: 'Voxera implementation guide', template: '%s · Voxera guide' },
  description: 'Verified workflows, application controls and deployment boundaries for this build.',
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-900/[0.06]">
        <div className="container-wide flex h-16 items-center gap-6">
          <a href="/" aria-label="Voxera home"><Logo size={28} /></a>
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-slateink-400">Implementation guide</span>
          <nav aria-label="Guide navigation" className="ml-auto flex items-center gap-4 text-[12.5px] text-slateink-400">
            <a href="/platform" className="hover:text-slate-900">Capabilities</a>
            <a href="/security" className="hover:text-slate-900">Security</a>
            <a href="/dashboard/setup" className="hover:text-slate-900">Setup</a>
          </nav>
        </div>
      </header>
      <main id="main-content">{children}</main>
    </div>
  );
}
