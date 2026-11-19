import * as React from 'react';
import { CallDemo } from '@/components/site/CallDemo';
import { Icons } from '@/components/icons';
import { LinkButton, Reveal, Section, SectionHead } from '@/components/ui';

export const metadata = {
  title: 'Voxera — calls, bookings and customer care',
  description: 'Keep appointments, customer communications and an optional AI phone assistant together in one workspace.',
};

const FEATURES = [
  { icon: 'calendar', title: 'A clearer calendar', desc: 'Manage appointments, working hours, services and availability in one diary.' },
  { icon: 'users', title: 'Customer records', desc: 'Keep contact details, appointments and notes together for your team.' },
  { icon: 'phone', title: 'An assistant for calls', desc: 'Configure an assistant to help with calls and booking tasks using your business information.' },
  { icon: 'send', title: 'Messages and reminders', desc: 'Send confirmations and reminders once a messaging provider is connected.' },
  { icon: 'dollar', title: 'Invoices and balances', desc: 'Create invoices and follow what is paid or outstanding. Online payments need a connected provider.' },
  { icon: 'chart', title: 'Useful reports', desc: 'See information drawn from your own calls, appointments and business records.' },
] as const;

const BUSINESSES = [
  { number: '01', title: 'Contractors & home services', desc: 'Run enquiries, versioned estimates, accepted jobs, conflict-checked visits, completion and draft invoicing.', note: 'Records are workspace-scoped; visits must be approved and scheduled against the real diary.' },
  { number: '02', title: 'Dental practices', desc: 'Organise appointments, practitioner schedules, reminders and patient records.', note: 'Dental-specific charting is not currently available.' },
  { number: '03', title: 'Physiotherapy', desc: 'Coordinate appointments, administrative practitioner notes, follow-ups and group sessions.', note: 'No diagnosis, treatment recommendation or clinical suitability is implied; complete independent review before using real patient data.' },
] as const;

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-brand-500/[0.07] via-transparent to-transparent" />
        <div className="container-wide relative pb-16 pt-16 sm:pt-20 lg:pb-24 lg:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <Reveal>
              <div className="inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-brand-500/[0.07] px-3.5 py-2 text-[12px] font-medium text-brand-700">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                Calls, bookings &amp; customer care
              </div>
              <h1 className="h1 mt-7 max-w-[13ch] text-balance">
                More time for <span className="text-brand-700">your business.</span>
              </h1>
              <p className="lede mt-6 max-w-[50ch] text-pretty">
                Voxera brings your appointments, customer communications and an optional AI phone assistant together in one workspace.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <LinkButton href="/signup" variant="brand" className="px-6 py-3 text-[14px]">
                  Create an account <Icons.arrowRight size={16} />
                </LinkButton>
                <LinkButton href="#how-it-works" variant="ghost" className="px-6 py-3 text-[14px]">
                  See how it works
                </LinkButton>
              </div>
              <p className="mt-6 max-w-[52ch] text-[12px] leading-relaxed text-slateink-400">
                Real phone calls, messages and online payments require their respective providers to be connected.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <CallDemo />
              <p className="mt-3 px-1 text-[11.5px] leading-relaxed text-slateink-400">
                Try a sample conversation. This is a demo; please do not enter real customer or patient information.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      <Section id="how-it-works" tone="panel">
        <div className="container-wide">
          <SectionHead eyebrow="How it works" title="A simpler way to keep things moving." desc="Set up the basics first, then connect the tools your business needs." />
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {[
              { n: '01', title: 'Set up your business', text: 'Add your services, team and working hours so the calendar reflects how you work.' },
              { n: '02', title: 'Connect when you are ready', text: 'Optionally connect phone and messaging providers, then review and test your assistant.' },
              { n: '03', title: 'Manage the day', text: 'Keep track of appointments, customer conversations and invoices in one place.' },
            ].map((step) => (
              <div key={step.n} className="panel h-full p-6 sm:p-7">
                <span className="font-mono text-[11px] text-brand-700">{step.n} / 03</span>
                <h3 className="mt-6 text-[17px] font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-slateink-400">{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section id="what-it-does">
        <div className="container-wide">
          <SectionHead eyebrow="What Voxera does" title="The everyday work, together." desc="Give your team a shared view of your schedule and customer communications." />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => {
              const Icon = Icons[feature.icon];
              return (
                <div key={feature.title} className="panel h-full p-6">
                  <span className="grid h-10 w-10 place-items-center rounded-xl border border-brand-500/20 bg-brand-500/[0.07] text-brand-700"><Icon size={19} /></span>
                  <h3 className="mt-5 text-[16px] font-semibold text-slate-900">{feature.title}</h3>
                  <p className="mt-2.5 text-[13.5px] leading-relaxed text-slateink-400">{feature.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </Section>

      <Section id="businesses" tone="panel">
        <div className="container-wide">
          <SectionHead eyebrow="Built for service businesses" title="Different work. The same need to stay organised." desc="Whether your team works in a clinic or visits customers, start with the tools that support your day." />
          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            {BUSINESSES.map((business) => (
              <div key={business.number} className="panel flex h-full flex-col p-6 sm:p-7">
                <div className="font-mono text-[11px] text-brand-700">{business.number} / SERVICE BUSINESS</div>
                <h3 className="mt-6 text-[18px] font-semibold text-slate-900">{business.title}</h3>
                <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">{business.desc}</p>
                <p className="mt-6 border-t border-slate-900/[0.06] pt-4 text-[12px] leading-relaxed text-slateink-400">{business.note}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-[12px] leading-relaxed text-slateink-400">
            Healthcare teams should complete appropriate security, compliance and provider checks before using real patient information.
          </p>
        </div>
      </Section>

      <Section>
        <div className="container-x">
          <div className="relative overflow-hidden rounded-3xl border border-brand-500/20 bg-brand-500/[0.06] px-6 py-14 text-center sm:px-12 sm:py-16">
            <div className="eyebrow mb-4">Get started</div>
            <h2 className="h2 text-balance">Make your day a little simpler.</h2>
            <p className="lede mx-auto mt-4 max-w-xl">Start with your workspace, then set up the tools that matter to your business.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <LinkButton href="/signup" variant="brand" className="px-6 py-3 text-[14px]">Create an account <Icons.arrowRight size={15} /></LinkButton>
              <LinkButton href="/support" variant="ghost" className="px-6 py-3 text-[14px]">Get help</LinkButton>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
