import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function LogsPage() {
  return <UnavailableCapability title="Request logs" description="Detailed API request and response inspection." boundary="Workspace users do not receive raw request or response bodies in this build, and there is no live-tail or log-export service. Use the tenant audit trail for recorded actions, Webhooks for actual delivery attempts, and Observability for aggregate server metrics." links={[{ href: '/dashboard/audit', label: 'Open audit log' }, { href: '/dashboard/webhooks', label: 'Open webhook deliveries' }, { href: '/dashboard/observability', label: 'Open observability' }]} />;
}
