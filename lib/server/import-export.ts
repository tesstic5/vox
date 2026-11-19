/**
 * Import and export: the two doors a practice's records actually move through.
 *
 * Every clinic arrives with a client list from somewhere else and leaves with a
 * spreadsheet for its accountant, and both journeys are where records get
 * quietly mangled. So:
 *
 *   1. **The import is a dry run by default.** The caller sees exactly which
 *      rows would be added, which are already here, and which cannot be read —
 *      with line numbers — before anything is written.
 *   2. **Dedupe is by phone number**, normalised the same way the rest of the
 *      product normalises it, so "+1 (415) 555-0111" and "14155550111" are one
 *      person rather than two.
 *   3. **A bad row never takes the good ones down with it.** It is reported and
 *      skipped, not thrown.
 *   4. **The export is a file a bookkeeper can open** — plain CSV, real headers,
 *      one row per thing, dates as ISO, money as a decimal.
 */

import { list } from './db';
import { audit } from './audit';
import { formatStructuredAddress } from '../addresses';
import { createClient, findClientByNumber, normaliseNumber, type ClientDoc } from './clients';
import { bookingsFor, type BookingDoc } from './bookings';
import { providerById, serviceById, locationById } from './practice';

/* -------------------------------------------------------------------- csv */

/**
 * Split a CSV document into rows.
 *
 * Handles the three things that actually appear in exported files: quoted
 * fields, commas and newlines inside quotes, and doubled quotes inside them.
 * Excel and Google Sheets both write those, and a client list with an address
 * column hits them on the first line.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length));
}

export function toCsv(rows: (string | number | undefined | null)[][]): string {
  const cell = (value: string | number | undefined | null) => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\n');
}

/** Header aliases, so an export from another system lands in the right fields. */
const COLUMN_ALIASES: Record<string, string> = {
  name: 'name',
  'full name': 'name',
  client: 'name',
  'client name': 'name',
  patient: 'name',
  'patient name': 'name',
  'first name': 'firstName',
  firstname: 'firstName',
  'last name': 'lastName',
  lastname: 'lastName',
  surname: 'lastName',
  phone: 'number',
  mobile: 'number',
  'phone number': 'number',
  number: 'number',
  telephone: 'number',
  email: 'email',
  'e-mail': 'email',
  'date of birth': 'dateOfBirth',
  dob: 'dateOfBirth',
  birthdate: 'dateOfBirth',
  address: 'address',
  notes: 'note',
  note: 'note',
  tags: 'tags',
  source: 'source',
};

/* ----------------------------------------------------------------- import */

export type ImportReport = {
  dryRun: boolean;
  columns: string[];
  recognised: string[];
  ignoredColumns: string[];
  total: number;
  added: number;
  existing: number;
  invalid: { line: number; reason: string; row: Record<string, string> }[];
  preview: { line: number; name: string; number: string; email?: string; action: 'add' | 'exists' }[];
};

