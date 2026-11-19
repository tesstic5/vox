import * as React from 'react';
import { AuthForm } from '@/components/site/AuthForm';

export const metadata = {
  title: 'Sign in',
  description: 'Sign in to the Voxera dashboard to manage assistants, calls, numbers, and analytics.',
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
