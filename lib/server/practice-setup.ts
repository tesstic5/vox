/**
 * practice-setup.ts — "what is left to do before this practice can run a day?"
 *
 * The voice-agent wizard (`onboarding.ts`) answers a different question: does
 * this workspace have an agent, a number, a first call and a webhook? A clinic
 * opening the diary for the first time has a second set of questions, and until
 * now nothing answered them. A receptionist arriving at an empty calendar had to
 * guess that the answer was "go to Practice setup, add a service and somebody to
 * deliver it".
 *
 * This module answers it, and — like the wizard — every step is derived from the
 * workspace's own records rather than from a flag the UI could set. A step that
 * says done means the row exists. Nothing here writes anything.
 *
 * The shape is deliberately small and honest: five steps, each one naming the
 * screen that finishes it, ordered the way the work actually has to be done
 * (services and people before hours, hours before a booking page, a diary before
 * a first appointment).
 */

import { count, get, type Doc } from './db';
import { providersFor, rotaForOrg, servicesFor } from './practice';
import { roomsFor } from './rooms';
import { bookingsFor } from './bookings';
import { bookingSettings } from './booking-page';
import type { OrgDoc } from './auth';

export type SetupStep = {
  id: string;
  /** What to do, in the words a practice owner would use. */
  title: string;
  /** Why it matters, in one sentence. */
  why: string;
  done: boolean;
  /** Where to do it. */
  href: string;
  /** The button's word — "Add a service", "Set hours". */
  action: string;
  /** Already-true detail, shown when the step is done. */
  detail?: string;
};

export type PracticeSetup = {
  steps: SetupStep[];
  done: number;
  total: number;
  percent: number;
  complete: boolean;
  /** True until there is at least one service and one practitioner: the diary
   *  cannot be run at all, and every screen should say so instead of looking
   *  broken. */
  empty: boolean;
};

export function practiceSetup(orgId: string): PracticeSetup {
  const services = servicesFor(orgId, { includeInactive: false });
  const providers = providersFor(orgId).filter((p) => p.active !== false);
  const rota = rotaForOrg(orgId);
  const rooms = roomsFor(orgId).filter((r) => r.active !== false);
  const org = get<OrgDoc>('orgs', orgId);
  const settings = org ? bookingSettings(org as never) : undefined;
  const booked = bookingsFor(orgId, (b) => String((b as { source?: string }).source ?? '') !== 'seed');
  const staff = count('users', (u: Doc) => (u as { orgId?: string }).orgId === orgId);

  const steps: SetupStep[] = [
    {
      id: 'services',
      title: 'List what you do',
      why: 'Every appointment is one of these, and each one carries its own length and price — which is what the agent quotes and what the invoice uses.',
      done: services.length > 0,
      href: '/dashboard/practice?tab=services',
      action: 'Add a service',
      detail: services.length ? `${services.length} service${services.length === 1 ? '' : 's'}` : undefined,
    },
    {
      id: 'people',
      title: 'Add the people who do the work',
      why: 'A practitioner is who an appointment is with. The agent will not offer a time nobody can deliver.',
      done: providers.length > 0,
      href: '/dashboard/practice?tab=team',
      action: 'Add a practitioner',
      detail: providers.length ? providers.map((p) => String(p.name)).join(', ') : undefined,
    },
    {
      id: 'hours',
      title: 'Set your opening hours',
      why: 'The rota is what makes "do you have anything Thursday?" truthful — hours, lunch breaks and days off all come from here.',
      done: rota.length > 0,
      href: '/dashboard/practice?tab=hours',
      action: 'Set hours',
      detail: rota.length ? `${rota.length} weekly rota${rota.length === 1 ? '' : 's'}` : undefined,
    },
    {
      id: 'rooms',
      title: 'Name the rooms',
      why: 'A room is what stops two patients being booked into the same four walls, and it is what the diary shows the desk so nobody has to ask.',
      done: rooms.length > 0,
      href: '/dashboard/practice?tab=locations',
      action: 'Add a room',
      detail: rooms.length ? `${rooms.length} room${rooms.length === 1 ? '' : 's'}` : undefined,
    },
    {
      id: 'desk',
      title: 'Give the front desk a login',
      why: 'The desk runs the diary without seeing clinical notes or the practice setup. Everybody gets their own account, so the record says who did what.',
      done: staff > 1,
      href: '/dashboard/team',
      action: 'Add somebody',
      detail: staff > 1 ? `${staff} logins` : undefined,
    },
    {
      id: 'booking',
      title: 'Turn on your booking page',
      why: 'One short link your clients can book from, without a phone call. It books into the same diary the desk sees.',
      done: Boolean(settings?.enabled) && services.length > 0 && providers.length > 0,
      href: '/dashboard/practice?tab=booking',
      action: 'Open the page',
      detail: settings?.enabled && org ? `/book/${String((org as { slug?: string }).slug ?? '')}` : undefined,
    },
    {
      id: 'first-visit',
      title: 'Book something in',
      why: 'Once there is a real appointment, this workspace stops being a demo: the diary, the reminders and the money all have something to work with.',
      done: booked.length > 0,
      href: '/dashboard/calendar',
      action: 'Open the diary',
      detail: booked.length ? `${booked.length} appointment${booked.length === 1 ? '' : 's'} of your own` : undefined,
    },
  ];

  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    total: steps.length,
    percent: Math.round((done / steps.length) * 100),
    complete: done === steps.length,
    empty: services.length === 0 || providers.length === 0,
  };
}

/**
 * Whether the practice has enough for the diary to be worth drawing.
 *
 * Used by the calendar's empty state: a two-line explanation and a link beat a
 * blank grid, every time.
 */
export function practiceIsRunnable(orgId: string): boolean {
  return (
    servicesFor(orgId, { includeInactive: false }).length > 0 &&
    providersFor(orgId).filter((p) => p.active !== false).length > 0
  );
}
