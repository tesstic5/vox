/**
 * A booking confirmation as a calendar file.
 *
 * Plain text with CRLF line endings and folded lines, because that is what the
 * format is — a `.ics` that only Outlook accepts is not a `.ics`. The event is
 * written in UTC (`Z`) so it lands at the right hour on a phone in another zone,
 * which is the one thing a patient will notice if we get it wrong.
 *
 * Public by design: the path carries an unguessable reference and no client
 * number, and the file contains only what the person who booked already knows.
 */

/** RFC 5545 escaping: commas, semicolons and newlines are separators otherwise. */
function escapeText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Long lines must be folded at 75 octets, continued with a single space. */
function fold(line: string) {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  return parts.join('\r\n');
}

function stamp(iso: string) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export type IcsInput = {
  uid: string;
  startsAt: string;
  durationMinutes: number;
  summary: string;
  description?: string;
  location?: string;
  /** Who the event is on the calendar of — a human name, never a number. */
  organizer?: string;
  status?: 'CONFIRMED' | 'CANCELLED';
};

export function buildIcs(input: IcsInput): string {
  const start = new Date(input.startsAt);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Voxera//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(input.uid)}@voxera`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(start.toISOString())}`,
    `DTEND:${stamp(end.toISOString())}`,
    `SUMMARY:${escapeText(input.summary)}`,
    input.description ? `DESCRIPTION:${escapeText(input.description)}` : undefined,
    input.location ? `LOCATION:${escapeText(input.location)}` : undefined,
    input.organizer ? `ORGANIZER;CN=${escapeText(input.organizer)}:mailto:no-reply@voxera.local` : undefined,
    `STATUS:${input.status ?? 'CONFIRMED'}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(input.summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((line): line is string => Boolean(line));
  return lines.map(fold).join('\r\n') + '\r\n';
}
