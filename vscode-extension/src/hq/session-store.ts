/**
 * Where the extension keeps a sign-in (decision 2, D1, §7c).
 *
 *   SecretStorage   `hq:<host>:tokens`  the access/refresh pair (JSON)
 *                   `hq:<host>:device`  the ed25519 device key, as OpenSSH private-key text
 *   globalState     `hq:<host>:account` grant id + who is signed in (no secret)
 *                   `hq:<host>:orgs`    the last org/team listing (no secret), for a quick first paint
 *
 * PER HOST, so switching `hq.host` can never send one host's tokens to another (decision 26).
 * `globalState` never holds a token: U1 asserts it.
 *
 * The token pair is read often (every request), and SecretStorage is an IPC round trip, so the last
 * value is kept in memory and DROPPED when another window changes it (`secrets.onDidChange`, §7c
 * step 3) or after 60 s at most (the fallback when that event does not cross windows).
 */
import type { RemoteOrg } from '@kpa/shared/remote.types';
import type { StoredTokens, TokenStore } from '@hq/client/api.js';

export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
  onDidChange(listener: (e: { key: string }) => unknown): { dispose(): unknown };
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface Account {
  grantId: string;
  user: { id: string; email: string; name: string };
}

/** The in-memory copy of the token pair is re-read at least this often. */
export const TOKEN_CACHE_MS = 60_000;

export function tokensKey(host: string): string {
  return `hq:${host}:tokens`;
}
export function deviceKeyKey(host: string): string {
  return `hq:${host}:device`;
}
export function accountKey(host: string): string {
  return `hq:${host}:account`;
}
export function orgsKey(host: string): string {
  return `hq:${host}:orgs`;
}

function parseTokens(raw: string | undefined): StoredTokens | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<StoredTokens>;
    return typeof t.accessToken === 'string' &&
      typeof t.refreshToken === 'string' &&
      typeof t.accessExpiresAt === 'string'
      ? {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          accessExpiresAt: t.accessExpiresAt,
          ...(t.needsRenewing === true ? { needsRenewing: true as const } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

export class SessionStore {
  private cached: { host: string; tokens: StoredTokens | null; at: number } | null = null;
  private readonly subscription: { dispose(): unknown };

  constructor(
    private readonly secrets: SecretsLike,
    private readonly memento: MementoLike,
    private readonly now: () => number = Date.now,
  ) {
    this.subscription = secrets.onDidChange((e) => {
      if (this.cached && e.key === tokensKey(this.cached.host)) this.cached = null;
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /** The `TokenStore` the shared `HqClient` reads and writes. */
  tokenStore(): TokenStore {
    return {
      // Review M-b: the refresh lock's re-read asks for `fresh`, never the in-memory copy.
      load: (host, opts) => (opts?.fresh ? this.reloadTokens(host) : this.loadTokens(host)),
      save: (host, tokens) => this.saveTokens(host, tokens),
    };
  }

  async loadTokens(host: string): Promise<StoredTokens | null> {
    const c = this.cached;
    if (c && c.host === host && this.now() - c.at < TOKEN_CACHE_MS) return c.tokens;
    const tokens = parseTokens(await this.secrets.get(tokensKey(host)));
    this.cached = { host, tokens, at: this.now() };
    return tokens;
  }

  /** Re-read the pair from SecretStorage now (another window may have rotated it). */
  async reloadTokens(host: string): Promise<StoredTokens | null> {
    this.cached = null;
    return this.loadTokens(host);
  }

  async saveTokens(host: string, tokens: StoredTokens): Promise<void> {
    await this.secrets.store(tokensKey(host), JSON.stringify(tokens));
    this.cached = { host, tokens, at: this.now() };
  }

  async loadDeviceKey(host: string): Promise<string | null> {
    return (await this.secrets.get(deviceKeyKey(host))) ?? null;
  }

  async saveDeviceKey(host: string, openSshText: string): Promise<void> {
    await this.secrets.store(deviceKeyKey(host), openSshText);
  }

  account(host: string): Account | null {
    const a = this.memento.get<Account>(accountKey(host));
    return a && typeof a.grantId === 'string' && a.user && typeof a.user.email === 'string'
      ? a
      : null;
  }

  async saveAccount(host: string, account: Account): Promise<void> {
    await this.memento.update(accountKey(host), account);
  }

  cachedOrgs(host: string): RemoteOrg[] {
    const o = this.memento.get<RemoteOrg[]>(orgsKey(host));
    return Array.isArray(o) ? o : [];
  }

  async saveOrgs(host: string, orgs: RemoteOrg[]): Promise<void> {
    await this.memento.update(orgsKey(host), orgs);
  }

  /** Forget everything this host's sign-in left behind: secrets first, then the cached listing. */
  async wipe(host: string): Promise<void> {
    this.cached = null;
    await this.secrets.delete(tokensKey(host));
    await this.secrets.delete(deviceKeyKey(host));
    await this.memento.update(accountKey(host), undefined);
    await this.memento.update(orgsKey(host), undefined);
  }
}
