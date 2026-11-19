'use client';

import * as React from 'react';
import { request } from '@/lib/server-sync';
import {
  BUSINESS_TYPE_OPTIONS,
  MODULES,
  MODULE_IDS,
  moduleDefinition,
  modulesWithDependencies,
  recommendedModules,
  recommendedTermPack,
  type BusinessHoursRow,
  type BusinessType,
  type EffectiveBusinessProfile,
  type ModuleId,
} from '@/lib/business';
import type { TermPackId } from '@/lib/terms';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

type ProfileResponse = {
  business: EffectiveBusinessProfile;
  vocabulary: TermPackId;
  money: { currency: string };
  canEdit: boolean;
  vocabularies: Array<{ id: TermPackId; description: string }>;
  currencies: string[];
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
];

function hoursFrom(rows?: BusinessHoursRow[]): BusinessHoursRow[] {
  const byDay = new Map((rows ?? []).map((row) => [row.weekday, row]));
  return DAYS.map((_, weekday) => byDay.get(weekday) ?? { weekday, open: false, start: '09:00', end: '17:00' });
}

export default function BusinessProfilePage() {
  const toast = useToast();
  const [data, setData] = React.useState<ProfileResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [type, setType] = React.useState<BusinessType>('other');
  const [otherDescription, setOtherDescription] = React.useState('');
  const [modules, setModules] = React.useState<ModuleId[]>([]);
  const [country, setCountry] = React.useState('');
  const [timezone, setTimezone] = React.useState('');
  const [currency, setCurrency] = React.useState('USD');
  const [termPack, setTermPack] = React.useState<TermPackId>('generic');
  const [hours, setHours] = React.useState<BusinessHoursRow[]>(hoursFrom());

  const adopt = React.useCallback((next: ProfileResponse) => {
    setData(next);
    setType(next.business.type);
    setOtherDescription(next.business.otherDescription ?? '');
    setModules(next.business.modules);
    setCountry(next.business.country ?? '');
    setTimezone(next.business.timezone ?? '');
    setCurrency(next.business.currency ?? next.money.currency ?? 'USD');
    setTermPack(next.vocabulary);
    setHours(hoursFrom(next.business.businessHours));
  }, []);

  const load = React.useCallback(async () => {
    setError('');
    try {
      adopt(await request<ProfileResponse>('GET', '/api/v1/workspace/profile'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workspace profile could not be loaded.');
    }
  }, [adopt]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggleModule = (id: ModuleId) => {
    if (!data?.canEdit) return;
    setModules((current) => {
      if (!current.includes(id)) return modulesWithDependencies([...current, id]);
      // Removing a dependency also removes modules that could no longer work.
      const selected = new Set(current.filter((module) => module !== id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const module of [...selected]) {
          if (moduleDefinition(module).dependencies.some((dependency) => !selected.has(dependency))) {
            selected.delete(module);
            changed = true;
          }
        }
      }
      return MODULE_IDS.filter((module) => selected.has(module));
    });
  };

  const save = async () => {
    if (!data?.canEdit || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await request<ProfileResponse>('PATCH', '/api/v1/workspace/profile', {
        type,
        otherDescription: type === 'other' ? otherDescription.trim() : '',
        modules,
        country: country.trim(),
        timezone: timezone.trim(),
        currency,
        businessHours: hours,
        termPack,
      });
      adopt(next);
      toast('Business profile and dashboard modules saved.', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The profile could not be saved.';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <>
        <PageHeader title="Business profile" desc="Loading this workspace's type, language and modules…" />
        <div className="panel p-6">
          {error ? <p role="alert" className="text-[13px] text-rose-700">{error}</p> : <div className="h-4 w-56 animate-pulse rounded bg-slate-900/[0.06]" />}
        </div>
      </>
    );
  }

  const recommended = modulesWithDependencies(recommendedModules(type));
  const changedFromRecommendation = recommended.some((id) => !modules.includes(id)) || modules.some((id) => !recommended.includes(id));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Business profile"
        desc="Choose the words and everyday tools this workspace uses. Modules organise the interface; role permissions still protect every action on the server."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Business profile' }]}
        actions={
          <Button variant="brand" size="sm" disabled={!data.canEdit || busy} onClick={() => void save()}>
            {busy ? <Icons.refresh size={13} className="animate-spin" /> : <Icons.check size={13} />}
            {busy ? 'Saving…' : 'Save profile'}
          </Button>
        }
      />

      {!data.business.configured && (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
          <div className="flex items-start gap-3">
            <Icons.alert size={15} className="mt-0.5 shrink-0 text-amber-800" />
            <div>
              <h2 className="text-[13.5px] font-medium text-slate-900">This is an existing workspace</h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slateink-300">
                Nothing has been guessed or changed. Every module remains available until an owner or admin saves a choice here.
              </p>
            </div>
          </div>
        </div>
      )}

      {!data.canEdit && (
        <div className="rounded-2xl border border-slate-900/[0.06] bg-slate-900/[0.02] p-4 text-[12.5px] text-slateink-300">
          You can view this setup, but only a workspace owner or admin can change it.
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-[12.5px] text-rose-700">
          {error}
        </div>
      )}

      <section className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">1. Business type</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-slateink-400">
              Type controls recommendations only. Changing it never rewrites customers, appointments, estimates, notes or invoices.
            </p>
          </div>
          <Pill tone="info">recommendation, not a restriction</Pill>
        </div>
        <fieldset className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <legend className="sr-only">Business type</legend>
          {BUSINESS_TYPE_OPTIONS.map((option) => (
            <label
              key={option.id}
              className={cn(
                'rounded-xl border p-4 transition-colors',
                data.canEdit ? 'cursor-pointer' : 'cursor-default opacity-80',
                type === option.id ? 'border-brand-500/45 bg-brand-500/[0.07]' : 'border-slate-900/[0.055] bg-ink-900/30'
              )}
            >
              <span className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name="business-profile-type"
                  checked={type === option.id}
                  disabled={!data.canEdit}
                  onChange={() => setType(option.id)}
                  className="mt-0.5 accent-emerald-500"
                />
                <span>
                  <span className="block text-[13px] font-medium text-slate-900">{option.label}</span>
                  <span className="mt-1 block text-[11.5px] leading-relaxed text-slateink-400">{option.description}</span>
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {type === 'other' && (
          <div className="mt-4 max-w-xl">
            <label htmlFor="business-description" className="label">Short description <span className="text-slateink-400">(optional)</span></label>
            <input
              id="business-description"
              className="field"
              maxLength={120}
              disabled={!data.canEdit}
              value={otherDescription}
              onChange={(event) => setOtherDescription(event.target.value)}
              placeholder="For example, property management"
            />
          </div>
        )}
      </section>

      <section className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">2. Everyday modules</h2>
            <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">
              Selected modules appear in everyday navigation. Turning one off hides shortcuts only: it does not delete records, bypass permissions or stop live automation.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!data.canEdit || !changedFromRecommendation}
            onClick={() => setModules(recommended)}
          >
            <Icons.sparkles size={13} /> Use recommended modules
          </Button>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {MODULES.map((module) => {
            const selected = modules.includes(module.id);
            return (
              <label
                key={module.id}
                className={cn(
                  'rounded-xl border p-4 transition-colors',
                  data.canEdit ? 'cursor-pointer' : 'cursor-default',
                  selected ? 'border-brand-500/35 bg-brand-500/[0.055]' : 'border-slate-900/[0.055] bg-ink-900/25'
                )}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!data.canEdit}
                    onChange={() => toggleModule(module.id)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-slate-900">{module.label}</span>
                    <span className="mt-1 block text-[11.5px] leading-relaxed text-slateink-400">{module.description}</span>
                    {module.dependencies.length > 0 && (
                      <span className="mt-2 block font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">
                        needs {module.dependencies.map((id) => moduleDefinition(id).label).join(' + ')}
                      </span>
                    )}
                    {module.consequence && <span className="mt-2 block text-[10.5px] leading-relaxed text-amber-800">{module.consequence}</span>}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-900">3. Locale and business hours</h2>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">
            Confirm these rather than relying on a sample workspace. Team rotas and location hours remain the authoritative source for bookable appointments and visits.
          </p>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="business-country" className="label">Country code</label>
            <input id="business-country" className="field uppercase" maxLength={2} disabled={!data.canEdit} value={country} onChange={(event) => setCountry(event.target.value.replace(/[^a-z]/gi, '').toUpperCase())} placeholder="GB" />
          </div>
          <div>
            <label htmlFor="business-timezone" className="label">Time zone</label>
            <input id="business-timezone" className="field" list="business-timezones" disabled={!data.canEdit} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/London" />
            <datalist id="business-timezones">{COMMON_TIMEZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
          </div>
          <div>
            <label htmlFor="business-currency" className="label">Currency for new invoices</label>
            <select id="business-currency" className="field" disabled={!data.canEdit} value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {data.currencies.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto rounded-xl border border-slate-900/[0.055]">
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead className="border-b border-slate-900/[0.055] bg-slate-900/[0.02] font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">
              <tr><th className="px-4 py-2.5">Day</th><th className="px-4 py-2.5">Open</th><th className="px-4 py-2.5">From</th><th className="px-4 py-2.5">To</th></tr>
            </thead>
            <tbody>
              {hours.map((row, index) => (
                <tr key={row.weekday} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-2.5 text-slate-900">{DAYS[row.weekday]}</td>
                  <td className="px-4 py-2.5"><input aria-label={`${DAYS[row.weekday]} is open`} type="checkbox" checked={row.open} disabled={!data.canEdit} onChange={(event) => setHours((current) => current.map((item, i) => i === index ? { ...item, open: event.target.checked } : item))} className="accent-emerald-500" /></td>
                  <td className="px-4 py-2.5"><input aria-label={`${DAYS[row.weekday]} opening time`} type="time" className="field py-1.5" value={row.start ?? '09:00'} disabled={!data.canEdit || !row.open} onChange={(event) => setHours((current) => current.map((item, i) => i === index ? { ...item, start: event.target.value } : item))} /></td>
                  <td className="px-4 py-2.5"><input aria-label={`${DAYS[row.weekday]} closing time`} type="time" className="field py-1.5" value={row.end ?? '17:00'} disabled={!data.canEdit || !row.open} onChange={(event) => setHours((current) => current.map((item, i) => i === index ? { ...item, end: event.target.value } : item))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">4. Interface vocabulary</h2>
            <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">
              Vocabulary is independent from business type. Choose it explicitly; changing it relabels the interface but does not rename stored collections or add specialist clinical features.
            </p>
          </div>
          {termPack !== recommendedTermPack(type) && (
            <Button variant="quiet" size="sm" disabled={!data.canEdit} onClick={() => setTermPack(recommendedTermPack(type))}>
              Use {type} recommendation
            </Button>
          )}
        </div>
        <fieldset className="mt-5 grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">Interface vocabulary</legend>
          {data.vocabularies.map((pack) => (
            <label key={pack.id} className={cn('rounded-xl border p-4', data.canEdit ? 'cursor-pointer' : '', termPack === pack.id ? 'border-brand-500/40 bg-brand-500/[0.06]' : 'border-slate-900/[0.055]')}>
              <span className="flex items-start gap-2.5">
                <input type="radio" name="term-pack" checked={termPack === pack.id} disabled={!data.canEdit} onChange={() => setTermPack(pack.id)} className="mt-0.5 accent-emerald-500" />
                <span><span className="block text-[13px] font-medium capitalize text-slate-900">{pack.id}</span><span className="mt-1 block text-[11.5px] text-slateink-400">{pack.description}</span></span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <div className="flex justify-end">
        <Button variant="brand" disabled={!data.canEdit || busy} onClick={() => void save()}>
          {busy ? <Icons.refresh size={14} className="animate-spin" /> : <Icons.check size={14} />}
          {busy ? 'Saving…' : 'Save business profile'}
        </Button>
      </div>
    </div>
  );
}
