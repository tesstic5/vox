'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill, useToast } from '@/components/ui';
import { Icons } from '@/components/icons';

type Section = {
  id: string;
  label: string;
  prompt?: string;
  required?: boolean;
  kind?: 'short_text' | 'long_text' | 'number' | 'choice' | 'body_chart';
};

type Template = {
  id: string;
  name: string;
  sections: Section[];
  state: 'draft' | 'published' | 'retired';
  currentVersion: number;
  currentVersionId: string;
  revision: number;
};

type Version = {
  id: string;
  version: number;
  name: string;
  sections: Section[];
  state: Template['state'];
  changeReason: string;
  provenance: 'seed' | 'legacy_migration' | 'staff';
  authoredByName?: string;
  createdAt: string;
};
type BodyChartTemplate = { id: string; title: string; state: 'draft' | 'published' | 'retired'; sourceDocumentId: string; sourceDocumentVersionId: string; sourceMimeType: string; revision: number };
type WorkspaceImage = { id: string; title: string; ownerType: string; patientId?: string; status: string; currentVersionId?: string; currentScanStatus?: string };

const blankSection = (suffix = ''): Section => ({ id: suffix ? `section_${suffix}` : 'record', label: suffix ? 'New section' : 'Clinical record', prompt: '', required: false, kind: 'long_text' });

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? 'That clinical template action could not be completed.');
  return body as T;
}

