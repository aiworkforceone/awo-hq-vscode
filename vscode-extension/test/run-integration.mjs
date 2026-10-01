// The first @vscode/test-electron harness in kpa-app (FEATURE.md O6, DEVOPS §3.5): starts a REAL
// VS Code (the `engines.vscode` floor by default; `VSCODE_TEST_VERSION=stable` for the newest) with
// only this extension loaded, a throwaway profile, and runs test/suite/index.cjs inside it.
// CI runs it under `xvfb-run -a`. The download is cached in .vscode-test/.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const floor = pkg.engines.vscode.replace(/^\^/, '');
const version = process.env.VSCODE_TEST_VERSION || floor;
const userData = mkdtempSync(path.join(tmpdir(), 'hq-vscode-ud-'));
const exts = mkdtempSync(path.join(tmpdir(), 'hq-vscode-ext-'));

try {
  // macOS builds from 1.139 name the app binary `Code`, where this @vscode/test-electron still
  // expects `Electron`: use the sibling that exists (Linux, the CI and mirror host, is unaffected).
  // The download lives in vscode-extension/.vscode-test whatever the caller's cwd: the path the CI
  // caches and eslint/prettier ignore (the library default is <cwd>/.vscode-test, which from the
  // repo root put a whole VS Code where the root lint walks, and missed the CI cache every run).
  let vscodeExecutablePath = await downloadAndUnzipVSCode({
    version,
    cachePath: path.join(root, '.vscode-test'),
  });
  const renamed = path.join(path.dirname(vscodeExecutablePath), 'Code');
  if (!existsSync(vscodeExecutablePath) && existsSync(renamed)) vscodeExecutablePath = renamed;
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(here, 'suite', 'index.cjs'),
    launchArgs: [
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userData}`,
      `--extensions-dir=${exts}`,
    ],
  });
} catch (err) {
  console.error('integration suite failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rmSync(userData, { recursive: true, force: true });
  rmSync(exts, { recursive: true, force: true });
}
