import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function EvalsPage() {
  return <UnavailableCapability title="Evals & QA" description="Rubric scoring, human overrides and review queues." boundary="There is no server-backed rubric runner, review queue, agreement metric or QA export in this build. Stored calls include their runtime analysis, but this screen does not turn that into invented scored reviews." links={[{ href: '/dashboard/calls', label: 'Review stored calls' }, { href: '/dashboard/analytics', label: 'Open call analytics' }]} />;
}
