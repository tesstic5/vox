import { EnterpriseIcon, Icons } from '@/components/icons';
import { LinkButton, Section, SectionHead } from '@/components/ui';

export const metadata = {
  title: 'Support',
  description: 'Self-service support paths and explicit support boundaries for the current Voxera build.',
};

const PATHS = [
  ['Setup checklist', 'Use server-derived setup steps for business profile, scheduling, assistant, number and first test call.', '/dashboard/setup', 'rocket'],
  ['Implementation guide', 'Read verified workflow, provider and deployment boundaries for this build.', '/docs', 'book'],
  ['Audit log', 'Find configuration and security actions by time, actor and target.', '/dashboard/audit', 'terminal'],
  ['Observability', 'Inspect stored call metrics without inferred provider uptime.', '/dashboard/observability', 'chart'],
] as const;

export default function SupportPage() {
  return (
    <>
      <Section className="pb-12 pt-16 sm:pt-20">
        <div className="container-wide">
          <div className="max-w-3xl">
            <div className="eyebrow mb-4">Support</div>
            <h1 className="h1 text-balance">Start with the record that failed.</h1>
            <p className="lede mt-6 max-w-[62ch]">Call IDs, request IDs, audit entries and provider responses are more useful than an invented status chart. The current build includes self-service evidence but no contracted response time or public incident operation.</p>
          </div>
        </div>
      </Section>
      <Section tone="panel">
        <div className="container-wide">
          <SectionHead eyebrow="Self service" title="Follow the evidence" desc="These destinations read actual workspace or repository state." />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PATHS.map(([title, description, href, icon]) => (
              <article key={title} className="panel flex h-full flex-col p-5">
                <span className="grid h-9 w-9 place-items-center rounded-xl border border-brand-500/20 bg-brand-500/[0.07] text-brand-700"><EnterpriseIcon name={icon} /></span>
                <h2 className="mt-4 text-[15px] font-semibold text-slate-900">{title}</h2>
                <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-slateink-400">{description}</p>
                <LinkButton href={href} variant="ghost" size="sm" className="mt-5">Open <Icons.arrowRight size={13} /></LinkButton>
              </article>
            ))}
          </div>
        </div>
      </Section>
      <Section>
        <div className="container-wide grid gap-8 lg:grid-cols-2">
          <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-6">
            <h2 className="text-[16px] font-semibold text-amber-900">No support or uptime SLA is claimed</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">No 24/7 on-call team, response target, automatic service credit or historical uptime feed is supplied by this repository. Any commitment must come from the actual operator in a signed agreement.</p>
          </div>
          <div className="panel p-6">
            <h2 className="text-[16px] font-semibold text-slate-900">Contact</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">Use the contact form to reach the deployment operator. Do not send patient records, credentials, payment data or call transcripts through an unreviewed channel.</p>
            <LinkButton href="/contact" variant="brand" className="mt-5"><Icons.send size={14} /> Contact the operator</LinkButton>
          </div>
        </div>
      </Section>
    </>
  );
}
