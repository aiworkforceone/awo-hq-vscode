// Bundle AI Workforce One HQ for VS Code to ONE CommonJS file, dist/extension.cjs (DEVOPS §3.2;
// `.cjs` because the package's own sources are ESM, `"type": "module"`, while VS Code loads a
// CommonJS main):
// cli/build.mjs's recipe with `vscode` external. `@kpa/shared/*` and `@hq/client/*` are aliased to
// their SOURCE, so the published file carries the same wire contract the server was built with and
// the same client code the `hq` CLI runs.
//
// No source maps and no minification (the public mirror rebuilds this byte for byte, and people read
// what they install), `metafile: true` (the CI paths drift guard and the mirror's source list read it),
// and `bufferutil` / `utf-8-validate` external: OPTIONAL native accelerators of `ws`; the extension
// ships no native module.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = (await import(path.join(here, 'package.json'), { with: { type: 'json' } })).default;

const result = await build({
  entryPoints: [path.join(here, 'src', 'extension.ts')],
  outfile: path.join(here, 'dist', 'extension.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  define: { __HQ_VSCODE_VERSION__: JSON.stringify(pkg.version) },
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  // Paths in the bundle's comments are relative to THIS directory whatever the caller's cwd, so a
  // rebuild in the public mirror (same relative layout) is byte for byte the same.
  absWorkingDir: here,
  alias: {
    '@kpa/shared': path.join(root, 'shared', 'src'),
    '@hq/client': path.join(root, 'hq-client', 'src'),
    // The two runtime dependencies come from THIS package's lockfile, never the repo root's, so a
    // kpa-app build and a mirror build (which has no root node_modules) bundle the same bytes.
    ws: path.join(here, 'node_modules', 'ws'),
    '@xterm/headless': path.join(here, 'node_modules', '@xterm', 'headless'),
  },
  logLevel: 'info',
});
// Beside the bundle, never inside dist/ (the .vsix packs dist/): the CI drift guard reads it.
mkdirSync(path.join(here, 'out'), { recursive: true });
writeFileSync(path.join(here, 'out', 'meta.json'), JSON.stringify(result.metafile, null, 2));
