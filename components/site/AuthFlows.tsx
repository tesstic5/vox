'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn, pinnedNow } from '@/lib/utils';
import { Button, useToast } from '@/components/ui';
import { Icons, LogoMark } from '@/components/icons';


/* --------------------------------------------------- talking to the server */

/**
 * Every screen in this file now calls a real endpoint, so they all want the same
 * two things: a typed fetch, and the server's own sentence when it refuses.
 *
 * The refusal message is shown verbatim. The auth endpoints write specific,
 * useful copy ("Five wrong attempts — this code is locked for an hour"), and a
 * generic "Something went wrong" would throw that away at the last step.
 */
type Call<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

async function authCall<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<Call<T>> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; message?: string };
      return { ok: false, code: err.code ?? 'ERROR', message: err.message ?? `Request failed (${res.status}).` };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, code: 'OFFLINE', message: 'Could not reach the server. Check the connection and try again.' };
  }
}

/** The headline for each way a link can fail, so every screen says the same thing. */
function linkTitle(reason?: string) {
  switch (reason) {
    case 'used':
      return 'That link was already used';
    case 'expired':
      return 'This link has expired';
    case 'revoked':
      return 'That link was cancelled';
    case 'locked':
      return 'That code is locked';
    default:
      return 'That link is not valid';
  }
}

function LinkProblem({ title, message, children }: { title: string; message: string; children?: React.ReactNode }) {
  return (
    <div>
      <span className="grid h-11 w-11 place-items-center rounded-2xl border border-amber-400/25 bg-amber-400/[0.08] text-amber-800">
        <Icons.alert size={19} />
      </span>
      <h1 className="h4 mt-5">{title}</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">{message}</p>
      {children}
    </div>
  );
}

function Checking({ what }: { what: string }) {
  return (
    <div className="py-6 text-center">
      <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-slate-900/[0.07] border-t-brand-400" />
      <p className="mt-4 text-[13px] text-slateink-300">{what}</p>
    </div>
  );
}

const SIGN_IN_AGAIN = (
  <div className="mt-6 flex flex-wrap gap-3">
    <Link href="/login" className="btn-brand px-5 py-3 text-[13.5px]">
      Back to sign in
    </Link>
    <Link href="/reset-password" className="btn-ghost px-5 py-3 text-[13.5px]">
      Request a new link
    </Link>
  </div>
);

/* ------------------------------------------------------------------ shell */

export function AuthCard({
  eyebrow,
  title,
  lede,
  children,
  aside,
  footer,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] lg:items-center">
      <div className="hidden lg:block">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-brand-700">{eyebrow}</div>
        <h2 className="h2 mt-5 text-balance">{title}</h2>
        {lede ? <p className="lede mt-5 max-w-[46ch]">{lede}</p> : null}
        {aside ? <div className="mt-10">{aside}</div> : null}
      </div>
      <div>
        <div className="panel p-6 sm:p-7">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <LogoMark size={26} />
            <span className="text-[15px] font-semibold text-slate-900">Voxera</span>
          </div>
          {children}
        </div>
        {footer ? <div className="mt-5 text-center text-[12.5px] text-slateink-400">{footer}</div> : null}
      </div>
    </div>
  );
}

export function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="mb-1.5 flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] font-medium text-slate-900">{children}</span>
      {hint ? <span className="text-[11px] text-slateink-400">{hint}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ pieces */

export function CodeInput({
  length = 6,
  value,
  onChange,
}: {
  length?: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(length, ' ').slice(0, length).split('');

  const set = (i: number, d: string) => {
    const clean = d.replace(/\D/g, '');
    if (!clean) {
      onChange((value.slice(0, i) + ' ' + value.slice(i + 1)).trimEnd());
      return;
    }
    const next = (value.padEnd(length, ' ').slice(0, i) + clean + value.padEnd(length, ' ').slice(i + 1)).slice(0, length);
    onChange(next.replace(/\s+$/, ''));
    if (i + clean.length < length) refs.current[i + clean.length]?.focus();
  };

  return (
    <div className="flex gap-2" role="group" aria-label={`${length} digit code`}>
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={digits[i].trim()}
          onChange={(e) => set(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i].trim() && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            set(0, e.clipboardData.getData('text'));
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          className="h-12 w-11 rounded-xl border border-slate-900/[0.035] bg-ink-900/80 text-center font-mono text-[17px] text-slate-900 focus:border-brand-500/50 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
      ))}
    </div>
  );
}

