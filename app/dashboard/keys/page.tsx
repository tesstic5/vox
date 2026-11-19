'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import type { ApiKey } from '@/lib/types';

import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, CodeBlock, EmptyState, Modal, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

/** `vk_live_••••••••eb01` — from the secret when this browser holds one, and from
 *  the tail the server returns otherwise. Never prints a secret the row lacks. */
function keyLabel(k: ApiKey): string {
  const tail = k.secret ? k.secret.slice(-4) : k.last4 ?? '····';
  return `${k.prefix}••••••••${tail}`;
}

/** The scope a row declares, or the capabilities the server recorded instead. */
function keyScope(k: ApiKey): string {
  if (k.scope) return k.scope;
  const scopes = k.scopes ?? [];
  if (scopes.includes('*')) return 'all scopes';
  return scopes.length ? scopes.join(', ') : '—';
}

export default function KeysPage() {
  const store = useStore();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<'public' | 'private'>('private');
  // The modal reveals the *server's* secret, which arrives a moment after the
  // row is created — so it holds the row's id and reads the secret back out of
  // the store, rather than capturing the placeholder `createKey` returns.
  const [revealedId, setRevealedId] = React.useState<string | null>(null);
  const revealedKey = revealedId ? store.keys.find((k) => k.id === revealedId) : undefined;
  const revealed = revealedKey?.secret ?? null;

  const keys = store.keys;
  const create = () => {
    const k = store.createKey(name || 'Untitled key', scope);
    setOpen(false);
    setName('');
    setRevealedId(k.id);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        desc="Keys authenticate your server and your browser. Public keys are safe in client code; private keys are not."
        actions={
          <>
            <a href="/library" className="btn-ghost btn-sm">
              <Icons.book size={13} /> Auth docs
            </a>
            <Button variant="brand" size="sm" onClick={() => setOpen(true)}>
              <Icons.plus size={14} /> Create key
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active keys" value={String(keys.length)} sub={`${keys.filter((k) => k.scope === 'private').length} private`} icon="key" />
        <StatCard label="Requests (24h)" value="84.1k" delta="+4.2%" sub="across all keys" icon="terminal" tone="brand" />
        <StatCard label="Rate limit" value="1,000 rpm" sub="per key, burst 2,000" icon="bolt" />
        <StatCard label="Last rotation" value="41 days ago" sub="rotate every 90 days" icon="refresh" />
      </div>

      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <Icons.shield size={16} className="text-amber-800" />
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-amber-800">
            Private keys are shown once at creation and stored hashed. Never commit them — use environment variables or
            your platform&rsquo;s secret manager.
          </p>
          <a href="/security" className="btn-ghost btn-sm shrink-0">
            Security practices
          </a>
        </div>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon="key"
          title="No keys yet"
          desc="Create a private key for your server, or a public key for browser-side WebRTC."
          action={
            <Button variant="brand" size="sm" onClick={() => setOpen(true)}>
              Create a key
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-900/[0.045] bg-ink-850/40">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-slate-900/[0.045] bg-ink-900/60">
                  {['Name', 'Key', 'Scope', 'Created', 'Last used', ''].map((h) => (
                    <th key={h} className="px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slateink-400">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/[0.03]">
                {keys.map((k) => (
                  <tr key={k.id} className="transition-colors hover:bg-slate-900/[0.03]">
                    <td className="px-4 py-3 text-[12.5px] text-slate-900">{k.name}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11.5px] text-slateink-300">{keyLabel(k)}</span>
                        <Button
                          variant="quiet"
                          size="sm"
                          title={k.secret ? 'Copy the key' : 'The secret is only shown when a key is created'}
                          onClick={() => {
                            // A key read back from the server has no secret to copy — the
                            // server keeps a hash. Say so rather than copying a blank.
                            if (!k.secret) {
                              toast('The secret is only shown when a key is created — the server keeps a hash.', 'info');
                              return;
                            }
                            navigator.clipboard?.writeText(`${k.prefix}${k.secret}`);
                            toast('Key copied.');
                          }}
                        >
                          <Icons.copy size={12} />
                        </Button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={keyScope(k) === 'private' ? 'warn' : 'info'}>{keyScope(k)}</Pill>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[11.5px] text-slateink-400"><Ago at={k.createdAt} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-[11.5px] text-slateink-400">
                      {k.lastUsed ?? k.lastUsedAt ? <Ago at={k.lastUsed ?? k.lastUsedAt!} /> : 'never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="quiet"
                        size="sm"
                        className="text-slateink-400 hover:text-red-700"
                        onClick={() => {
                          store.revokeKey(k.id);
                          toast(`${k.name} revoked.`, 'info');
                        }}
                      >
                        <Icons.trash size={12} /> Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <h2 className="text-[14.5px] font-semibold text-slate-900">Use a key</h2>
          <p className="mt-1.5 text-[12px] text-slateink-400">Server-side requests carry the private key in a header.</p>
          <div className="mt-4">
            <CodeBlock
              lang="bash"
              filename="terminal"
              code={`export VOXERA_API_KEY="sk_live_..."\n\ncurl https://api.voxera.ai/v1/assistants \\\n  -H "Authorization: Bearer $VOXERA_API_KEY" \\\n  -H "Content-Type: application/json"`}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <h2 className="text-[14.5px] font-semibold text-slate-900">Public keys in the browser</h2>
          <p className="mt-1.5 text-[12px] text-slateink-400">
            Public keys can only start web calls. They cannot read your data or place outbound PSTN calls.
          </p>
          <div className="mt-4">
            <CodeBlock
              lang="ts"
              filename="app/voice-button.tsx"
              code={`import { useVoxera } from '@voxera/react';\n\nexport function VoiceButton() {\n  const { start, status } = useVoxera({\n    publicKey: process.env.NEXT_PUBLIC_VOXERA_KEY!,\n    assistantId: 'asst_support_concierge',\n  });\n\n  return (\n    <button onClick={start} disabled={status === 'connecting'}>\n      {status === 'live' ? 'On call — tap to end' : 'Talk to support'}\n    </button>\n  );\n}`}
            />
          </div>
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create an API key"
        desc="Give it a name that says where it lives — “Production server”, “Staging worker”."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" onClick={create}>
              Create key
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label">Name</label>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production server" />
          </div>
          <div>
            <label className="label">Scope</label>
            <div className="space-y-2.5">
              {([
                ['private', 'Private', 'Full API access. Server-side only.'],
                ['public', 'Public', 'Browser-safe. Web calls and transcripts only.'],
              ] as const).map(([v, l, d]) => (
                <label
                  key={v}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5"
                >
                  <input type="radio" checked={scope === v} onChange={() => setScope(v)} className="mt-0.5 h-4 w-4 accent-[#2BE38B]" />
                  <span>
                    <span className="block text-[13px] font-medium text-slate-900">{l}</span>
                    <span className="mt-0.5 block text-[11.5px] text-slateink-400">{d}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!revealedId}
        onClose={() => setRevealedId(null)}
        title="Copy your key now"
        desc="This is the only time the full secret is shown."
        footer={
          <Button variant="brand" size="sm" onClick={() => setRevealedId(null)}>
            I have stored it
          </Button>
        }
      >
        <div className="rounded-xl border border-slate-900/[0.045] bg-ink-950 p-4">
          <div className="break-all font-mono text-[12px] text-brand-700">
            {revealed ?? 'Minting the key — the secret appears here the moment the server answers.'}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 w-full"
          onClick={() => {
            navigator.clipboard?.writeText(revealed ?? '');
            toast('Copied to clipboard.');
          }}
        >
          <Icons.copy size={13} /> Copy to clipboard
        </Button>
      </Modal>
    </div>
  );
}
