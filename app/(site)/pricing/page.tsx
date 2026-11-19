import { Icons } from '@/components/icons';
import { LinkButton, Section, SectionHead } from '@/components/ui';

export const metadata = {
  title: 'Pricing boundary',
  description: 'What this Voxera build does and does not meter, bill or settle.',
};

const COSTS = [
  ['Application operation', 'Hosting, database, backup, monitoring and operator time depend on the deployment you choose.'],
  ['Telephony and messaging', 'Carrier numbers, minutes and messages are charged and settled by the connected carrier; sandbox records cost nothing and are not dialable.'],
  ['Models and speech', 'Inference, transcription and synthesis require real provider credentials. Provider invoices are external to the recorded call-cost fields.'],
  ['Payments', 'Invoice records and payment links exist, but real collection and settlement require a configured payment provider and reconciliation.'],
] as const;

export default function PricingPage() {
  return (
    <>
      <Section className="pb-12 pt-16 sm:pt-20">
        <div className="container-wide max-w-4xl"><div className="eyebrow mb-4">Pricing</div><h1 className="h1 text-balance">No fictional plan entitlement or provider bill.</h1><p className="lede mt-6 max-w-[64ch]">The repository records workspace plan labels and call-cost components, but it does not run a subscription checkout or prove external settlement. Pricing must be agreed with the actual operator and providers.</p><div className="mt-8 flex flex-wrap gap-3"><LinkButton href="/signup" variant="brand">Create a test workspace</LinkButton><LinkButton href="/contact" variant="ghost">Discuss operating costs</LinkButton></div></div>
      </Section>
      <Section tone="panel"><div className="container-wide"><SectionHead eyebrow="Cost boundaries" title="Budget the systems that really run" desc="Recorded estimates are useful operational fields, not invoices from third parties." /><div className="mt-10 grid gap-4 md:grid-cols-2">{COSTS.map(([title, description]) => <article key={title} className="panel p-6"><Icons.dollar size={18} className="text-brand-700" /><h2 className="mt-4 text-[16px] font-semibold text-slate-900">{title}</h2><p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">{description}</p></article>)}</div></div></Section>
      <Section><div className="container-wide rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-6"><h2 className="text-[16px] font-semibold text-amber-900">No paid compliance or SLA add-on is offered here</h2><p className="mt-2 max-w-4xl text-[12.5px] leading-relaxed text-amber-900">The former sample prices for certification, a BAA, zero retention, voice cloning, concurrency and support commitments have been removed. None is implemented or contractually available from this codebase.</p></div></Section>
    </>
  );
}
