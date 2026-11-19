import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

/**
 * Run the destructive migration assertions against a consistent online copy of
 * the current store. Nothing in the working data directory is opened writable.
 */
async function main() {
  const root = process.cwd();
  const sourceDir = path.join(root, 'data');
  const sourceDb = path.join(sourceDir, 'voxera-db.sqlite');
  assert(fs.existsSync(sourceDb), `missing source store: ${sourceDb}`);

  const copyDir = fs.mkdtempSync(path.join(root, '.migration-check-'));
  const copyDb = path.join(copyDir, 'voxera-db.sqlite');

  try {
    const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try {
      await db.backup(copyDb);
    } finally {
      db.close();
    }

    for (const name of ['.voxera-key', 'voxera-db.json']) {
      const source = path.join(sourceDir, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(copyDir, name));
    }

    const tsx = process.platform === 'win32'
      ? path.join(root, 'node_modules', '.bin', 'tsx.cmd')
      : path.join(root, 'node_modules', '.bin', 'tsx');
    const result = spawnSync(tsx, [path.join(root, 'scripts', 'migration-check.ts')], {
      cwd: root,
      env: {
        ...process.env,
        VOXERA_DATA_DIR: copyDir,
        VOXERA_MIGRATION_CHECK: '1',
        // Keep this probe independent of any operator retention policy.
        VOXERA_RECORD_RETENTION_DAYS: '',
      },
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
