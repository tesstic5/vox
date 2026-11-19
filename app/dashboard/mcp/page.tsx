import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function McpPage() {
  return <UnavailableCapability title="MCP servers" description="External Model Context Protocol tool discovery." boundary="MCP transport, credential storage, tool discovery, refresh and allow-list enforcement are not connected to the runtime in this build. Register ordinary HTTP tools through the tested tool API instead." links={[{ href: '/dashboard/tools', label: 'Open registered tools' }, { href: '/docs', label: 'Read implementation guide' }]} />;
}
