'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { CallDetail } from '@/components/dash/CallDetail';

export default function CallDetailPage() {
  const params = useParams<{ id: string }>();
  return <CallDetail id={String(params?.id ?? '')} />;
}
