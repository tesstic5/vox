import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function WidgetPage() {
  return <UnavailableCapability title="Web widget" description="An embeddable public chat and voice client." boundary="No public widget script, hosted assistant URL, React package, widget session store or widget analytics are deployed by this build. The dashboard test-call panel is real, but copying an embed snippet would point at software that does not exist, so configuration and save controls are withheld." links={[{ href: '/dashboard/assistants', label: 'Open dashboard test calls' }]} />;
}
