import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Security boundaries for the current Voxera build.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({ eyebrow: 'Security', title: 'Verify controls in code and deployment.', subtitle: 'Implemented application controls and explicit external release boundaries.', meta: 'No certification claim' });
}
