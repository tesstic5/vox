'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

const RESOURCES = [
  ['processing-activities', 'Processing activities'],
  ['processors', 'Processors'],
  ['retention-policies', 'Retention'],
  ['retention-previews', 'Retention previews'],
  ['communication-policies', 'Communication data'],
  ['legal-holds', 'Legal holds'],
  ['deletion-requests', 'Deletion requests'],
  ['external-reviews', 'External reviews'],
  ['recovery-evidence', 'Recovery evidence'],
] as const;
type Resource = (typeof RESOURCES)[number][0];
type Row = Record<string, unknown> & { id: string; name?: string; status?: string; createdAt?: string };
type PrivacyProfile = {
  id: string; revision: number; controllerName: string; controllerAddress: string; controllerContactEmail: string;
  controllerContactPhone?: string; dpoName?: string; dpoEmail?: string; privacyNoticeVersion: string; privacyNoticeUrl: string;
  dpiaReference: string; dpiaStatus: 'not_started' | 'draft' | 'review_required' | 'approved_by_controller';
  dpiaReviewedAt?: string; dpiaReviewedBy?: string; auditCompleteFromAt?: string; breakGlassEnabled: boolean;
  breakGlassMaxMinutes: number; breakGlassNotify: string[];
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] font-medium text-slateink-500">{label}{children}</label>;
}
const inputClass = 'mt-1.5 w-full rounded-xl border border-slate-900/[0.08] bg-white px-3 py-2 text-[12px] text-slate-900 outline-none focus:border-brand-500/40';

