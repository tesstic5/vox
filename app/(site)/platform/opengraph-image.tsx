import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Business records first; providers are optional connections.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({ eyebrow: 'Platform', title: 'Business records first.', subtitle: 'Scheduling, communication, field service and optional provider-backed assistants.', meta: 'Explicit capability boundaries' });
}
