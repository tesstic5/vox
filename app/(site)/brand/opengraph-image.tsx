import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Use the Voxera name correctly.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({
    eyebrow: 'Brand',
    title: 'Use the Voxera name correctly.',
    subtitle:
      'Logo files, colour tokens, voice and tone rules, and the phrases we would rather you did not use.',
    meta: 'Brand kit',
  });
}
