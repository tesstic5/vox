/**
 * Look at the store without opening the app.
 *
 * With no argument: a summary — how big each collection is, in rows and bytes.
 * With a collection: that collection, pretty-printed.
 *
 *   npx tsx scripts/store-peek.ts
 *   npx tsx scripts/store-peek.ts audit | head -40
 *
 * Read-only: it opens the database in `readonly` mode, so it is safe to run
 * against a live server (and cannot be the thing that corrupts one).
 */

import fs from 'node:fs';
import path from 'node:path';

const sqlitePath = path.join(process.cwd(), 'data', 'voxera-db.sqlite');
const jsonPath = path.join(process.cwd(), 'data', 'voxera-db.json');

const name = process.argv[2];

function withJson() {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const db = JSON.parse(raw) as { version: number; collections: Record<string, unknown[]> };
  if (!name) {
    const rows = Object.entries(db.collections)
      .map(([key, docs]) => ({ key, docs, bytes: Buffer.byteLength(JSON.stringify(docs)) }))
      .sort((a, b) => b.bytes - a.bytes);
    console.log(`store ${jsonPath} (JSON)`);
    for (const row of rows.slice(0, 20)) {
      console.log(`  ${row.key.padEnd(24)} ${String(row.docs.length).padStart(6)} docs ${(row.bytes / 1e6).toFixed(2).padStart(7)} MB`);
    }
    return;
  }
  const docs = db.collections[name];
  if (!docs) {
    console.error(`no collection "${name}"`);
    process.exit(1);
  }
  console.log(JSON.stringify(docs, null, 2));
}

async function withSqlite() {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(sqlitePath, { readonly: true });

  if (!name) {
    const rows = db
      .prepare('SELECT collection, COUNT(*) AS n, SUM(LENGTH(body)) AS bytes FROM docs GROUP BY collection ORDER BY bytes DESC')
      .all() as { collection: string; n: number; bytes: number }[];
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    const bytes = rows.reduce((sum, r) => sum + r.bytes, 0);
    console.log(`store ${sqlitePath} (SQLite)`);
    console.log(`  ${(bytes / 1e6).toFixed(1)} MB of documents · ${rows.length} collections · ${total} rows`);
    for (const row of rows.slice(0, 20)) {
      console.log(`  ${row.collection.padEnd(24)} ${String(row.n).padStart(6)} docs ${(row.bytes / 1e6).toFixed(2).padStart(7)} MB`);
    }
    return;
  }

  const rows = db.prepare('SELECT body FROM docs WHERE collection = ? ORDER BY seq DESC').all(name) as { body: string }[];
  if (!rows.length) {
    const collections = db.prepare('SELECT DISTINCT collection FROM docs ORDER BY collection').all() as { collection: string }[];
    console.error(`no collection "${name}" — have: ${collections.map((c) => c.collection).join(', ')}`);
    process.exit(1);
  }
  console.log(`[${rows.map((r) => JSON.stringify(JSON.parse(r.body), null, 2)).join(',\n')}]`);
}

if (fs.existsSync(sqlitePath)) void withSqlite();
else if (fs.existsSync(jsonPath)) withJson();
else {
  console.error(`no store at ${sqlitePath} or ${jsonPath}`);
  process.exit(1);
}
