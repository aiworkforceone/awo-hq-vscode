// The first @vscode/test-electron harness in kpa-app (FEATURE.md O6, DEVOPS §3.5): starts a REAL
// VS Code (the `engines.vscode` floor by default; `VSCODE_TEST_VERSION=stable` for the newest) with
// only this extension loaded, a throwaway profile, and runs test/suite/index.cjs inside it.
// CI runs it under `xvfb-run -a`. The download is cached in .vscode-test/.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
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
// The second run (hq-vscode-multi-account U23): a window opened on a folder whose account is not
// signed in yet, a loopback fake HQ in the extension host (test/suite/account-returns.cjs), and the
// sign-in that brings the account back.
const userData2 = mkdtempSync(path.join(tmpdir(), 'hq-vscode-ud2-'));
const exts2 = mkdtempSync(path.join(tmpdir(), 'hq-vscode-ext2-'));
const work2 = mkdtempSync(path.join(tmpdir(), 'hq-vscode-ws2-'));

/** A free loopback port for the fake HQ (its host is part of the folder's tag, so fixed up front). */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

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
  const failures = [];
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
  }).catch((err) => failures.push(err));

  const port = await freePort();
  const host = `http://127.0.0.1:${port}`;
  const userId = 'u-returns-1';
  const tag = `a${createHash('sha256').update(`${host}|${userId}`).digest('hex').slice(0, 12)}`;
  mkdirSync(path.join(userData2, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData2, 'User', 'settings.json'),
    JSON.stringify({
      'hq.host': host,
      'hq.allowedHosts': [host],
      'security.workspace.trust.enabled': false,
    }),
  );
  const workspaceFile = path.join(work2, 'returns.code-workspace');
  writeFileSync(
    workspaceFile,
    JSON.stringify({
      folders: [{ uri: `hq://${tag}@awo/hq-3f9a1c2e`, name: 'Backend team (AWO)' }],
    }),
  );
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(here, 'suite', 'account-returns.cjs'),
    extensionTestsEnv: { HQ_FAKE_PORT: String(port), HQ_FAKE_USER: userId, HQ_FAKE_TAG: tag },
    launchArgs: [
      workspaceFile,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userData2}`,
      `--extensions-dir=${exts2}`,
    ],
  }).catch((err) => {
    failures.push(err);
    // What the extension itself recorded (its Output channel's log file): the reason on screen.
    for (const f of readdirSync(userData2, { recursive: true })) {
      if (String(f).endsWith('AI Workforce One HQ.log')) {
        console.log(`--- ${f}\n${readFileSync(path.join(userData2, String(f)), 'utf8')}`);
      }
    }
  });
  if (failures.length > 0) throw failures[0];
} catch (err) {
  console.error('integration suite failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rmSync(userData, { recursive: true, force: true });
  for (const d of [userData2, exts2, work2]) rmSync(d, { recursive: true, force: true });
  rmSync(exts, { recursive: true, force: true });
}
