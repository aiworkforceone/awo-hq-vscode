/**
 * The AI Workforce One developer brand: every name exactly as it is published today
 * (`dev-brands.test.ts` pins them to `cli/package.json` and `vscode-extension/package.json`).
 */
import type { DevBrand } from '../dev-brand-core.js';

export const DEV_BRAND: DevBrand = Object.freeze({
  id: 'awo',
  productName: 'HQ',
  displayName: 'AI Workforce One HQ',
  defaultHost: 'https://hq.aiworkforceone.com',
  builtInHosts: ['https://hq.aiworkforceone.com', 'https://hq-test.aiworkforceone.com'],
  builtInHostParents: [],
  reservedHostLabels: [],
  hostExample: 'https://hq.aiworkforceone.com',
  teamAliasPrefix: 'hq',
  apiBaseUrl: 'https://api-hq.aiworkforceone.com',
  apiDocsBase: 'https://hq.aiworkforceone.com/docs/api',
  cli: {
    command: 'hq',
    packageName: '@aiworkforceoneofficial/hq',
    description:
      'Connect your computer to your AI Team Cloud Computers in AI Workforce One HQ: attach and port forwarding.',
    envPrefix: 'HQ',
    homeDirName: '.hq',
    keychainService: 'hq.aiworkforceone',
    bundleFile: 'hq.cjs',
    repository: 'aiworkforceone/awo-hq-cli',
    legacySshConfig: '~/.ssh/hq_config',
  },
  sdk: { npm: '@aiworkforceoneofficial/hq-sdk', pypi: 'aiworkforceone-hq' },
  vscode: {
    publisher: 'aiworkforceone',
    name: 'awo-hq',
    displayName: 'AI Workforce One HQ',
    description:
      'Your AI Workforce One HQ teams inside VS Code: join their session terminals and forward their ports, without SSH.',
    idPrefix: 'hq',
    authProviderId: 'aiworkforceone-hq',
    fsScheme: 'hq',
    repository: 'aiworkforceone/awo-hq-vscode',
  },
});
