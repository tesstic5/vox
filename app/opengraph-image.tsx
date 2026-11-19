import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Voxera — booking and communication workspace';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({ eyebrow: 'Booking and communication', title: 'One workspace for calls, scheduling and follow-up.', subtitle: 'Business records, optional provider-backed assistants and explicit deployment boundaries.', meta: 'Contractor · dental · physiotherapy · other' });
}
