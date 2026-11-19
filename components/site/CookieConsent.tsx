'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';

/**
 * Cookie consent + preference centre.
 *
 * Three categories, matching /legal/cookies: necessary (always on),
 * preferences, and first-party analytics. The choice lives in localStorage and
 * is mirrored to a cookie so the server can read it later if needed. Nothing
 * loads conditionally yet — this is the honest version of a consent surface
 * before any third-party script exists.
 */

type Choice = { preferences: boolean; analytics: boolean };
type Stored = Choice & { decidedAt: string; gpc: boolean };

const KEY = 'voxera.consent';

function readStored(): Stored | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function write(stored: Stored) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(stored));
    document.cookie = `${KEY}=${encodeURIComponent(JSON.stringify({ preferences: stored.preferences, analytics: stored.analytics }))}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* storage disabled — the banner will simply reappear next visit */
  }
}

function Row({
  title,
  desc,
  locked,
  value,
  onChange,
}: {
  title: string;
  desc: string;
  locked?: boolean;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-5 border-b border-slate-900/[0.04] py-4 last:border-0">
      <div>
        <div className="flex items-center gap-2 text-[13.5px] font-medium text-slate-900">
          {title}
          {locked ? <span className="badge-brand">always on</span> : null}
        </div>
        <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-relaxed text-slateink-300">{desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={title}
        disabled={locked}
        onClick={() => !locked && onChange(!value)}
        className={cn(
          'mt-1 h-[22px] w-[38px] shrink-0 rounded-full border transition-colors',
          value ? 'border-brand-500/40 bg-brand-500/30' : 'border-slate-900/[0.045] bg-slate-900/[0.06]',
          locked && 'opacity-60'
        )}
      >
        <span
          className={cn(
            'block h-[16px] w-[16px] translate-y-[2px] rounded-full transition-transform',
            value ? 'translate-x-[18px] bg-brand-300' : 'translate-x-[3px] bg-slateink-300'
          )}
        />
      </button>
    </div>
  );
}

export function CookieConsent() {
  const [mounted, setMounted] = React.useState(false);
  const [banner, setBanner] = React.useState(false);
  const [panel, setPanel] = React.useState(false);
  const [choice, setChoice] = React.useState<Choice>({ preferences: true, analytics: true });

  React.useEffect(() => {
    setMounted(true);
    const stored = readStored();
    let gpc = false;
    try {
      gpc = Boolean((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl);
    } catch {
      gpc = false;
    }
    if (stored) {
      setChoice({ preferences: stored.preferences, analytics: stored.analytics });
      setBanner(false);
    } else if (gpc) {
      // Global Privacy Control is a decline signal — honour it without asking.
      const s: Stored = { preferences: false, analytics: false, decidedAt: new Date().toISOString(), gpc: true };
      write(s);
      setChoice({ preferences: false, analytics: false });
      setBanner(false);
    } else {
      setBanner(true);
    }

    const openPanel = () => {
      setBanner(true);
      setPanel(true);
    };
    window.addEventListener('voxera:cookies', openPanel);
    return () => window.removeEventListener('voxera:cookies', openPanel);
  }, []);

  const decide = (c: Choice) => {
    write({ ...c, decidedAt: new Date().toISOString(), gpc: false });
    setChoice(c);
    setBanner(false);
    setPanel(false);
  };

  if (!mounted || !banner) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[150] p-3 sm:p-5" role="region" aria-label="Cookie preferences">
      <div className="container-x">
        <div className="rounded-2xl border border-slate-900/[0.035] bg-white/95 shadow-2xl backdrop-blur-xl">
          {!panel ? (
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <Icons.shield size={16} className="mt-0.5 shrink-0 text-brand-700" />
                <p className="max-w-[76ch] text-[12.5px] leading-relaxed text-slateink-200">
                  We use strictly necessary cookies to keep you signed in, plus optional ones for interface
                  preferences and first-party analytics. No advertising trackers, no session replay on the dashboard.{' '}
                  <Link href="/legal/cookies" className="text-brand-700 underline underline-offset-2">
                    Cookie policy
                  </Link>
                  .
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button className="btn-quiet btn-sm" onClick={() => decide({ preferences: false, analytics: false })}>
                  Decline optional
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setPanel(true)}>
                  Manage choices
                </button>
                <button className="btn-brand btn-sm" onClick={() => decide({ preferences: true, analytics: true })}>
                  Accept all
                </button>
              </div>
            </div>
          ) : (
            <div className="p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-[13.5px] font-medium text-slate-900">
                  <Icons.shield size={15} className="text-brand-700" />
                  Cookie preferences
                </div>
                <button
                  onClick={() => setPanel(false)}
                  className="btn-quiet p-1.5"
                  aria-label="Close cookie preferences"
                >
                  <Icons.chevronDown size={15} />
                </button>
              </div>

              <div className="mt-2">
                <Row
                  title="Strictly necessary"
                  desc="Session authentication, CSRF protection, locale, and bot mitigation at the edge. Without these the dashboard cannot work."
                  locked
                  value
                  onChange={() => {}}
                />
                <Row
                  title="Preferences"
                  desc="Theme, collapsed navigation, docs reading position, and wallboard layout. Declining resets each interface to defaults on every visit."
                  value={choice.preferences}
                  onChange={(v) => setChoice((c) => ({ ...c, preferences: v }))}
                />
                <Row
                  title="First-party analytics"
                  desc="Aggregate visitor and feature-usage counts, served from our own domain, never joined to identity data and never shared."
                  value={choice.analytics}
                  onChange={(v) => setChoice((c) => ({ ...c, analytics: v }))}
                />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-900/[0.04] pt-4">
                <button className="btn-ghost btn-sm" onClick={() => decide({ preferences: false, analytics: false })}>
                  Decline optional
                </button>
                <button className="btn-brand btn-sm" onClick={() => decide(choice)}>
                  Save choices
                </button>
                <button className="btn-quiet btn-sm" onClick={() => decide({ preferences: true, analytics: true })}>
                  Accept all
                </button>
                <Link href="/legal/cookies" className="ml-auto text-[12px] text-slateink-400 hover:text-slate-900">
                  Read the cookie policy
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
