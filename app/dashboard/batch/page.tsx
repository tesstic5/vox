import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function BatchPage() {
  return <UnavailableCapability title="Batch calls" description="Bulk list dialling and disposition exports." boundary="This build has no server-side batch runner, pacing queue or batch disposition export. Importing a CSV here would only create browser state, so those controls are intentionally unavailable. Use the tested booking-campaign scheduler for appointment follow-up." links={[{ href: '/dashboard/bookings', label: 'Open booking campaigns' }, { href: '/dashboard/calls', label: 'Open call records' }]} />;
}
