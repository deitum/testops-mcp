// Copies the version from package.json into src/testops.constants.ts, which is
// what the server reports to MCP clients during initialisation.
//
// Changesets owns package.json, so without this step the two drift apart on
// every release; `npm run changeset:version` runs it between the bump and the
// lockfile refresh.
import { readFileSync, writeFileSync } from 'node:fs';

const CONSTANTS = new URL('../src/testops.constants.ts', import.meta.url);
const PATTERN = /(export const SERVER_VERSION = ')[^']*(')/;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(CONSTANTS, 'utf8');

if (!PATTERN.test(source)) {
  throw new Error(`SERVER_VERSION not found in ${CONSTANTS.pathname}`);
}

const updated = source.replace(PATTERN, `$1${version}$2`);
if (updated !== source) {
  writeFileSync(CONSTANTS, updated);
  console.log(`SERVER_VERSION -> ${version}`);
}
