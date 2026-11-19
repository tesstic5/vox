import { redirect } from 'next/navigation';

/**
 * The old checklist lives on as /dashboard/setup.
 *
 * Kept as a redirect rather than deleted: the marketing site, the docs, and
 * whatever a customer bookmarked all point here.
 */
export default function OnboardingPage() {
  redirect('/dashboard/setup');
}
