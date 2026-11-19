import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Follow actual request and audit evidence.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({ eyebrow: 'Support', title: 'Start with the failed record.', subtitle: 'Use call IDs, request IDs, audit entries and provider responses.', meta: 'No implied SLA' });
}
