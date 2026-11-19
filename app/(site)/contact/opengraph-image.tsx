import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Talk to a human, quickly.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({
    eyebrow: 'Contact',
    title: 'Talk to a human, quickly.',
    subtitle:
      'Sales, support, security, privacy, abuse, and accessibility — routed to the right team, not a shared inbox.',
    meta: '4h response',
  });
}
