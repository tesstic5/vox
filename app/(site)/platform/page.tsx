import { EnterpriseIcon, Icons } from '@/components/icons';
import { LinkButton, Section, SectionHead } from '@/components/ui';

export const metadata = {
  title: 'Platform capabilities',
  description: 'Implemented Voxera capabilities and explicit provider/deployment boundaries.',
};

const CAPABILITIES = [
  ['building', 'Business profile and modules', 'Choose contractor, dental, physiotherapy or other; keep terminology explicit and let owners change enabled modules later.'],
  ['briefcase', 'Field-service lifecycle', 'Workspace-scoped enquiries, versioned estimates and acceptance, jobs, conflict-checked visits, completion and draft invoices.'],
  ['calendar', 'Practice scheduling', 'Locations, services, practitioners, rotas, appointments, classes, wait lists, reminders and generic signed notes.'],
  ['phone', 'Stored calls and assistants', 'Versioned assistant records, bounded tools, literal factual snippets, web-call turns, transcripts and recorded runtime metrics.'],
  ['dollar', 'Money records', 'Invoices, balances, packs and payment-link flows with explicit separation between recorded amounts and real provider settlement.'],
  ['terminal', 'Developer surface', 'Tenant-scoped APIs, hashed scoped keys, signed webhooks, real request console, audit export and server-derived analytics.'],
] as const;

export default function PlatformPage() {
  return (
    <>
      <Section className="pb-12 pt-16 sm:pt-20">
        <div className="container-wide max-w-4xl">
          <div className="eyebrow mb-4">Platform</div>
          <h1 className="h1 text-balance">Business records first. Providers are optional connections.</h1>
          <p className="lede mt-6 max-w-[64ch]">The dashboard works as a tenant-scoped booking and communication workspace. Phone delivery, model inference, speech, email and payment settlement work only when the relevant provider and deployment configuration are present.</p>
          <div className="mt-8 flex flex-wrap gap-3"><LinkButton href="/signup" variant="brand">Create a workspace</LinkButton><LinkButton href="/docs" variant="ghost">Read the implementation guides</LinkButton></div>
        </div>
      </Section>
      <Section tone="panel">
        <div className="container-wide">
          <SectionHead eyebrow="Implemented" title="Capabilities backed by application records" desc="Business type recommends language and defaults; server-side tenant and role checks remain authoritative." />
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(([icon, title, description]) => <article key={title} className="panel h-full p-6"><span className="grid h-9 w-9 place-items-center rounded-xl border border-brand-500/20 bg-brand-500/[0.07] text-brand-700"><EnterpriseIcon name={icon} /></span><h2 className="mt-4 text-[15px] font-semibold text-slate-900">{title}</h2><p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">{description}</p></article>)}
          </div>
        </div>
      </Section>
      <Section>
        <div className="container-wide rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-6">
          <div className="flex items-start gap-3"><Icons.shield size={19} className="mt-0.5 shrink-0 text-amber-900" /><div><h2 className="text-[16px] font-semibold text-amber-900">Explicit boundaries</h2><p className="mt-2 max-w-4xl text-[12.5px] leading-relaxed text-amber-900">No dental charting, imaging, insurance claims, specialist clinical assessment, certification, managed provider availability or production SLA is implied. Batch calling, squads, visual workflows, global knowledge ingestion, evaluations and embeddable widgets are unavailable rather than simulated.</p></div></div>
        </div>
      </Section>
    </>
  );
}
