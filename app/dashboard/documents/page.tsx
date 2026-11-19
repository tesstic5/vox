'use client';

import * as React from 'react';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type DocumentRow = {
  id: string;
  patientId?: string;
  title: string;
  category: string;
  status: 'active' | 'archived' | 'metadata_only';
  versionCount: number;
  currentScanStatus?: 'clean' | 'infected' | 'error' | 'unavailable';
  currentVersionId?: string;
  updatedAt?: string;
  createdAt?: string;
  legacySource?: { id: string; metadataOnly: true };
  links?: Array<{ id: string; resourceType: string; resourceId: string; relationship: string; visibleInPortal: false }>;
};

export default function ClinicalDocumentsPage() {
  const [rows, setRows] = React.useState<DocumentRow[]>([]);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [patientId, setPatientId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [category, setCategory] = React.useState('clinical_document');
  const [search, setSearch] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/v1/documents', { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'Documents could not be loaded.');
      setRows(body.data ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Documents could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('patientId');
    if (requested) setPatientId(requested);
  }, []);

  const visibleRows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => (!patientId.trim() || row.patientId === patientId.trim()) &&
      (!needle || `${row.title} ${row.category} ${row.id}`.toLowerCase().includes(needle)));
  }, [rows, patientId, search]);

  const upload = async () => {
    if (!file || !patientId.trim() || !title.trim()) return;
    setUploading(true);
    setError('');
    try {
      const tokenResponse = await fetch('/api/v1/documents', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' },
        body: JSON.stringify({ ownerType: 'patient', ownerId: patientId.trim(), patientId: patientId.trim(), title: title.trim(), category, allowedMimeTypes: [file.type], maxBytes: file.size }),
      });
      const tokenBody = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok) throw new Error(tokenBody?.error?.message ?? 'An upload token could not be created.');
      const response = await fetch(tokenBody.uploadPath, {
        method: 'PUT', credentials: 'same-origin', body: file,
        headers: { 'content-type': file.type, 'x-voxera-file-name': encodeURIComponent(file.name), 'x-voxera-synthetic-data': '1' },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'The document could not be uploaded.');
      setTitle('');
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The document could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  const migrateLegacy = async () => {
    setError('');
    const response = await fetch('/api/v1/documents/legacy-migration', { method: 'POST', credentials: 'same-origin' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(body?.error?.message ?? 'Legacy metadata migration failed.');
    else await load();
  };

  const scanTone = (row: DocumentRow) => row.status === 'metadata_only' ? 'default' : row.currentScanStatus === 'clean' ? 'brand' : row.currentScanStatus === 'infected' ? 'danger' : 'warn';

  return (
    <div className="space-y-6">
      <PageHeader title="Clinical documents" desc="Encrypted object bytes, immutable versions and quarantine-first downloads. Legacy file rows remain explicitly metadata-only." />

      <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">
        This screen sends the synthetic-data acknowledgement while the workspace is in test mode. Do not upload real patient material until Clinical foundation reports every live gate as passed and an owner activates live mode.
      </section>
      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div> : null}

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)] xl:items-start">
        <section className="panel p-5" aria-labelledby="upload-title">
          <h2 id="upload-title" className="text-[15px] font-semibold text-slate-900">Upload a version</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slateink-400">The patient ID is checked server-side. A token lasts 15 minutes and is consumed once.</p>
          <div className="mt-4 space-y-3">
            <label className="block text-[11px] font-medium text-slateink-500">Patient ID
              <input value={patientId} onChange={(event) => setPatientId(event.target.value)} placeholder="cli_…" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[12px] outline-none focus:border-brand-500/40" />
            </label>
            <label className="block text-[11px] font-medium text-slateink-500">Document title
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Referral letter" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px] outline-none focus:border-brand-500/40" />
            </label>
            <label className="block text-[11px] font-medium text-slateink-500">Category
              <input value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px] outline-none focus:border-brand-500/40" />
            </label>
            <label className="block text-[11px] font-medium text-slateink-500">PDF, JPEG, PNG, text or DOCX
              <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.txt,.docx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="mt-1.5 block w-full text-[11px] text-slateink-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900/[0.05] file:px-3 file:py-2 file:text-[11px] file:font-medium" />
            </label>
            <Button className="w-full" size="sm" disabled={uploading || !file || !patientId.trim() || !title.trim()} onClick={() => void upload()}>
              <Icons.cloud size={13} /> {uploading ? 'Encrypting & uploading…' : 'Upload to quarantine'}
            </Button>
          </div>
        </section>

        <section className="panel overflow-hidden" aria-labelledby="document-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-900/[0.05] px-5 py-4">
            <div className="min-w-[220px] flex-1">
              <h2 id="document-list-title" className="text-[15px] font-semibold text-slate-900">Server documents</h2>
              <p className="mt-1 text-[11.5px] text-slateink-400">{loading ? 'Loading…' : `${visibleRows.length} of ${rows.length} record(s)`}</p>
              <label className="mt-3 block max-w-md text-[10.5px] font-medium text-slateink-400">Search title, category or document ID
                <input value={search} onChange={(event) => setSearch(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px] outline-none focus:border-brand-500/40" placeholder="Search documents" />
              </label>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => void migrateLegacy()}>Migrate legacy metadata</Button>
              <a href="/api/v1/documents?view=export" className="btn-ghost btn-sm"><Icons.download size={13} /> Manifest</a>
            </div>
          </div>
          <div className="divide-y divide-slate-900/[0.05]">
            {visibleRows.map((row) => (
              <article key={row.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-900/[0.04] text-slateink-500"><Icons.book size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[13px] font-semibold text-slate-900">{row.title}</h3>
                    <Pill tone={scanTone(row) as 'default' | 'brand' | 'danger' | 'warn'}>
                      {row.status === 'metadata_only' ? 'metadata only' : row.currentScanStatus ?? 'scan pending'}
                    </Pill>
                  </div>
                  <p className="mt-1 font-mono text-[10.5px] text-slateink-400">{row.id} · patient {row.patientId ?? 'not linked'} · {row.versionCount} version(s)</p>
                  <p className="mt-1 text-[10.5px] text-slateink-400">
                    Linked records: {row.links?.length ? row.links.map((link) => `${link.relationship} ${link.resourceType}:${link.resourceId}`).join(' · ') : 'none recorded'}
                  </p>
                  {row.status === 'metadata_only' ? <p className="mt-1 text-[11px] text-amber-800">No bytes, encryption status or scan result were inferred from the legacy row.</p> : null}
                </div>
                {row.currentScanStatus === 'clean' && row.currentVersionId ? (
                  <a href={`/api/v1/documents/${encodeURIComponent(row.id)}/download`} className="btn-ghost btn-sm"><Icons.download size={13} /> Download</a>
                ) : <span className="text-[10.5px] text-slateink-300">Download blocked</span>}
              </article>
            ))}
            {!loading && visibleRows.length === 0 ? <div className="px-5 py-12 text-center text-[12.5px] text-slateink-400">No clinical document records match this patient/filter.</div> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
