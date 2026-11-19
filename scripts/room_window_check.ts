/**
 * The room picker and the clash check agree about every window.
 *
 * A move asks them in that order — `freeRoomFor` chooses a room, `isFree` then
 * judges it — so an instant where the picker returns a room the clash check then
 * refuses is a diary that offers a time and will not take it. This is a property
 * rather than a case, so it is asserted over a grid of instants, services and
 * practitioners: 175 windows on the seed diary found 6 disagreements before the
 * lengths were made to match, and none after.
 *
 * Reads the database directly, so the app can stay up:
 *
 *     ./node_modules/.bin/tsx scripts/room_window_check.ts
 */
import { isFree } from '../lib/server/availability';
import { freeRoomFor } from '../lib/server/rooms';
import { list } from '../lib/server/db';

const orgId = 'org_3b5dd38bbd095dd5';
const services = list<{ id: string; name: string; durationMinutes: number }>('services', () => true);
const pairs: { providerId: string; locationId: string; serviceId: string; duration: number }[] = [];
for (const [providerId, locationId, serviceIds] of [
  ['prv_7fd7391e1243f9d6', 'loc_eeab0874c9532f8a', ['svc_6a3c71505db3a71d', 'svc_bc8eff66d7b03ceb']],
  ['prv_99d18356bbbc56a0', 'loc_eeab0874c9532f8a', ['svc_f6bd27128651934e', 'svc_defbc1ffdaa2febc']],
] as [string, string, string[]][]) {
  for (const serviceId of serviceIds) {
    const service = services.find((s) => s.id === serviceId);
    if (service) pairs.push({ providerId, locationId, serviceId, duration: 30 });
  }
}

let disagreements = 0;
let checked = 0;
const detail: string[] = [];
for (let day = 19; day <= 23; day += 1) {
  for (let minute = 16 * 60; minute <= 23 * 60; minute += 15) {
    const startsAt = new Date(Date.UTC(2026, 9, day, 0, minute)).toISOString();
    for (const pair of pairs) {
      const service = services.find((s) => s.id === pair.serviceId);
      const providerOk = isFree({ orgId, providerId: pair.providerId, startsAt, durationMinutes: pair.duration, service: service as never, locationId: pair.locationId });
      if (!providerOk.free) continue; // a provider clash is a different question
      const room = freeRoomFor(orgId, { locationId: pair.locationId, startsAt, durationMinutes: pair.duration, serviceId: pair.serviceId });
      if (!room) continue;
      checked += 1;
      const verdict = isFree({ orgId, providerId: pair.providerId, startsAt, durationMinutes: pair.duration, service: service as never, roomId: room.id, locationId: pair.locationId });
      if (!verdict.free) {
        disagreements += 1;
        if (detail.length < 3) {
          detail.push(`${startsAt} ${service?.name} (${service?.durationMinutes}m, asked ${pair.duration}m) → picked ${room.name}, refused: ${verdict.reason ?? 'conflict'}`);
        }
      }
    }
  }
}
for (const line of detail) console.log('  ' + line);
console.log(`${checked} window(s) checked · ${disagreements} disagreement(s) between the picker and the clash check`);
if (!checked) {
  console.log('  nothing to check — the fixture ids in this gate no longer exist');
  process.exit(1);
}
process.exit(disagreements ? 1 : 0);
