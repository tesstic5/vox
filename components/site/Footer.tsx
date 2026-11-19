'use client';

import { Icons, Logo } from '../icons';

const LINKS = [
  { title: 'Explore', items: [
    { label: 'What Voxera does', href: '/#what-it-does' },
    { label: 'How it works', href: '/#how-it-works' },
    { label: 'For your business', href: '/#businesses' },
  ] },
  { title: 'Resources', items: [
    { label: 'Documentation', href: '/docs' },
    { label: 'Support', href: '/support' },
    { label: 'Contact sales', href: '/sales' },
  ] },
  { title: 'Account', items: [
    { label: 'Create an account', href: '/signup' },
    { label: 'Sign in', href: '/login' },
    { label: 'Security', href: '/security' },
  ] },
];

export function Footer() {
  return (
    <footer className="relative mt-10 border-t border-slate-900/[0.06]">
      <div className="container-wide pt-16">
        <div className="grid gap-12 lg:grid-cols-[1.3fr_2fr]">
          <div>
            <Logo size={30} />
            <p className="mt-4 max-w-[38ch] text-[13.5px] leading-relaxed text-slateink-400">
              Calls, appointments and customer care, together in one workspace.
            </p>
            <a href="/support" className="mt-5 inline-flex items-center gap-2 text-[12.5px] font-medium text-brand-700 hover:underline">
              Need help? <Icons.arrowRight size={14} />
            </a>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {LINKS.map((group) => (
              <div key={group.title}>
                <h4 className="mb-4 font-mono text-[10.5px] font-medium uppercase tracking-[0.18em] text-slateink-400">{group.title}</h4>
                <ul className="space-y-2.5">
                  {group.items.map((item) => (
                    <li key={item.href}><a href={item.href} className="text-[13px] text-slateink-300 hover:text-brand-700">{item.label}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-slate-900/[0.06] py-7 text-[12px] text-slateink-400">
          <span>Voxera</span>
          <a href="/privacy" className="hover:text-slate-900">Privacy</a>
          <a href="/terms-of-service" className="hover:text-slate-900">Terms</a>
          <button type="button" onClick={() => window.dispatchEvent(new Event('voxera:cookies'))} className="hover:text-slate-900">Cookie settings</button>
          <span className="sm:ml-auto">Phone, messaging and payments require connected providers.</span>
        </div>
      </div>
    </footer>
  );
}
