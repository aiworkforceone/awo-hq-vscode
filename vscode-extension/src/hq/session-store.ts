/**
 * Where the extension keeps its sign-ins (hq-vscode decision 2, D1, §7c; hq-vscode-multi-account
 * decisions 2-5, 10, 17, 18, 22, 29). One SLOT per account (`account-ref.ts`):
 *
 *   SecretStorage   `<slot>tokens`   the access/refresh pair (JSON; a `user` slot adds `grantId`)
 *                   `<slot>device`   the ed25519 device key: OpenSSH text (legacy), or
 *                                    `{"grantId","openssh"}` (user)
 *   globalState     `<slot>account`  grant id + who is signed in (no secret)
 *                   `<slot>orgs`     the last org/team listing (no secret), for a quick first paint
 *                   `<slot>ports:forwards|dismissed`  the Ports view's own lists
 *   globalState     `hq:<host>:t:<tag>` tombstones, `hq:<host>:legacyUser`, `hq:<host>:lastActive`,
 *                   `hq:profileKey`: none of them a secret
 *
 * ⛔ NO SHARED ACCOUNT INDEX (decision 4): the list is derived from `globalState.keys()` every time.
 *    `Memento.update` is last-writer-wins on a whole value, and sign-out/revocation must never wait
 *    on the sign-in lock.
 * ⛔ NO SLOT-TO-SLOT TOKEN API (MA-S7). A slot's tokens are written only by the sign-in result for
 *    that slot, by `HqClient` rotation under that slot's lock (`tokenStore`), and by `wipe`.
 * ⛔ ONE IN-MEMORY PAIR PER SLOT, never per host (security B-1): with two accounts on one host a
 *    per-host cache handed A's bearer to B's unsigned reads for up to 60 s.
 *
 * The pair is read often and SecretStorage is an IPC round trip, so each slot's last value is kept
 * in memory and DROPPED when another window changes that key (`secrets.onDidChange`) or after 60 s at
 * most (Cursor never sends that event across windows, P0 check 2). A `user` slot's pair is
 * re-checked against its `grantId` stamp on EVERY load (decision 17): a different stamp means
 * another window renewed the slot (`SlotRenewedError`), never a revocation.
 */
import { createHash } from 'node:crypto';
import type { RemoteOrg } from '@kpa/shared/remote.types';
import type { StoredTokens, TokenStore } from '@hq/client/api.js';
import { deviceKeyFromOpenSsh } from '@hq/client/device-key.js';
import { Emitter } from '../util/emitter.js';
import {
  accountTag,
  PROFILE_KEY_RE,
  slotPrefix,
  USER_ID_RE,
  type AccountRef,
} from './account-ref.js';

export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
  onDidChange(listener: (e: { key: string }) => unknown): { dispose(): unknown };
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
  /** `Memento.keys()` (engine ^1.90): the account list is derived from it (decision 4). */
  keys(): readonly string[];
}

export interface Account {
  grantId: string;
  user: { id: string; email: string; name: string };
  /** Set on `user` slots (ISO time). */
  addedAt?: string;
}

/** Decision 29: who the 0.1.x sign-in was, and the fingerprint of the key it had. */
export interface LegacyUser {
  userId: string;
  email: string;
  devicePubFp: string;
  /** The legacy record's grant when the fingerprint was taken (a re-sign-in changes it). */
  grantId: string;
}

/** Decision 10: who a tag was, kept after sign-out so a folder can say whose it is. */
export interface Tombstone {
  userId: string;
  email: string;
  at: string;
}

/** Decision 18. `needs-sign-in`: record present, secrets gone (or the legacy key changed hands). */
export type SlotHealth = 'ok' | 'needs-sign-in' | 'busy';

/** The slot's `account` record vanished: another window signed it out (decision 23). */
export class AccountGoneError extends Error {
  constructor() {
    super('This HQ account was signed out in another window.');
    this.name = 'AccountGoneError';
  }
}

/** The slot's `grantId` moved on: another window renewed it (decisions 17, 26). Never a 401. */
export class SlotRenewedError extends Error {
  constructor() {
    super('This HQ sign-in was renewed in another window.');
    this.name = 'SlotRenewedError';
  }
}

