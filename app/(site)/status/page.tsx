import { Icons } from '@/components/icons';
import { LinkButton, Section } from '@/components/ui';

export const metadata = {
  title: 'Deployment status',
  description: 'Runtime health boundary for this Voxera deployment; no fabricated historical uptime or incidents.',
};

export default function StatusPage() {
  return (
    <Section className="pb-20 pt-16 sm:pt-24">
      <div className="container-wide">
        <div className="max-w-3xl">
          <div className="eyebrow mb-4">Deployment status</div>
          <h1 className="h1 text-balance">No public uptime history is configured.</h1>
          <p className="lede mt-6 max-w-[62ch]">This repository exposes a current health endpoint and Prometheus-format process metrics. It does not have an independent public monitor, incident feed, rolling uptime calculation or contractual SLA, so this page does not manufacture them.</p>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <article className="panel p-6">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-brand-500/20 bg-brand-500/[0.07] text-brand-700"><Icons.bolt size={16} /></span>
            <h2 className="mt-4 text-[16px] font-semibold text-slate-900">Current process health</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">The health endpoint reports the process and store state at request time. A successful response is not uptime history.</p>
            <LinkButton href="/api/health" variant="ghost" size="sm" className="mt-5">Open health response</LinkButton>
          </article>
          <article className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-6">
            <h2 className="text-[16px] font-semibold text-amber-900">Operator responsibility</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">Run an external monitor from outside the hosting boundary, retain incident evidence and define alert ownership before relying on this deployment.</p>
          </article>
        </div>
      </div>
    </Section>
  );
}