export default function PrivacyGovernancePage() {
  const [resource, setResource] = React.useState<Resource>('processing-activities');
  const [data, setData] = React.useState<Record<Resource, Row[]>>({
    'processing-activities': [], processors: [], 'retention-policies': [], 'retention-previews': [], 'communication-policies': [], 'legal-holds': [],
    'deletion-requests': [], 'external-reviews': [], 'recovery-evidence': [],
  });
  const [profile, setProfile] = React.useState<PrivacyProfile | null>(null);
  const [profileSaving, setProfileSaving] = React.useState(false);
  const [form, setForm] = React.useState<Record<string, string | boolean>>({});
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setError('');
    const [entries, profileResponse] = await Promise.all([
      Promise.all(RESOURCES.map(async ([id]) => {
        const response = await fetch(`/api/v1/privacy/${id}`, { credentials: 'same-origin', cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message ?? `${id} could not be loaded.`);
        return [id, body.data ?? []] as const;
      })),
      fetch('/api/v1/privacy/profile', { credentials: 'same-origin', cache: 'no-store' }),
    ]);
    const profileBody = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok) throw new Error(profileBody?.error?.message ?? 'Controller profile could not be loaded.');
    setData(Object.fromEntries(entries) as Record<Resource, Row[]>);
    setProfile(profileBody as PrivacyProfile);
  }, []);

  React.useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Privacy records could not be loaded.')); }, [load]);
  React.useEffect(() => setForm({}), [resource]);
  const set = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  const payload = (): Record<string, unknown> => {
    if (resource === 'processing-activities') return {
      name: form.name, purpose: form.purpose, article6Basis: form.article6Basis, article9Condition: form.article9Condition,
      dataSubjects: String(form.dataSubjects ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      dataCategories: String(form.dataCategories ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      recipients: String(form.recipients ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      internationalTransfers: form.internationalTransfers === true, transferSafeguards: form.transferSafeguards,
      owner: form.owner, status: form.status || 'draft',
    };
    if (resource === 'processors') return {
      name: form.name, service: form.service, purpose: form.purpose, role: form.role || 'processor',
      hostingRegions: String(form.hostingRegions ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      receivesHealthData: form.receivesHealthData === true, dpaStatus: form.dpaStatus || 'not_reviewed',
      dpaReference: form.dpaReference, transferMechanism: form.transferMechanism, owner: form.owner, active: true,
    };
    if (resource === 'retention-policies') return {
      name: form.name, recordClass: form.recordClass, trigger: form.trigger || 'episode_closed',
      durationDays: Number(form.durationDays), disposition: form.disposition || 'review', rationale: form.rationale,
      status: form.status || 'draft', activationConfirmation: form.activationConfirmation,
    };
    if (resource === 'retention-previews') return { asOf: form.asOf || undefined, limit: Number(form.limit || 10_000) };
    if (resource === 'communication-policies') return {
      channel: form.channel || 'phone', recordingPurpose: form.recordingPurpose, transcriptPurpose: form.transcriptPurpose,
      noticeVersion: form.noticeVersion, contentRetentionDays: Number(form.contentRetentionDays),
      metadataRetentionDays: Number(form.metadataRetentionDays),
      allowedRoles: String(form.allowedRoles ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      assistantExposure: 'minimum_context', status: form.status || 'draft',
    };
    if (resource === 'legal-holds') return {
      scopeType: form.scopeType || 'patient', scopeId: form.scopeId, recordClass: form.recordClass, reason: form.reason,
    };
    if (resource === 'deletion-requests') return {
      requesterType: form.requesterType || 'patient', requesterReference: form.requesterReference,
      patientId: form.patientId, scope: form.scope, dueAt: form.dueAt,
    };
    if (resource === 'external-reviews') return {
      type: form.type, reviewerName: form.reviewerName, reviewerOrganisation: form.reviewerOrganisation,
      independent: form.independent === true, scope: form.scope, outcome: form.outcome || 'not_approved',
      reportReference: form.reportReference, reportSha256: form.reportSha256,
      reviewedAt: form.reviewedAt, expiresAt: form.expiresAt, actionsOpen: Number(form.actionsOpen ?? 0),
    };
    return {
      backupReference: form.backupReference, restoreTestedAt: form.restoreTestedAt, testedBy: form.testedBy,
      recoveryPointMinutes: form.recoveryPointMinutes ? Number(form.recoveryPointMinutes) : undefined,
      recoveryTimeMinutes: form.recoveryTimeMinutes ? Number(form.recoveryTimeMinutes) : undefined,
      outcome: form.outcome || 'failed', evidenceReference: form.evidenceReference,
    };
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/v1/privacy/${resource}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'The governance record could not be saved.');
      setForm({});
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The governance record could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const saveProfile = async () => {
    if (!profile) return;
    setProfileSaving(true);
    setError('');
    try {
      const response = await fetch('/api/v1/privacy/profile', {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...profile, expectedRevision: profile.revision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'Controller profile could not be saved.');
      setProfile(body as PrivacyProfile);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Controller profile could not be saved.');
    } finally {
      setProfileSaving(false);
    }
  };

  const current = data[resource];
  const label = RESOURCES.find(([id]) => id === resource)?.[1] ?? resource;

  return (
    <div className="space-y-6">
      <PageHeader title="Privacy, retention & evidence" desc="Controller-entered records for UK clinical setup. Voxera does not choose a lawful basis, retention period or processor conclusion for you." />
      <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[12.5px] leading-relaxed text-amber-900">
        Do not enter invented approvals. External-review and restore-evidence rows must point to work that actually happened. These records support accountability; they are not legal advice or a compliance certificate.
      </section>
      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div> : null}

      {profile ? <section className="panel p-5" aria-labelledby="controller-profile-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 id="controller-profile-title" className="text-[15px] font-semibold text-slate-900">Controller, privacy notice & DPIA</h2><p className="mt-1 text-[11.5px] text-slateink-400">Controller-entered evidence. Saving this record does not constitute legal approval.</p></div>
          <Button size="sm" disabled={profileSaving} onClick={() => void saveProfile()}>{profileSaving ? 'Saving…' : 'Save controller profile'}</Button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Controller legal name"><input className={inputClass} value={profile.controllerName} onChange={(e) => setProfile({ ...profile, controllerName: e.target.value })} /></Field>
          <Field label="Controller contact email"><input type="email" className={inputClass} value={profile.controllerContactEmail} onChange={(e) => setProfile({ ...profile, controllerContactEmail: e.target.value })} /></Field>
          <Field label="Controller contact phone"><input className={inputClass} value={profile.controllerContactPhone ?? ''} onChange={(e) => setProfile({ ...profile, controllerContactPhone: e.target.value })} /></Field>
          <Field label="Controller address"><textarea className={inputClass} value={profile.controllerAddress} onChange={(e) => setProfile({ ...profile, controllerAddress: e.target.value })} /></Field>
          <Field label="Privacy notice version"><input className={inputClass} value={profile.privacyNoticeVersion} onChange={(e) => setProfile({ ...profile, privacyNoticeVersion: e.target.value })} /></Field>
          <Field label="Privacy notice HTTPS URL"><input type="url" className={inputClass} value={profile.privacyNoticeUrl} onChange={(e) => setProfile({ ...profile, privacyNoticeUrl: e.target.value })} /></Field>
          <Field label="DPIA reference"><input className={inputClass} value={profile.dpiaReference} onChange={(e) => setProfile({ ...profile, dpiaReference: e.target.value })} /></Field>
          <Field label="DPIA status"><select className={inputClass} value={profile.dpiaStatus} onChange={(e) => setProfile({ ...profile, dpiaStatus: e.target.value as PrivacyProfile['dpiaStatus'] })}><option value="not_started">Not started</option><option value="draft">Draft</option><option value="review_required">Review required</option><option value="approved_by_controller">Approved by controller</option></select></Field>
          <Field label="DPIA reviewed at"><input type="date" className={inputClass} value={profile.dpiaReviewedAt?.slice(0, 10) ?? ''} onChange={(e) => setProfile({ ...profile, dpiaReviewedAt: e.target.value })} /></Field>
          <Field label="DPIA reviewed by"><input className={inputClass} value={profile.dpiaReviewedBy ?? ''} onChange={(e) => setProfile({ ...profile, dpiaReviewedBy: e.target.value })} /></Field>
          <Field label="Break-glass maximum minutes"><input type="number" min={5} max={240} className={inputClass} value={profile.breakGlassMaxMinutes} onChange={(e) => setProfile({ ...profile, breakGlassMaxMinutes: Number(e.target.value) })} /></Field>
          <Field label="Break-glass notification emails"><input className={inputClass} value={profile.breakGlassNotify.join(', ')} onChange={(e) => setProfile({ ...profile, breakGlassNotify: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-[11.5px] text-slateink-500"><input type="checkbox" checked={profile.breakGlassEnabled} onChange={(e) => setProfile({ ...profile, breakGlassEnabled: e.target.checked })} /> Enable controller-configured, time-limited emergency access (every grant is audited and queued for notification)</label>
        <p className="mt-2 text-[10.5px] text-slateink-400">Append-only clinical access history is marked complete from {profile.auditCompleteFromAt ? new Date(profile.auditCompleteFromAt).toLocaleString('en-GB') : 'the Phase 1 migration cutover has not been recorded'}; earlier operational history remains labelled legacy/capped.</p>
      </section> : null}

      <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)_minmax(320px,0.75fr)] xl:items-start">
        <nav className="panel p-2" aria-label="Privacy records">
          {RESOURCES.map(([id, text]) => (
            <button key={id} onClick={() => setResource(id)} className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[12.5px] ${resource === id ? 'bg-brand-500/[0.09] font-medium text-brand-800' : 'text-slateink-500 hover:bg-slate-900/[0.03]'}`}>
              <span>{text}</span><span className="font-mono text-[10px]">{data[id].length}</span>
            </button>
          ))}
          <Link href="/dashboard/clinical" className="mt-2 flex items-center justify-between border-t border-slate-900/[0.05] px-3 pt-3 text-[11.5px] font-medium text-brand-700">Readiness gate <Icons.arrowRight size={12} /></Link>
        </nav>

        <section className="panel overflow-hidden" aria-labelledby="privacy-records-title">
          <div className="border-b border-slate-900/[0.05] px-5 py-4">
            <h2 id="privacy-records-title" className="text-[15px] font-semibold text-slate-900">{label}</h2>
            <p className="mt-1 text-[11.5px] text-slateink-400">Server-backed, tenant-scoped and revisioned.</p>
          </div>
          <div className="divide-y divide-slate-900/[0.05]">
            {current.map((row) => (
              <article key={row.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[12.5px] font-semibold text-slate-900">{String(row.name ?? row.service ?? row.type ?? row.scope ?? row.backupReference ?? row.requesterReference ?? row.id)}</h3>
                  {row.status ? <Pill tone={row.status === 'active' || row.status === 'completed' ? 'brand' : row.status === 'blocked' ? 'danger' : 'default'}>{row.status}</Pill> : null}
                </div>
                <p className="mt-1 font-mono text-[10px] text-slateink-300">{row.id}</p>
                <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-slateink-400">
                  {String(row.purpose ?? row.rationale ?? row.reason ?? row.scope ?? row.evidenceReference ?? row.reportReference ?? 'Recorded metadata')}
                </p>
              </article>
            ))}
            {current.length === 0 ? <div className="px-5 py-12 text-center text-[12px] text-slateink-400">No {label.toLowerCase()} recorded.</div> : null}
          </div>
        </section>

        <section className="panel p-5" aria-labelledby="new-record-title">
          <h2 id="new-record-title" className="text-[14px] font-semibold text-slate-900">Add {label.toLowerCase().replace(/s$/, '')}</h2>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">Required fields are validated by the typed server workflow.</p>
          <div className="mt-4 space-y-3">
            {resource === 'processing-activities' ? <>
              <Field label="Name"><input className={inputClass} value={String(form.name ?? '')} onChange={(e) => set('name', e.target.value)} /></Field>
              <Field label="Purpose"><textarea className={inputClass} value={String(form.purpose ?? '')} onChange={(e) => set('purpose', e.target.value)} /></Field>
              <Field label="Article 6 basis"><input className={inputClass} value={String(form.article6Basis ?? '')} onChange={(e) => set('article6Basis', e.target.value)} /></Field>
              <Field label="Article 9 condition"><input className={inputClass} value={String(form.article9Condition ?? '')} onChange={(e) => set('article9Condition', e.target.value)} /></Field>
              <Field label="Data subjects (comma-separated)"><input className={inputClass} value={String(form.dataSubjects ?? '')} onChange={(e) => set('dataSubjects', e.target.value)} /></Field>
              <Field label="Data categories"><input className={inputClass} placeholder="health data, contact data" value={String(form.dataCategories ?? '')} onChange={(e) => set('dataCategories', e.target.value)} /></Field>
              <Field label="Recipients"><input className={inputClass} value={String(form.recipients ?? '')} onChange={(e) => set('recipients', e.target.value)} /></Field>
              <Field label="Controller owner"><input className={inputClass} value={String(form.owner ?? '')} onChange={(e) => set('owner', e.target.value)} /></Field>
              <Field label="Status"><select className={inputClass} value={String(form.status ?? 'draft')} onChange={(e) => set('status', e.target.value)}><option value="draft">Draft</option><option value="active">Active</option></select></Field>
            </> : null}

            {resource === 'processors' ? <>
              <Field label="Provider name"><input className={inputClass} value={String(form.name ?? '')} onChange={(e) => set('name', e.target.value)} /></Field>
              <Field label="Service"><input className={inputClass} value={String(form.service ?? '')} onChange={(e) => set('service', e.target.value)} /></Field>
              <Field label="Purpose"><textarea className={inputClass} value={String(form.purpose ?? '')} onChange={(e) => set('purpose', e.target.value)} /></Field>
              <Field label="Hosting regions"><input className={inputClass} value={String(form.hostingRegions ?? '')} onChange={(e) => set('hostingRegions', e.target.value)} /></Field>
              <label className="flex items-center gap-2 text-[11.5px] text-slateink-500"><input type="checkbox" checked={form.receivesHealthData === true} onChange={(e) => set('receivesHealthData', e.target.checked)} /> Receives health data</label>
              <Field label="DPA status"><select className={inputClass} value={String(form.dpaStatus ?? 'not_reviewed')} onChange={(e) => set('dpaStatus', e.target.value)}><option value="not_reviewed">Not reviewed</option><option value="reviewing">Reviewing</option><option value="signed">Signed</option><option value="not_applicable">Not applicable</option></select></Field>
              <Field label="DPA reference"><input className={inputClass} value={String(form.dpaReference ?? '')} onChange={(e) => set('dpaReference', e.target.value)} /></Field>
              <Field label="Controller owner"><input className={inputClass} value={String(form.owner ?? '')} onChange={(e) => set('owner', e.target.value)} /></Field>
            </> : null}

            {resource === 'retention-policies' ? <>
              <Field label="Policy name"><input className={inputClass} value={String(form.name ?? '')} onChange={(e) => set('name', e.target.value)} /></Field>
              <Field label="Record class"><select className={inputClass} value={String(form.recordClass ?? '')} onChange={(e) => set('recordClass', e.target.value)}><option value="">Select…</option><option value="patient_record">Patient record</option><option value="clinical_note">Clinical note</option><option value="clinical_document">Clinical document</option><option value="clinical_access_event">Clinical access event</option></select></Field>
              <Field label="Duration (days)"><input type="number" className={inputClass} value={String(form.durationDays ?? '')} onChange={(e) => set('durationDays', e.target.value)} /></Field>
              <Field label="Rationale"><textarea className={inputClass} value={String(form.rationale ?? '')} onChange={(e) => set('rationale', e.target.value)} /></Field>
              <Field label="Status"><select className={inputClass} value={String(form.status ?? 'draft')} onChange={(e) => set('status', e.target.value)}><option value="draft">Draft</option><option value="active">Active</option></select></Field>
              {form.status === 'active' ? <Field label="Type ACTIVATE CONTROLLER RETENTION POLICY"><input className={inputClass} value={String(form.activationConfirmation ?? '')} onChange={(e) => set('activationConfirmation', e.target.value)} /></Field> : null}
            </> : null}

            {resource === 'retention-previews' ? <>
              <p className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-[11px] leading-relaxed text-amber-900">This queues a review manifest only. It never deletes or anonymises records, and legal holds are evaluated while the governance lock is held.</p>
              <Field label="As of (optional)"><input type="datetime-local" className={inputClass} value={String(form.asOf ?? '')} onChange={(e) => set('asOf', e.target.value)} /></Field>
              <Field label="Candidate cap"><input type="number" className={inputClass} value={String(form.limit ?? '10000')} onChange={(e) => set('limit', e.target.value)} /></Field>
            </> : null}

            {resource === 'communication-policies' ? <>
              <Field label="Channel"><select className={inputClass} value={String(form.channel ?? 'phone')} onChange={(e) => set('channel', e.target.value)}><option value="phone">Phone</option><option value="sms">SMS</option><option value="email">Email</option><option value="web">Web</option></select></Field>
              <Field label="Recording purpose"><textarea className={inputClass} value={String(form.recordingPurpose ?? '')} onChange={(e) => set('recordingPurpose', e.target.value)} /></Field>
              <Field label="Transcript purpose"><textarea className={inputClass} value={String(form.transcriptPurpose ?? '')} onChange={(e) => set('transcriptPurpose', e.target.value)} /></Field>
              <Field label="Notice version"><input className={inputClass} value={String(form.noticeVersion ?? '')} onChange={(e) => set('noticeVersion', e.target.value)} /></Field>
              <Field label="Content retention days"><input type="number" className={inputClass} value={String(form.contentRetentionDays ?? '')} onChange={(e) => set('contentRetentionDays', e.target.value)} /></Field>
              <Field label="Metadata retention days"><input type="number" className={inputClass} value={String(form.metadataRetentionDays ?? '')} onChange={(e) => set('metadataRetentionDays', e.target.value)} /></Field>
              <Field label="Allowed roles (comma-separated)"><input className={inputClass} value={String(form.allowedRoles ?? '')} onChange={(e) => set('allowedRoles', e.target.value)} /></Field>
              <Field label="Status"><select className={inputClass} value={String(form.status ?? 'draft')} onChange={(e) => set('status', e.target.value)}><option value="draft">Draft</option><option value="active">Active</option></select></Field>
            </> : null}

            {resource === 'legal-holds' ? <>
              <Field label="Scope"><select className={inputClass} value={String(form.scopeType ?? 'patient')} onChange={(e) => set('scopeType', e.target.value)}><option value="patient">Patient</option><option value="resource">Resource</option><option value="record_class">Record class</option><option value="workspace">Workspace</option></select></Field>
              <Field label="Scope ID"><input className={inputClass} value={String(form.scopeId ?? '')} onChange={(e) => set('scopeId', e.target.value)} /></Field>
              <Field label="Reason"><textarea className={inputClass} value={String(form.reason ?? '')} onChange={(e) => set('reason', e.target.value)} /></Field>
            </> : null}

            {resource === 'deletion-requests' ? <>
              <Field label="Requester reference"><input className={inputClass} value={String(form.requesterReference ?? '')} onChange={(e) => set('requesterReference', e.target.value)} /></Field>
              <Field label="Patient ID (if applicable)"><input className={inputClass} value={String(form.patientId ?? '')} onChange={(e) => set('patientId', e.target.value)} /></Field>
              <Field label="Requested scope"><textarea className={inputClass} value={String(form.scope ?? '')} onChange={(e) => set('scope', e.target.value)} /></Field>
              <Field label="Due date"><input type="date" className={inputClass} value={String(form.dueAt ?? '')} onChange={(e) => set('dueAt', e.target.value)} /></Field>
            </> : null}

            {resource === 'external-reviews' ? <>
              <Field label="Review type"><select className={inputClass} value={String(form.type ?? '')} onChange={(e) => set('type', e.target.value)}><option value="">Select actual review…</option><option value="security">Security</option><option value="privacy_legal">UK privacy/legal</option><option value="clinical">Allied-health clinical</option></select></Field>
              <Field label="Reviewer"><input className={inputClass} value={String(form.reviewerName ?? '')} onChange={(e) => set('reviewerName', e.target.value)} /></Field>
              <Field label="Reviewer organisation"><input className={inputClass} value={String(form.reviewerOrganisation ?? '')} onChange={(e) => set('reviewerOrganisation', e.target.value)} /></Field>
              <label className="flex items-center gap-2 text-[11.5px] text-slateink-500"><input type="checkbox" checked={form.independent === true} onChange={(e) => set('independent', e.target.checked)} /> Reviewer was independent</label>
              <Field label="Scope"><textarea className={inputClass} value={String(form.scope ?? '')} onChange={(e) => set('scope', e.target.value)} /></Field>
              <Field label="Outcome"><select className={inputClass} value={String(form.outcome ?? 'not_approved')} onChange={(e) => set('outcome', e.target.value)}><option value="not_approved">Not approved</option><option value="approved_with_actions">Approved with actions</option><option value="approved">Approved</option></select></Field>
              <Field label="Open actions"><input type="number" className={inputClass} value={String(form.actionsOpen ?? '0')} onChange={(e) => set('actionsOpen', e.target.value)} /></Field>
              <Field label="Report reference"><input className={inputClass} value={String(form.reportReference ?? '')} onChange={(e) => set('reportReference', e.target.value)} /></Field>
              <Field label="Reviewed at"><input type="date" className={inputClass} value={String(form.reviewedAt ?? '')} onChange={(e) => set('reviewedAt', e.target.value)} /></Field>
              <Field label="Expires at"><input type="date" className={inputClass} value={String(form.expiresAt ?? '')} onChange={(e) => set('expiresAt', e.target.value)} /></Field>
            </> : null}

            {resource === 'recovery-evidence' ? <>
              <Field label="Backup reference"><input className={inputClass} value={String(form.backupReference ?? '')} onChange={(e) => set('backupReference', e.target.value)} /></Field>
              <Field label="Restore tested at"><input type="date" className={inputClass} value={String(form.restoreTestedAt ?? '')} onChange={(e) => set('restoreTestedAt', e.target.value)} /></Field>
              <Field label="Tested by"><input className={inputClass} value={String(form.testedBy ?? '')} onChange={(e) => set('testedBy', e.target.value)} /></Field>
              <Field label="Outcome"><select className={inputClass} value={String(form.outcome ?? 'failed')} onChange={(e) => set('outcome', e.target.value)}><option value="failed">Failed</option><option value="passed">Passed</option></select></Field>
              <Field label="Evidence reference"><input className={inputClass} value={String(form.evidenceReference ?? '')} onChange={(e) => set('evidenceReference', e.target.value)} /></Field>
            </> : null}

            <Button className="w-full" size="sm" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save server record'}</Button>
          </div>
        </section>
      </div>
    </div>
  );
}
