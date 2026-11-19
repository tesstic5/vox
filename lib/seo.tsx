import * as React from 'react';
import { SITE } from './content';

export type JsonLdNode = Record<string, unknown>;

export function JsonLd({ data }: { data: JsonLdNode | JsonLdNode[] }) {
  // Escaping '<' prevents a future caller from terminating the script element
  // if structured data ever includes workspace-authored text.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

export function absolute(href: string) {
  return href.startsWith('http') ? href : `${SITE.url}${href === '/' ? '' : href}`;
}

export function organizationJsonLd(): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE.url}/#organization`,
    name: 'Voxera',
    url: SITE.url,
    description: SITE.description,
  };
}

export function websiteJsonLd(): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE.url}/#website`,
    url: SITE.url,
    name: 'Voxera',
    description: SITE.description,
    publisher: { '@id': `${SITE.url}/#organization` },
    inLanguage: 'en-US',
  };
}

export function softwareApplicationJsonLd(): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': `${SITE.url}/#product`,
    name: 'Voxera',
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Booking and communication workspace',
    operatingSystem: 'Web',
    publisher: { '@id': `${SITE.url}/#organization` },
    description: SITE.description,
    featureList: [
      'Business profiles with owner-selected modules',
      'Contractor enquiry-to-invoice records',
      'Practice scheduling, classes and generic notes',
      'Optional provider-backed assistants and calls',
      'Tenant-scoped APIs, audit records and exports',
    ],
  };
}

export function breadcrumbJsonLd(trail: { name: string; href: string }[]): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absolute(item.href),
    })),
  };
}
