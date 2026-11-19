'use client';

import * as React from 'react';
import { STATS } from '@/lib/content';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';
import { LinkButton, Reveal, Section } from '../ui';

/** Legacy section exports are intentionally conservative: no customer logo,
 * testimonial, integration, phone-line or outcome is inferred from seed data. */
export function LogoStrip({ title = 'Customer evidence' }: { companies?: string[]; title?: string }) {
  return <Boundary title={title}>No verified endorsement or customer-logo permission is bundled with this repository.</Boundary>;
}

export function IntegrationsMarquee() {
  return <Boundary title="External providers">Provider integrations appear only after an authorised workspace member configures and verifies credentials.</Boundary>;
}

export function TestimonialBlock({ index: _index = 0 }: { index?: number }) {
  return <Boundary title="Customer evidence">No testimonial is published without a separately verified source and permission.</Boundary>;
}

export function CallUsBand() {
  return <Boundary title="Phone boundary">No staffed public phone line is represented by this build. Use the contact form to create a traceable enquiry record.</Boundary>;
}

export function MetricsBand() {
  return (
    <Section className="py-16 sm:py-20">
      <div className="container-x grid grid-cols-2 gap-y-10 sm:grid-cols-4">
        {STATS.map((item, index) => (
          <Reveal key={item.label} delay={index * 50} className="border-l border-slate-900/[0.045] pl-5">
            <div className="text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-none text-slate-900 tabular">{item.value}</div>
            <div className="mt-2.5 max-w-[20ch] text-[12.5px] leading-snug text-slateink-400">{item.label}</div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

export function CaseStudyCards() {
  return <Boundary title="Case studies">No customer result or case study is claimed from sample or seeded records.</Boundary>;
}

function Boundary({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Section>
      <div className="container-x">
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-6">
          <h2 className="text-[16px] font-semibold text-amber-900">{title}</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">{children}</p>
        </div>
      </div>
    </Section>
  );
}

export function CTASection({
  eyebrow = 'Get started',
  title = 'Create a workspace and verify the workflow.',
  desc = 'Choose a business profile, review recommended modules, and connect external providers only when you are ready to test them.',
  primary = { label: 'Create a workspace', href: '/signup' },
  secondary = { label: 'Read the implementation guide', href: '/docs' },
}: {
  eyebrow?: string;
  title?: string;
  desc?: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
}) {
  return (
    <Section className="pb-24">
      <div className="container-x">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-slate-900/[0.035] bg-ink-900/60 px-6 py-14 text-center sm:px-12 sm:py-20">
            <div className="absolute inset-0 grid-bg opacity-30" />
            <div className="relative mx-auto max-w-2xl">
              <div className="eyebrow mb-4">{eyebrow}</div>
              <h2 className="h2 text-balance">{title}</h2>
              <p className="lede mx-auto mt-5 max-w-[54ch] text-pretty">{desc}</p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <LinkButton href={primary.href} variant="brand" className="px-6 py-3 text-[14px]">{primary.label} <Icons.arrowRight size={16} /></LinkButton>
                <LinkButton href={secondary.href} variant="ghost" className="px-6 py-3 text-[14px]">{secondary.label}</LinkButton>
              </div>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 font-mono text-[11px] text-slateink-400">
                <span>Explicit business type</span><span>Owner-selected modules</span><span>Provider delivery verified separately</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

export function FeatureCard({ icon, title, desc, href, meta, className, children }: {
  icon?: keyof typeof Icons; title: string; desc: string; href?: string; meta?: string; className?: string; children?: React.ReactNode;
}) {
  const Icon = icon ? Icons[icon] : null;
  const inner = <>{Icon && <span className="grid h-10 w-10 place-items-center rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.03] text-brand-700"><Icon size={18} /></span>}<h3 className="mt-5 text-[16px] font-semibold text-slate-900">{title}</h3><p className="mt-2.5 text-[13.5px] leading-relaxed text-slateink-400">{desc}</p>{children}{meta && <div className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-slateink-400">{meta}</div>}</>;
  const classes = cn('group relative flex h-full flex-col rounded-2xl border border-slate-900/[0.045] bg-ink-850/60 p-6', className);
  return href ? <a href={href} className={classes}>{inner}</a> : <div className={classes}>{inner}</div>;
}
