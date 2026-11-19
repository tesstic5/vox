'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Icons, LogoMark } from '../icons';
import { useToast } from '../ui';
import { CallWidget } from './CallWidget';
import { MODULE_IDS, labelsForBusiness, type BusinessType, type ModuleId } from '@/lib/business';

type NavItem = {
  href: string;
  label: string;
  icon: string;
  module?: ModuleId;
  badge?: string;
};

type NavGroup = { label: string; items: NavItem[] };

/**
 * Business type changes the everyday order and words; selected modules decide
 * which shortcuts are shown. The APIs behind every page keep their own role and
 * tenant checks — this menu is organisation, never authorisation.
 */
function navGroups(type: BusinessType): NavGroup[] {
  const labels = labelsForBusiness(type);
  const contractor = type === 'contractor';
  return [
    {
      label: contractor ? 'Field work' : type === 'dental' || type === 'physiotherapy' ? 'Practice' : 'Everyday work',
      items: [
        { href: '/dashboard', label: labels.home, icon: 'chart' },
        ...(contractor
          ? [
              { href: '/dashboard/enquiries', label: 'Enquiries', icon: 'send', module: 'field_service' as ModuleId },
              { href: '/dashboard/estimates', label: 'Estimates', icon: 'layers', module: 'field_service' as ModuleId },
              { href: '/dashboard/jobs', label: 'Jobs', icon: 'briefcase', module: 'field_service' as ModuleId },
              { href: '/dashboard/dispatch', label: 'Dispatch', icon: 'calendar', module: 'field_service' as ModuleId },
            ]
          : [
              { href: '/dashboard/my-day', label: 'My day', icon: 'briefcase', module: 'schedule' as ModuleId },
              { href: '/dashboard/calendar', label: labels.schedule, icon: 'calendar', module: 'schedule' as ModuleId },
              { href: '/dashboard/classes', label: 'Classes', icon: 'users', module: 'classes' as ModuleId },
            ]),
        { href: '/dashboard/clients', label: labels.people, icon: 'users', module: 'customers' },
        { href: '/dashboard/tasks', label: 'Tasks', icon: 'check' },
        ...(!contractor
          ? [
              { href: '/dashboard/clinical', label: 'Clinical foundation', icon: 'shield' as const, module: 'clinical_records' as ModuleId },
              { href: '/dashboard/cases', label: 'Cases & funding', icon: 'briefcase' as const, module: 'clinical_records' as ModuleId },
              { href: '/dashboard/documents', label: 'Clinical documents', icon: 'book' as const, module: 'clinical_documents' as ModuleId },
              { href: '/dashboard/forms', label: 'Forms', icon: 'layers' as const, module: 'intake_forms' as ModuleId },
              { href: '/dashboard/intake', label: 'Intake administration', icon: 'users' as const, module: 'intake_forms' as ModuleId },
              { href: '/dashboard/referrals', label: 'Referrals', icon: 'send' as const, module: 'referrals' as ModuleId },
              { href: '/dashboard/referral-forms', label: 'Public referral forms', icon: 'globe' as const, module: 'referrals' as ModuleId },
              { href: '/dashboard/letters', label: 'Letters', icon: 'book' as const, module: 'correspondence' as ModuleId },
              { href: '/dashboard/bookings', label: type === 'dental' || type === 'physiotherapy' ? 'Appointment list' : 'Bookings', icon: 'calendar' as const, module: 'schedule' as ModuleId },
            ]
          : []),
        { href: '/dashboard/messaging', label: 'Messages', icon: 'send', module: 'communications' },
        { href: '/dashboard/money', label: 'Invoices & payments', icon: 'download', module: 'money' },
        { href: '/dashboard/reports', label: 'Reports', icon: 'chart', module: 'reports' },
        { href: '/dashboard/practice', label: labels.setup, icon: 'settings', module: 'schedule' },
        { href: '/dashboard/board', label: 'Staff board', icon: 'layers' },
        { href: '/dashboard/team', label: 'Team & roles', icon: 'users' },
      ],
    },
    {
      label: 'Calls & automation',
      items: [
        { href: '/dashboard/assistants', label: 'Assistants', icon: 'sparkles', module: 'assistants' },
        { href: '/dashboard/calls', label: 'Calls', icon: 'phone', module: 'communications' },
        { href: '/dashboard/numbers', label: 'Phone numbers', icon: 'globe', module: 'communications' },
        ...(!contractor ? [{ href: '/dashboard/automations', label: 'Administrative automations', icon: 'bolt' as const }] : []),
      ],
    },
    {
      label: 'Workspace',
      items: [
        { href: '/dashboard/setup', label: 'Setup checklist', icon: 'rocket' },
        { href: '/dashboard/business', label: 'Business profile & modules', icon: 'building' },
        { href: '/dashboard/notifications', label: 'Notifications', icon: 'badge' },
        { href: '/dashboard/audit', label: 'Audit log', icon: 'terminal' },
        { href: '/dashboard/settings', label: 'Settings', icon: 'settings' },
        { href: '/dashboard/settings/privacy', label: 'Privacy & retention', icon: 'shield', module: 'privacy_governance' },
        { href: '/dashboard/settings/roles', label: 'Granular roles', icon: 'users' },
        { href: '/dashboard/settings/security', label: 'Security', icon: 'lock' },
      ],
    },
    {
      label: 'Developer & advanced',
      items: [
        { href: '/dashboard/tools', label: 'Tools', icon: 'puzzle', module: 'developer' },
        { href: '/dashboard/providers', label: 'Model providers', icon: 'server', module: 'developer' },
        { href: '/dashboard/carriers', label: 'Carriers', icon: 'server', module: 'developer' },
        { href: '/dashboard/webhooks', label: 'Webhooks', icon: 'terminal', module: 'developer' },
        { href: '/dashboard/analytics', label: 'Call analytics', icon: 'chart', module: 'developer' },
        { href: '/dashboard/observability', label: 'Observability', icon: 'bolt', module: 'developer' },
        { href: '/dashboard/playground', label: 'API playground', icon: 'send', module: 'developer' },
        { href: '/dashboard/keys', label: 'API keys', icon: 'key', module: 'developer' },
      ],
    },
    {
      label: 'Platform',
      items: [{ href: '/admin', label: 'Operator console', icon: 'shield' }],
    },
  ];
}

