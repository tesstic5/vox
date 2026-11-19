'use client';

import * as React from 'react';
import { Icons } from '@/components/icons';
import { Button, LinkButton } from '@/components/ui';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error('dashboard route error', error.digest, error.message);
  }, [error]);

  return (
    <div className="rounded-3xl border border-slate-900/[0.035] bg-ink-850/60 p-8">
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-amber-800">
        <Icons.alert size={14} /> Dashboard error
      </div>
      <h2 className="h4 mt-4">This view failed to render.</h2>
      <p className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-slateink-300">
        Your data is safe — nothing was written while this view was failing. The error
        {error.digest ? ` carries reference ${error.digest}` : ''} and is attached to your organisation&apos;s log.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="primary" onClick={reset}>
          <Icons.refresh size={15} /> Reload the view
        </Button>
        <LinkButton href="/dashboard" variant="ghost">
          Back to overview
        </LinkButton>
        <LinkButton href="/support" variant="quiet">
          Contact support
        </LinkButton>
      </div>
    </div>
  );
}