/** `secrets.get` THREW (keychain locked, the IPC failed): transient, never a wipe (decision 18). */
export class SecretsBusyError extends Error {
  constructor() {
    super('Could not read the HQ sign-in from the keychain.');
    this.name = 'SecretsBusyError';
  }
}

/** The record is present but its secrets are not usable here (decision 18's zombie). */
export class NeedsSignInError extends Error {
  constructor() {
    super('This HQ sign-in needs renewing.');
    this.name = 'NeedsSignInError';
  }
}

/** The in-memory copy of a slot's pair is re-read at least this often. */
export const TOKEN_CACHE_MS = 60_000;
/** Tombstones kept per host (decision 10). */
export const TOMBSTONES_MAX = 20;
export const PROFILE_KEY = 'hq:profileKey';

export function tokensKey(ref: AccountRef): string {
  return `${slotPrefix(ref)}tokens`;
}
export function deviceKeyKey(ref: AccountRef): string {
  return `${slotPrefix(ref)}device`;
}
export function accountKey(ref: AccountRef): string {
  return `${slotPrefix(ref)}account`;
}
export function orgsKey(ref: AccountRef): string {
  return `${slotPrefix(ref)}orgs`;
}
export function portsKey(ref: AccountRef, list: 'forwards' | 'dismissed'): string {
  return `${slotPrefix(ref)}ports:${list}`;
}
export function legacyUserKey(host: string): string {
  return `hq:${host}:legacyUser`;
}
export function tombstoneKey(host: string, tag: string): string {
  return `hq:${host}:t:${tag}`;
}
export function lastActiveKey(host: string): string {
  return `hq:${host}:lastActive`;
}

/** `sha256:<hex>` of the device key's public line; null when the text is not a key. */
export function deviceFingerprint(openssh: string): string | null {
  try {
    const line = deviceKeyFromOpenSsh(openssh).publicLine;
    return `sha256:${createHash('sha256').update(line).digest('hex')}`;
  } catch {
    return null;
  }
}

type Stamped = StoredTokens & { grantId?: string };

