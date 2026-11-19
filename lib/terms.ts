/**
 * Term packs.
 *
 * The database and the API speak one vocabulary — `clients`, `providers`,
 * `services`, `appointments`, `notes` — because renaming collections per
 * industry is a migration every time a customer changes one. The *interface*
 * speaks the customer's language instead: a physio sees patients and
 * practitioners, a security firm sees customers and technicians, and an
 * ordinary office sees clients.
 *
 * This file is deliberately free of server imports so a client component, a
 * message template and a PDF can all read the same words.
 */

export type TermPackId = 'clinical' | 'service' | 'generic';

export type Term = { one: string; many: string; One: string; Many: string };

export type Terms = {
  client: Term;
  provider: Term;
  service: Term;
  appointment: Term;
  note: Term;
  location: Term;
};

function pack(rows: {
  client: [string, string];
  provider: [string, string];
  service: [string, string];
  appointment: [string, string];
  note: [string, string];
  location: [string, string];
}): Terms {
  const make = ([one, many]: [string, string]): Term => ({
    one,
    many,
    // Title-cased forms, for headings and buttons. `many` is only given a
    // capital when it is a real word on its own ("Jobs" is, "Appointments" is).
    One: one.charAt(0).toUpperCase() + one.slice(1),
    Many: many.charAt(0).toUpperCase() + many.slice(1),
  });
  return {
    client: make(rows.client),
    provider: make(rows.provider),
    service: make(rows.service),
    appointment: make(rows.appointment),
    note: make(rows.note),
    location: make(rows.location),
  };
}

export const TERM_PACKS: Record<TermPackId, Terms> = {
  clinical: pack({
    client: ['patient', 'patients'],
    provider: ['practitioner', 'practitioners'],
    service: ['appointment type', 'appointment types'],
    appointment: ['appointment', 'appointments'],
    note: ['treatment note', 'treatment notes'],
    location: ['clinic', 'clinics'],
  }),
  service: pack({
    client: ['customer', 'customers'],
    provider: ['technician', 'technicians'],
    service: ['service', 'services'],
    appointment: ['job', 'jobs'],
    note: ['job note', 'job notes'],
    location: ['site', 'sites'],
  }),
  generic: pack({
    client: ['client', 'clients'],
    provider: ['team member', 'team members'],
    service: ['service', 'services'],
    appointment: ['appointment', 'appointments'],
    note: ['note', 'notes'],
    location: ['location', 'locations'],
  }),
};

export const TERM_PACK_IDS = Object.keys(TERM_PACKS) as TermPackId[];

export function termsFor(pack: string | null | undefined): Terms {
  if (pack && pack in TERM_PACKS) return TERM_PACKS[pack as TermPackId];
  return TERM_PACKS.generic;
}

/** A one-line description of a pack, for the picker in the dashboard. */
export function describeTermPack(id: TermPackId): string {
  const t = TERM_PACKS[id];
  return `${t.client.Many} · ${t.provider.Many} · ${t.appointment.Many} · ${t.note.Many}`;
}
