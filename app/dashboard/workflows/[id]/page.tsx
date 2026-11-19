import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function WorkflowDetailPage() {
  return <UnavailableCapability title="Visual workflow" description="Workflow detail and publishing." boundary="Visual workflow records are not executed by the call runtime in this build. A stored browser graph would not alter a call, so editing and publishing are unavailable rather than simulated." links={[{ href: '/dashboard/assistants', label: 'Open assistants' }, { href: '/dashboard/tools', label: 'Open tools' }]} />;
}
