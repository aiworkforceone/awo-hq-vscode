/**
 * The SHAPE of a developer-surface brand and the pure helpers over one. No brand data lives here
 * (that is `dev-brands/<id>.ts`), and no brand's id or name: a bundle that imports this file
 * carries no names but its own build's. The copy functions are `dev-brand-copy.ts`.
 */

export interface DevBrand {
  /** The brand's id (its data file's name, `dev-brands/<id>.ts`). */
  id: string;
  /** The product as a noun inside a sentence ("open HQ to wake it"). */
  productName: string;
  /** The full product name (titles, the Accounts menu, the extension's display name). */
  displayName: string;
  /**
   * The console address the CLI and the extension sign in to when none is configured. `null` for a
   * brand whose every customer has their own address, so the person names it (`--host`, the `host`
   * setting).
   */
  defaultHost: string | null;
  /** Console addresses always allowed without configuration (exact `https://host`). */
  builtInHosts: readonly string[];
  /**
   * Parent domains whose ONE-LABEL children are always allowed (customers' hosts under the brand's
   * own domains). A custom domain is never built in: the person adds it (`allowedHosts`, `--host`).
   */
  builtInHostParents: readonly string[];
  /** Labels under a built-in parent that are infrastructure, never a console. */
  reservedHostLabels: readonly string[];
  /** What an address looks like, for messages. */
  hostExample: string;
  /** The prefix of the short team names the CLI and the extension print (`hq-3f9a1c2e`). */
  teamAliasPrefix: string;
  /** The public API base an SDK uses by default (the client appends `/v1`). */
  apiBaseUrl: string;
  /** Where the API docs live; problem `type` URIs resolve to an anchor on its errors page. */
  apiDocsBase: string;
  cli: {
    command: string;
    packageName: string;
    description: string;
    /** `HQ` makes `HQ_HOST`, `HQ_HOME`, ... */
    envPrefix: string;
    /** The state directory under the home directory. */
    homeDirName: string;
    keychainService: string;
    /** The bundle's file name under `dist/`. */
    bundleFile: string;
    /** The public source mirror the package is published from (npm provenance points at it). */
    repository: string;
    /**
     * The SSH config file an older release of this CLI wrote (`ssh-proxy` tells people to delete
     * it), or null for a brand whose CLI never had SSH.
     */
    legacySshConfig: string | null;
  };
  sdk: { npm: string; pypi: string };
  vscode: {
    publisher: string;
    name: string;
    displayName: string;
    description: string;
    /** The prefix of every command, view, context key and setting (`hq.signIn`, `hq.host`). */
    idPrefix: string;
    authProviderId: string;
    /** The FileSystemProvider scheme of team files (`hq:/...`). */
    fsScheme: string;
    /** The public source mirror the extension is published from. */
    repository: string;
  };
}

/** `HQ_HOST`: the brand's prefix, then `_`, then the suffix. */
export function devBrandEnvName(brand: DevBrand, suffix: string): string {
  return `${brand.cli.envPrefix}_${suffix}`;
}

/** The brand's environment variable, or undefined. */
export function devBrandEnv(
  brand: DevBrand,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  suffix: string,
): string | undefined {
  return env[devBrandEnvName(brand, suffix)];
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Is `host` (`https://name`, already normalized: lower case, no path, no trailing slash) an address
 * this brand trusts without configuration? An exact built-in host, or ONE customer label under a
 * built-in parent that is not an infrastructure label. No port, no http, no deeper name.
 */
export function isBuiltInHost(brand: DevBrand, host: string): boolean {
  if (brand.builtInHosts.includes(host)) return true;
  if (!host.startsWith('https://')) return false;
  const name = host.slice('https://'.length);
  for (const parent of brand.builtInHostParents) {
    const suffix = `.${parent}`;
    if (!name.endsWith(suffix)) continue;
    const label = name.slice(0, -suffix.length);
    if (LABEL_RE.test(label) && !brand.reservedHostLabels.includes(label)) return true;
  }
  return false;
}
