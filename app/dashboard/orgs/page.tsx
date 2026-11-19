import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function OrganisationsPage() {
  return <UnavailableCapability title="Organisation switcher" description="Create and administer multiple workspaces from one login." boundary="Workspace creation, cross-workspace switching, custom role matrices and invitation delivery are not provided by this screen in the current build. Each authenticated session stays tenant-scoped; manage this workspace's real members and roles on the Team page." links={[{ href: '/dashboard/team', label: 'Open team & roles' }, { href: '/dashboard/business', label: 'Open business profile' }]} />;
}