export function DashShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const store = useStore();
  const toast = useToast();
  const { connection } = store;
  const userName = connection.user?.name ?? 'Signed-in user';
  const userEmail = connection.user?.email ?? 'Account details unavailable';
  const businessType = connection.org?.business?.type ?? 'other';
  const enabledModules = React.useMemo(
    () => new Set<ModuleId>(connection.org?.business?.modules ?? [...MODULE_IDS]),
    [connection.org?.business?.modules]
  );
  const groups = React.useMemo(
    () =>
      navGroups(businessType)
        .filter((group) => group.label !== 'Platform' || connection.user?.platformOperator)
        .map((group) => ({ ...group, items: group.items.filter((item) => !item.module || enabledModules.has(item.module)) }))
        .filter((group) => group.items.length > 0),
    [businessType, connection.user?.platformOperator, enabledModules]
  );
  const quickAction = businessType === 'contractor'
    ? { href: '/dashboard/enquiries?new=1', label: 'New enquiry' }
    : { href: '/dashboard/calendar?new=1', label: 'New appointment' };
  const userInitials =
    userName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || 'JR';
  const p50 = store.serverMetrics?.latency.p50;

  // A client-side navigation into the dashboard does not remount the store
  // provider, so ask the server once on arrival if we are still on the cache.
  const connectionStatus = connection.status;
  /**
   * A verified-email banner, shown on every page while the account is unverified.
   *
   * `connection.user.emailVerified === false` and not merely falsy: the local
   * (anonymous) dashboard has no user at all, and a marketing visitor should not
   * be nagged about verifying an address they never gave us.
   */
  const needsVerification = connection.user?.emailVerified === false;
  const refreshFromServer = store.refreshFromServer;
  React.useEffect(() => {
    if (connectionStatus === 'local') refreshFromServer();
  }, [connectionStatus, refreshFromServer]);
  const signOut = React.useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* local store still clears below */
    }
    store.reset();
    toast('Signed out.');
    router.push('/login');
    router.refresh();
  }, [router, store, toast]);
  const [sidebar, setSidebar] = React.useState(false);
  const [widget, setWidget] = React.useState(false);
  const [profile, setProfile] = React.useState(false);

  // These are observed call records returned by the API. There is deliberately
  // no synthetic plan allowance or per-minute estimate in the shell.
  const storedMetrics = store.serverMetrics;
  const usedMinutes = Math.round(storedMetrics?.minutes ?? 0);
  const storedCost = storedMetrics?.cost ?? 0;

  React.useEffect(() => setSidebar(false), [pathname]);

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen bg-white">
      {/* ---------------------------------------------------------- sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[248px] shrink-0 flex-col border-r border-slate-900/[0.045] bg-ink-900/95 backdrop-blur-xl transition-transform duration-250 lg:static lg:translate-x-0',
          sidebar ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-[58px] items-center gap-2.5 border-b border-slate-900/[0.045] px-4">
          <Link href="/" prefetch={false} className="flex items-center gap-2.5">
            <LogoMark size={26} />
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-slate-900">
              Voxera<span className="text-brand-400">.</span>
            </span>
          </Link>
          <span className="ml-auto rounded-md border border-slate-900/[0.035] px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-slateink-400">
            workspace
          </span>
          <button onClick={() => setSidebar(false)} className="btn-quiet p-1.5 lg:hidden" aria-label="Close menu">
            <Icons.close size={15} />
          </button>
        </div>

        <div className="px-3 py-3">
          <button
            onClick={() => router.push(quickAction.href)}
            className="btn-brand w-full py-2.5 text-[13px]"
          >
            <Icons.plus size={15} /> {quickAction.label}
          </button>
        </div>

        <nav aria-label="Dashboard" className="no-scrollbar flex-1 overflow-y-auto px-3 pb-4">
          {groups.map((g) => (
            <div key={g.label} className="mb-4">
              <div className="mb-1.5 px-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.18em] text-slateink-300">
                {g.label}
              </div>
              <ul className="space-y-0.5">
                {g.items.map((item) => {
                  const Icon = Icons[item.icon as keyof typeof Icons];
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        prefetch={false}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                          active
                            ? 'bg-slate-900/[0.07] text-slate-900'
                            : 'text-slateink-400 hover:bg-slate-900/[0.04] hover:text-slate-900'
                        )}
                      >
                        <Icon size={16} className={active ? 'text-brand-700' : ''} />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {'badge' in item && item.badge && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-400" />
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Observed records only — no inferred allowance, rate or invoice. */}
        <div className="border-t border-slate-900/[0.045] p-3">
          <details className="group rounded-xl border border-slate-900/[0.045] bg-ink-850/60 p-3">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-slateink-400">Stored call usage</span>
              <Icons.chevronDown size={12} className="text-slateink-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 text-[12.5px] font-medium text-slate-900">
              {storedMetrics ? `${usedMinutes.toLocaleString()} observed min` : 'Usage not loaded'}
            </div>
            <div className="mt-3 space-y-2 border-t border-slate-900/[0.045] pt-3 text-[11.5px]">
              <div className="flex justify-between text-slateink-400">
                <span>Stored cost total</span>
                <span className="text-slate-900">{storedMetrics ? `$${storedCost.toFixed(2)}` : 'Not loaded'}</span>
              </div>
              <p className="leading-relaxed text-slateink-400">Not a plan allowance or invoice.</p>
              <Link href="/dashboard/analytics" prefetch={false} className="btn-ghost btn-sm mt-1 w-full justify-center">
                Inspect analytics
              </Link>
            </div>
          </details>

          <div className="mt-3 flex items-center gap-2.5 rounded-xl px-1 py-1.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-900/[0.04] bg-gradient-to-br from-brand-500/25 to-ink-800 font-mono text-[10.5px] text-brand-700">
              {userInitials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-slate-900">{userName}</span>
              <span className="block truncate font-mono text-[10px] text-slateink-400">
                {connection.org?.id ?? 'workspace unavailable'} · {connection.org?.plan ?? 'plan unavailable'}
              </span>
            </span>
            <button onClick={signOut} className="btn-quiet p-1.5" title="Sign out">
              <Icons.arrowUpRight size={14} />
            </button>
          </div>
        </div>
      </aside>

      {sidebar && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setSidebar(false)} />}

      {/* ---------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-slate-900/[0.045] bg-white/85 backdrop-blur-xl">
          <div className="flex h-[58px] items-center gap-3 px-4 sm:px-6">
            <button onClick={() => setSidebar(true)} className="btn-quiet p-2 lg:hidden" aria-label="Open menu">
              <Icons.menu size={17} />
            </button>

            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('voxera:palette'))}
              className="hidden min-w-[220px] flex-1 items-center gap-2.5 rounded-xl border border-slate-900/[0.035] bg-ink-900/70 px-3 py-2 text-left transition-colors hover:border-slate-900/[0.09] sm:flex lg:max-w-[380px]"
            >
              <Icons.search size={15} className="text-slateink-400" />
              <span className="w-full truncate text-[12.5px] text-slateink-300">
                Search pages and documentation…
              </span>
              <span className="hidden rounded-md border border-slate-900/[0.035] px-1.5 py-0.5 font-mono text-[9.5px] text-slateink-400 lg:block">
                ⌘K
              </span>
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => {
                  store.refreshFromServer();
                  toast(connection.status === 'live' ? 'Workspace synced from the API.' : 'Reconnecting…');
                }}
                title={
                  connection.status === 'live'
                    ? `Connected to the Voxera API${connection.lastSyncAt ? ` · synced ${new Date(connection.lastSyncAt).toLocaleTimeString()}` : ''}`
                    : 'No session — running on this browser only'
                }
                className={cn(
                  'hidden items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10.5px] md:inline-flex',
                  connection.status === 'live'
                    ? 'border-brand-500/25 bg-brand-500/[0.07] text-brand-700'
                    : connection.status === 'error'
                      ? 'border-amber-500/30 bg-amber-500/[0.07] text-amber-800'
                      : 'border-slate-900/[0.04] bg-slate-900/[0.03] text-slateink-400'
                )}
              >
                <span className="relative flex h-1.5 w-1.5">
                  {connection.status === 'live' && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                  )}
                  <span
                    className={cn(
                      'relative inline-flex h-1.5 w-1.5 rounded-full',
                      connection.status === 'live' ? 'bg-brand-400' : connection.status === 'error' ? 'bg-amber-400' : 'bg-slateink-400'
                    )}
                  />
                </span>
                {connection.status === 'live' ? `live · ${p50 ? `${p50}ms p50` : 'api connected'}` : connection.status === 'error' ? 'api error' : 'offline'}
              </button>
              <button onClick={() => setWidget(true)} className="btn-ghost btn-sm">
                <Icons.waveform size={14} /> Test call
              </button>
              <Link href="/support" prefetch={false} className="btn-quiet p-2" title="Support">
                <Icons.headphones size={16} />
              </Link>
              <div className="relative">
                <button onClick={() => setProfile((v) => !v)} className="btn-quiet gap-2 px-2 py-1.5">
                  <span className="grid h-7 w-7 place-items-center rounded-full border border-slate-900/[0.04] bg-gradient-to-br from-brand-500/25 to-ink-800 font-mono text-[10px] text-brand-700">
                    {userInitials}
                  </span>
                  <Icons.chevronDown size={12} />
                </button>
                {profile && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setProfile(false)} />
                    <div className="absolute right-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-xl border border-slate-900/[0.035] bg-ink-850 shadow-panel">
                      <div className="border-b border-slate-900/[0.04] px-3.5 py-3">
                        <div className="text-[12.5px] font-medium text-slate-900">{userName}</div>
                        <div className="font-mono text-[10.5px] text-slateink-400">{userEmail}</div>
                      </div>
                      {[
                        { l: 'Organization settings', h: '/dashboard/settings' },
                        { l: 'API keys', h: '/dashboard/keys' },
                        { l: 'Invite teammates', h: '/dashboard/team' },
                        { l: 'Call analytics', h: '/dashboard/analytics' },
                        { l: 'Documentation', h: '/docs' },
                      ].map((x) => (
                        <Link
                          key={x.l}
                          href={x.h}
                          onClick={() => setProfile(false)}
                          className="block px-3.5 py-2.5 text-[12.5px] text-slateink-300 transition-colors hover:bg-slate-900/[0.05] hover:text-slate-900"
                        >
                          {x.l}
                        </Link>
                      ))}
                      <button
                        onClick={() => {
                          setProfile(false);
                          void signOut();
                        }}
                        className="block w-full border-t border-slate-900/[0.04] px-3.5 py-2.5 text-left text-[12.5px] text-slateink-300 transition-colors hover:bg-slate-900/[0.05] hover:text-slate-900"
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        {/*
          Two states the dashboard used to hide: the API is unreachable (so
          server state may be stale), or a write was rejected (so what is on
          screen may not be saved). Both change what the records mean, so both
          are said out loud instead of living in a dot or a log line.
        */}
        {connection.status === 'error' && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/25 bg-amber-500/[0.08] px-4 py-2.5 text-[12.5px] text-amber-800 sm:px-6"
          >
            <Icons.alert size={14} />
            <span className="font-medium">Not connected to the Voxera API — server state may be out of date.</span>
            <span className="text-amber-800">Changes are not being sent to your workspace. Reconnect before relying on this screen.</span>
            <button onClick={() => store.refreshFromServer()} className="ml-auto rounded-lg border border-amber-500/30 px-2.5 py-1 font-medium transition-colors hover:bg-amber-500/10">
              Retry
            </button>
          </div>
        )}
        {connection.mirrorError && connection.status === 'live' && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/25 bg-amber-500/[0.08] px-4 py-2.5 text-[12.5px] text-amber-800 sm:px-6"
          >
            <Icons.alert size={14} />
            <span className="font-medium">Part of this workspace is not syncing: {connection.mirrorError.name}.</span>
            <span className="text-amber-800">{connection.mirrorError.message} — it is kept in this browser and retried on the next change.</span>
            <button onClick={() => store.refreshFromServer()} className="ml-auto rounded-lg border border-amber-500/30 px-2.5 py-1 font-medium transition-colors hover:bg-amber-500/10">
              Reload from server
            </button>
          </div>
        )}
        {store.writeError && connection.status === 'live' && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rose-500/25 bg-rose-500/[0.08] px-4 py-2.5 text-[12.5px] text-rose-700 sm:px-6"
          >
            <Icons.alert size={14} />
            <span className="font-medium">That change was not saved: {store.writeError.message}</span>
            <span className="font-mono text-[11px] text-rose-700">{store.writeError.path}</span>
            <span className="text-rose-700">The workspace has been reloaded from the server.</span>
            <button onClick={store.dismissWriteError} className="ml-auto rounded-lg border border-rose-500/30 px-2.5 py-1 font-medium transition-colors hover:bg-rose-500/10">
              Dismiss
            </button>
          </div>
        )}

        <main id="main-content" className="min-w-0 flex-1 p-4 sm:p-6">
          {needsVerification && pathname !== '/verify-email' ? (
            <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-amber-400/25 bg-amber-400/[0.08] text-amber-800">
                <Icons.alert size={16} />
              </span>
              <div className="min-w-[220px] flex-1">
                <div className="text-[13.5px] font-medium text-slate-900">
                  {userEmail} is not verified yet
                </div>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-slateink-300">
                  Publishing an assistant, buying a number and creating API keys are refused until a six-digit code is
                  accepted. Everything else — the diary, clients, messages, money — works as normal.
                </p>
              </div>
              <Link href="/verify-email" className="btn-brand px-4 py-2 text-[12.5px] no-underline">
                Verify email
              </Link>
            </div>
          ) : null}
          {children}
        </main>
      </div>

      <CallWidget open={widget} onClose={() => setWidget(false)} />
    </div>
  );
}

/* ------------------------------------------------------------ page header */

export function PageHeader({
  title,
  desc,
  actions,
  breadcrumb,
}: {
  title: string;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb && (
          <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">
            {breadcrumb.map((b, i) => (
              <span key={b.label} className="flex items-center gap-1.5">
                {i > 0 && <Icons.chevronRight size={10} />}
                {b.href ? (
                  <Link href={b.href} prefetch={false} className="hover:text-brand-700">
                    {b.label}
                  </Link>
                ) : (
                  <span className="text-brand-700">{b.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-slate-900 sm:text-[26px]">{title}</h1>
        {desc && <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slateink-400">{desc}</p>}
      </div>
      {/* On a phone the actions take their own row and wrap inside it; from `sm`
          up they sit beside the title exactly as before. `shrink-0` without that
          fallback is how a header row ends up wider than the screen. */}
      {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">{actions}</div>}
    </div>
  );
}
