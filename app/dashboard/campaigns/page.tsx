import { redirect } from 'next/navigation';

/** Booking campaigns are implemented and managed on the server-backed booking page. */
export default function CampaignsPage() {
  redirect('/dashboard/bookings');
}
