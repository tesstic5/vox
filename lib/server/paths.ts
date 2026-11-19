import path from 'node:path';

/**
 * The only place that decides where mutable application state lives.
 *
 * Production containers normally mount `/app/data`, while migration and
 * integration checks point `VOXERA_DATA_DIR` at an isolated directory. Keeping
 * this in one module prevents the database from moving while scheduler locks,
 * encryption keys, archives and health checks quietly keep using `./data`.
 */
export function dataDir(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.VOXERA_DATA_DIR?.trim() || path.join(process.cwd(), 'data'));
}

export function dataPath(...parts: string[]): string {
  return path.join(/* turbopackIgnore: true */ dataDir(), ...parts);
}
