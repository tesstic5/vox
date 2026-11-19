import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function SimulationsPage() {
  return <UnavailableCapability title="Hosted simulations" description="Synthetic caller suites and CI integration." boundary="There is no hosted simulation queue or CI callback in this build. The assistant editor runs real stored web calls through the same tenant-scoped runtime, and the repository's verification scripts remain the release gate; neither is presented as a hosted regression suite." links={[{ href: '/dashboard/assistants', label: 'Test an assistant' }, { href: '/dashboard/calls', label: 'Review test calls' }]} />;
}
