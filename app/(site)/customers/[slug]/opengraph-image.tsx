import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';
export const alt = 'Workflow examples, not customer endorsements.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export default function Image() { return renderOg({ eyebrow: 'Examples', title: 'No invented customer story.', subtitle: 'Review implemented workflows and validate outcomes with your own data.', meta: 'Evidence required' }); }
