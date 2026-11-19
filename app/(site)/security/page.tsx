import { Icons } from '@/components/icons';
import { LinkButton, Section, SectionHead } from '@/components/ui';
import { JsonLd, breadcrumbJsonLd } from '@/lib/seo';

export const metadata = {
  title: 'Security boundaries',
  description: 'Security controls implemented in this Voxera build, plus the deployment and compliance work that remains external.',
};

const IMPLEMENTED = [
  ['Tenant-scoped APIs', 'Authenticated application routes check the workspace on every record read and write; navigation visibility is not treated as authorization.'],
  ['Roles and write gates', 'Owner, admin, developer, frontline and viewer roles are enforced on the server for configuration and sensitive operations.'],
  ['Account protection', 'Password hashing, signed server sessions, email verification, one-time recovery links and authenticator-based two-factor authentication are implemented.'],
  ['Scoped API keys', 'Keys are generated server-side, shown once, stored as hashes, scoped, revocable and checked by API middleware.'],
  ['Audit records', 'Security, configuration and sensitive business actions write tenant-owned audit entries that can be filtered and exported.'],
  ['Signed integrations', 'Webhook delivery is signed; telephony callbacks and media sessions have request-validation and short-lived signing paths.'],
];

const NOT_CLAIMED = [
  'No SOC 2, ISO 27001, PCI DSS or other certification is claimed by this codebase.',
  'No HIPAA Business Associate Agreement, clinical suitability or legal compliance is bundled with the software.',
  'No regional residency, customer-managed keys, zero-data-retention mode or third-party penetration-test report is represented as available.',
  'TLS termination, secret management, encrypted infrastructure, monitoring, incident response and provider contracts depend on the actual deployment.',
  'Real patient, payment or call data requires independent security, privacy, legal and provider review before production use.',
];

export default function SecurityPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd([{ name: 'Security', href: '/security' }])} />
      <Section className="pb-12 pt-16 sm:pt-20">
        <div className="container-wide">
          <div className="max-w-3xl">
            <div className="eyebrow mb-4">Security boundaries</div>
            <h1 className="h1 text-balance">Verify controls in code and in the deployment.</h1>
            <p className="lede mt-6 max-w-[62ch] text-pretty">
              This page names what the current build actually enforces and what it does not. Product code is only one layer; hosting, providers, contracts and operating practice must be reviewed separately.
            </p>
          </div>
          <div className="mt-10 rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-5">
            <div className="flex items-start gap-3">
              <Icons.shield size={20} className="mt-0.5 shrink-0 text-amber-900" />
              <p className="max-w-4xl text-[13px] leading-relaxed text-amber-900">
                Voxera does not advertise a certification, BAA, compliance attestation or uptime SLA in this build. Obtain independent evidence for the environment you intend to operate.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section tone="panel">
        <div className="container-wide">
          <SectionHead eyebrow="Implemented" title="Controls present in the application" desc="These statements describe source paths that are exercised by the repository's authorization and integrity checks." />
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {IMPLEMENTED.map(([title, description]) => (
              <article key={title} className="panel h-full p-6">
                <span className="grid h-9 w-9 place-items-center rounded-xl border border-brand-500/20 bg-brand-500/[0.07] text-brand-700"><Icons.check size={16} /></span>
                <h2 className="mt-4 text-[15px] font-semibold text-slate-900">{title}</h2>
                <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">{description}</p>
              </article>
            ))}
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-wide grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <SectionHead eyebrow="Not represented" title="External release work remains" desc="Absence is stated explicitly rather than hidden behind badges or sample policy text." maxWidth="max-w-md" />
          <div className="space-y-3">
            {NOT_CLAIMED.map((item) => (
              <div key={item} className="flex gap-3 rounded-xl border border-slate-900/[0.045] bg-ink-850/45 p-4">
                <Icons.close size={15} className="mt-0.5 shrink-0 text-slateink-400" />
                <p className="text-[12.5px] leading-relaxed text-slateink-300">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section tone="panel">
        <div className="container-wide flex flex-wrap items-center justify-between gap-6">
          <div className="max-w-2xl">
            <h2 className="text-[22px] font-semibold text-slate-900">Review the evidence that exists.</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-slateink-400">Signed-in owners can inspect audit entries, two-factor settings, API keys, provider status and the workspace export. Deployment evidence must come from the operator.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/dashboard/settings/security" variant="brand">Open security settings</LinkButton>
            <LinkButton href="/contact" variant="ghost">Contact the operator</LinkButton>
          </div>
        </div>
      </Section>
    </>
  );
}
