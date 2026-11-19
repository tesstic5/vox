import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Security evidence and boundaries.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({ eyebrow: 'Security', title: 'Evidence before claims.', subtitle: 'Review implemented controls and obtain deployment-specific assurance independently.', meta: 'Explicit boundaries' });
}
