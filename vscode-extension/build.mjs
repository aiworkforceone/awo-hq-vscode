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
//
// One source, one build per brand (shared/src/dev-brands.ts):
//
//   node build.mjs                          the AWO extension, exactly as before: dist/extension.cjs
//                                           and out/meta.json (this directory is the package).
//   node build.mjs --out <dir>              the same, staged as a COMPLETE package directory (the
//                                           manifest and files of this one): `vsce package` runs IN
//                                           that directory.
//   node build.mjs --brand <id> [--out <dir>]
//                                           another brand's package (default out/brands/<id>/): its
//                                           manifest (scripts/brand-manifest.mjs), the bundle, its
//                                           own README/CHANGELOG/LICENSE and mark (brand-files/<id>/),
//                                           .vscodeignore, vsix-allowlist.json and meta.json. Its
//                                           bundle is minified with its modules keyed by number: it
//                                           ships no source, so nothing in it names a source path.
//
// The brand reaches the code at build time (../scripts/dev-brand-build.mjs, handed THIS package's
// esbuild and typescript: the mirror has no repo-root node_modules).
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {
  devBrandPlugin,
  loadDevBrand,
  loadRebrandCopy,
  neutralizeModulePaths,
} from '../scripts/dev-brand-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = (await import(path.join(here, 'package.json'), { with: { type: 'json' } })).default;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const brandId = arg('brand') ?? 'awo';
const deps = { esbuild, ts };
const brand = await loadDevBrand(root, brandId, deps);
const isAwo = brandId === 'awo';
const outArg = arg('out');
const stage = outArg
  ? path.resolve(outArg)
  : isAwo
    ? here
    : path.join(here, 'out', 'brands', brandId);
const bundleFile = path.join(stage, 'dist', 'extension.cjs');

const result = await esbuild.build({
  entryPoints: [path.join(here, 'src', 'extension.ts')],
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  // AWO's is rebuilt byte for byte by its public mirror and read by people; another brand's ships
  // no source.
  minify: !isAwo,
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
  plugins: [await devBrandPlugin(root, brandId, deps)],
  logLevel: 'info',
});

if (isAwo && stage === here) {
  // Beside the bundle, never inside dist/ (the .vsix packs dist/): the CI drift guard reads it.
  mkdirSync(path.join(here, 'out'), { recursive: true });
  writeFileSync(path.join(here, 'out', 'meta.json'), JSON.stringify(result.metafile, null, 2));
} else if (isAwo) {
  // The AWO package, staged: its own manifest and files, unchanged.
  for (const f of [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE.txt',
    'media/hq-mark.svg',
    '.vscodeignore',
    'vsix-allowlist.json',
  ]) {
    mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    copyFileSync(path.join(here, f), path.join(stage, f));
  }
  writeFileSync(path.join(stage, 'meta.json'), JSON.stringify(result.metafile, null, 2));
  console.log(`${pkg.publisher}.${pkg.name}@${pkg.version} → ${stage}`);
} else {
  writeFileSync(
    bundleFile,
    neutralizeModulePaths(readFileSync(bundleFile, 'utf8'), result.metafile),
  );
  // Only another brand's build needs the manifest transform (the AWO mirror does not carry it).
  const { brandManifest, readBrandFiles } = await import('./scripts/brand-manifest.mjs');
  const awo = await loadDevBrand(root, 'awo', deps);
  const rebrandCopy = await loadRebrandCopy(root, deps);
  const files = readBrandFiles(here, brandId);
  const manifest = brandManifest(pkg, awo, brand, rebrandCopy, files);
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // The brand's own package files, written by hand (brand-files/<brand>/), never ours rebranded.
  const icon = files.icon ?? 'media/hq-mark.svg';
  mkdirSync(path.join(stage, path.dirname(icon)), { recursive: true });
  for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE.txt', icon]) {
    copyFileSync(path.join(here, 'brand-files', brandId, f), path.join(stage, f));
  }
  // What ships, and what the .vsix may hold: AWO's lists with the brand's mark in place of ours.
  const swapIcon = (s) => s.split('media/hq-mark.svg').join(icon);
  writeFileSync(
    path.join(stage, '.vscodeignore'),
    swapIcon(readFileSync(path.join(here, '.vscodeignore'), 'utf8')).replace(/^#.*\n/gm, ''),
  );
  const allow = JSON.parse(readFileSync(path.join(here, 'vsix-allowlist.json'), 'utf8'));
  writeFileSync(
    path.join(stage, 'vsix-allowlist.json'),
    `${JSON.stringify({ files: allow.files.map(swapIcon) }, null, 2)}\n`,
  );
  writeFileSync(path.join(stage, 'meta.json'), JSON.stringify(result.metafile, null, 2));
  console.log(`${brand.vscode.publisher}.${brand.vscode.name}@${pkg.version} → ${stage}`);
}
