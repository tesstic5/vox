import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Production assurance requires deployment evidence.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({ eyebrow: 'Deployment planning', title: 'Assurance requires evidence.', subtitle: 'Provider contracts, operations and independent review remain deployment work.', meta: 'No implied SLA' });
}
