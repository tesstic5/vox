import * as React from 'react';

export const metadata = {
  alternates: {
    types: {
      'application/rss+xml': '/blog/rss.xml',
      'application/feed+json': '/blog/feed.json',
    },
  },
};

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
