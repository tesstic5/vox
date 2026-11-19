import type { McpServerSeed, McpTransport } from './types';

/**
 * Model Context Protocol is not connected to the call runtime in this build.
 *
 * Keep the catalogue empty: sample vendor endpoints and inferred tool lists were
 * easy to mistake for working integrations. The dashboard route now points users
 * to the tested HTTP-tool registry instead. A future MCP implementation must add
 * real credential storage, transport, discovery, allow-list enforcement and
 * acceptance checks before any server appears here.
 */
export const MCP_CATALOG: McpServerSeed[] = [];

export const TRANSPORT_LABELS: Record<McpTransport, { label: string; desc: string }> = {
  http: { label: 'HTTP', desc: 'Unavailable until MCP transport and discovery are implemented.' },
  sse: { label: 'SSE', desc: 'Unavailable until MCP transport and discovery are implemented.' },
  stdio: { label: 'stdio', desc: 'Unavailable until MCP process isolation and transport are implemented.' },
};

export function mcpCatalogBySlug(_slug: string) {
  return undefined;
}

/** No tool schema is inferred: discovery must come from a verified server. */
export function inferTools(_name: string): McpServerSeed['tools'] {
  return [];
}
