// The extension's OWN unit tier (DEVOPS §4: kept out of the root vitest config on purpose,
// `@types/vscode` lives only here). `vscode` resolves to a small test double: the units under test
// talk to VS Code through a handful of classes and calls, which the double records.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  resolve: {
    alias: {
      vscode: here('./test/unit/vscode-stub.ts'),
      '@kpa/shared': here('../shared/src'),
      '@hq/client': here('../hq-client/src'),
      // As in build.mjs: this package's own pins, so the public mirror (no root node_modules) runs too.
      ws: here('./node_modules/ws'),
      '@xterm/headless': here('./node_modules/@xterm/headless'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
