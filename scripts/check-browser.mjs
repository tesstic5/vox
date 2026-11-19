/**
 * The browser walks, in one command.
 *
 * Five passes drive the product in a real browser — the console sweep, the
 * practitioner's day view, the diary's drag gesture, the classes walk and the
 * contractor field-service journey. Each is
 * a script you can run on its own, and each prints its own verdict; what was
 * missing was a way to run all four and get one answer, which is the difference
 * between a pass somebody runs and a pass that rots.
 *
 * This runs them in order, streams their output, and prints a table at the end.
 * The passes exist outside `scripts/check.py` on purpose: they need Playwright, a
 * browser and a live workspace, and the suite has to stay runnable without any of
 * that. The command below is for the machine that has all three.
 *
 *     npm run check:browser            # app up, repo cwd, playwright installed
 *     npm run check:browser -- --only classes
 *
 * Env the passes read: VOXERA_BASE (default http://127.0.0.1:3000), VOXERA_SLUG
 * (northwind-labs), VOXERA_EMAIL / VOXERA_PASSWORD for the desk login. Any of
 * them can be set here and are inherited. A walk that needs something the
 * workspace does not have says so and counts as a failure — the classes walk
 * stages its own class, and the others read what is on the diary.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const WALKS = [
  { key: 'console', script: 'console-sweep.mjs', label: 'every dashboard page renders without an error' },
  { key: 'day', script: 'day-ui-pass.mjs', label: "the practitioner's day, on a phone and a desk" },
  { key: 'calendar', script: 'calendar-drag-pass.mjs', label: 'the diary drags what it drew' },
  { key: 'classes', script: 'class-ui-pass.mjs', label: 'classes, from the desk and from the public page' },
  { key: 'field', script: 'field-ui-check.mjs', label: 'contractor workflow on desktop and mobile' },
  { key: 'documents', script: 'document-ui-pass.mjs', label: 'scoped client records and quarantine-first Files' },
];

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
const chosen = only ? WALKS.filter((walk) => walk.key === only || walk.script === only) : WALKS;
if (!chosen.length) {
  console.log(`No walk matches "${only}". Known: ${WALKS.map((w) => w.key).join(', ')}`);
  process.exit(2);
}

/** Run one walk, streaming its output; returns its exit code and check count. */
function run(walk) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, walk.script)], { cwd: root, env: process.env });
    let tail = '';
    const keep = (chunk) => {
      text += chunk;
      tail = text.slice(-4000);
    };
    let text = '';
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); keep(chunk.toString()); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); keep(chunk.toString()); });
    child.on('close', (code) => {
      // Two ways of counting, because the walks phrase it two ways: "N checks
      // passed" and the console sweep's "N/M dashboard routes console-clean".
      const passed = /(\d+)\s+checks passed/.exec(tail)
        ?? /(\d+)\/\d+[^\n]*checks passed/.exec(tail)
        ?? /(\d+)\/\d+\s+dashboard routes/.exec(tail);
      const failed = /(\d+)\s+(?:check\(s\) )?failed/i.exec(tail);
      resolve({ code: code ?? 1, checks: passed ? Number(passed[1]) : 0, failed: failed ? Number(failed[1]) : 0 });
    });
  });
}

const results = [];
console.log(`browser walks against ${process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000'}`);
for (const walk of chosen) {
  console.log(`\n── ${walk.key} — ${walk.label}`);
  const outcome = await run(walk);
  results.push({ walk, ...outcome });
}

console.log('\n── summary');
let checks = 0;
let bad = 0;
for (const { walk, code, checks: count, failed } of results) {
  checks += count;
  if (code !== 0 || failed) bad += 1;
  const verdict = code === 0 && !failed ? `✔ ${count} passed` : `✘ ${count} passed, ${failed} failed (exit ${code})`;
  console.log(`   ${verdict.padEnd(28)} ${walk.key} — ${walk.label}`);
}
console.log(
  bad
    ? `\n${results.length - bad} of ${results.length} walk(s) green — ${checks} check(s) passed, ${bad} walk(s) failed.`
    : `\nall ${results.length} walk(s) green — ${checks} check(s) passed, 0 failed.`
);
process.exit(bad ? 1 : 0);
