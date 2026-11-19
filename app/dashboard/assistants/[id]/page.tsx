import * as React from 'react';
import { AssistantEditor } from '@/components/dash/AssistantEditor';

export default async function AssistantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssistantEditor id={id} />;
}
