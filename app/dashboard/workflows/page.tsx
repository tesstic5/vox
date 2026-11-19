import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function WorkflowsPage() {
  return <UnavailableCapability title="Visual workflows" description="Node-based call automation and publishing." boundary="Visual workflow records are not executed by the call runtime in this build. Creating or publishing a browser-only graph would not change a call, so the builder is intentionally unavailable. Assistants use explicit server-backed tools and prompts." links={[{ href: '/dashboard/assistants', label: 'Open assistants' }, { href: '/dashboard/tools', label: 'Open tools' }]} />;
}