export function importClients(
  orgId: string,
  input: { csv: string; dryRun?: boolean; actor: string; actorName?: string; source?: string }
): ImportReport {
  const dryRun = input.dryRun !== false;
  const rows = parseCsv(input.csv);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const mapped = header.map((h) => COLUMN_ALIASES[h] ?? '');
  const recognised = mapped.filter(Boolean);
  const ignoredColumns = header.filter((_, i) => !mapped[i]);

  const report: ImportReport = {
    dryRun,
    columns: header,
    recognised,
    ignoredColumns,
    total: 0,
    added: 0,
    existing: 0,
    invalid: [],
    preview: [],
  };

  if (!recognised.includes('name') && !(recognised.includes('firstName') && recognised.includes('lastName'))) {
    report.invalid.push({ line: 1, reason: 'No name column — expected `Name`, or `First name` and `Last name`.', row: {} });
    return report;
  }
  if (!recognised.includes('number')) {
    report.invalid.push({ line: 1, reason: 'No phone column — expected `Phone` (the number is what keeps two clients apart).', row: {} });
    return report;
  }

  for (let i = 1; i < rows.length; i += 1) {
    const line = i + 1;
    const cells = rows[i];
    const row: Record<string, string> = {};
    mapped.forEach((key, index) => {
      if (key) row[key] = String(cells[index] ?? '').trim();
    });
    const name = row.name || [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
    if (!name) {
      report.invalid.push({ line, reason: 'No name on this row.', row });
      continue;
    }
    const number = normaliseNumber(row.number ?? '');
    if (number.replace(/\D/g, '').length < 6) {
      report.invalid.push({ line, reason: `"${row.number ?? ''}" is not a usable phone number.`, row });
      continue;
    }
    report.total += 1;
    const existing = findClientByNumber(orgId, number);
    if (existing) {
      report.existing += 1;
      if (report.preview.length < 25) report.preview.push({ line, name: existing.name, number, email: existing.email, action: 'exists' });
      continue;
    }
    report.added += 1;
    if (report.preview.length < 25) report.preview.push({ line, name, number, email: row.email || undefined, action: 'add' });
    if (!dryRun) {
      createClient(
        orgId,
        {
          name,
          number,
          email: row.email || undefined,
          dateOfBirth: row.dateOfBirth || undefined,
          address: row.address || undefined,
          note: row.note || undefined,
          tags: row.tags ? row.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : ['imported'],
        },
        input.actor,
        { source: input.source ?? 'import', actorName: input.actorName }
      );
    }
  }

  if (!dryRun && report.added) {
    audit({
      orgId,
      actor: input.actor,
      action: 'clients.imported',
      target: 'clients',
      detail: `${report.added} added, ${report.existing} already here, ${report.invalid.length} skipped`,
    });
  }
  return report;
}

/* ----------------------------------------------------------------- export */

const CLIENT_COLUMNS = [
  'Name',
  'Phone',
  'Email',
  'Date of birth',
  'Address',
  'Tags',
  'SMS consent',
  'Email consent',
  'Visits',
  'Last visit',
  'Since',
];

export function clientsCsv(orgId: string, visible?: (client: ClientDoc) => boolean): { csv: string; rows: number } {
  const clients = list<ClientDoc>('clients', (c) => c.orgId === orgId && !c.archivedAt && (!visible || visible(c)));
  const rows: (string | number)[][] = [CLIENT_COLUMNS];
  for (const client of clients) {
    rows.push([
      client.name,
      client.number,
      client.email ?? '',
      client.dateOfBirth ?? '',
      formatStructuredAddress(client.structuredAddress, client.address) ?? '',
      (client.tags ?? []).join('; '),
      client.consents?.sms?.granted ? 'yes' : 'no',
      client.consents?.email?.granted ? 'yes' : 'no',
      Number(client.appointmentCount ?? 0),
      client.lastAppointmentAt ?? '',
      String(client.createdAt ?? '').slice(0, 10),
    ]);
  }
  return { csv: toCsv(rows), rows: rows.length - 1 };
}

const APPOINTMENT_COLUMNS = [
  'Starts at',
  'Ends at',
  'Client',
  'Phone',
  'Service',
  'Practitioner',
  'Site',
  'Room',
  'Status',
  'Source',
  'Value',
  'Reference',
];

export function appointmentsCsv(orgId: string, opts?: { from?: string; to?: string; locationId?: string }): { csv: string; rows: number } {
  const appointments = bookingsFor(orgId, (b) => {
    if (opts?.locationId && b.locationId !== opts.locationId) return false;
    const at = String(b.startsAt ?? '').slice(0, 10);
    if (opts?.from && at < opts.from) return false;
    if (opts?.to && at > opts.to) return false;
    return true;
  }).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

  const rows: (string | number)[][] = [APPOINTMENT_COLUMNS];
  for (const booking of appointments as BookingDoc[]) {
    const start = new Date(String(booking.startsAt));
    const duration = Number(booking.durationMinutes ?? 30) || 30;
    rows.push([
      Number.isNaN(start.getTime()) ? String(booking.startsAt) : start.toISOString(),
      Number.isNaN(start.getTime()) ? '' : new Date(start.getTime() + duration * 60_000).toISOString(),
      booking.customer?.name ?? '',
      booking.customer?.number ?? '',
      serviceById(orgId, String(booking.serviceId ?? ''))?.name ?? String(booking.service ?? ''),
      providerById(orgId, String(booking.providerId ?? ''))?.name ?? '',
      locationById(orgId, String(booking.locationId ?? ''))?.name ?? '',
      (booking as { roomId?: string }).roomId ? roomLabel(orgId, String((booking as { roomId?: string }).roomId)) : '',
      String(booking.status ?? ''),
      String((booking as { source?: string }).source ?? ''),
      typeof booking.value === 'number' ? (booking.value / 100).toFixed(2) : '',
      String((booking as { reference?: string }).reference ?? ''),
    ]);
  }
  return { csv: toCsv(rows), rows: rows.length - 1 };
}

function roomLabel(orgId: string, roomId: string): string {
  const rooms = list<{ id: string; orgId?: string; name?: string }>('rooms', (r) => r.orgId === orgId && r.id === roomId);
  return rooms[0]?.name ?? '';
}

export function importTemplateCsv(): string {
  return toCsv([
    ['Name', 'Phone', 'Email', 'Date of birth', 'Address', 'Tags', 'Note'],
    ['Alex Morgan', '+14155550123', 'alex@example.com', '1988-04-02', '18 Pine St, San Francisco', 'new; referral', 'Prefers mornings'],
  ]);
}
