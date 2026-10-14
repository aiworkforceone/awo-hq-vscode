// The .vsix allow-list (DEVOPS §3.2 step 7 / §3.5): every entry must be named in
// vsix-allowlist.json, and nothing that could leak or execute may ride along (a native module, a
// source map, source, dependencies, an env file, a test). Run: node scripts/check-vsix.mjs <file.vsix>
// [--allowlist <file>] (another brand's staged list, which names its own mark).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const vsix = process.argv[2];
if (!vsix) {
  console.error('usage: node scripts/check-vsix.mjs <file.vsix>');
  process.exit(2);
}
const listArg = process.argv.indexOf('--allowlist');
const listFile =
  listArg === -1 ? path.join(here, '..', 'vsix-allowlist.json') : process.argv[listArg + 1];
const allowed = new Set(JSON.parse(readFileSync(listFile, 'utf8')).files);
const entries = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const forbidden = /\.node$|\.map$|(^|\/)src\/|(^|\/)node_modules\/|(^|\/)\.env|\.test\./;
const unexpected = entries.filter((e) => !allowed.has(e) || forbidden.test(e));
const missing = [...allowed].filter((f) => !entries.includes(f));
if (unexpected.length > 0 || missing.length > 0) {
  if (unexpected.length) console.error('unexpected entries in the vsix:', unexpected);
  if (missing.length) console.error('entries missing from the vsix:', missing);
  process.exit(1);
}
console.log(`vsix: ${entries.join(', ')}`);
