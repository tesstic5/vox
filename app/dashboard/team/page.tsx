'use client';

/**
 * Team.
 *
 * Who can sign in, what they may do, and how that changes — the screen a
 * practice actually needs the day it hires somebody and the day somebody
 * leaves. Three things it refuses to do quietly:
 *
 *   - grant or withdraw **owner** unless an owner is doing it;
 *   - leave the workspace with **no owner** at all;
 *   - hand out a login without saying what that role can see, so the permission
 *     table is on the page rather than in a manual.
 *
 * A temporary password is shown once, in the modal that minted it. Only its
 * hash is stored, so this really is the only time it can be read.
 */

import * as React from 'react';
import Link from 'next/link';
import { ApiError, request } from '@/lib/server-sync';
import { cn, pinnedNow } from '@/lib/utils';
import { Button, Modal, Pill, Tabs, useToast } from '@/components/ui';
import { DataTable, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

type Role = 'owner' | 'admin' | 'developer' | 'receptionist' | 'practitioner' | 'viewer';

type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  roleId?: string;
  roleName?: string;
  active: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt?: string;
  lastLoginAt?: string;
  lastActiveAt?: string;
  sessions: number;
  phone?: string;
  isYou?: boolean;
  providerName?: string;
};

type Capability = { key: string; label: string; note: string; roles: Role[] };
type GranularRole = { id: string; name: string; system: boolean; archivedAt?: string };


type MembersPayload = { members: Member[]; roles: Role[]; counts: Record<string, number>; you?: { id: string; role: Role } };

const ROLE_NOTE: Record<Role, string> = {
  owner: 'Runs the workspace. Can do everything, including the team and the money.',
  admin: 'Everything an owner can, except owner-level changes to other owners.',
  developer: 'Builds and configures: assistants, keys, tools, practice setup.',
  receptionist: 'Runs the diary and the desk: bookings, clients, taking payments.',
  practitioner: 'Sees their own diary, writes notes, reads the money they earned.',
  viewer: 'Read-only. Good for an accountant or a locum who only needs to look.',
};

