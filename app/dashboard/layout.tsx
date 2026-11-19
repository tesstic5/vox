import * as React from 'react';
import { DashShell } from '@/components/dash/Shell';

export const metadata = {
  title: 'Dashboard',
  description: 'Manage assistants, calls, phone numbers, campaigns, simulations, and analytics.',
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashShell>{children}</DashShell>;
}