export function PasswordStrength({ value }: { value: string }) {
  const score = React.useMemo(() => {
    let s = 0;
    if (value.length >= 10) s++;
    if (value.length >= 14) s++;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) s++;
    if (/\d/.test(value)) s++;
    if (/[^A-Za-z0-9]/.test(value)) s++;
    return Math.min(s, 4);
  }, [value]);

  const labels = ['Too short', 'Weak', 'Fair', 'Strong', 'Excellent'];
  const tones = ['bg-red-400/70', 'bg-amber-400/70', 'bg-amber-300/80', 'bg-brand-400', 'bg-brand-400'];

  return (
    <div className="mt-2">
      <div className="flex gap-1.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn('h-1 flex-1 rounded-full', i < score ? tones[score] : 'bg-slate-900/[0.08]')} />
        ))}
      </div>
      <p className="mt-1.5 text-[11.5px] text-slateink-400">
        {value ? labels[score] : 'At least 10 characters, and length beats symbols.'}
      </p>
    </div>
  );
}

export function InboxPanel({
  email,
  title,
  body,
  ctaHref,
  ctaLabel,
  note,
  onResend,
  secondary,
}: {
  email: string;
  title: string;
  body: string;
  /**
   * Both are optional on purpose. A "sent" screen that offers a button to follow
   * a link nobody has — `/reset-password/rt_9f42c1ab` was literally that — is
   * worse than no button: it teaches people to trust a screen that lies.
   */
  ctaHref?: string;
  ctaLabel?: string;
  note?: React.ReactNode;
  onResend?: () => void;
  secondary?: React.ReactNode;
}) {
  const [cooldown, setCooldown] = React.useState(0);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  return (
    <div>
      <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
        <Icons.send size={19} />
      </span>
      <h1 className="h4 mt-5">{title}</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
        {body} <span className="text-slate-900">{email}</span>.
      </p>

      <div className="mt-6 rounded-xl border border-slate-900/[0.045] bg-slate-900/[0.02] p-4 text-[12.5px] leading-relaxed text-slateink-300">
        <div className="flex items-center gap-2 text-slate-900">
          <Icons.clock size={14} className="text-brand-700" />
          Not there in a minute?
        </div>
        <ul className="mt-2.5 space-y-1.5">
          <li>· Check the spam folder — cold emails from a voice platform look a lot like spam.</li>
          <li>· If your organisation enforces SSO, links from a password reset are still valid but expire in 15 minutes.</li>
          <li>· Delivery is usually under 4 seconds. Anything longer means the inbox provider is queueing.</li>
        </ul>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {ctaHref && ctaLabel ? (
          <Button variant="primary" onClick={() => window.open(ctaHref, '_self')}>
            {ctaLabel}
            <Icons.arrowRight size={15} />
          </Button>
        ) : null}
        {onResend ? (
          <Button
            variant="ghost"
            disabled={cooldown > 0}
            onClick={() => {
              onResend();
              setCooldown(45);
            }}
          >
            <Icons.refresh size={15} />
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
          </Button>
        ) : null}
      </div>
      {note ? <div className="mt-4 text-[12.5px] leading-relaxed text-slateink-400">{note}</div> : null}
      {secondary ? <div className="mt-5 border-t border-slate-900/[0.04] pt-5">{secondary}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- 7.1 reset */

export function ResetRequest() {
  const [email, setEmail] = React.useState('jordan@northwind.dev');
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    setBusy(true);
    const res = await authCall<{ requested: boolean; expiresInMinutes: number }>('/api/auth/password/request', {
      method: 'POST',
      body: { email },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setSent(true);
  }

  if (sent) {
    return (
      <InboxPanel
        email={email}
        title="Check your inbox for the reset link"
        body="If that address has an account here, a single-use reset link is on its way to"
        onResend={() => {
          void send();
        }}
        note={
          <>
            {error ? <span className="mb-2 block text-amber-800">{error}</span> : null}
            The link lasts fifteen minutes and works once. This screen answers the same way whether or not the address
            has an account — a reset form that says “no such user” is a free tool for finding out who your colleagues
            are.
          </>
        }
        secondary={
          <p className="text-[12.5px] text-slateink-400">
            Wrong address?{' '}
            <button className="text-brand-700 hover:underline" onClick={() => setSent(false)}>
              Use a different email
            </button>{' '}
            · Or{' '}
            <Link href="/magic-link" className="text-brand-700 hover:underline">
              sign in with a magic link
            </Link>{' '}
            instead.
          </p>
        }
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700 lg:hidden">Account recovery</div>
      <h1 className="h4 mt-3 lg:mt-0">Reset your password</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-slateink-300">
        Enter the email on the account. If your organisation enforces SSO you will still receive this link — it signs you
        into the same session SSO would have created.
      </p>

      <label className="mt-6 block">
        <FieldLabel>Work email</FieldLabel>
        <input className="field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>

      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3.5 text-[12.5px] text-amber-800">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center py-3">
        {busy ? 'Sending…' : 'Send the reset link'}
        {!busy ? <Icons.arrowRight size={15} /> : null}
      </Button>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-900/[0.04] pt-5 text-[12.5px]">
        <Link href="/magic-link" className="text-brand-700 hover:underline">
          Email me a magic link
        </Link>
        <Link href="/sso" className="text-slateink-300 hover:text-slate-900">
          Continue with SSO
        </Link>
        <Link href="/login" className="ml-auto text-slateink-400 hover:text-slate-900">
          Back to sign in
        </Link>
      </div>
    </form>
  );
}

type LinkCheck = { valid: boolean; reason?: string; message?: string; email?: string };

export function ResetConfirm({ token }: { token: string }) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<'checking' | 'form' | 'invalid' | 'done'>('checking');
  const [check, setCheck] = React.useState<LinkCheck>({ valid: false });
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [ended, setEnded] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await authCall<LinkCheck>(`/api/auth/password/state?token=${encodeURIComponent(token)}`);
      if (!alive) return;
      if (res.ok && res.data.valid) {
        setEmail(res.data.email ?? '');
        setPhase('form');
        return;
      }
      setCheck(res.ok ? res.data : { valid: false, reason: 'unknown', message: res.message });
      setPhase('invalid');
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters — it is the server’s line too, and length is the part that matters.');
      return;
    }
    if (password !== confirm) {
      setError('The two entries do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    const res = await authCall<{ sessionsEnded: number; email: string }>('/api/auth/password/reset', {
      method: 'POST',
      body: { token, password },
    });
    setBusy(false);
    if (!res.ok) {
      // A spent or expired link is not a form error: the form is over.
      if (res.code === 'CONFLICT') {
        setCheck({ valid: false, reason: 'used', message: res.message });
        setPhase('invalid');
      } else {
        setError(res.message);
      }
      return;
    }
    setEnded(res.data.sessionsEnded);
    setPhase('done');
  }

  if (phase === 'checking') return <Checking what="Checking the reset link…" />;

  if (phase === 'invalid') {
    return (
      <LinkProblem title={linkTitle(check.reason)} message={check.message ?? 'Reset links last fifteen minutes and work once.'}>
        {SIGN_IN_AGAIN}
      </LinkProblem>
    );
  }

  if (phase === 'done') {
    return (
      <div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
          <Icons.check size={19} />
        </span>
        <h1 className="h4 mt-5">Password changed</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
          Signed in as <span className="text-slate-900">{email}</span>. Every session on the account was ended —{' '}
          <span className="text-slate-900">{ended}</span> in total — and this browser has a brand-new one. Anywhere else you
          were signed in will ask for the new password.
        </p>
        <Button variant="primary" className="mt-6 w-full justify-center py-3" onClick={() => router.push('/dashboard')}>
          Go to the dashboard
          <Icons.arrowRight size={15} />
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700 lg:hidden">Account recovery</div>
      <h1 className="h4 mt-3 lg:mt-0">Choose a new password</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-slateink-300">
        Reset link for <span className="text-slate-900">{email}</span>. Every other session is signed out the moment you
        save.
      </p>

      <label className="mt-6 block">
        <FieldLabel>New password</FieldLabel>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
        />
        <PasswordStrength value={password} />
      </label>

      <label className="mt-5 block">
        <FieldLabel>Confirm password</FieldLabel>
        <input
          className="field"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3.5 text-[12.5px] text-amber-800">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center py-3">
        {busy ? 'Saving…' : 'Set the new password'}
      </Button>

      <p className="mt-5 border-t border-slate-900/[0.04] pt-5 text-[12px] leading-relaxed text-slateink-400">
        Signing out of other devices is automatic. You can review the session list afterwards in Dashboard → Settings →
        Security.
      </p>
    </form>
  );
}

/* ---------------------------------------------------------- 7.1b magic link */

export function MagicLinkRequest() {
  const [email, setEmail] = React.useState('jordan@northwind.dev');
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    setBusy(true);
    const res = await authCall<{ requested: boolean }>('/api/auth/magic/request', { method: 'POST', body: { email } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setSent(true);
  }

  if (sent) {
    return (
      <InboxPanel
        email={email}
        title="Your magic link is on the way"
        body="If that address has an account, a single-use sign-in link is on its way to"
        onResend={() => {
          void send();
        }}
        note={
          <>
            {error ? <span className="mb-2 block text-amber-800">{error}</span> : null}
            Nothing happens until you open the link and press the button on the page it opens. That is deliberate: mail
            scanners happily fetch every link in a message, and a link that signs you in on fetch would be spent before
            you ever clicked it.
          </>
        }
        secondary={
          <p className="text-[12.5px] text-slateink-400">
            Prefer a password?{' '}
            <Link href="/reset-password" className="text-brand-700 hover:underline">
              Reset it instead
            </Link>
            .
          </p>
        }
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700 lg:hidden">Passwordless</div>
      <h1 className="h4 mt-3 lg:mt-0">Sign in with a magic link</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-slateink-300">
        No password to remember or rotate. We email a link that signs you into the dashboard directly — useful on shared
        machines where you would rather not type a password at all.
      </p>

      <label className="mt-6 block">
        <FieldLabel>Work email</FieldLabel>
        <input className="field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>

      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3.5 text-[12.5px] text-amber-800">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center py-3">
        {busy ? 'Sending…' : 'Send the link'}
        {!busy ? <Icons.send size={15} /> : null}
      </Button>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-900/[0.04] pt-5 text-[12.5px]">
        <Link href="/reset-password" className="text-brand-700 hover:underline">
          Reset a forgotten password
        </Link>
        <Link href="/sso" className="text-slateink-300 hover:text-slate-900">
          Continue with SSO
        </Link>
        <Link href="/login" className="ml-auto text-slateink-400 hover:text-slate-900">
          Back to sign in
        </Link>
      </div>
    </form>
  );
}

/**
 * The page the emailed link opens.
 *
 * It reads the token first and shows the address it belongs to, so nobody is
 * asked to press "sign me in" on a link they did not ask for, and a forwarder
 * that follows every URL still cannot spend it.
 */
export function MagicLinkConsume({ token }: { token: string }) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<'checking' | 'ready' | 'invalid'>('checking');
  const [check, setCheck] = React.useState<LinkCheck>({ valid: false });
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await authCall<LinkCheck>(`/api/auth/magic/state?token=${encodeURIComponent(token)}`);
      if (!alive) return;
      if (res.ok && res.data.valid) {
        setEmail(res.data.email ?? '');
        setPhase('ready');
        return;
      }
      setCheck(res.ok ? res.data : { valid: false, reason: 'unknown', message: res.message });
      setPhase('invalid');
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function signIn() {
    setBusy(true);
    const res = await authCall<{ signedIn: boolean; user: { email: string } }>('/api/auth/magic/consume', {
      method: 'POST',
      body: { token },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      setCheck({ valid: false, reason: res.code === 'CONFLICT' ? 'used' : 'unknown', message: res.message });
      setPhase('invalid');
      return;
    }
    router.push('/dashboard');
  }

  if (phase === 'checking') return <Checking what="Checking the sign-in link…" />;

  if (phase === 'invalid') {
    return (
      <LinkProblem title={linkTitle(check.reason)} message={check.message ?? 'Sign-in links last fifteen minutes.'}>
        {SIGN_IN_AGAIN}
      </LinkProblem>
    );
  }

  return (
    <div>
      <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
        <Icons.send size={19} />
      </span>
      <h1 className="h4 mt-5">Sign in as {email}?</h1>
      <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
        Pressing the button spends the link and starts a normal session with this account’s existing role. Second-factor
        actions — key rotation, billing, member removal — still ask for one.
      </p>
      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3.5 text-[12.5px] text-amber-800">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <Button variant="primary" disabled={busy} className="mt-6 w-full justify-center py-3" onClick={() => void signIn()}>
        {busy ? 'Signing you in…' : 'Sign me in'}
        {!busy ? <Icons.arrowRight size={15} /> : null}
      </Button>
      <p className="mt-5 border-t border-slate-900/[0.04] pt-5 text-[12px] leading-relaxed text-slateink-400">
        Not you? Close this page — the link expires in fifteen minutes and nothing has been used up.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- 7.2 email verify */

/**
 * The six-digit code screen.
 *
 * It asks the server what is true — is this account already verified, is there a
 * live code, is it locked — instead of assuming. That is why the screen no longer
 * has a "sent" variant: the old one printed a hard-coded address and told you a
 * code had been sent whether or not anything had been sent at all.
 */
export function VerifyEmail() {
  const router = useRouter();
  const toast = useToast();
  const [phase, setPhase] = React.useState<'checking' | 'signin' | 'code' | 'verified' | 'locked'>('checking');
  const [email, setEmail] = React.useState('');
  const [attemptsLeft, setAttemptsLeft] = React.useState<number | null>(null);
  const [retryAt, setRetryAt] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(
    async (allowSend: boolean) => {
      const res = await authCall<{
        verified: boolean;
        email: string;
        code: { outstanding: boolean; attemptsLeft?: number; locked?: boolean; retryAt?: string };
      }>('/api/auth/verify');
      if (!res.ok) {
        if (res.code === 'UNAUTHORIZED') setPhase('signin');
        else {
          setError(res.message);
          setPhase('code');
        }
        return;
      }
      setEmail(res.data.email);
      if (res.data.verified) {
        setPhase('verified');
        return;
      }
      if (res.data.code.locked) {
        setRetryAt(res.data.code.retryAt ?? null);
        setPhase('locked');
        return;
      }
      setAttemptsLeft(res.data.code.attemptsLeft ?? null);
      setPhase('code');
      // Only ask for a code when there is not one already in flight: re-sending
      // would revoke the code sitting in the inbox.
      if (allowSend && !res.data.code.outstanding) await send(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  async function send(loud = true) {
    setBusy(true);
    const res = await authCall<{ sent: boolean; alreadyVerified?: boolean; email: string }>('/api/auth/verify', {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === 'CONFLICT') {
        setPhase('locked');
        setError(res.message);
        return false;
      }
      setError(res.message);
      return false;
    }
    if (res.data.alreadyVerified) {
      setPhase('verified');
      return true;
    }
    setAttemptsLeft(5);
    if (loud) {
      toast(`New code sent to ${res.data.email}.`);
      setCode('');
    }
    return true;
  }

  React.useEffect(() => {
    void refresh(true);
  }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.replace(/\D/g, '').length < 6) {
      setError('Enter all six digits — they are in the email.');
      return;
    }
    setError(null);
    setBusy(true);
    const res = await authCall<{ verified: boolean; email: string }>('/api/auth/verify/confirm', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      if (res.code === 'CONFLICT') setPhase('locked');
      return;
    }
    setPhase('verified');
    toast(`Email verified — ${res.data.email} can publish and provision numbers now.`);
  }

  if (phase === 'checking') return <Checking what="Checking your verification state…" />;

  if (phase === 'signin') {
    return (
      <LinkProblem
        title="Sign in to verify"
        message="Verification codes belong to an account, so there has to be one signed in before we can send or accept a code."
      >
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/login" className="btn-brand px-5 py-3 text-[13.5px]">
            Sign in
          </Link>
          <Link href="/signup" className="btn-ghost px-5 py-3 text-[13.5px]">
            Create an account
          </Link>
        </div>
      </LinkProblem>
    );
  }

  if (phase === 'locked') {
    return (
      <LinkProblem
        title="This code is locked"
        message={
          error ??
          `Five wrong attempts locks a code for an hour — that is the rule printed on this screen, and it is enforced on the server. Send yourself a fresh code after ${retryAt ? new Date(retryAt).toLocaleTimeString() : 'an hour'}.`
        }
      >
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/dashboard" className="btn-ghost px-5 py-3 text-[13.5px]">
            Back to the dashboard
          </Link>
        </div>
      </LinkProblem>
    );
  }

  if (phase === 'verified') {
    return (
      <div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
          <Icons.check size={19} />
        </span>
        <h1 className="h4 mt-5">You are verified</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
          <span className="text-slate-900">{email}</span> is confirmed. Publishing an assistant, buying a number and creating
          API keys are unlocked.
        </p>
        <Button variant="primary" className="mt-6 w-full justify-center py-3" onClick={() => router.push('/dashboard/setup')}>
          Continue to setup
          <Icons.arrowRight size={15} />
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700 lg:hidden">Almost there</div>
      <h1 className="h4 mt-3 lg:mt-0">Enter the six-digit code</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-slateink-300">
        Sent to <span className="text-slate-900">{email}</span>. It expires in fifteen minutes
        {attemptsLeft !== null ? ` and you have ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left` : ''}.
      </p>

      <div className="mt-6">
        <CodeInput value={code} onChange={setCode} />
      </div>

      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3.5 text-[12.5px] text-amber-800">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center py-3">
        {busy ? 'Verifying…' : 'Verify and continue'}
        {!busy ? <Icons.arrowRight size={15} /> : null}
      </Button>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-900/[0.04] pt-5 text-[12.5px]">
        <button type="button" className="text-brand-700 hover:underline" onClick={() => void send()}>
          Send a new code
        </button>
        <Link href="/dashboard" className="text-slateink-300 hover:text-slate-900">
          Not now
        </Link>
        <Link href="/support" className="ml-auto text-slateink-400 hover:text-slate-900">
          Code never arrived?
        </Link>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- 7.3 SSO */

const IDENTITY_PROVIDERS = [
  { id: 'okta', name: 'Okta', protocol: 'SAML 2.0', note: 'SCIM provisioning supported' },
  { id: 'entra', name: 'Microsoft Entra ID', protocol: 'OIDC', note: 'Groups map to Voxera roles' },
  { id: 'google', name: 'Google Workspace', protocol: 'OIDC', note: 'Workspace domain verification' },
  { id: 'onelogin', name: 'OneLogin', protocol: 'SAML 2.0', note: 'Just-in-time provisioning' },
  { id: 'ping', name: 'Ping Identity', protocol: 'SAML 2.0', note: 'Signed assertions required' },
  { id: 'generic', name: 'Other SAML provider', protocol: 'SAML 2.0', note: 'Paste your metadata XML' },
];

export function SsoDiscovery() {
  const router = useRouter();
  const toast = useToast();
  const [domain, setDomain] = React.useState('northwind.dev');
  const [found, setFound] = React.useState<null | { provider: string; protocol: string; enforced: boolean }>(null);
  const [redirecting, setRedirecting] = React.useState(false);

  const discover = (e: React.FormEvent) => {
    e.preventDefault();
    if (!domain.includes('.')) return;
    setFound({ provider: 'Okta', protocol: 'SAML 2.0', enforced: true });
    toast('Identity provider discovered for ' + domain);
  };

  if (redirecting) {
    return (
      <div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
          <Icons.lock size={19} />
        </span>
        <h1 className="h4 mt-5">Redirecting to Okta</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
          Authenticating against <span className="font-mono text-[12.5px] text-slate-900">northwind.okta.com</span>. Your
          password never reaches Voxera — the identity provider returns a signed assertion and we exchange it for a
          session.
        </p>
        <div className="mt-5 space-y-2.5">
          {[
            ['Redirect issued', true],
            ['SAML AuthnRequest signed', true],
            ['Waiting for the assertion', false],
          ].map(([label, done]) => (
            <div key={label as string} className="flex items-center gap-3 text-[12.5px] text-slateink-300">
              <span
                className={cn(
                  'grid h-5 w-5 place-items-center rounded-full border',
                  done ? 'border-brand-500/30 bg-brand-500/[0.14] text-brand-700' : 'border-slate-900/[0.045] text-slateink-400'
                )}
              >
                {done ? <Icons.check size={11} /> : <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
              </span>
              {label}
            </div>
          ))}
        </div>
        <Button variant="primary" className="mt-6 w-full justify-center py-3" onClick={() => router.push('/dashboard')}>
          Complete sign-in (demo)
          <Icons.arrowRight size={15} />
        </Button>
      </div>
    );
  }

  if (found) {
    return (
      <div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
          <Icons.building size={19} />
        </span>
        <h1 className="h4 mt-5">{domain} signs in with {found.provider}</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
          {found.enforced
            ? 'Your organisation requires SSO, so password sign-in is disabled for this domain. Personal access tokens and the CLI are unaffected.'
            : 'SSO is available but not enforced — you can still use a password if you prefer.'}
        </p>

        <div className="mt-5 space-y-2.5 rounded-xl border border-slate-900/[0.045] bg-slate-900/[0.02] p-4 text-[12.5px] text-slateink-300">
          {[
            ['Protocol', found.protocol],
            ['Provisioning', 'SCIM enabled — group membership maps to roles'],
            ['Default role for new members', 'developer'],
            ['Just-in-time provisioning', 'On, first sign-in creates the account'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <span className="text-slateink-400">{k}</span>
              <span className="text-right text-slateink-200">{v}</span>
            </div>
          ))}
        </div>

        <Button variant="primary" className="mt-5 w-full justify-center py-3" onClick={() => setRedirecting(true)}>
          <Icons.lock size={15} /> Continue with {found.provider}
        </Button>
        <button
          className="mt-4 w-full text-center text-[12.5px] text-slateink-400 hover:text-slate-900"
          onClick={() => setFound(null)}
        >
          Use a different domain
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={discover}>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700 lg:hidden">Enterprise sign-in</div>
      <h1 className="h4 mt-3 lg:mt-0">Sign in with SSO</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-slateink-300">
        Enter your work domain and we will route you to the right identity provider. No need to know whether your
        organisation uses SAML or OIDC — the domain lookup handles that.
      </p>

      <label className="mt-6 block">
        <FieldLabel hint="no https://">Company domain</FieldLabel>
        <input className="field" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" />
      </label>

      <Button type="submit" variant="primary" className="mt-5 w-full justify-center py-3">
        Find my identity provider
        <Icons.arrowRight size={15} />
      </Button>

      <div className="mt-6 border-t border-slate-900/[0.04] pt-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Or pick a provider</div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {IDENTITY_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setFound({ provider: p.name, protocol: p.protocol, enforced: true });
                toast(`${p.name} selected`);
              }}
              className="flex items-center gap-3 rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.02] px-3.5 py-3 text-left transition-colors hover:border-brand-500/30"
            >
              <Icons.lock size={15} className="shrink-0 text-slateink-400" />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-slate-900">{p.name}</span>
                <span className="block text-[11px] text-slateink-400">
                  {p.protocol} · {p.note}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <p className="mt-5 text-[12px] text-slateink-400">
        Admin? Configure SSO and SCIM in{' '}
        <Link href="/dashboard/settings/security" className="text-brand-700 hover:underline">
          Dashboard → Settings → Security
        </Link>
        .
      </p>
    </form>
  );
}

/* ------------------------------------------------------- 7.4 invite accept */

/**
 * Accepting an invitation.
 *
 * Everything on this screen comes from the token: who invited whom, which
 * workspace, and — the part that used to be a bug — which role. The old version
 * offered the invitee a dropdown of roles, so somebody invited as a viewer could
 * pick "admin" and grant it to themselves. The role is chosen by the person doing
 * the inviting and shown here as a fact.
 */
export function InviteAccept({
  token,
  valid,
  org,
  inviter,
  email,
  role: invitedRole,
  expiresIn,
}: {
  token: string;
  /**
   * Optional pre-fetched invite details, for callers that already resolved
   * the token on the server. They only seed the first paint: the effect
   * below always re-checks the token against `/api/auth/invite/state`, so
   * a stale `valid` here can never accept (or refuse) an invite on its own.
   */
  valid?: boolean;
  org?: string;
  inviter?: string;
  email?: string;
  role?: string;
  expiresIn?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [phase, setPhase] = React.useState<'checking' | 'ready' | 'joined' | 'invalid' | 'declined'>(
    valid === false ? 'invalid' : 'checking'
  );
  const [invite, setInvite] = React.useState<null | {
    email: string;
    org: string;
    inviter: string;
    role: string;
    expiresAt: string;
    name: string;
  }>(
    valid && (org || email)
      ? { email: email ?? '', org: org ?? '', inviter: inviter ?? '', role: invitedRole ?? 'viewer', expiresAt: '', name: '' }
      : null
  );
  const [check, setCheck] = React.useState<LinkCheck>({ valid: false });
  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [joined, setJoined] = React.useState<{ org: string; role: string; email: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await authCall<{ valid: boolean; reason?: string; message?: string } & Record<string, string>>(
        `/api/auth/invite/state?token=${encodeURIComponent(token)}`
      );
      if (!alive) return;
      if (res.ok && res.data.valid) {
        const data = res.data as unknown as { email: string; org: string; inviter: string; role: string; expiresAt: string; name: string };
        setInvite(data);
        setName(data.name ?? '');
        setPhase('ready');
        return;
      }
      setCheck(res.ok ? (res.data as unknown as LinkCheck) : { valid: false, reason: 'unknown', message: res.message });
      setPhase('invalid');
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters — it is the server’s line too.');
      return;
    }
    if (password !== confirm) {
      setError('The two entries do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    const res = await authCall<{ joined: boolean; org: string; role: string; email: string }>('/api/auth/invite/accept', {
      method: 'POST',
      body: { token, name, password },
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === 'CONFLICT') {
        setCheck({ valid: false, reason: 'used', message: res.message });
        setPhase('invalid');
      } else {
        setError(res.message);
      }
      return;
    }
    setJoined({ org: res.data.org, role: res.data.role, email: res.data.email });
    setPhase('joined');
    toast(`You are in ${res.data.org}.`);
  }

  async function decline() {
    const res = await authCall('/api/auth/invite/decline', { method: 'POST', body: { token } });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPhase('declined');
  }

  if (phase === 'checking') return <Checking what="Checking the invitation…" />;

  if (phase === 'declined') {
    return (
      <div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.03] text-slateink-300">
          <Icons.check size={19} />
        </span>
        <h1 className="h4 mt-5">Invitation declined</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
          The link has been cancelled, so it cannot be used by anybody else either. The person who invited you can send a
          new one if this was a mistake.
        </p>
        <Link href="/" className="btn-ghost mt-6 inline-flex px-5 py-3 text-[13.5px]">
          Back to the site
        </Link>
      </div>
    );
  }

  if (phase === 'invalid') {
    return (
      <LinkProblem title={linkTitle(check.reason)} message={check.message ?? 'Invitations last seven days and work once.'}>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/login" className="btn-brand px-5 py-3 text-[13.5px]">
            Back to sign in
          </Link>
          <Link href="/support" className="btn-ghost px-5 py-3 text-[13.5px]">
            Ask for a new invitation
          </Link>
        </div>
      </LinkProblem>
    );
  }

  if (phase === 'joined' && joined) {
    return (
      <div>
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.08] text-brand-700">
          <Icons.check size={19} />
        </span>
        <h1 className="h4 mt-5">You are in {joined.org}</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-slateink-300">
          Signed in as <span className="text-slate-900">{joined.email}</span> with the{' '}
          <span className="text-slate-900">{joined.role}</span> role, with the password you just chose. Your session is
          scoped to this organisation — switch between organisations from the account menu, not by signing out.
        </p>
        <Button variant="primary" className="mt-6 w-full justify-center py-3" onClick={() => router.push('/dashboard')}>
          Open the dashboard
          <Icons.arrowRight size={15} />
        </Button>
      </div>
    );
  }

  const role = invite?.role ?? 'receptionist';
  // A pre-fetched seed may carry a human `expiresIn` ("3 days") or nothing
  // parseable as a date; fall back to the neutral 7 rather than NaN.
  const expiryMs = invite ? new Date(invite.expiresAt).getTime() : NaN;
  const days = Number.isFinite(expiryMs) ? Math.max(0, Math.ceil((expiryMs - pinnedNow()) / 86_400_000)) : 7;
  void expiresIn;

  return (
    <form onSubmit={accept}>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700 lg:hidden">Invitation</div>
      <h1 className="h4 mt-3 lg:mt-0">
        {invite?.inviter} invited you to {invite?.org}
      </h1>
      <p className="mt-3 text-[13px] leading-relaxed text-slateink-300">
        The invitation was sent to <span className="text-slate-900">{invite?.email}</span> and expires in {days} day
        {days === 1 ? '' : 's'}. Choose a password to accept it.
      </p>

      <div className="mt-5 rounded-xl border border-slate-900/[0.045] bg-slate-900/[0.02] p-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">You have been given</div>
        <div className="mt-1.5 text-[13.5px] font-medium text-slate-900">{role}</div>
        <ul className="mt-3 space-y-2 text-[12.5px] text-slateink-300">
          {(role === 'viewer'
            ? ['Read call logs, transcripts, and analytics', 'Export reports and download recordings', 'Comment on eval reviews']
            : role === 'developer'
              ? [
                  'Create and edit assistants, tools, and workflows',
                  'Read call logs, transcripts, and analytics',
                  'Run simulations and evals, and use the API playground',
                  'Manage API keys, but not billing or members',
                ]
              : role === 'receptionist' || role === 'practitioner'
                ? ['Run the diary: appointments, clients, and reminders', 'Take payments and send payment links', 'Cannot read clinical notes']
                : [
                    'Everything a developer can do, plus publish and release',
                    'Manage phone numbers, campaigns, and integrations',
                    'Manage members and roles, and read the audit log',
                    'Billing access, but not ownership transfer',
                  ]
          ).map((x) => (
            <li key={x} className="flex gap-2.5">
              <Icons.check size={14} className="mt-0.5 shrink-0 text-brand-400" />
              {x}
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-slate-900/[0.04] pt-3 text-[12px] text-slateink-400">
          The role travels with the invitation — it is set by whoever invited you, not on this screen.
        </p>
      </div>

      <label className="mt-5 block">
        <FieldLabel>Your name</FieldLabel>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </label>

      <label className="mt-5 block">
        <FieldLabel hint="at least 8 characters">Choose a password</FieldLabel>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        <PasswordStrength value={password} />
      </label>

      <label className="mt-5 block">
        <FieldLabel>Confirm password</FieldLabel>
        <input
          className="field"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3.5 text-[12.5px] text-amber-800">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full justify-center py-3">
        {busy ? 'Joining…' : `Accept and join ${invite?.org ?? ''}`}
        {!busy ? <Icons.arrowRight size={15} /> : null}
      </Button>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-900/[0.04] pt-5 text-[12.5px]">
        <button type="button" className="text-slateink-400 hover:text-slate-900" onClick={() => void decline()}>
          Decline and cancel the link
        </button>
        <Link href="/terms-of-service" className="text-slateink-400 hover:text-slate-900">
          Terms
        </Link>
        <Link href="/legal/dpa" className="ml-auto text-slateink-400 hover:text-slate-900">
          Data processing addendum
        </Link>
      </div>
    </form>
  );
}
