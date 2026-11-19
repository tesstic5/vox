'use client';

import { PageHeader } from '@/components/dash/Shell';
import { AiEnginePanel } from '@/components/dash/AiEnginePanel';

export default function ProvidersPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Model providers"
        desc="Connect, verify, test and remove the model credentials the call runtime actually resolves. Missing credentials fall back to the built-in rule engine rather than a pretend managed provider."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Model providers' }]}
      />
      <AiEnginePanel />
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[12.5px] leading-relaxed text-amber-900">
        Speech-to-text and text-to-speech are deployment-level media providers in this build. Per-assistant speech routing, blended-rate estimates, regional failover chains and savings projections are not inferred here.
      </div>
    </div>
  );
}
