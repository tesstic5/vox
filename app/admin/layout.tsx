import type { Metadata } from 'next';
import * as React from 'react';

/** The operator console is never indexed — it is a session-gated internal tool. */
export const metadata: Metadata = {
  title: 'Operator console — Voxera',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
