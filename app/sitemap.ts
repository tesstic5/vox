import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/content';

export const dynamic = 'force-static';

const PATHS = ['/', '/platform', '/solutions', '/docs', '/security', '/pricing', '/status', '/support', '/contact', '/privacy', '/terms-of-service', '/legal', '/brand', '/enterprise', '/customers', '/careers'];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((path, index) => ({
    url: `${SITE.url}${path === '/' ? '' : path}`,
    changeFrequency: index === 0 ? 'weekly' : 'monthly',
    priority: index === 0 ? 1 : 0.6,
  }));
}