function parseTokens(raw: string | undefined): Stamped | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<Stamped>;
    return typeof t.accessToken === 'string' &&
      typeof t.refreshToken === 'string' &&
      typeof t.accessExpiresAt === 'string'
      ? {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          accessExpiresAt: t.accessExpiresAt,
          ...(t.needsRenewing === true ? { needsRenewing: true as const } : {}),
          ...(typeof t.grantId === 'string' ? { grantId: t.grantId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function unstamp(t: Stamped): StoredTokens {
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresAt: t.accessExpiresAt,
    ...(t.needsRenewing ? { needsRenewing: true as const } : {}),
  };
}

function validAccount(a: unknown): a is Account {
  const r = a as Partial<Account> | undefined;
  return (
    !!r &&
    typeof r.grantId === 'string' &&
    !!r.user &&
    typeof r.user.id === 'string' &&
    typeof r.user.email === 'string'
  );
}

export class SessionStore {
  private readonly cached = new Map<string, { tokens: Stamped | null; at: number }>();
  private readonly subscription: { dispose(): unknown };
  private readonly secretChanged = new Emitter<string>();
  /** A SecretStorage key changed (this window or, in VS Code, another one). */
  readonly onSecretChanged = this.secretChanged.event;

  constructor(
    private readonly secrets: SecretsLike,
    private readonly memento: MementoLike,
    private readonly now: () => number = Date.now,
  ) {
    this.subscription = secrets.onDidChange((e) => {
      for (const prefix of [...this.cached.keys()]) {
        if (e.key === `${prefix}tokens`) this.cached.delete(prefix);
      }
      this.secretChanged.fire(e.key);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.secretChanged.dispose();
  }

  /** `secrets.get`, with a THROW turned into `SecretsBusyError` (never into "gone"). */
  private async secret(key: string): Promise<string | undefined> {
    try {
      return await this.secrets.get(key);
    } catch {
      throw new SecretsBusyError();
    }
  }

  // ── profile key (decision 22) ──────────────────────────────────────────────────────────────────

  profileKey(): string | null {
    const k = this.memento.get<string>(PROFILE_KEY);
    return typeof k === 'string' && PROFILE_KEY_RE.test(k) ? k : null;
  }

  /** Only under the sign-in lock: re-read, and write `fresh` only when still absent. */
  async ensureProfileKey(fresh: () => string): Promise<string> {
    const have = this.profileKey();
    if (have) return have;
    const k = fresh();
    await this.memento.update(PROFILE_KEY, k);
    return k;
  }

  // ── the account list (decision 4) ──────────────────────────────────────────────────────────────

  /**
   * Accounts on `host`: legacy `hq:<host>:account` + every `hq:<host>:u:<profileKey>:<id>:account`
   * of THIS profile, deduped by user id (a `user` slot wins over legacy).
   */
  accounts(host: string, profileKey: string | null): Array<{ ref: AccountRef; account: Account }> {
    const out = new Map<string, { ref: AccountRef; account: Account }>();
    const userPrefix = profileKey ? `hq:${host}:u:${profileKey}:` : null;
    for (const key of this.memento.keys()) {
      if (!userPrefix || !key.startsWith(userPrefix) || !key.endsWith(':account')) continue;
      const userId = key.slice(userPrefix.length, -':account'.length);
      if (!USER_ID_RE.test(userId)) continue;
      const account = this.memento.get<Account>(key);
      if (!validAccount(account) || account.user.id !== userId) continue;
      out.set(userId, { ref: { host, userId, slot: 'user', profileKey: profileKey! }, account });
    }
    const legacy = this.memento.get<Account>(`hq:${host}:account`);
    if (validAccount(legacy) && USER_ID_RE.test(legacy.user.id) && !out.has(legacy.user.id)) {
      out.set(legacy.user.id, {
        ref: { host, userId: legacy.user.id, slot: 'legacy', profileKey: profileKey ?? '' },
        account: legacy,
      });
    }
    return [...out.values()];
  }

  /** The slot's `account` record (an in-memory Memento read), or null when it is gone. */
  accountRecord(ref: AccountRef): Account | null {
    const a = this.memento.get<Account>(accountKey(ref));
    if (!validAccount(a)) return null;
    // A legacy slot holds whoever 0.1.x signed in last; it belongs to `ref` only if that is ref.
    return a.user.id === ref.userId ? a : null;
  }

  // ── tokens ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * The `TokenStore` one `HqClient` uses, CLOSED OVER ONE SLOT. It refuses any other host (it never
   * falls back). For a `user` slot every load compares the pair's `grantId` stamp with `grantId`
   * and throws `SlotRenewedError` on a mismatch; every save writes that stamp back beside the pair.
   */
  tokenStore(ref: AccountRef, grantId: string | null, keyFp: string | null = null): TokenStore {
    const check = (host: string): void => {
      if (host !== ref.host) throw new Error('token store host mismatch');
    };
    const stamped = async (fresh: boolean): Promise<StoredTokens | null> => {
      // Review C1 / security M1: the legacy slot is shared by every profile. Each time its pair is
      // read from SecretStorage (not the in-memory copy), its key must still be the one this
      // client signs with; another profile's 0.1.1 may have written its own sign-in there.
      if (ref.slot === 'legacy' && keyFp !== null && (fresh || !this.cacheValid(ref))) {
        const device = await this.loadDeviceKey(ref);
        if (!device || deviceFingerprint(device.openssh) !== keyFp) throw new NeedsSignInError();
      }
      const t = await this.loadStamped(ref, fresh);
      if (!t) return null;
      if (ref.slot === 'user' && t.grantId !== grantId) throw new SlotRenewedError();
      return unstamp(t);
    };
    return {
      load: async (host, opts) => {
        check(host);
        return stamped(opts?.fresh === true);
      },
      save: async (host, tokens) => {
        check(host);
        await this.saveTokens(ref, tokens, grantId);
      },
    };
  }

  private cacheValid(ref: AccountRef): boolean {
    const c = this.cached.get(slotPrefix(ref));
    return c !== undefined && this.now() - c.at < TOKEN_CACHE_MS;
  }

  /** The slot's pair with its stamp (cached up to 60 s unless `fresh`). */
  async loadStamped(ref: AccountRef, fresh = false): Promise<Stamped | null> {
    const prefix = slotPrefix(ref);
    const c = this.cached.get(prefix);
    if (!fresh && c && this.now() - c.at < TOKEN_CACHE_MS) return c.tokens;
    const tokens = parseTokens(await this.secret(`${prefix}tokens`));
    this.cached.set(prefix, { tokens, at: this.now() });
    return tokens;
  }

  private async saveTokens(
    ref: AccountRef,
    tokens: StoredTokens,
    grantId: string | null,
  ): Promise<void> {
    const value: Stamped =
      ref.slot === 'user' && grantId ? { grantId, ...unstamp(tokens) } : unstamp(tokens);
    await this.secrets.store(tokensKey(ref), JSON.stringify(value));
    this.cached.set(slotPrefix(ref), { tokens: value, at: this.now() });
  }

  // ── device key ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The device key and its stamp. Legacy: raw OpenSSH text, no stamp. `null` = the secret is gone
   * (or unreadable as a key); a THROWING `secrets.get` is `SecretsBusyError` (decision 18).
   */
  async loadDeviceKey(
    ref: AccountRef,
  ): Promise<{ openssh: string; grantId: string | null } | null> {
    const raw = await this.secret(deviceKeyKey(ref));
    if (!raw) return null;
    if (ref.slot === 'legacy') return { openssh: raw, grantId: null };
    try {
      const d = JSON.parse(raw) as { grantId?: unknown; openssh?: unknown };
      return typeof d.grantId === 'string' && typeof d.openssh === 'string'
        ? { openssh: d.openssh, grantId: d.grantId }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Decision 18 from the record and both secrets. A `user` slot whose stamps disagree is mid-renew
   * (`busy`); a legacy slot whose key fingerprint is not the recorded one is `needs-sign-in`.
   */
  async health(ref: AccountRef): Promise<SlotHealth> {
    const record = this.accountRecord(ref);
    if (!record) return 'needs-sign-in';
    try {
      const device = await this.loadDeviceKey(ref);
      // Review M1: a health read never fills the slot's in-memory copy. For the shared legacy
      // slot that copy is what a built client signs with, and the pair read here may be another
      // profile's sign-in.
      const tokens = parseTokens(await this.secret(tokensKey(ref)));
      if (!device || !tokens) return 'needs-sign-in';
      if (ref.slot === 'user') {
        return device.grantId === record.grantId && tokens.grantId === record.grantId
          ? 'ok'
          : 'busy';
      }
      if ((await this.legacyKeyVerdict(ref.host, device.openssh)) !== 'mismatch') return 'ok';
      this.cached.delete(slotPrefix(ref)); // never serve a pair from a key that is not ours
      return 'needs-sign-in';
    } catch (err) {
      if (err instanceof SecretsBusyError) return 'busy';
      throw err;
    }
  }

  // ── legacy user (decision 29) ──────────────────────────────────────────────────────────────────

  legacyUser(host: string): LegacyUser | null {
    const u = this.memento.get<LegacyUser>(legacyUserKey(host));
    return u &&
      typeof u.userId === 'string' &&
      typeof u.email === 'string' &&
      typeof u.devicePubFp === 'string'
      ? u
      : null;
  }

  /**
   * Record the 0.1.x user once (first 0.2.0 activation that finds a legacy account). Nothing else is
   * written, and no secret is touched beyond reading the key to fingerprint it.
   */
  async recordLegacyUser(host: string): Promise<LegacyUser | null> {
    const have = this.legacyUser(host);
    if (have) return have;
    const record = this.memento.get<Account>(`hq:${host}:account`);
    if (!validAccount(record)) return null;
    const ref: AccountRef = { host, userId: record.user.id, slot: 'legacy', profileKey: '' };
    const device = await this.loadDeviceKey(ref);
    const fp = device ? deviceFingerprint(device.openssh) : null;
    if (!fp) return null;
    const user: LegacyUser = {
      userId: record.user.id,
      email: record.user.email,
      devicePubFp: fp,
      grantId: record.grantId,
    };
    await this.memento.update(legacyUserKey(host), user);
    return user;
  }

  /**
   * Does the shared legacy key still belong to this profile's legacy sign-in? SecretStorage is shared
   * across profiles, the `account` record is not (P0 check 3). A 0.1.1 window in THIS profile that
   * signed in again as the same user changed the record too: the fingerprint is re-recorded.
   */
  async legacyKeyVerdict(host: string, openssh: string): Promise<'ok' | 'rerecorded' | 'mismatch'> {
    const fp = deviceFingerprint(openssh);
    const user = this.legacyUser(host);
    if (!fp) return 'mismatch';
    if (!user) return 'ok'; // nothing recorded yet: `recordLegacyUser` takes this one
    if (fp === user.devicePubFp) return 'ok';
    const record = this.memento.get<Account>(`hq:${host}:account`);
    if (validAccount(record) && record.user.id === user.userId && record.grantId !== user.grantId) {
      await this.memento.update(legacyUserKey(host), {
        ...user,
        email: record.user.email,
        devicePubFp: fp,
        grantId: record.grantId,
      } satisfies LegacyUser);
      return 'rerecorded';
    }
    return 'mismatch';
  }

  /**
   * Review M2: may THIS profile act on the shared legacy secrets (revoke their grant, delete
   * them)? Not when their key is someone else's (another profile's 0.1.1), and not when the
   * keychain cannot be read. A slot with no key left has nothing to protect.
   */
  async legacyKeyIsOurs(ref: AccountRef): Promise<boolean> {
    if (ref.slot !== 'legacy') return true;
    try {
      const device = await this.loadDeviceKey(ref);
      if (!device) return true;
      return (await this.legacyKeyVerdict(ref.host, device.openssh)) !== 'mismatch';
    } catch {
      return false;
    }
  }

  // ── writing a sign-in ──────────────────────────────────────────────────────────────────────────

  /**
   * A new or renewed `user` slot: the key first, then the pair, then the listing, the `account`
   * record LAST (an account is only ever recorded once everything it needs is stored). Both secrets
   * carry `grantId`, so a window reading between two writes sees a tear, never a wrong pairing.
   */
  async writeUserSlot(
    ref: AccountRef,
    w: {
      grantId: string;
      openssh: string;
      tokens: StoredTokens;
      orgs: RemoteOrg[];
      user: Account['user'];
    },
  ): Promise<void> {
    if (ref.slot !== 'user') throw new Error('0.2.0 never writes the legacy slot');
    // A sign-in of this account supersedes any marker of an older sign-out of it: no sweep may
    // take this slot's fresh secrets for that one's leftovers (the record is written last).
    await this.clearSigningOut(ref.host, accountTag(ref.host, ref.userId));
    await this.secrets.store(
      deviceKeyKey(ref),
      JSON.stringify({ grantId: w.grantId, openssh: w.openssh }),
    );
    await this.saveTokens(ref, w.tokens, w.grantId);
    await this.memento.update(orgsKey(ref), w.orgs);
    await this.memento.update(accountKey(ref), {
      grantId: w.grantId,
      user: { id: w.user.id, email: w.user.email, name: w.user.name },
      addedAt: new Date(this.now()).toISOString(),
    } satisfies Account);
    await this.writeTombstone(ref, w.user.email);
  }

  /** Copy the Ports view's own (non-secret) lists to the slot an account moved to (decision 3). */
  async carryPortLists(from: AccountRef, to: AccountRef): Promise<void> {
    for (const list of ['forwards', 'dismissed'] as const) {
      const v = this.memento.get<unknown[]>(portsKey(from, list));
      if (Array.isArray(v) && v.length > 0) await this.memento.update(portsKey(to, list), v);
    }
  }

  // ── listing cache ──────────────────────────────────────────────────────────────────────────────

  cachedOrgs(ref: AccountRef): RemoteOrg[] {
    const o = this.memento.get<RemoteOrg[]>(orgsKey(ref));
    return Array.isArray(o) ? o : [];
  }

  async saveOrgs(ref: AccountRef, orgs: RemoteOrg[]): Promise<void> {
    await this.memento.update(orgsKey(ref), orgs);
  }

  // ── tombstones, last active (decisions 7, 10) ──────────────────────────────────────────────────

  tombstone(host: string, tag: string): Tombstone | null {
    const t = this.memento.get<Tombstone>(tombstoneKey(host, tag));
    return t && typeof t.userId === 'string' && typeof t.email === 'string' ? t : null;
  }

  /** Written at sign-in and refreshed at sign-out; pruned to the newest 20 by a prefix scan. */
  async writeTombstone(ref: AccountRef, email: string): Promise<void> {
    const tag = accountTag(ref.host, ref.userId);
    await this.memento.update(tombstoneKey(ref.host, tag), {
      userId: ref.userId,
      email,
      at: new Date(this.now()).toISOString(),
    } satisfies Tombstone);
    const prefix = `hq:${ref.host}:t:`;
    const all = this.memento
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ k, at: this.memento.get<Tombstone>(k)?.at ?? '' }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const old of all.slice(TOMBSTONES_MAX)) await this.memento.update(old.k, undefined);
  }

  lastActive(host: string): string | null {
    const t = this.memento.get<string>(lastActiveKey(host));
    return typeof t === 'string' ? t : null;
  }

  async setLastActive(host: string, tag: string): Promise<void> {
    await this.memento.update(lastActiveKey(host), tag);
  }

  // ── sign-out markers (security L2) ─────────────────────────────────────────────────────────────

  /**
   * "This account is being signed out" (a TAG and a time, nothing else), written before its record
   * goes and cleared after its wipe. A window that dies in between leaves it, and the next activation
   * finishes the wipe (`HqAccounts`).
   */
  async markSigningOut(host: string, tag: string, grantId: string): Promise<void> {
    await this.memento.update(`hq:${host}:signingOut:${tag}`, {
      at: new Date(this.now()).toISOString(),
      grantId,
    });
  }

  /**
   * Markers older than `minAgeMs` (a sign-out that has had all the time it needs to finish):
   * `grantId` null when the marker is malformed. Younger ones are some window's sign-out IN
   * PROGRESS and are never acted on (review: the sweep raced a live DELETE).
   */
  staleSigningOutMarkers(
    host: string,
    minAgeMs: number,
  ): Array<{ tag: string; grantId: string | null }> {
    return this.signingOutTags(host).flatMap((tag) => {
      const m = this.memento.get<{ at?: unknown; grantId?: unknown }>(
        `hq:${host}:signingOut:${tag}`,
      );
      const at = typeof m?.at === 'string' ? Date.parse(m.at) : NaN;
      if (Number.isFinite(at) && this.now() - at < minAgeMs) return [];
      return [{ tag, grantId: typeof m?.grantId === 'string' ? m.grantId : null }];
    });
  }

  async clearSigningOut(host: string, tag: string): Promise<void> {
    await this.memento.update(`hq:${host}:signingOut:${tag}`, undefined);
  }

  /** Tags with a sign-out marker on `host`. */
  signingOutTags(host: string): string[] {
    const prefix = `hq:${host}:signingOut:`;
    return this.memento
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  /**
   * Drop only the slot's `account` record (live re-test #1): a sign-out removes it BEFORE it asks
   * HQ to revoke, so other windows learn of the sign-out from the record, not from a refused token.
   */
  async forgetAccountRecord(ref: AccountRef): Promise<void> {
    await this.memento.update(accountKey(ref), undefined);
  }

  // ── wipe ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Forget ONE slot: secrets first, then its records and lists. The tombstone stays (refreshed).
   * A legacy slot whose shared secrets are not this profile's (M2) keeps them: only this profile's
   * records go.
   */
  async wipe(ref: AccountRef, knownEmail?: string): Promise<void> {
    const email = this.accountRecord(ref)?.user.email ?? knownEmail;
    this.cached.delete(slotPrefix(ref));
    if (await this.legacyKeyIsOurs(ref)) {
      await this.secrets.delete(tokensKey(ref));
      await this.secrets.delete(deviceKeyKey(ref));
    }
    await this.memento.update(accountKey(ref), undefined);
    await this.memento.update(orgsKey(ref), undefined);
    await this.memento.update(portsKey(ref, 'forwards'), undefined);
    await this.memento.update(portsKey(ref, 'dismissed'), undefined);
    if (email) await this.writeTombstone(ref, email);
  }
}
