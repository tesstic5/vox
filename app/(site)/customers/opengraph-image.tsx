import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';
export const alt = 'Examples without invented endorsements.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export default function Image() { return renderOg({ eyebrow: 'Examples', title: 'Evidence before outcomes.', subtitle: 'No customer metric or endorsement is claimed without verification.', meta: 'Workflow examples only' }); }
