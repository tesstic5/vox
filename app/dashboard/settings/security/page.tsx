'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, Pill, Tabs, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

const METHODS = [
  {
    id: 'totp' as const,
    name: 'Authenticator app',
    desc: 'Time-based codes from 1Password, Authy, Google Authenticator, or any TOTP app. Works offline.',
    recommended: true,
  },
  {
    id: 'webauthn' as const,
    name: 'Security key or passkey',
    desc: 'A hardware key or platform passkey bound to this device. Phishing-resistant by construction.',
    recommended: false,
  },
  {
    id: 'sms' as const,
    name: 'SMS code',
    desc: 'A six-digit code to the phone on file. Convenient, and the weakest of the three — SIM swaps happen.',
    recommended: false,
  },
];

type TwoFactorStatus = { enabled: boolean; enrolledAt: string | null; recoveryCodesRemaining: number };

async function tfApi<T = Record<string, unknown>>(action?: string, extra: Record<string, string> = {}): Promise<T> {
  const res = action
    ? await fetch('/api/auth/2fa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, ...extra }),
      })
    : await fetch('/api/auth/2fa', { credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

function RecoveryCodesPanel({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const toast = useToast();
  return (
    <div className="panel p-6">
      <div className="flex items-center gap-2 text-[14px] font-medium text-slate-900">
        <Icons.key size={15} className="text-brand-700" />
        Recovery codes — save them now
      </div>
      <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-slateink-300">
        Each code signs you in once if you lose the authenticator. This is the only time they are shown in full —
        the server keeps only their hashes.
      </p>
      <div className="mt-4 grid max-w-[520px] gap-2 sm:grid-cols-2">
        {codes.map((c) => (
          <div key={c} className="rounded-lg border border-slate-900/[0.035] bg-slate-900/[0.02] px-3 py-2 font-mono text-[12.5px] text-slate-900">
            {c}
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigator.clipboard?.writeText(codes.join('\n')).catch(() => {});
            toast('Recovery codes copied.');
          }}
        >
          <Icons.copy size={13} /> Copy all
        </Button>
        <Button variant="brand" size="sm" onClick={onClose}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}

/**
 * Real TOTP enrolment: the server mints a sealed secret, the person pairs an
 * authenticator with it, and a current code proves the pairing before
 * anything is switched on. (This panel used to show a hardcoded secret and a
 * decorative QR pattern while flipping a local flag — it now does the thing.)
 */
function EnrolmentPanel({ onDone, onEnabled }: { onDone: () => void; onEnabled: (codes: string[]) => void }) {
  const toast = useToast();
  const [secret, setSecret] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    tfApi<{ secret: string }>('setup')
      .then((res) => {
        if (!cancelled) setSecret(res.secret);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not start enrolment.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = async () => {
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tfApi<{ recoveryCodes: string[] }>('confirm', { code });
      toast('Two-factor enabled. Save your recovery codes before closing this screen.');
      onEnabled(res.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not match.');
    } finally {
      setBusy(false);
    }
  };

  const grouped = secret ? secret.replace(/(.{4})/g, '$1 ').trim() : '…';

  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="text-[14px] font-medium text-slate-900">Pair an authenticator, then confirm</div>
        <Pill tone="brand">live enrolment</Pill>
      </div>
      <div className="mt-5 max-w-[70ch]">
        <p className="text-[12.5px] leading-relaxed text-slateink-300">
          Add this secret to 1Password, Authy, Google Authenticator or any TOTP app (in most apps: “enter a setup
          key”, account <span className="text-slate-900">Voxera</span>). Then enter the current six-digit code to
          prove the pairing worked — two-factor only switches on once a code checks out.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-900/[0.045] bg-slate-900/[0.02] p-3.5">
          <span className="font-mono text-[12.5px] tracking-[0.14em] text-slate-900">{grouped}</span>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              if (secret) navigator.clipboard?.writeText(secret).catch(() => {});
              toast('Secret copied.');
            }}
          >
            <Icons.copy size={13} /> Copy
          </Button>
        </div>
        <label className="mt-5 block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-slate-900">Code from the app</span>
          <input
            className="field max-w-[200px] font-mono tracking-[0.3em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </label>
        {error ? (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-red-700">
            {error}
          </div>
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-900/[0.04] pt-5">
        <Button variant="brand" onClick={finish} disabled={busy || code.length !== 6}>
          <Icons.shield size={15} /> {busy ? 'Checking…' : 'Enable two-factor'}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DisablePanel({ onDone, onDisabled }: { onDone: () => void; onDisabled: () => void }) {
  const toast = useToast();
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const disable = async () => {
    if (busy || !password || code.trim().length < 6) return;
    setBusy(true);
    setError(null);
    try {
      await tfApi('disable', { password, code: code.trim() });
      toast('Two-factor disabled.');
      onDisabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable two-factor.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel p-6">
      <div className="text-[14px] font-medium text-slate-900">Turn off two-factor</div>
      <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-slateink-300">
        This needs both proofs the account has: your password and a current code. A signed-in session alone —
        including a stolen one — cannot remove the factor.
      </p>
      <div className="mt-4 grid max-w-[520px] gap-4">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-slate-900">Password</span>
          <input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-slate-900">Authenticator or recovery code</span>
          <input
            className="field max-w-[240px] font-mono tracking-[0.2em]"
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 12))}
            placeholder="000000"
            inputMode="text"
          />
        </label>
      </div>
      {error ? (
        <div role="alert" className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-red-700">
          {error}
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-900/[0.04] pt-5">
        <Button variant="danger" onClick={disable} disabled={busy || !password || code.trim().length < 6}>
          {busy ? 'Checking…' : 'Turn off two-factor'}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Keep it on
        </Button>
      </div>
    </div>
  );
}

export default function SecuritySettingsPage() {
  const store = useStore();
  const toast = useToast();
  const [tab, setTab] = React.useState<'twofactor' | 'session' | 'sso' | 'password'>('twofactor');
  const [enrolling, setEnrolling] = React.useState(false);
  const [disabling, setDisabling] = React.useState(false);
  const [regenOpen, setRegenOpen] = React.useState(false);
  const [regenCode, setRegenCode] = React.useState('');
  const [freshCodes, setFreshCodes] = React.useState<string[] | null>(null);
  const [tfError, setTfError] = React.useState('');
  const session = store.connection.session ?? null;

  const [tf, setTf] = React.useState<TwoFactorStatus>({ enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 });
  const refreshTf = React.useCallback(() => {
    setTfError('');
    tfApi<{ twoFactor: TwoFactorStatus }>()
      .then((result) => setTf(result.twoFactor))
      .catch((error) => setTfError(error instanceof Error ? error.message : 'Two-factor status could not be loaded.'));
  }, []);

  React.useEffect(() => {
    refreshTf();
  }, [refreshTf]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account security"
        desc="Authenticator-based two-factor is enforced by the authentication server. Unsupported session and SSO controls are shown as unavailable rather than simulated."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Settings', href: '/dashboard/settings' }, { label: 'Security' }]}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Two-factor" value={tf.enabled ? 'on · totp' : 'off'} tone={tf.enabled ? 'brand' : 'default'} sub="Read from /api/auth/2fa" icon="shield" />
        <StatCard label="Signed-in role" value={store.connection.user?.role ?? 'unavailable'} sub={store.connection.user?.email ?? 'No connected account'} icon="key" />
        <StatCard label="Current session" value={session ? 'active' : 'unavailable'} sub={session ? `expires ${new Date(session.expiresAt).toLocaleString()}` : 'No session metadata returned'} icon="terminal" />
      </div>

      <Tabs
        tabs={[
          { id: 'twofactor', label: 'Two-factor', badge: tf.enabled ? undefined : 'off' },
          { id: 'session', label: 'Current session' },
          { id: 'password', label: 'Password' },
          { id: 'sso', label: 'SSO & domains' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
      />

      {tfError ? <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-[12.5px] text-red-700">{tfError}</div> : null}

      {tab === 'twofactor' ? (
        <div className="space-y-4">
          {enrolling ? (
            <EnrolmentPanel
              onDone={() => setEnrolling(false)}
              onEnabled={(codes) => {
                setEnrolling(false);
                setFreshCodes(codes);
                refreshTf();
              }}
            />
          ) : disabling ? (
            <DisablePanel
              onDone={() => setDisabling(false)}
              onDisabled={() => {
                setDisabling(false);
                refreshTf();
              }}
            />
          ) : freshCodes ? (
            <RecoveryCodesPanel codes={freshCodes} onClose={() => setFreshCodes(null)} />
          ) : regenOpen ? (
            <div className="panel p-6">
              <h2 className="text-[14px] font-medium text-slate-900">Replace recovery codes</h2>
              <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-slateink-300">The current set is revoked when the server creates a replacement. Confirm with a current authenticator code.</p>
              <label className="mt-4 block">
                <span className="mb-1.5 block text-[12.5px] font-medium text-slate-900">Authenticator code</span>
                <input className="field max-w-[200px] font-mono tracking-[0.3em]" value={regenCode} onChange={(event) => setRegenCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" inputMode="numeric" autoComplete="one-time-code" />
              </label>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  variant="brand"
                  size="sm"
                  disabled={regenCode.length !== 6}
                  onClick={async () => {
                    try {
                      const result = await tfApi<{ recoveryCodes: string[] }>('recovery', { code: regenCode });
                      setRegenOpen(false);
                      setRegenCode('');
                      setFreshCodes(result.recoveryCodes);
                      refreshTf();
                    } catch (error) {
                      toast(error instanceof Error ? error.message : 'That code did not work.', 'error');
                    }
                  }}
                >
                  Mint new codes
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setRegenOpen(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <section className="panel p-6" aria-labelledby="two-factor-state-title">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className={cn('grid h-9 w-9 place-items-center rounded-xl border', tf.enabled ? 'border-brand-500/25 bg-brand-500/[0.08] text-brand-700' : 'border-amber-400/25 bg-amber-400/[0.08] text-amber-800')}>
                      <Icons.shield size={17} />
                    </span>
                    <div>
                      <h2 id="two-factor-state-title" className="text-[14px] font-medium text-slate-900">Two-factor authentication is {tf.enabled ? 'on' : 'off'}</h2>
                      <p className="mt-1 text-[12px] text-slateink-400">
                        {tf.enabled ? <>{tf.enrolledAt ? <>Enrolled <Ago at={tf.enrolledAt} /> · </> : null}{tf.recoveryCodesRemaining} recovery codes remaining</> : 'A password alone currently signs in to this account.'}
                      </p>
                    </div>
                  </div>
                  {tf.enabled ? (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setRegenOpen(true)}><Icons.refresh size={13} /> New recovery codes</Button>
                      <Button variant="danger" size="sm" onClick={() => setDisabling(true)}>Turn off</Button>
                    </div>
                  ) : <Button variant="brand" size="sm" onClick={() => setEnrolling(true)}>Set up authenticator</Button>}
                </div>
              </section>

              {!tf.enabled ? (
                <div className="grid gap-4 lg:grid-cols-3">
                  {METHODS.map((method) => (
                    <section key={method.id} className="panel flex h-full flex-col p-5">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-[13.5px] font-medium text-slate-900">{method.name}</h2>
                        {method.recommended ? <Pill tone="brand">available</Pill> : <Pill tone="warn">not available</Pill>}
                      </div>
                      <p className="mt-2.5 flex-1 text-[12.5px] leading-relaxed text-slateink-300">{method.desc}</p>
                      {method.id === 'totp' ? <Button variant="ghost" size="sm" className="mt-4 self-start" onClick={() => setEnrolling(true)}>Set up <Icons.arrowRight size={13} /></Button> : null}
                    </section>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {tab === 'session' ? (
        <section className="panel max-w-3xl p-6" aria-labelledby="session-title">
          <h2 id="session-title" className="text-[14px] font-medium text-slate-900">Current session</h2>
          {session ? (
            <dl className="mt-4 space-y-3 text-[12.5px]">
              <div className="flex flex-wrap justify-between gap-3 border-b border-slate-900/[0.04] pb-3"><dt className="text-slateink-400">Session ID</dt><dd className="font-mono text-slate-900">{session.id}</dd></div>
              <div className="flex flex-wrap justify-between gap-3"><dt className="text-slateink-400">Expires</dt><dd className="font-mono text-slate-900">{new Date(session.expiresAt).toLocaleString()}</dd></div>
            </dl>
          ) : <p className="mt-3 text-[12.5px] text-slateink-400">The authentication API did not return current-session metadata.</p>}
          <div className="mt-5 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[12.5px] leading-relaxed text-amber-900">
            A server-backed list of other devices and a revoke-all-others action are not implemented. This screen does not fabricate devices, IP addresses or revocation results.
          </div>
        </section>
      ) : null}

      {tab === 'password' ? (
        <section className="panel max-w-3xl p-6" aria-labelledby="password-title">
          <h2 id="password-title" className="text-[14px] font-medium text-slate-900">Change your password</h2>
          <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-slateink-300">Password changes use the single-use reset flow. The server emails a time-limited link when delivery is configured; no current password or success state is simulated on this page.</p>
          <a href="/reset-password" className="btn-brand btn-sm mt-5 inline-flex items-center gap-2"><Icons.key size={13} /> Open password reset</a>
        </section>
      ) : null}

      {tab === 'sso' ? (
        <section className="panel max-w-3xl p-6" aria-labelledby="sso-title">
          <h2 id="sso-title" className="text-[14px] font-medium text-slate-900">SSO and domain verification</h2>
          <p className="mt-2 max-w-[72ch] text-[12.5px] leading-relaxed text-slateink-300">SAML/OIDC configuration, DNS ownership checks and SCIM provisioning do not have server workflows in this deployment. They are unavailable rather than represented by local switches.</p>
          <div className="mt-4"><Pill tone="warn">not configured</Pill></div>
        </section>
      ) : null}
    </div>
  );
}
