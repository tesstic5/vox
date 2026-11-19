import { SalesForm } from '@/components/site/SalesForm';
import { Icons } from '@/components/icons';
import { Section } from '@/components/ui';
import { JsonLd, breadcrumbJsonLd } from '@/lib/seo';

export const metadata = { title: 'Contact', description: 'Create a deployment enquiry record without an invented response-time promise.' };

export default function ContactPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd([{ name: 'Contact', href: '/contact' }])} />
      <Section className="pb-16 pt-16 sm:pt-20">
        <div className="container-wide grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-start">
          <div className="max-w-xl"><div className="eyebrow mb-4">Contact</div><h1 className="h1 text-balance">Describe the deployment you need.</h1><p className="lede mt-6">The form creates a server-side sales-lead record for the operator of this deployment. No office address, staffed phone line or response-time SLA is assumed.</p><div className="mt-8 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5"><div className="flex gap-3"><Icons.shield size={18} className="mt-0.5 shrink-0 text-amber-900" /><p className="text-[12.5px] leading-relaxed text-amber-900">Do not submit credentials, patient information, payment-card data, call recordings or other sensitive records through an unreviewed contact form.</p></div></div></div>
          <div className="panel p-6"><h2 className="text-[18px] font-semibold text-slate-900">Deployment enquiry</h2><p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">Ask about architecture, provider setup, migration or operating costs. Security and compliance evidence must be supplied and verified separately.</p><div className="mt-6"><SalesForm /></div></div>
        </div>
      </Section>
    </>
  );
}
