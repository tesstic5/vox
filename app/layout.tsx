import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { StoreProvider } from '@/lib/store';
import { ToastProvider } from '@/components/ui';
import { PaletteMount } from '@/components/site/PaletteMount';
import { CookieConsent } from '@/components/site/CookieConsent';
import { SITE } from '@/lib/content';
import { JsonLd, organizationJsonLd, softwareApplicationJsonLd, websiteJsonLd } from '@/lib/seo';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  preload: false,
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: 'Voxera — calls, bookings and customer care',
    template: '%s · Voxera',
  },
  description: SITE.description,
  keywords: ['booking communication', 'field service workflow', 'practice scheduling', 'voice assistant', 'customer records'],
  authors: [{ name: 'Voxera' }],
  openGraph: {
    type: 'website',
    title: 'Voxera — calls, bookings and customer care',
    description: SITE.description,
    siteName: 'Voxera',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Voxera — calls, bookings and customer care',
    description: SITE.description,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#050706',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} dark`}>
      <body className="font-sans">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[300] focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-ink-950"
        >
          Skip to content
        </a>
        <JsonLd data={[organizationJsonLd(), websiteJsonLd(), softwareApplicationJsonLd()]} />
        {/* The demo workspace is seeded from one instant, computed here and handed
            to the client in the payload, so the HTML the server renders and the
            browser's first render are the same workspace — not two drawings of
            one (D9). */}
        <StoreProvider seedAt={Date.now()}>
          <ToastProvider>
            {children}
            <PaletteMount />
            <CookieConsent />
          </ToastProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
