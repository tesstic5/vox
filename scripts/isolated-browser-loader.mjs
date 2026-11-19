import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Resolve optional browser-audit tools from an isolated install.
 *
 * Playwright and axe are deliberately not product dependencies. Local/CI browser
 * gates install them under a disposable directory and set
 * VOXERA_BROWSER_TOOLS_DIR to that directory's node_modules folder. Using a
 * loader keeps package.json/package-lock.json and the shipped image free of
 * browser tooling while allowing the existing standalone gate scripts to use
 * normal `import 'playwright'` / `import 'axe-core'` statements.
 */
const root = process.env.VOXERA_BROWSER_TOOLS_DIR;
if (!root || !path.isAbsolute(root)) {
  throw new Error('VOXERA_BROWSER_TOOLS_DIR must be an absolute isolated node_modules path');
}

const aliases = new Map([
  ['playwright', pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href],
  ['axe-core', pathToFileURL(path.join(root, 'axe-core', 'axe.js')).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const url = aliases.get(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
