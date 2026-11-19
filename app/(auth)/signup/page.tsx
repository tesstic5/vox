import * as React from 'react';
import { AuthForm } from '@/components/site/AuthForm';

export const metadata = {
  title: 'Create an account',
  description: 'Create a free Voxera account with 60 minutes of platform usage. No credit card required.',
};

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
