'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type ShadowEvent = { id: string; userId: string; permission: string; legacyAllowed: boolean; granularAllowed: boolean; decisionSource: string; at: string };

type Role = {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  scopes: Record<string, string>;
  system: boolean;
  legacyBaseRole: string;
  revision: number;
};

export default function GranularRolesPage() {
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [catalogue, setCatalogue] = React.useState<string[]>([]);
  const [shadow, setShadow] = React.useState<{ disagreements: number; latestAt?: string } | null>(null);
  const [shadowEvents, setShadowEvents] = React.useState<ShadowEvent[]>([]);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [base, setBase] = React.useState('receptionist');
  const [permissions, setPermissions] = React.useState<Set<string>>(new Set(['workspace.read', 'clients.read', 'schedule.read']));
  const [scope, setScope] = React.useState('all');
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const [response, shadowResponse] = await Promise.all([
      fetch('/api/v1/roles', { credentials: 'same-origin', cache: 'no-store' }),
      fetch('/api/v1/roles/shadow', { credentials: 'same-origin', cache: 'no-store' }),
    ]);
    const [body, shadowBody] = await Promise.all([response.json().catch(() => ({})), shadowResponse.json().catch(() => ({}))]);
    if (!response.ok) throw new Error(body?.error?.message ?? 'Roles could not be loaded.');
    if (!shadowResponse.ok) throw new Error(shadowBody?.error?.message ?? 'Permission comparisons could not be loaded.');
    setRoles(body.data ?? []);
    setCatalogue(body.permissions ?? []);
    setShadow(body.shadow ?? null);
    setShadowEvents(shadowBody.data ?? []);
  }, []);

  React.useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Roles could not be loaded.')); }, [load]);

  const toggle = (permission: string) => setPermissions((current) => {
    const next = new Set(current);
    if (next.has(permission)) next.delete(permission); else next.add(permission);
    return next;
  });

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/v1/roles', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name, description, legacyBaseRole: base, permissions: [...permissions],
          scopes: { clients: scope, cases: scope, clinical: scope, documents: scope, schedule: scope },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'Role could not be created.');
      setName(''); setDescription('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Role could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const resolveShadow = async (event: ShadowEvent) => {
    const resolution = window.prompt('Record why this difference is accepted or how it was corrected.');
    if (!resolution) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/v1/roles/shadow', {
        method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: event.id, resolution }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? body?.error ?? 'Permission comparison could not be resolved.');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Permission comparison could not be resolved.');
    } finally {
      setSaving(false);
    }
  };

  const grouped = React.useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const permission of catalogue) {
      const area = permission.split('.')[0];
      groups.set(area, [...(groups.get(area) ?? []), permission]);
    }
    return [...groups.entries()];
  }, [catalogue]);

  return (
    <div className="space-y-6">
      <PageHeader title="Granular roles" desc="Explicit permissions and patient/caseload scope. Existing fixed roles remain as compatibility templates while disagreement shadowing is reviewed." />
      <section className="rounded-2xl border border-slate-900/[0.06] bg-slate-900/[0.025] p-4 text-[12.5px] leading-relaxed text-slateink-500">
        Navigation is not authorisation. Typed clinical routes evaluate permission and record scope on the server; custom roles also receive a fail-closed route-policy backstop. Owner identity remains protected by the system owner role.
      </section>
      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
        <section className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-900/[0.05] px-5 py-4">
            <div><h2 className="text-[15px] font-semibold text-slate-900">Workspace roles</h2><p className="mt-1 text-[11.5px] text-slateink-400">{roles.length} template(s) and custom role(s)</p></div>
            <Pill tone={shadow?.disagreements ? 'warn' : 'brand'}>{shadow?.disagreements ?? 0} shadow disagreement(s)</Pill>
          </div>
          <div className="divide-y divide-slate-900/[0.05]">
            {roles.map((role) => (
              <article key={role.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-[13px] font-semibold text-slate-900">{role.name}</h3><Pill tone={role.system ? 'default' : 'brand'}>{role.system ? 'system' : 'custom'}</Pill></div>
                <p className="mt-1 text-[11.5px] text-slateink-400">{role.description ?? `Compatibility base: ${role.legacyBaseRole}`}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {role.permissions.slice(0, 8).map((permission) => <span key={permission} className="rounded-md bg-slate-900/[0.04] px-2 py-1 font-mono text-[9px] text-slateink-500">{permission}</span>)}
                  {role.permissions.length > 8 ? <span className="px-1 py-1 text-[9.5px] text-slateink-300">+{role.permissions.length - 8}</span> : null}
                </div>
                <p className="mt-2 font-mono text-[9.5px] text-slateink-300">scope: {Object.entries(role.scopes).map(([area, value]) => `${area}=${value}`).join(' · ')}</p>
              </article>
            ))}
          </div>
          <div className="border-t border-slate-900/[0.05] px-5 py-4"><Link href="/dashboard/team" className="text-[12px] font-medium text-brand-700">Open Team to manage members <Icons.arrowRight size={12} className="ml-1 inline" /></Link></div>
        </section>

        <aside className="panel p-5">
          <h2 className="text-[14px] font-semibold text-slate-900">Create custom role</h2>
          <div className="mt-4 space-y-3">
            <label className="block text-[11px] font-medium text-slateink-500">Name<input value={name} onChange={(e) => setName(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px] outline-none focus:border-brand-500/40" /></label>
            <label className="block text-[11px] font-medium text-slateink-500">Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px] outline-none focus:border-brand-500/40" /></label>
            <label className="block text-[11px] font-medium text-slateink-500">Legacy compatibility base<select value={base} onChange={(e) => setBase(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="receptionist">Receptionist</option><option value="practitioner">Practitioner</option><option value="viewer">Viewer</option><option value="admin">Admin</option><option value="developer">Developer</option></select></label>
            <label className="block text-[11px] font-medium text-slateink-500">Patient-record scope<select value={scope} onChange={(e) => setScope(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="all">All records</option><option value="caseload">Assigned caseload</option><option value="explicit">Explicit grants only</option><option value="none">No patient records</option></select></label>
            <div>
              <h3 className="text-[11px] font-medium text-slateink-500">Permissions</h3>
              <div className="mt-2 max-h-[390px] space-y-3 overflow-y-auto rounded-xl border border-slate-900/[0.06] p-3">
                {grouped.map(([area, items]) => <div key={area}><div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slateink-300">{area}</div>{items.map((permission) => <label key={permission} className="flex items-center gap-2 py-1 text-[10.5px] text-slateink-500"><input type="checkbox" checked={permissions.has(permission)} onChange={() => toggle(permission)} /> {permission}</label>)}</div>)}
              </div>
            </div>
            <Button className="w-full" size="sm" disabled={saving || name.trim().length < 2} onClick={() => void create()}>{saving ? 'Creating…' : 'Create custom role'}</Button>
          </div>
        </aside>
      </div>

      <section className="panel overflow-hidden" aria-labelledby="shadow-title">
        <div className="border-b border-slate-900/[0.05] px-5 py-4">
          <h2 id="shadow-title" className="text-[14px] font-semibold text-slate-900">Unresolved fixed-role comparisons</h2>
          <p className="mt-1 text-[11.5px] text-slateink-400">One event is retained per user, role revision, permission and decision shape. Resolution is auditable and never changes the enforced result.</p>
        </div>
        {shadowEvents.length === 0 ? <p className="px-5 py-5 text-[12px] text-slateink-400">No unresolved differences.</p> : (
          <div className="divide-y divide-slate-900/[0.05]">
            {shadowEvents.map((event) => (
              <div key={event.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-[11.5px]">
                <span className="min-w-0 flex-1"><span className="font-mono text-[10px] text-slate-900">{event.permission}</span><span className="ml-2 text-slateink-400">fixed {String(event.legacyAllowed)} · granular {String(event.granularAllowed)} · {event.decisionSource}</span></span>
                <span className="text-[10px] text-slateink-300">{new Date(event.at).toLocaleString()}</span>
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => void resolveShadow(event)}>Review & resolve</Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
