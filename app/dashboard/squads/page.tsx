import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function SquadsPage() {
  return <UnavailableCapability title="Assistant squads" description="Assistant-to-assistant live handoffs." boundary="Assistant squads, shared handoff memory and assistant-to-assistant routing are not implemented in the call runtime. Assistants can use the tested transfer tool to hand a caller to a person, but this build does not claim a multi-assistant transfer occurred." links={[{ href: '/dashboard/assistants', label: 'Open assistants' }, { href: '/dashboard/tools', label: 'Review tools' }]} />;
}
