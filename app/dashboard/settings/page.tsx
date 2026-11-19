'use client';

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { Icons } from '@/components/icons';
import { Button, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-900/[0.04] py-3 first:pt-0 last:border-0 last:pb-0">
      <dt className="text-[12.5px] text-slateink-400">{label}</dt>
      <dd className="max-w-full break-words text-right font-mono text-[12px] text-slate-900">{value}</dd>
    </div>
  );
}

function Destination({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: keyof typeof Icons;
  title: string;
  description: string;
}) {
  const Icon = Icons[icon];
  return (
    <Link href={href} className="panel group flex min-h-28 items-start gap-4 p-5 transition-colors hover:border-brand-500/25">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-900/[0.05] bg-slate-900/[0.03] text-brand-700">
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold text-slate-900">
          {title} <Icons.arrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1.5 block text-[12px] leading-relaxed text-slateink-400">{description}</span>
      </span>
    </Link>
  );
}

export default function SettingsPage() {
  const store = useStore();
  const toast = useToast();
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState('');
  const org = store.connection.org;
  const user = store.connection.user;
  const business = org?.business;

  const exportWorkspace = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const response = await fetch('/api/v1/workspaces/export', { credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'The workspace export could not be created.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = response.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'voxera-workspace-export.json';
      anchor.click();
      URL.revokeObjectURL(url);
      toast('Workspace export downloaded.');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The workspace export could not be created.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        desc="Verified workspace state and links to the screens that own each setting. Values that are not connected are not invented here."
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] xl:items-start">
        <section className="panel p-5" aria-labelledby="workspace-state-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="workspace-state-title" className="text-[15px] font-semibold text-slate-900">Workspace state</h2>
              <p className="mt-1.5 text-[12px] text-slateink-400">Read from the signed-in session and workspace profile.</p>
            </div>
            <Pill tone={store.connection.status === 'live' ? 'brand' : store.connection.status === 'error' ? 'danger' : 'warn'}>
              {store.connection.status}
            </Pill>
          </div>

          <dl className="mt-5">
            <Row label="Display name" value={org?.name ?? 'Unavailable until the workspace connects'} />
            <Row label="Workspace ID" value={org?.id ?? 'Unavailable'} />
            <Row label="Plan" value={org?.plan ?? 'Unavailable'} />
            <Row label="Region" value={org?.region ?? 'Not configured'} />
            <Row label="Signed in as" value={user ? `${user.name} · ${user.role ?? 'member'}` : 'Unavailable'} />
            <Row label="Business type" value={business?.configured ? business.type.replaceAll('_', ' ') : 'Not selected for this existing workspace'} />
            <Row label="Enabled modules" value={business?.modules?.length ? business.modules.join(', ') : 'No profile-backed module list available'} />
          </dl>
          {store.connection.error ? <div role="alert" className="mt-4 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3.5 py-3 text-[12px] text-red-700">{store.connection.error}</div> : null}
        </section>

        <section className="panel p-5" aria-labelledby="export-title">
          <h2 id="export-title" className="text-[15px] font-semibold text-slate-900">Export this workspace</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">
            Download the records this workspace owns as JSON. Password hashes, API-key hashes, credentials and sessions are excluded or redacted. The export is written to the audit log.
          </p>
          <Button variant="ghost" size="sm" className="mt-4" disabled={exporting || !user} onClick={() => void exportWorkspace()}>
            <Icons.download size={13} /> {exporting ? 'Preparing…' : 'Download workspace export'}
          </Button>
          {exportError ? <div role="alert" className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3.5 py-2.5 text-[12px] text-red-700">{exportError}</div> : null}
        </section>
      </div>

      <section aria-labelledby="settings-destinations-title">
        <div className="mb-3">
          <h2 id="settings-destinations-title" className="text-[15px] font-semibold text-slate-900">Configuration</h2>
          <p className="mt-1 text-[12px] text-slateink-400">Each link opens the server-backed screen responsible for that area.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Destination href="/dashboard/business" icon="building" title="Business profile & modules" description="Business type, terminology, locale, currency and owner-selected modules." />
          <Destination href="/dashboard/settings/security" icon="shield" title="Account security" description="Real authenticator enrolment, recovery codes and password-reset access." />
          <Destination href="/dashboard/settings/privacy" icon="shield" title="Privacy, retention & evidence" description="Controller-entered processing, processor, retention, legal-hold, deletion and review records." />
          <Destination href="/dashboard/settings/roles" icon="users" title="Granular roles" description="Explicit permissions, record scope, custom roles and migration shadow status." />
          <Destination href="/dashboard/providers" icon="layers" title="AI providers" description="Inspect provider capability and add encrypted bring-your-own credentials where supported." />
          <Destination href="/dashboard/webhooks" icon="send" title="Webhooks" description="Create endpoints and inspect delivery attempts from the webhook service." />
          <Destination href="/dashboard/billing" icon="dollar" title="Platform billing" description="Usage and platform invoices recorded for this workspace. No payment card is assumed." />
          <Destination href="/dashboard/audit" icon="terminal" title="Audit log" description="Review workspace actions recorded by authenticated server routes." />
        </div>
      </section>

      <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5" aria-labelledby="deployment-boundaries-title">
        <h2 id="deployment-boundaries-title" className="text-[14px] font-semibold text-amber-900">Deployment boundaries</h2>
        <p className="mt-2 max-w-4xl text-[12.5px] leading-relaxed text-amber-900">
          Clinical retention, processor, legal-hold and deletion-request records now have a dedicated reviewed workflow under Privacy & retention; nothing is activated by this summary screen. Data residency conclusions, SSO/SCIM, payment-card management and workspace deletion remain separate deployment/provider work. Live telephony, email, AI delivery and payment settlement also depend on configured external providers.
        </p>
      </section>
    </div>
  );
}
