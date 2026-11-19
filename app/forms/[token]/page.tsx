import type { Metadata } from 'next';
import { PublicForm } from './PublicForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Secure form · Voxera',
  description: 'Complete a secure form shared by your care team.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function FormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicForm token={token} />;
}
