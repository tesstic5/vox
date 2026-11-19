import * as React from 'react';
import { CTASection } from '@/components/site/sections';
import { CodeBlock, CopyButton, LinkButton, Reveal, Section, SectionHead } from '@/components/ui';
import { Icons, Logo, LogoMark } from '@/components/icons';
import { JsonLd, breadcrumbJsonLd } from '@/lib/seo';

export const metadata = {
  title: 'Brand',
  description: 'Voxera brand assets, logo files, color palette, typography, and usage guidelines.',
};

const COLORS = [
  { name: 'Ink', hex: '#050706', note: 'Primary background' },
  { name: 'Panel', hex: '#0A0E0C', note: 'Surfaces and cards' },
  { name: 'Signal Green', hex: '#2BE38B', note: 'Primary accent' },
  { name: 'Lime', hex: '#D2FD45', note: 'High-emphasis accent' },
  { name: 'Brand 300', hex: '#57F2AE', note: 'Text on dark' },
  { name: 'Brand 600', hex: '#0BA362', note: 'Pressed state' },
  { name: 'Mist', hex: '#AEB7B3', note: 'Secondary text' },
  { name: 'White', hex: '#FFFFFF', note: 'Primary text' },
];

export default function BrandPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd([{ name: 'Brand', href: '/brand' }])} />
      <Section className="pb-12 pt-16 sm:pt-20">
        <div className="container-wide">
          <div className="max-w-3xl">
            <div className="eyebrow mb-4">Brand</div>
            <h1 className="h1 text-balance">Voxera brand assets.</h1>
            <p className="lede mt-6 max-w-[52ch] text-pretty">
              Our mark is a waveform inside a rounded tile: five bars representing the five layers of the voice
              pipeline. Use it in green on dark, or black on light. Never stretch, recolor outside this palette, or add
              effects.
            </p>
          </div>
        </div>
      </Section>

      <Section tone="panel">
        <div className="container-wide">
          <SectionHead eyebrow="Logo" title="Primary lockup and mark" />
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            <div className="panel flex flex-col items-center justify-center gap-6 p-10">
              <Logo size={40} />
              <CopyButton label="Copy SVG" value={'<svg viewBox="0 0 28 28">Voxera logo</svg>'} />
            </div>
            <div className="panel flex flex-col items-center justify-center gap-6 p-10">
              <LogoMark size={56} />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-slateink-400">Mark only</span>
            </div>
            <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-slate-900/[0.045] bg-white p-10">
              <span className="inline-flex items-center gap-2.5">
                <svg viewBox="0 0 28 28" width="40" height="40" fill="none" aria-hidden>
                  <rect x="0.5" y="0.5" width="27" height="27" rx="7.5" fill="#050706" />
                  <g fill="#2BE38B">
                    <rect x="6" y="12" width="2.2" height="4" rx="1.1" />
                    <rect x="9.6" y="8.5" width="2.2" height="11" rx="1.1" />
                    <rect x="13.2" y="5.8" width="2.2" height="16.4" rx="1.1" />
                    <rect x="16.8" y="9.6" width="2.2" height="8.8" rx="1.1" />
                    <rect x="20.4" y="12.6" width="2.2" height="2.8" rx="1.1" />
                  </g>
                </svg>
                <span className="text-[17px] font-semibold tracking-[-0.03em] text-black">
                  Voxera<span className="text-[#0BA362]">.</span>
                </span>
              </span>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-black/50">On light</span>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="panel p-6">
              <h3 className="h4">Clear space & minimum size</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-slateink-400">
                Keep clear space equal to the height of the mark on all sides. Minimum digital size is 20px for the
                mark and 88px wide for the full lockup. Below that, use the mark alone.
              </p>
            </div>
            <div className="panel p-6">
              <h3 className="h4">Do not</h3>
              <ul className="mt-3 space-y-2 text-[13px] text-slateink-400">
                {[
                  'Recolor the mark outside the palette above',
                  'Stretch, skew, rotate, or add a stroke',
                  'Place the lockup on a busy photographic background',
                  'Use the wordmark without the mark in product UI',
                  'Add drop shadows, glows, or gradients to the mark',
                ].map((d) => (
                  <li key={d} className="flex gap-2.5">
                    <Icons.close size={14} className="mt-0.5 shrink-0 text-red-700" />
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-wide">
          <SectionHead eyebrow="Palette" title="Color" desc="Dark-first. Green carries meaning: it marks the live, the working, and the primary action — nothing else." />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {COLORS.map((c) => (
              <div key={c.name} className="overflow-hidden rounded-2xl border border-slate-900/[0.045]">
                <div className="h-24" style={{ background: c.hex }} />
                <div className="bg-ink-850/60 p-4">
                  <div className="text-[13.5px] font-medium text-slate-900">{c.name}</div>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] text-slateink-400">{c.hex}</span>
                    <CopyButton value={c.hex} />
                  </div>
                  <div className="mt-2 text-[11.5px] text-slateink-400">{c.note}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-12 grid gap-4 lg:grid-cols-2">
            <div>
              <SectionHead eyebrow="Typography" title="Type scale" maxWidth="max-w-lg" />
              <div className="mt-8 space-y-5 rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-6">
                {[
                  { label: 'Display / 68px / -3.5%', cls: 'text-[40px] font-semibold leading-none tracking-[-0.035em] text-slate-900', text: 'Voice agents' },
                  { label: 'Heading / 40px / -3%', cls: 'text-[28px] font-semibold leading-tight tracking-[-0.03em] text-slate-900', text: 'One platform' },
                  { label: 'Body / 17px', cls: 'text-[16px] leading-relaxed text-slateink-200', text: 'Inter for everything that is read; JetBrains Mono for everything that is measured.' },
                  { label: 'Mono / 11px / 16%', cls: 'font-mono text-[11px] uppercase tracking-[0.16em] text-brand-700', text: 'Server record · verified' },
                ].map((t) => (
                  <div key={t.label}>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">{t.label}</div>
                    <div className={t.cls}>{t.text}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <SectionHead eyebrow="Voice" title="How we write" maxWidth="max-w-lg" />
              <div className="mt-8 space-y-3">
                {[
                  { t: 'Specific over impressive', d: 'Name the stored field, time window and source instead of using an unsupported superlative.' },
                  { t: 'Name the boundary', d: 'Separate stored application facts from provider delivery, deployment and contract responsibilities.' },
                  { t: 'Short sentences', d: 'Engineers skim. One idea per sentence, one claim per paragraph.' },
                  { t: 'Never oversell the model', d: 'We describe capability, not sentience. No “understands like a human.”' },
                  { t: 'Lowercase for commands', d: 'CLI and API strings are always lowercase mono: voxera push --dry-run.' },
                ].map((x) => (
                  <div key={x.t} className="rounded-xl border border-slate-900/[0.045] bg-ink-850/50 p-4">
                    <div className="text-[13.5px] font-medium text-slate-900">{x.t}</div>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-slateink-400">{x.d}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section tone="panel">
        <div className="container-wide">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <SectionHead eyebrow="Assets" title="Download the kit" maxWidth="max-w-lg" />
              <p className="mt-4 text-[13.5px] leading-relaxed text-slateink-400">
                SVG, PNG, and Figma files for the lockup, mark, app icon, social cards, and slide deck template.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <LinkButton href="/brand" variant="brand" size="sm">
                  <Icons.download size={14} /> Brand kit (.zip)
                </LinkButton>
                <LinkButton href="/brand" variant="ghost" size="sm">
                  <Icons.download size={14} /> Figma library
                </LinkButton>
                <LinkButton href="/brand" variant="ghost" size="sm">
                  <Icons.download size={14} /> Social cards
                </LinkButton>
              </div>
              <p className="mt-5 text-[12px] leading-relaxed text-slateink-400">
                Do not imply partnership or endorsement without written permission from the deployment operator.
                Use the <a href="/contact" className="text-brand-700 hover:underline">contact form</a> to create a traceable request.
              </p>
            </div>
            <div>
              <CodeBlock
                filename="tokens.css"
                lang="css"
                code={`:root {
  --vx-ink: #050706;
  --vx-panel: #0A0E0C;
  --vx-signal: #2BE38B;
  --vx-lime: #D2FD45;
  --vx-text: #FFFFFF;
  --vx-mist: #AEB7B3;

  --vx-radius: 16px;
  --vx-font-sans: "Inter", system-ui;
  --vx-font-mono: "JetBrains Mono", monospace;
}`}
              />
            </div>
          </div>
        </div>
      </Section>

      <CTASection
        eyebrow="Using these assets"
        title="Keep the product identity accurate."
        desc="Use the supplied Voxera marks without implying an endorsement, partnership, certification or feature that has not been independently verified."
        primary={{ label: 'Read the implementation guide', href: '/docs' }}
        secondary={{ label: 'Create an enquiry record', href: '/contact' }}
      />
    </>
  );
}