export default function ClinicalTemplatesPage() {
  const toast = useToast();
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [selectedId, setSelectedId] = React.useState('');
  const [versions, setVersions] = React.useState<Version[]>([]);
  const [name, setName] = React.useState('');
  const [sections, setSections] = React.useState<Section[]>([blankSection()]);
  const [state, setState] = React.useState<Template['state']>('published');
  const [changeReason, setChangeReason] = React.useState('');
  const [isNew, setIsNew] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [chartTemplates, setChartTemplates] = React.useState<BodyChartTemplate[]>([]);
  const [workspaceImages, setWorkspaceImages] = React.useState<WorkspaceImage[]>([]);
  const [chartTitle, setChartTitle] = React.useState('');
  const [chartDocumentId, setChartDocumentId] = React.useState('');
  const [chartFile, setChartFile] = React.useState<File | null>(null);
  const [chartBusy, setChartBusy] = React.useState(false);
  const [chartMessage, setChartMessage] = React.useState('');
  const chartFileRef = React.useRef<HTMLInputElement>(null);
  const intent = React.useRef(0);

  const selected = templates.find((template) => template.id === selectedId);

  const loadChartLibrary = React.useCallback(async () => {
    try {
      const [templateBody, documentBody] = await Promise.all([
        json<{ data: BodyChartTemplate[] }>('/api/v1/body-chart-templates?include=retired'),
        json<{ data: WorkspaceImage[] }>('/api/v1/documents?ownerType=workspace'),
      ]);
      setChartTemplates(templateBody.data ?? []);
      const images = (documentBody.data ?? []).filter((row) => !row.patientId && row.ownerType === 'workspace' && row.status === 'active');
      setWorkspaceImages(images);
      setChartDocumentId((current) => current || images.find((row) => row.currentScanStatus === 'clean' && row.currentVersionId)?.id || '');
    } catch (error) {
      setChartMessage(error instanceof Error ? error.message : 'Body-chart library could not be loaded.');
    }
  }, []);

  const applyTemplate = React.useCallback((template: Template, history?: Version[]) => {
    setSelectedId(template.id);
    setName(template.name);
    setSections(template.sections.map((section) => ({ ...section })));
    setState(template.state);
    setVersions(history ?? []);
    setChangeReason('');
    setIsNew(false);
  }, []);

  React.useEffect(() => {
    const loadIntent = intent.current;
    void json<{ data: Template[] }>('/api/v1/note-templates')
      .then(async (body) => {
        setTemplates(body.data ?? []);
        const first = body.data?.[0];
        if (first) {
          const detail = await json<{ template: Template; versions: Version[] }>(`/api/v1/note-templates/${first.id}`);
          // A person may have pressed New while the first detail request was in
          // flight. Never let that late response replace their new draft.
          if (intent.current === loadIntent) applyTemplate(detail.template, detail.versions);
        }
      })
      .catch((error) => toast(error instanceof Error ? error.message : 'Clinical templates could not be loaded.', 'error'))
      .finally(() => setLoading(false));
  }, [applyTemplate, toast]);
  React.useEffect(() => { void loadChartLibrary(); }, [loadChartLibrary]);

  async function choose(id: string) {
    const chooseIntent = ++intent.current;
    setMessage('');
    try {
      const detail = await json<{ template: Template; versions: Version[] }>(`/api/v1/note-templates/${id}`);
      if (intent.current === chooseIntent) applyTemplate(detail.template, detail.versions);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That template could not be opened.', 'error');
    }
  }

  function startNew() {
    intent.current += 1;
    setSelectedId('');
    setName('');
    setSections([blankSection()]);
    setState('published');
    setVersions([]);
    setChangeReason('');
    setMessage('');
    setIsNew(true);
  }

  function changeSection(index: number, patch: Partial<Section>) {
    setSections((current) => current.map((section, at) => at === index ? { ...section, ...patch } : section));
  }

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const payload = isNew
        ? { action: 'create', name, sections, state }
        : {
            action: 'revise',
            id: selected?.id,
            expectedRevision: selected?.revision,
            name,
            sections,
            state,
            changeReason,
          };
      const body = await json<{ template: Template; version: Version }>('/api/v1/note-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setTemplates((current) => {
        const exists = current.some((template) => template.id === body.template.id);
        return exists ? current.map((template) => template.id === body.template.id ? body.template : template) : [body.template, ...current];
      });
      // The returned immutable version is evidence already committed by the
      // server. Insert it now; do not make the user reload to see what they made.
      setVersions((current) => [body.version, ...current.filter((version) => version.id !== body.version.id)].sort((a, b) => b.version - a.version));
      setSelectedId(body.template.id);
      setName(body.template.name);
      setSections(body.template.sections.map((section) => ({ ...section })));
      setState(body.template.state);
      setChangeReason('');
      setIsNew(false);
      setMessage(isNew ? 'Versioned note template created.' : `Version ${body.version.version} created. Earlier versions were not changed.`);
      toast(isNew ? 'Template version 1 created.' : `Template version ${body.version.version} created.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That version could not be created.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function uploadChartImage() {
    if (!chartFile || !chartTitle.trim()) return;
    setChartBusy(true);
    setChartMessage('');
    try {
      if (!['image/png', 'image/jpeg'].includes(chartFile.type)) throw new Error('Choose a PNG or JPEG image. SVG and executable formats are not accepted.');
      const me = await json<{ authenticated: boolean; org?: { id: string } }>('/api/auth/me');
      if (!me.authenticated || !me.org?.id) throw new Error('The workspace session could not be resolved.');
      const token = await json<{ uploadPath: string }>('/api/v1/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' },
        body: JSON.stringify({
          ownerType: 'workspace', ownerId: me.org.id, title: chartTitle.trim(), category: 'body_chart_template',
          allowedMimeTypes: [chartFile.type], maxBytes: chartFile.size,
        }),
      });
      await json(token.uploadPath, {
        method: 'PUT',
        headers: { 'content-type': chartFile.type, 'x-voxera-file-name': encodeURIComponent(chartFile.name), 'x-voxera-synthetic-data': '1' },
        body: chartFile,
      });
      setChartFile(null);
      if (chartFileRef.current) chartFileRef.current.value = '';
      setChartMessage('Image encrypted and uploaded. It remains unavailable as a template until malware scanning reports clean.');
      await loadChartLibrary();
    } catch (error) {
      setChartMessage(error instanceof Error ? error.message : 'The body-chart source image could not be uploaded.');
    } finally {
      setChartBusy(false);
    }
  }

  async function createChartTemplate() {
    const document = workspaceImages.find((row) => row.id === chartDocumentId);
    if (!document?.currentVersionId) return;
    setChartBusy(true);
    setChartMessage('');
    try {
      const body = await json<{ template: BodyChartTemplate }>('/api/v1/body-chart-templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', title: chartTitle.trim() || document.title, sourceDocumentId: document.id, sourceDocumentVersionId: document.currentVersionId, state: 'published' }),
      });
      setChartTitle('');
      setChartTemplates((current) => [body.template, ...current.filter((row) => row.id !== body.template.id)]);
      setChartMessage('Published template created. Its scanner-clean source-image version is immutable.');
      toast('Body-chart template published.', 'success');
    } catch (error) {
      setChartMessage(error instanceof Error ? error.message : 'The body-chart template could not be created.');
    } finally {
      setChartBusy(false);
    }
  }

  async function setChartState(template: BodyChartTemplate, next: BodyChartTemplate['state']) {
    setChartBusy(true);
    try {
      const body = await json<{ template: BodyChartTemplate }>('/api/v1/body-chart-templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set_state', id: template.id, expectedRevision: template.revision, state: next }),
      });
      setChartTemplates((current) => current.map((row) => row.id === body.template.id ? body.template : row));
      setChartMessage(`Template ${next}. Existing annotations still point to the exact source version.`);
    } catch (error) {
      setChartMessage(error instanceof Error ? error.message : 'The body-chart template state could not be changed.');
    } finally {
      setChartBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title="Clinical note templates"
        desc="Design the clinician-authored record schema. Every save creates a new immutable version; notes already opened keep the exact version they started with."
        actions={<Button variant="brand" size="sm" onClick={startNew}><Icons.plus size={14} /> New</Button>}
      />

      <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-4 text-[12.5px] leading-relaxed text-amber-950">
        <strong>Synthetic/test records only.</strong> Real patient data remains blocked until deployment evidence and independent UK security, privacy/legal and clinical-workflow reviews pass. Templates structure clinician-authored text; they do not diagnose, recommend treatment, prescribe or generate billing codes.
      </section>

      {message ? <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12.5px] text-emerald-800">{message}</div> : null}

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(220px,300px)_minmax(0,1fr)] xl:items-start">
        <aside className="panel min-w-0 p-4" aria-label="Clinical note templates">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold text-slate-900">Templates</h2>
            <span className="font-mono text-[10px] text-slateink-400">{templates.length}</span>
          </div>
          {loading ? <div className="h-24 animate-pulse rounded-xl bg-ink-850/40" /> : null}
          <div className="space-y-1.5">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => void choose(template.id)}
                className={`w-full min-w-0 rounded-xl border px-3 py-2.5 text-left transition ${selectedId === template.id ? 'border-brand-500/25 bg-brand-500/[0.07]' : 'border-slate-900/[0.05] bg-ink-900/30 hover:bg-ink-850/50'}`}
              >
                <span className="block truncate text-[12.5px] font-medium text-slate-900">{template.name}</span>
                <span className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-slateink-500"><span>{template.sections.length} sections</span><span className="font-mono">v{template.currentVersion}</span></span>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0 space-y-5">
          <section className="panel min-w-0 p-4 sm:p-5" aria-labelledby="template-editor-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="template-editor-title" className="text-[15px] font-semibold text-slate-900">{isNew ? 'New versioned template' : `Create version ${(selected?.currentVersion ?? 0) + 1}`}</h2>
                <p className="mt-1 text-[11.5px] text-slateink-400">Stable ids preserve section meaning across versions. Saving never edits an earlier schema.</p>
              </div>
              {!isNew && selected ? <Pill tone="brand">current v{selected.currentVersion}</Pill> : <Pill tone="info">version 1</Pill>}
            </div>

            <div className="mt-5 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
              <label className="min-w-0">
                <span className="label">Template name</span>
                <input className="field w-full text-[12.5px]" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                <span className="label">State</span>
                <select className="field w-full text-[12.5px]" value={state} onChange={(event) => setState(event.target.value as Template['state'])}>
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                  <option value="retired">Retired</option>
                </select>
              </label>
            </div>

            <div className="mt-5 space-y-3">
              {sections.map((section, index) => (
                <fieldset key={`${index}-${section.id}`} className="min-w-0 rounded-xl border border-slate-900/[0.06] bg-ink-900/30 p-3">
                  <legend className="px-1 font-mono text-[10px] uppercase tracking-[0.12em] text-slateink-400">Section {index + 1}</legend>
                  <div className="grid min-w-0 gap-3 md:grid-cols-2">
                    <label className="min-w-0"><span className="label">Stable id</span><input className="field w-full font-mono text-[12px]" value={section.id} onChange={(event) => changeSection(index, { id: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></label>
                    <label className="min-w-0"><span className="label">Heading</span><input className="field w-full text-[12px]" value={section.label} onChange={(event) => changeSection(index, { label: event.target.value })} /></label>
                  </div>
                  <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                    <label className="min-w-0"><span className="label">Prompt</span><input className="field w-full text-[12px]" value={section.prompt ?? ''} onChange={(event) => changeSection(index, { prompt: event.target.value })} /></label>
                    <label><span className="label">Input</span><select className="field w-full text-[12px]" value={section.kind ?? 'long_text'} onChange={(event) => changeSection(index, { kind: event.target.value as Section['kind'] })}>
                      <option value="long_text">Long text</option>
                      <option value="short_text">Short text</option>
                      <option value="number">Number</option>
                      <option value="choice">Choice</option>
                      <option value="body_chart">Body chart</option>
                    </select></label>
                  </div>
                  {section.kind === 'body_chart' ? <p className="mt-2 text-[11px] leading-relaxed text-slateink-500">The note opens an image-backed annotation slot here. Coordinates and the exact source-image version are frozen with signed evidence.</p> : null}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-[11.5px] text-slateink-400"><input type="checkbox" checked={Boolean(section.required)} onChange={(event) => changeSection(index, { required: event.target.checked })} />Required before finalisation</label>
                    {sections.length > 1 ? <Button variant="ghost" size="sm" onClick={() => setSections((current) => current.filter((_, at) => at !== index))}>Remove</Button> : null}
                  </div>
                </fieldset>
              ))}
            </div>

            <div className="mt-3"><Button variant="ghost" size="sm" onClick={() => setSections((current) => [...current, blankSection(String(current.length + 1))])}><Icons.plus size={13} /> Add section</Button></div>

            {!isNew ? (
              <label className="mt-5 block min-w-0">
                <span className="label">Why this version is changing</span>
                <textarea className="field min-h-[72px] w-full text-[12.5px]" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="A concise, clinician-owned change reason" />
              </label>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-900/[0.05] pt-4">
              <p className="max-w-xl text-[11px] leading-relaxed text-slateink-500">No generated diagnoses, treatment recommendations, prescriptions or billing codes. This designer stores structure only.</p>
              <Button variant="brand" size="sm" disabled={saving || !name.trim() || sections.some((section) => !section.id || !section.label) || (!isNew && !changeReason.trim())} onClick={() => void save()}>
                {saving ? 'Creating…' : `Create version ${isNew ? 1 : (selected?.currentVersion ?? 0) + 1}`}
              </Button>
            </div>
          </section>

          {!isNew ? (
            <section className="panel min-w-0 p-4 sm:p-5" aria-labelledby="version-history-title">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="version-history-title" className="text-[14px] font-semibold text-slate-900">Immutable version history</h2><Link href="/dashboard/clinical" className="text-[11.5px] text-brand-700 hover:underline">Clinical readiness</Link></div>
              <div className="mt-3 space-y-2">
                {versions.map((version) => (
                  <article key={version.id} className="rounded-xl border border-slate-900/[0.05] bg-ink-900/30 px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2"><Pill tone={version.version === selected?.currentVersion ? 'brand' : 'default'}>v{version.version}</Pill><span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900">{version.name}</span><span className="font-mono text-[10px] text-slateink-500">{new Date(version.createdAt).toLocaleString()}</span></div>
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-slateink-400">{version.changeReason}{version.authoredByName ? ` · ${version.authoredByName}` : ''}</p>
                    <p className="mt-1 font-mono text-[10px] text-slateink-500">{version.sections.map((section) => section.id).join(' · ')}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </main>
      </div>

      <section className="panel min-w-0 p-4 sm:p-5" aria-labelledby="body-chart-library-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 id="body-chart-library-title" className="text-[15px] font-semibold text-slate-900">Body-chart template library</h2><p className="mt-1 max-w-3xl text-[11.5px] leading-relaxed text-slateink-400">Upload a workspace-owned PNG or JPEG through the encrypted document lane. Only scanner-clean images can be published, and every annotation pins the exact source version.</p></div>
          <Pill tone="info">normalised 0–1 coordinates</Pill>
        </div>
        {chartMessage ? <div role="status" className="mt-3 rounded-xl border border-slate-900/[0.06] bg-ink-900/40 px-3 py-2 text-[11.5px] text-slateink-300">{chartMessage}</div> : null}
        <div className="mt-4 grid min-w-0 gap-5 lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] lg:items-start">
          <div className="space-y-4">
            <fieldset className="rounded-xl border border-slate-900/[0.06] bg-ink-900/30 p-3">
              <legend className="px-1 text-[11px] font-semibold text-slate-900">1 · Upload source image</legend>
              <label className="mt-2 block"><span className="label">Template title</span><input className="field w-full text-[12px]" value={chartTitle} onChange={(event) => setChartTitle(event.target.value)} placeholder="Anterior body" /></label>
              <label className="mt-3 block"><span className="label">PNG or JPEG</span><input ref={chartFileRef} type="file" accept="image/png,image/jpeg" onChange={(event) => setChartFile(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-[11px] text-slateink-400 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-900/[0.05] file:px-3 file:py-2 file:text-[11px]" /></label>
              <Button className="mt-3 w-full" variant="ghost" size="sm" disabled={chartBusy || !chartFile || !chartTitle.trim()} onClick={() => void uploadChartImage()}><Icons.cloud size={13} /> {chartBusy ? 'Working…' : 'Encrypt & upload'}</Button>
            </fieldset>
            <fieldset className="rounded-xl border border-slate-900/[0.06] bg-ink-900/30 p-3">
              <legend className="px-1 text-[11px] font-semibold text-slate-900">2 · Publish scanner-clean image</legend>
              <label className="mt-2 block"><span className="label">Workspace image</span><select className="field w-full text-[12px]" value={chartDocumentId} onChange={(event) => setChartDocumentId(event.target.value)}>
                <option value="">Choose a clean image</option>
                {workspaceImages.filter((row) => row.currentScanStatus === 'clean' && row.currentVersionId).map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
              </select></label>
              <Button className="mt-3 w-full" variant="brand" size="sm" disabled={chartBusy || !chartDocumentId} onClick={() => void createChartTemplate()}><Icons.plus size={13} /> Publish immutable source</Button>
              {workspaceImages.some((row) => row.currentScanStatus !== 'clean') ? <p className="mt-2 text-[10.5px] leading-relaxed text-amber-800">{workspaceImages.filter((row) => row.currentScanStatus !== 'clean').length} workspace image(s) remain quarantined or failed scanning and cannot be selected.</p> : null}
            </fieldset>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {chartTemplates.map((template) => (
              <article key={template.id} className="min-w-0 overflow-hidden rounded-xl border border-slate-900/[0.06] bg-white/60">
                <div className="aspect-[4/3] bg-slate-50 p-2">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={`/api/v1/body-chart-templates/${template.id}/source`} alt="" className="h-full w-full object-contain" /></div>
                <div className="p-3"><div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900">{template.title}</span><Pill tone={template.state === 'published' ? 'brand' : template.state === 'draft' ? 'warn' : 'default'}>{template.state}</Pill></div><p className="mt-1 truncate font-mono text-[9.5px] text-slateink-500">{template.sourceDocumentVersionId}</p>
                  <div className="mt-2 flex flex-wrap gap-2">{template.state === 'published' ? <Button variant="ghost" size="sm" disabled={chartBusy} onClick={() => void setChartState(template, 'retired')}>Retire</Button> : <Button variant="ghost" size="sm" disabled={chartBusy} onClick={() => void setChartState(template, 'published')}>Publish</Button>}</div>
                </div>
              </article>
            ))}
            {chartTemplates.length === 0 ? <div className="rounded-xl border border-dashed border-slate-900/10 p-6 text-center text-[11.5px] text-slateink-500 sm:col-span-2">No body-chart templates yet. Upload and scan a workspace image, then publish it here.</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