function when(value?: string) {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  const days = Math.floor((pinnedNow() - at.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return at.toISOString().slice(0, 10);
}

/** A live invitation link, as the server reports it. */
type InviteRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  invitedBy: string;
  sentAt: string;
  expiresAt: string;
  expiresInHours: number;
  active: boolean;
  alreadySignedIn: boolean;
};

export default function TeamPage() {
  const toast = useToast();
  const [tab, setTab] = React.useState<'members' | 'roles'>('members');
  const [data, setData] = React.useState<MembersPayload | null>(null);
  const [invites, setInvites] = React.useState<InviteRow[]>([]);
  const [roles, setRoles] = React.useState<Capability[]>([]);
  const [granularRoles, setGranularRoles] = React.useState<GranularRole[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [secret, setSecret] = React.useState<{ email: string; password: string; kind: string } | null>(null);
  const [form, setForm] = React.useState<{ name: string; email: string; role: Role; phone: string }>({ name: '', email: '', role: 'receptionist', phone: '' });
  /** Whose mobile is being set, and the value being typed. */
  const [phoneFor, setPhoneFor] = React.useState<Member | null>(null);
  const [phoneValue, setPhoneValue] = React.useState('');

  const fail = (error: unknown) => toast(error instanceof ApiError ? error.message : 'Something went wrong', 'error');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [members, matrix, pending, granular] = await Promise.all([
        request<MembersPayload>('GET', '/api/v1/team?view=members'),
        request<{ capabilities: Capability[]; roles: Role[] }>('GET', '/api/v1/team?view=roles'),
        // Live invitation links, read from the tokens themselves — so this list
        // cannot disagree with what the links actually do.
        request<{ invites: InviteRow[] }>('GET', '/api/v1/team?view=invites'),
        request<{ data: GranularRole[] }>('GET', '/api/v1/roles'),
      ]);
      setData(members);
      setRoles(matrix.capabilities);
      setInvites(pending.invites ?? []);
      setGranularRoles((granular.data ?? []).filter((role) => !role.system && !role.archivedAt));
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function act<T = { temporaryPassword?: string; sessionsEnded?: number; inviteSent?: boolean; inviteError?: string }>(
    body: Record<string, unknown>,
    success: string | ((result: T) => string)
  ) {
    setBusy(true);
    try {
      const result = await request<T>('POST', '/api/v1/team', body);
      toast(typeof success === 'function' ? success(result) : success);
      const typed = result as { temporaryPassword?: string };
      if (typed.temporaryPassword) {
        setSecret({ email: String(body.email ?? ''), password: typed.temporaryPassword, kind: String(body.action) });
      }
      await load();
      return result;
    } catch (error) {
      fail(error);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const assignGranularRole = async (member: Member, roleId: string) => {
    setBusy(true);
    try {
      await request('POST', '/api/v1/roles/assignments', { userId: member.id, roleId: roleId || null });
      toast(roleId ? `Granular role assigned to ${member.name}` : `Custom role removed from ${member.name}`);
      await load();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const members = data?.members ?? [];
  const active = members.filter((m) => m.active);
  const owners = active.filter((m) => m.role === 'owner').length;
  const me = data?.you;

  return (
    <>
      <PageHeader
        title="Team & roles"
        desc="Who can sign in, what they may do, and what happens the day somebody leaves."
        breadcrumb={[{ label: 'Practice' }, { label: 'Team' }]}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/settings/roles" className="btn-ghost btn-sm">Granular roles</Link>
            <Button variant="brand" size="sm" onClick={() => setInviteOpen(true)}>
              Add someone
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="People with a login"
          value={String(members.length)}
          sub={invites.length ? `${active.length} active · ${invites.length} invited` : `${active.length} active`}
        />
        <StatCard label="Owners" value={String(owners)} sub={owners === 1 ? 'a single owner — you' : 'more than one'} />
        <StatCard label="Signed in now" value={String(members.reduce((sum, m) => sum + m.sessions, 0))} sub="live sessions" />
        <StatCard label="Roles in use" value={String(Object.keys(data?.counts ?? {}).length)} sub={Object.entries(data?.counts ?? {}).map(([r, n]) => `${r} ${n}`).join(' · ') || '—'} />
      </div>

      <Tabs
        tabs={[
          { id: 'members', label: 'People', badge: String(members.length) },
          { id: 'roles', label: 'What each role can do' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'members' | 'roles')}
      />

      {tab === 'members' && (
        <>
          {loading && !data ? (
            <p className="py-10 text-center text-[13px] text-slateink-400">Loading the team…</p>
          ) : (
            <DataTable
              columns={[
                { key: 'name', label: 'Person' },
                { key: 'role', label: 'Role' },
                { key: 'seen', label: 'Last active' },
                { key: 'state', label: 'Login' },
                { key: 'act', label: '', align: 'right' },
              ]}
            >
              {members.map((member) => (
                <tr key={member.id} className={cn('border-b border-slate-900/[0.035] last:border-0', !member.active && 'opacity-60')}>
                  <td className="px-4 py-3">
                    <div className="text-[13.5px] font-medium text-slate-900">
                      {member.name}
                      {member.isYou && <span className="ml-2 text-[11px] text-brand-700">you</span>}
                    </div>
                    <div className="font-mono text-[11.5px] text-slateink-400">{member.email}</div>
                    {member.providerName && <div className="mt-0.5 text-[11.5px] text-slateink-400">diary: {member.providerName}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className="field w-[150px] text-[12.5px]"
                      value={member.role}
                      disabled={busy}
                      onChange={(e) => void act({ action: 'role', id: member.id, role: e.target.value }, `${member.name} is now ${e.target.value}`)}
                    >
                      {(data?.roles ?? []).map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 max-w-[220px] text-[11px] leading-snug text-slateink-500">{ROLE_NOTE[member.role]}</div>
                    {member.role !== 'owner' && granularRoles.length > 0 ? (
                      <select
                        aria-label={`Granular role for ${member.name}`}
                        className="field mt-2 w-[190px] text-[11px]"
                        value={member.roleId ?? ''}
                        disabled={busy}
                        onChange={(event) => void assignGranularRole(member, event.target.value)}
                      >
                        <option value="">No custom role</option>
                        {granularRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                      </select>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-[12.5px] text-slateink-300">
                    {when(member.lastActiveAt ?? member.lastLoginAt)}
                    {member.sessions > 0 && <div className="text-[11px] text-brand-700">{member.sessions} live session{member.sessions === 1 ? '' : 's'}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone={member.active ? 'brand' : 'warn'}>{member.active ? 'active' : 'deactivated'}</Pill>
                    {!member.emailVerified && <div className="mt-1 text-[11px] text-slateink-500">invitation not opened yet</div>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        title={
                          member.phone
                            ? `${member.phone} — the assistant recognises this number when they ring in`
                            : 'Add their mobile so the assistant recognises them when they ring the practice line'
                        }
                        className="rounded-lg border border-slate-900/[0.05] px-2 py-1 font-mono text-[11px] text-slateink-300 transition hover:border-slate-900/[0.09] hover:text-slate-900"
                        onClick={() => {
                          setPhoneFor(member);
                          setPhoneValue(member.phone ?? '');
                        }}
                      >
                        {member.phone ? `☎ ${member.phone}` : '+ mobile'}
                      </button>
                      <Button variant="quiet" size="sm" disabled={busy} onClick={() => void act({ action: 'password', id: member.id, email: member.email }, 'New temporary password issued')}>
                        Reset password
                      </Button>
                      {member.sessions > 0 && (
                        <Button variant="quiet" size="sm" disabled={busy} onClick={() => void act({ action: 'sessions:revoke', id: member.id }, 'Signing them out everywhere')}>
                          Sign out
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={busy || member.isYou}
                        onClick={() =>
                          void act(
                            { action: member.active ? 'deactivate' : 'reactivate', id: member.id },
                            member.active ? `${member.name} can no longer sign in` : `${member.name} can sign in again`
                          )
                        }
                      >
                        {member.active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          <p className="mt-3 text-[12px] text-slateink-400">
            Deactivating ends their sessions as it goes: a login that has been taken away should not keep reading the diary until it expires. A
            temporary password is shown once and stored only as a hash.
          </p>

          {invites.length > 0 && (
            <div className="mt-6 rounded-2xl border border-slate-900/[0.045] bg-slate-900/[0.02] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13.5px] font-medium text-slate-900">Waiting to join</div>
                  <p className="mt-1 text-[12px] text-slateink-400">
                    Invitation links that have been sent and not used. Each one works once, and expires seven days after it was sent.
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {invites.map((invite) => (
                  <div key={invite.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-4 py-3">
                    <div className="min-w-[200px] flex-1">
                      <div className="text-[13px] font-medium text-slate-900">{invite.name}</div>
                      <div className="font-mono text-[11.5px] text-slateink-400">{invite.email}</div>
                    </div>
                    <div className="text-[12px] text-slateink-300">{invite.role}</div>
                    <div className="text-[12px] text-slateink-400">
                      invited by {invite.invitedBy}
                      <div className="text-[11.5px] text-slateink-500">
                        {invite.expiresInHours >= 1 ? `${Math.round(invite.expiresInHours)}h left` : 'expires within the hour'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            { action: 'resend_invite', id: invite.userId },
                            (result: { expiresAt?: string }) =>
                              result?.expiresAt ? `New invitation emailed — expires ${when(result.expiresAt)}` : 'Invitation re-sent'
                          )
                        }
                      >
                        Send again
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act({ action: 'revoke_invite', id: invite.userId }, `Link cancelled for ${invite.name}`)}
                      >
                        Cancel link
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'roles' && (
        <DataTable
          columns={[
            { key: 'cap', label: 'Capability' },
            // The column heading carries the role's one-liner, so the matrix can be
            // read without hunting for what "developer" means.
            ...(data?.roles ?? []).map((role) => ({ key: role, label: role, align: 'center' as const })),
          ]}
        >
          {roles.map((capability) => (
            <tr key={capability.key} className="border-b border-slate-900/[0.035] last:border-0">
              <td className="px-4 py-3">
                <div className="text-[13px] text-slate-900">{capability.label}</div>
                <div className="text-[11.5px] text-slateink-400">{capability.note}</div>
              </td>
              {(data?.roles ?? []).map((role) => (
                <td key={role} className="px-4 py-3 text-center">
                  {capability.roles.includes(role) ? (
                    <span className="text-brand-700">✓</span>
                  ) : (
                    <span className="text-slateink-600">—</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </DataTable>
      )}

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Add someone to the workspace"
        width="520px"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (!form.name.trim() || !form.email.trim()) {
                  toast('A name and an email address, please.', 'error');
                  return;
                }
                await act<{ inviteSent?: boolean; inviteError?: string }>(
                  { action: 'invite', ...form },
                  (result) =>
                    result?.inviteSent
                      ? `Invitation emailed to ${form.email}`
                      : `Added — the invitation email did not go out${result?.inviteError ? ` (${result.inviteError})` : ''}, so pass the temporary password on`
                );
                setSecret((current) => (current ? { ...current, email: form.email } : current));
                setInviteOpen(false);
                setForm({ name: '', email: '', role: 'receptionist', phone: '' });
              }}
            >
              {busy ? 'Adding…' : 'Add them'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="t-name">
              Name
            </label>
            <input id="t-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="t-email">
              Email
            </label>
            <input id="t-email" className="field text-[13px]" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="t-role">
              Role
            </label>
            <select id="t-role" className="field text-[13px]" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(data?.roles ?? ['receptionist']).map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[11.5px] leading-snug text-slateink-400">{ROLE_NOTE[form.role]}</p>
          </div>
          <div>
            <label className="label" htmlFor="t-phone">
              Mobile <span className="font-normal text-slateink-500">— optional</span>
            </label>
            <input
              id="t-phone"
              className="field text-[13px]"
              placeholder="+14155550123"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <p className="mt-1.5 text-[11.5px] leading-snug text-slateink-400">
              With this on file the assistant knows it is one of the team calling, so it can answer questions about the practice. Without it, it politely
              can&rsquo;t.
            </p>
          </div>
          <p className="text-[11.5px] text-slateink-400">
            They get an emailed invitation link — seven days, single use — which is how most people will join: they pick their own
            password on arrival. A temporary password is issued at the same time as a fallback you can read out, shown once and stored
            only as a hash. Accepting the invitation also verifies their email address.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!phoneFor}
        onClose={() => setPhoneFor(null)}
        title={phoneFor?.phone ? 'Mobile number' : 'Add a mobile number'}
        width="460px"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPhoneFor(null)}>
              Cancel
            </Button>
            {phoneFor?.phone && (
              <Button
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  await act({ action: 'phone', id: phoneFor.id, phone: '' }, `${phoneFor.name} is no longer recognised by number`);
                  setPhoneFor(null);
                }}
              >
                Remove it
              </Button>
            )}
            <Button
              variant="brand"
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (!phoneFor) return;
                await act({ action: 'phone', id: phoneFor.id, phone: phoneValue }, `Saved for ${phoneFor.name}`);
                setPhoneFor(null);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-slateink-200">
            When {phoneFor?.name ?? 'they'} rings the practice line from this number, the assistant knows it is one of the team — so it can answer
            questions about how the practice is doing instead of politely refusing.
          </p>
          <div>
            <label className="label" htmlFor="m-phone">
              Mobile
            </label>
            <input
              id="m-phone"
              className="field text-[13px]"
              placeholder="+14155550123"
              value={phoneValue}
              onChange={(e) => setPhoneValue(e.target.value)}
            />
            <p className="mt-1.5 text-[11.5px] leading-snug text-slateink-400">
              The full number including the country code. One number can belong to one person only.
            </p>
          </div>
        </div>
      </Modal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title="Temporary password" width="460px" footer={
        <Button variant="brand" size="sm" onClick={() => setSecret(null)}>
          Done
        </Button>
      }>
        <p className="text-[13px] text-slateink-200">
          {secret?.kind === 'password' ? 'A new password for' : 'A login for'} <span className="font-mono text-[12.5px] text-slate-900">{secret?.email}</span>. This is
          the only time it is shown.
        </p>
        <div className="mt-3 rounded-xl border border-slate-900/[0.035] bg-ink-900/60 px-4 py-3 font-mono text-[15px] text-brand-700">{secret?.password}</div>
        <p className="mt-3 text-[11.5px] text-slateink-400">
          Anyone with this password can sign in as them until it is changed. If it leaks, reset it again — that ends every session too.
        </p>
      </Modal>

      {me && (
        <p className="mt-6 text-[12px] text-slateink-500">
          You are signed in as <span className="text-slateink-300">{me.role}</span>. Only an owner can grant or take away owner access, and the last owner
          cannot be demoted or deactivated.
        </p>
      )}
    </>
  );
}
