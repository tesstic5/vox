'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { useToast } from '../ui';
import { Icons, LogoMark } from '../icons';
import { BUSINESS_TYPE_OPTIONS, type BusinessType } from '@/lib/business';

/** Small typed wrapper around the auth endpoints. */
async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const toast = useToast();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [name, setName] = React.useState('');
  const [businessType, setBusinessType] = React.useState<BusinessType | ''>('');
  const [otherDescription, setOtherDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  // Two-factor step: the password was accepted and the server wants a code.
  const [mfaChallenge, setMfaChallenge] = React.useState<string | null>(null);
  const [mfaCode, setMfaCode] = React.useState('');
  const [showPw, setShowPw] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const valid =
    email.includes('@') &&
    (mode === 'login'
      ? password.length > 0
      : password.length >= 8 && name.trim().length > 1 && company.trim().length > 1 && Boolean(businessType));
  // A new account goes straight into setup; an existing one goes where it asked
  // to go. The wizard is four real steps, not a tour.
  const fallback = mode === 'signup' ? '/dashboard/setup' : '/dashboard';
  const next = typeof window === 'undefined' ? fallback : new URLSearchParams(window.location.search).get('next') || fallback;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        const res = await post<{ mfaRequired?: boolean; challenge?: string }>('/api/auth/login', { email, password });
        if (res.mfaRequired && res.challenge) {
          // No session yet — the code step below finishes the sign-in.
          setMfaChallenge(res.challenge);
          setBusy(false);
          return;
        }
        toast('Signed in — welcome back.');
        // Hard navigation: the workspace provider boots with the session cookie
        // and hydrates the dashboard from the API in one pass.
        window.location.assign(next);
        return;
      }
      {
        const res = await post<{ org: { name: string }; user: { email: string } }>('/api/auth/signup', {
          email,
          password,
          name,
          orgName: company,
          businessType,
          otherDescription: businessType === 'other' ? otherDescription.trim() || undefined : undefined,
        });
        setNotice(`Workspace “${res.org.name}” created. Setting up your agent…`);
        // A fresh org is seeded through the real runtime before the dashboard opens.
        await post('/api/bootstrap').catch(() => undefined);
        toast('Account created — your workspace is ready.');
        window.location.assign(next);
        return;
      }
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaChallenge || busy || mfaCode.trim().length < 6) return;
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login/verify', { challenge: mfaChallenge, code: mfaCode.trim() });
      toast('Signed in — welcome back.');
      window.location.assign(next);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'That code did not work. Try again.');
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-center">
      <div className="hidden lg:block">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-brand-700">
          {mode === 'login' ? 'Welcome back' : 'Welcome to Voxera'}
        </div>
        <h1 className="h2 mt-5 text-balance">
          {mode === 'login' ? 'Your business, all in one place.' : 'Make more time for your customers.'}
        </h1>
        <p className="lede mt-5 max-w-[46ch]">
          {mode === 'login'
            ? 'Sign in to manage your schedule, customers, calls and messages.'
            : 'Bring your appointments, customer communications and business records together in one workspace.'}
        </p>

        <div className="mt-10 space-y-3">
          {[
            { t: 'Keep your diary organised', d: 'Manage appointments, availability and your team in one place.' },
            { t: 'Stay in touch', d: 'Send confirmations and reminders when your messaging provider is connected.' },
            { t: 'Set up an assistant', d: 'Configure an assistant to help with calls and bookings.' },
          ].map((x) => (
            <div key={x.t} className="flex gap-3.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-brand-500/20 bg-brand-500/[0.07] text-brand-700">
                <Icons.check size={15} />
              </span>
              <div>
                <div className="text-[14px] font-medium text-slate-900">{x.t}</div>
                <p className="mt-0.5 text-[12.5px] text-slateink-400">{x.d}</p>
              </div>
            </div>
          ))}
        </div>

      </div>

      <div className="w-full rounded-3xl border border-slate-900/[0.035] bg-ink-850/85 p-6 shadow-panel backdrop-blur sm:p-8">
        <div className="lg:hidden">
          <LogoMark size={32} />
        </div>
        <h2 className="mt-6 text-[20px] font-semibold tracking-[-0.02em] text-slate-900 lg:mt-0">
          {mode === 'login' ? 'Sign in to Voxera' : 'Create your account'}
        </h2>
        <p className="mt-2 mb-6 text-[13px] text-slateink-400">
          {mode === 'login'
            ? 'Enter your email and password to continue.'
            : 'Create a workspace with your email and password.'}
        </p>

        {mfaChallenge ? (
          <form onSubmit={submitMfa} className="space-y-4">
            <div className="rounded-xl border border-brand-500/25 bg-brand-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-brand-700">
              Password accepted. Enter the current code from your authenticator app — or a recovery code if the
              phone is out of reach.
            </div>
            <div>
              <label className="label" htmlFor="auth-mfa-code">Authentication code</label>
              <input
                id="auth-mfa-code"
                className="field font-mono tracking-[0.25em]"
                placeholder="000000"
                inputMode="text"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.slice(0, 12))}
                autoFocus
              />
            </div>
            {error && (
              <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-red-700">
                {error}
              </div>
            )}
            <button type="submit" disabled={busy || mfaCode.trim().length < 6} className={cn('btn-brand w-full py-3')}>
              {busy ? (
                <>
                  <Icons.refresh size={15} className="animate-spin" /> Checking code…
                </>
              ) : (
                <>
                  Verify and sign in <Icons.arrowRight size={15} />
                </>
              )}
            </button>
            <button
              type="button"
              className="w-full text-center text-[12.5px] text-slateink-300 hover:text-slate-900"
              onClick={() => {
                setMfaChallenge(null);
                setMfaCode('');
                setError(null);
              }}
            >
              Start over with a different account
            </button>
          </form>
        ) : (
        <form onSubmit={submit} className="space-y-4">
          {mode === 'signup' && (
            <>
              <div>
                <label className="label" htmlFor="auth-name">Full name</label>
                <input id="auth-name" className="field" autoComplete="name" placeholder="Jordan Reyes" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="auth-company">Company</label>
                <input id="auth-company" className="field" autoComplete="organization" placeholder="Northwind Inc." value={company} onChange={(e) => setCompany(e.target.value)} />
              </div>
              <fieldset>
                <legend className="label">What kind of business is this?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {BUSINESS_TYPE_OPTIONS.map((option) => (
                    <label
                      key={option.id}
                      className={cn(
                        'cursor-pointer rounded-xl border px-3 py-2.5 transition-colors',
                        businessType === option.id
                          ? 'border-brand-500/45 bg-brand-500/[0.08]'
                          : 'border-slate-900/[0.06] bg-slate-900/[0.015] hover:border-slate-900/[0.12]'
                      )}
                    >
                      <span className="flex items-start gap-2.5">
                        <input
                          type="radio"
                          name="businessType"
                          value={option.id}
                          checked={businessType === option.id}
                          onChange={() => setBusinessType(option.id)}
                          className="mt-0.5 accent-emerald-500"
                          required
                        />
                        <span>
                          <span className="block text-[12.5px] font-medium text-slate-900">{option.label}</span>
                          <span className="mt-0.5 block text-[10.5px] leading-snug text-slateink-400">{option.description}</span>
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-slateink-400">
                  This recommends language and modules. An owner can change both later.
                </p>
              </fieldset>
              {businessType === 'other' && (
                <div>
                  <label className="label" htmlFor="auth-business-description">Describe the business <span className="text-slateink-400">(optional)</span></label>
                  <input
                    id="auth-business-description"
                    className="field"
                    maxLength={120}
                    placeholder="For example, property management"
                    value={otherDescription}
                    onChange={(e) => setOtherDescription(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          <div>
            <label className="label" htmlFor="auth-email">Work email</label>
            <input
              id="auth-email"
              className="field"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="auth-password">Password</label>
            <div className="relative">
              <input
                id="auth-password"
                className="field pr-10"
                type={showPw ? 'text' : 'password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slateink-400 hover:text-slate-900"
                aria-label="Toggle password visibility"
              >
                <Icons.eye size={15} />
              </button>
            </div>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-red-700">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-xl border border-brand-500/25 bg-brand-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-brand-700">
              {notice}
            </div>
          )}

          <button type="submit" disabled={!valid || busy} className={cn('btn-brand w-full py-3')}>
            {busy ? (
              <>
                <Icons.refresh size={15} className="animate-spin" /> {mode === 'login' ? 'Signing in…' : 'Creating account…'}
              </>
            ) : (
              <>
                {mode === 'login' ? 'Sign in' : 'Create account'} <Icons.arrowRight size={15} />
              </>
            )}
          </button>
        </form>
        )}

        {mode === 'login' && !mfaChallenge ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[12.5px]">
            <a href="/reset-password" className="text-slateink-300 hover:text-slate-900">
              Forgot password?
            </a>
            <a href="/magic-link" className="text-slateink-300 hover:text-slate-900">
              Magic link
            </a>
            <a href="/sso" className="text-slateink-300 hover:text-slate-900">
              Sign in with SSO
            </a>
          </div>
        ) : (
          <p className="mt-4 text-center text-[12.5px] text-slateink-400">
            Invited by an admin? Open the link in the invitation email — invitations are single-use, so it is the only
            one that works.
          </p>
        )}

        <p className="mt-5 text-center text-[12.5px] text-slateink-400">
          {mode === 'login' ? (
            <>
              New here?{' '}
              <a href="/signup" className="text-brand-700 underline underline-offset-2">
                Create an account
              </a>
            </>
          ) : (
            <>
              Already have one?{' '}
              <a href="/login" className="text-brand-700 underline underline-offset-2">
                Sign in
              </a>
            </>
          )}
        </p>

        <p className="mt-6 border-t border-slate-900/[0.04] pt-5 text-center font-mono text-[10.5px] leading-relaxed text-slateink-400">
          By continuing you agree to our{' '}
          <a href="/terms-of-service" className="text-slateink-300 underline underline-offset-2 hover:text-slate-900">
            Terms
          </a>{' '}
          and{' '}
          <a href="/privacy" className="text-slateink-300 underline underline-offset-2 hover:text-slate-900">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
