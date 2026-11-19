import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Pricing is not configured for this build.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({
    eyebrow: 'Pricing boundary',
    title: 'No fictional plan entitlement or provider bill.',
    subtitle:
      'This build records operational usage and cost fields; it does not publish a subscription tariff or prove external provider settlement.',
    meta: 'No published tariff',
  });
}
