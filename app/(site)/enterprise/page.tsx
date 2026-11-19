import { Icons } from '@/components/icons';
import { LinkButton, Section } from '@/components/ui';
import { JsonLd, breadcrumbJsonLd } from '@/lib/seo';

export const metadata = {
  title: 'Deployment planning',
  description: 'Plan a Voxera deployment without assuming an SLA, certification, managed carrier or compliance agreement.',
};

export default function EnterprisePage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd([{ name: 'Deployment planning', href: '/enterprise' }])} />
      <Section className="pb-16 pt-16 sm:pt-24">
        <div className="container-wide grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)] lg:items-start">
          <div className="max-w-3xl">
            <div className="eyebrow mb-4">Deployment planning</div>
            <h1 className="h1 text-balance">Production assurance is deployment work, not a badge on a page.</h1>
            <p className="lede mt-6 max-w-[62ch]">The application includes tenant roles, audit records, optional provider credentials, scheduling and communication workflows. It does not include a contractual uptime commitment, certification, BAA, managed telephony agreement or guaranteed support response.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/security" variant="brand">Review security boundaries</LinkButton>
              <LinkButton href="/contact" variant="ghost">Discuss a deployment</LinkButton>
            </div>
          </div>
          <aside className="panel p-6">
            <h2 className="text-[16px] font-semibold text-slate-900">Before production</h2>
            <ul className="mt-4 space-y-3">
              {[
                'Choose and contract real telephony, email, model, speech and payment providers.',
                'Configure TLS, secrets, backups, monitoring, restore drills and incident ownership.',
                'Run independent security, privacy, accessibility, legal and compliance reviews.',
                'Validate provider delivery, carrier settlement and payment settlement in the target environment.',
                'Write any SLA or support commitment in a real signed agreement backed by measured operations.',
              ].map((item) => <li key={item} className="flex gap-2.5 text-[12.5px] leading-relaxed text-slateink-300"><Icons.check size={15} className="mt-0.5 shrink-0 text-brand-700" />{item}</li>)}
            </ul>
          </aside>
        </div>
      </Section>
    </>
  );
}
