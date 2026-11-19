'use client';

import * as React from 'react';
import { Icons } from '@/components/icons';
import { Button, LinkButton } from '@/components/ui';

export default function SiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    // In production this is where the error reaches Sentry with the digest attached.
    console.error('site route error', error.digest, error.message);
  }, [error]);

  return (
    <div className="container-x py-24">
      <div className="mx-auto max-w-2xl rounded-3xl border border-slate-900/[0.035] bg-ink-850/60 p-8">
        <div className="eyebrow mb-4">Something broke</div>
        <h1 className="h3 text-balance">That page hit an error we did not plan for.</h1>
        <p className="mt-4 text-[14px] leading-relaxed text-slateink-300">
          The failure is logged{error.digest ? ` with reference ${error.digest}` : ''}. Retrying is usually enough —
          most of these are a bad network hop rather than a bad page.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button variant="primary" onClick={reset}>
            <Icons.refresh size={15} /> Try again
          </Button>
          <LinkButton href="/support" variant="ghost">
            Report it to support
          </LinkButton>
          <LinkButton href="/status" variant="quiet">
            Check platform status
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
