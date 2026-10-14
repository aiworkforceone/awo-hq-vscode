/**
 * ONE account's connection to HQ (hq-vscode decision 4; hq-vscode-multi-account decision 6): its
 * shared `HqClient` built over its own storage slot, its org/team listing, and what every HQ answer
 * means for THAT account. Built by `HqAccounts`, one per signed-in account; nothing outside
 * `hq/accounts.ts` holds a "current" service.
 *
 *   client     built from the slot's device key, with the slot's own token store and refresh lock.
 *              `client()` checks on EVERY call that the slot's `account` record still exists
 *              (another window may have signed it out, decision 23) and that its `grantId` is the
 *              one the client was built for (another window may have renewed it, decision 26).
 *   refresh    shared `HqClient`: one refresh per window, a cross-window lock under `~/.hq/vscode`
 *              per SLOT (decision 5), and on `409 REFRESH_RACE` up to 10 re-reads 500 ms apart. A
 *              refresh that cannot finish is NEVER retried by presenting the used token: the person
 *              is asked to sign in again as that account.
 *   401        only when HQ CONFIRMS it (an unsigned `GET /api/remote/orgs` with THIS account's token
 *              also answers 401, security review B1) AND the failing client's grant is still the
 *              slot's (a renewed slot is rebuilt, never wiped) is the grant gone: this slot is wiped,
 *              its terminals, forwards and sockets close (`onAccountRemoved`), one modal names it.
 *   zombie     a record whose secrets read `undefined` is "needs sign-in"; a keychain that THROWS is
 *              "busy". Neither is ever a wipe (decision 18).
 *
 * Every request carries `X-HQ-Client: vscode/<version>` and asks for its next nonce. Nothing here logs
 * a token, a nonce, a code or a signature.
 */
import os from 'node:os';
import path from 'node:path';
import { HQ_HEADER_CLIENT, HQ_HEADER_WANT_NONCE, type RemoteOrg } from '@kpa/shared/remote.types';
import {
  HqApiError,
  HqClient,
  NotLoggedInError,
  RefreshBusyError,
  RefreshNeedsRenewingError,
  type FetchLike,
} from '@hq/client/api.js';
import { deviceKeyFromOpenSsh } from '@hq/client/device-key.js';
import { partitionTeams, type Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { silentLog, type HqLog } from '../log.js';
import { accountTag, refreshLockName, type AccountRef } from './account-ref.js';
import {
  AccountGoneError,
  NeedsSignInError,
  SecretsBusyError,
  SlotRenewedError,
  deviceFingerprint,
  type Account,
  type SessionStore,
} from './session-store.js';
import { copy } from '@kpa/shared/active-dev-brand';
import { HOME_DIR_NAME } from '../brand-keys.js';

/** The refresh fetch is abandoned after this long (§7c step 2). */
export const REFRESH_TIMEOUT_MS = 10_000;
/** `409 REFRESH_RACE`: this many re-reads of SecretStorage, this far apart (§7c step 4). */
export const RACE_REREADS = 10;
export const RACE_REREAD_MS = 500;
/**
 * Live re-test #1: after HQ confirms a 401, how long to wait for the account's record to vanish
 * (another window signing it out: globalState reaches other windows in up to ~2 s) before calling
 * it a revocation, and how often to look.
 */
export const SIGNOUT_GRACE_MS = 5_000;
export const SIGNOUT_LOOK_MS = 250;
/** A `user` slot whose two stamps disagree is re-read once after this long (decision 17). */
export const STAMP_REREAD_MS = 500;

/** What the services and the sign-in need from the editor. The extension passes VS Code's. */
export interface HqUi {
  /** Show the code (and a Cancel). The returned `close` hides it again. */
  showDeviceCode(code: string, onCancel: () => void): { close(): void };
  openExternal(url: string): Promise<unknown>;
  copyToClipboard(text: string): Promise<unknown>;
  info(message: string): void;
  /** A notification about ONE account with a Sign in action; resolves true when it was chosen. */
  askToSignIn(ref: AccountRef, message: string, modal: boolean): Promise<boolean>;
  modal(message: string): void;
  /** Another window is signing in: offer "Sign in here instead"; resolves true when it was chosen. */
  offerSignInHere(message: string): Promise<boolean>;
  /** A modal yes/no with one confirming action (sign-out with 2+ accounts, decision 16). */
  confirm(message: string, action: string): Promise<boolean>;
}

/** What a service needs from the registry that owns it (`HqAccounts`). */
export interface AccountOwner {
  /** Decision 23: re-read the account list now. */
  rederive(reason: 'error'): void;
  /** This account's slot was wiped here: close its things, locally. */
  removed(ref: AccountRef): void;
  /** This account's slot holds a new grant (decision 26): reconnect what captured the old client. */
  renewed(ref: AccountRef): void;
  /** The listing or the account's health changed. */
  changed(): void;
  signIn(
    intent:
      | { kind: 'renew'; ref: AccountRef }
      | { kind: 'as'; tag: string; expectedUserId: string },
  ): Promise<unknown>;
  showTooOld(): void;
  /** How many accounts are signed in here now. */
  count(): number;
}

export interface HqServiceDeps {
  store: SessionStore;
  ui: HqUi;
  owner: AccountOwner;
  extensionVersion: string;
  /** `vscode.env.appName`: part of every lock name. */
  appName: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where the cross-window refresh and sign-in locks live. Default `~/.hq/vscode`. */
  lockDir?: string;
  log?: HqLog;
}

export function defaultLockDir(): string {
  return path.join(os.homedir(), HOME_DIR_NAME, 'vscode');
}

export function clientHeaders(extensionVersion: string): Record<string, string> {
  return {
    [HQ_HEADER_CLIENT]: `vscode/${extensionVersion}`,
    [HQ_HEADER_WANT_NONCE]: '1',
  };
}

export class HqService {
  private built: { grantId: string; client: HqClient } | null = null;
  /** The grant each client was built for: a 401 from an old one is a renew, never a revocation. */
  private readonly grantOf = new WeakMap<HqClient, string>();
  /** The last grant this window saw on the slot (decision 26: a change is a renew). */
  private seenGrant: string | null;
  /** One open prompt per account (review 9): a second request while one is open is dropped. */
  private renewAsked = false;
  private revokedShown = false;
  private busySaid = false;
  /** The registry's last health read said this account cannot be used here (decision 18). */
  private needsSignIn = false;
  /** When this window last had a listing of this account (0: never). */
  private listedAt = 0;
  /** A confirmed 401 being told apart from a sign-out elsewhere (one at a time). */
  private revoking: Promise<void> | null = null;

  constructor(
    private readonly deps: HqServiceDeps,
    private refValue: AccountRef,
  ) {
    this.seenGrant = deps.store.accountRecord(refValue)?.grantId ?? null;
  }

  get ref(): AccountRef {
    return this.refValue;
  }

  get tag(): string {
    return accountTag(this.refValue.host, this.refValue.userId);
  }

  host(): string {
    return this.refValue.host;
  }

  /** The renewed legacy account now lives in a `user` slot (decision 3): same account, new slot. */
  moveTo(ref: AccountRef, grantId: string): void {
    this.refValue = ref;
    this.built = null;
    // The move IS the renew: the caller says so once; `noteGrant` must not say it again.
    this.seenGrant = grantId;
  }

  /** The same slot, a ref with fresher fields (the legacy slot's profile key). */
  updateRef(ref: AccountRef): void {
    this.refValue = ref;
  }

  account(): Account | null {
    return this.deps.store.accountRecord(this.refValue);
  }

  email(): string {
    return this.account()?.user.email ?? '';
  }

  clientHeaders(): Record<string, string> {
    return clientHeaders(this.deps.extensionVersion);
  }

  private lockDir(): string {
    return this.deps.lockDir ?? defaultLockDir();
  }

  /** The grant `client` was built for (a renew makes it differ from `currentGrant()`). */
  grantOfClient(client: HqClient): string | undefined {
    return this.grantOf.get(client);
  }

  /** The slot's grant right now (a globalState read), or null when the account is gone. */
  currentGrant(): string | null {
    return this.account()?.grantId ?? null;
  }

  /**
   * The registry's health read for this account. `needs-sign-in` refuses every call, even with a
   * client already built (review C1, defence in depth: the shared legacy key may be another
   * profile's now). Anything else lifts it.
   */
  setHealth(health: 'ok' | 'needs-sign-in' | 'busy'): void {
    this.needsSignIn = health === 'needs-sign-in';
    if (this.needsSignIn) this.built = null;
  }

  /** Forget the built client (another window renewed the slot, or its key changed). */
  invalidate(): void {
    this.built = null;
  }

  /**
   * The slot's grant as another window left it. A different one than last seen is a renew: the
   * client is rebuilt and the owner told, so sockets, terminals and forwards reconnect (decision 26).
   */
  noteGrant(grantId: string): boolean {
    const before = this.seenGrant;
    this.seenGrant = grantId;
    if (before === null || before === grantId) return false;
    this.built = null;
    this.deps.owner.renewed(this.refValue);
    return true;
  }

  /**
   * This account's client. Throws `AccountGoneError` (signed out elsewhere), `NeedsSignInError`
   * (the slot's secrets are gone or the legacy key changed hands) or `SecretsBusyError` (the
   * keychain could not be read, or a renew is mid-write past one re-read).
   */
  async client(): Promise<HqClient> {
    let rec = this.account();
    if (!rec) {
      this.deps.owner.rederive('error');
      throw new AccountGoneError();
    }
    this.noteGrant(rec.grantId);
    if (this.needsSignIn) throw new NeedsSignInError();
    if (this.built?.grantId === rec.grantId) return this.built.client;
    const ref = this.refValue;
    let openssh: string | null = null;
    for (let attempt = 0; attempt < 2 && openssh === null; attempt++) {
      const device = await this.deps.store.loadDeviceKey(ref);
      if (!device) throw new NeedsSignInError();
      if (ref.slot === 'legacy') {
        if ((await this.deps.store.legacyKeyVerdict(ref.host, device.openssh)) === 'mismatch') {
          throw new NeedsSignInError();
        }
        openssh = device.openssh;
        break;
      }
      const tokens = await this.deps.store.loadStamped(ref, true);
      if (!tokens) throw new NeedsSignInError();
      if (device.grantId === rec.grantId && tokens.grantId === rec.grantId) {
        openssh = device.openssh;
        break;
      }
      if (attempt === 1) throw new SecretsBusyError();
      await (this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(
        STAMP_REREAD_MS,
      );
      rec = this.account();
      if (!rec) {
        this.deps.owner.rederive('error');
        throw new AccountGoneError();
      }
    }
    const grantId = rec.grantId;
    const client = new HqClient({
      host: ref.host,
      key: deviceKeyFromOpenSsh(openssh!).privateKey,
      store: this.deps.store.tokenStore(
        ref,
        ref.slot === 'user' ? grantId : null,
        ref.slot === 'legacy' ? deviceFingerprint(openssh!) : null,
      ),
      lockDir: this.lockDir(),
      lockName: refreshLockName(this.deps.appName, ref),
      clientHeaders: this.clientHeaders(),
      refreshTimeoutMs: REFRESH_TIMEOUT_MS,
      raceRereads: RACE_REREADS,
      raceRereadMs: RACE_REREAD_MS,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    this.grantOf.set(client, grantId);
    this.built = { grantId, client };
    this.busySaid = false;
    this.noteGrant(grantId);
    return client;
  }

  /** The teams this account can reach, from its last listing (no request). */
  teams(): Team[] {
    return partitionTeams(this.orgs()).teams.filter((t) => t.org.remoteAccess.allowed);
  }

  orgs(): RemoteOrg[] {
    return this.deps.store.cachedOrgs(this.refValue);
  }

  /** `GET /api/remote/orgs` as this account, cached in its slot (no secret). */
  async refreshOrgs(): Promise<RemoteOrg[]> {
    const orgs = await this.call(
      async (c) => (await c.request<RemoteOrg[]>('GET', '/api/remote/orgs')).body,
    );
    if (this.account()) await this.deps.store.saveOrgs(this.refValue, orgs);
    this.markListed();
    this.deps.owner.changed();
    return orgs;
  }

  /** The listing in the slot is current as of now (it came with a sign-in). */
  markListed(): void {
    this.listedAt = (this.deps.now ?? Date.now)();
  }

  /**
   * Re-list when this window's listing is older than `maxAgeMs` (live test 2026-10-02: a team read
   * "off" in the status bar and the picker while its sessions ran). One at a time; a failure waits
   * for the next turn rather than retrying at once.
   */
  async refreshOrgsIfOlder(maxAgeMs: number): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    if (now - this.listedAt < maxAgeMs) return;
    this.listedAt = now;
    await this.refreshOrgs().catch(() => undefined);
  }

  /**
   * Run one HQ call as this account, turning the answers that change the sign-in into what the
   * person sees. A renew seen mid-call (`SlotRenewedError`) rebuilds and retries ONCE. The error is
   * rethrown for the caller's own message, except where this already said everything.
   */
  async call<T>(fn: (client: HqClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let client: HqClient | null = null;
      try {
        client = await this.client();
        return await fn(client);
      } catch (err) {
        if (err instanceof SlotRenewedError && attempt === 0) {
          this.invalidate();
          continue;
        }
        await this.handleError(err, client);
        throw err;
      }
    }
  }

  /** What an error means for THIS account (see the header). */
  async handleError(err: unknown, failing: HqClient | null = null): Promise<void> {
    if (err instanceof SlotRenewedError) {
      this.invalidate();
      return;
    }
    if (err instanceof AccountGoneError) {
      this.deps.owner.rederive('error');
      return;
    }
    if (err instanceof SecretsBusyError) {
      this.sayBusy();
      return;
    }
    if (
      err instanceof NeedsSignInError ||
      err instanceof RefreshBusyError ||
      err instanceof RefreshNeedsRenewingError
    ) {
      void this.askRenew();
      return;
    }
    if (err instanceof HqApiError) {
      if (err.code === 'REFRESH_RACE') {
        void this.askRenew();
        return;
      }
      if (err.status === 401) {
        // One confirmation at a time (security Info): a 401 while one is being checked or told
        // apart from a sign-out elsewhere waits for it, and never asks HQ a second time.
        if (this.revoking) return this.revoking;
        // The grant that died: the failing client's, else the one the slot holds now.
        const dead = (failing ? this.grantOf.get(failing) : undefined) ?? this.account()?.grantId;
        this.revoking = (async () => {
          if (await this.revocationConfirmed(failing)) {
            await this.revokedUnlessSignedOutElsewhere(dead ?? null);
          } else {
            this.log.info(copy`account ${this.tag}: a 401 HQ did not confirm; nothing signed out`);
          }
        })().finally(() => {
          this.revoking = null;
        });
        return this.revoking;
      }
      if (err.status === 426) this.deps.owner.showTooOld();
      return;
    }
    if (err instanceof NotLoggedInError) {
      // The pair is gone but the record is there: a zombie, never a wipe (decision 18).
      const health = await this.deps.store.health(this.refValue);
      if (!this.account()) this.deps.owner.rederive('error');
      else if (health === 'busy') this.sayBusy();
      else if (health === 'needs-sign-in') void this.askRenew();
    }
  }

  /**
   * B1 plus decision 18: is THIS account's grant really gone? Not when the slot moved on to another
   * grant (a renew elsewhere), not when its secrets cannot be read, and only when HQ's unsigned
   * answer with this account's token says so.
   */
  private async revocationConfirmed(failing: HqClient | null): Promise<boolean> {
    const rec = this.account();
    if (!rec) {
      this.deps.owner.rederive('error');
      return false;
    }
    const failingGrant = failing ? this.grantOf.get(failing) : this.built?.grantId;
    if (failingGrant !== undefined && failingGrant !== rec.grantId) {
      this.noteGrant(rec.grantId);
      return false;
    }
    const health = await this.deps.store.health(this.refValue);
    if (health === 'busy') {
      this.sayBusy();
      return false;
    }
    if (health === 'needs-sign-in') {
      void this.askRenew();
      return false;
    }
    const client = await this.client().catch(() => null);
    if (!client) return false;
    return client.confirmRevoked();
  }

  /** 426: this version is below `KR_REMOTE_MIN_VSCODE_VERSION` (one modal per window). */
  showTooOld(): void {
    this.deps.owner.showTooOld();
  }

  private get log(): HqLog {
    return this.deps.log ?? silentLog;
  }

  private sayBusy(): void {
    if (this.busySaid) return;
    this.log.warn(`account ${this.tag}: the keychain could not be read`);
    this.busySaid = true;
    this.deps.ui.modal(COPY.keychainBusy(this.email()));
  }

  /** "Your HQ sign-in as <email> needs renewing." with Sign in → `renew(this)`. One at a time. */
  async askRenew(): Promise<void> {
    if (this.renewAsked) return;
    this.renewAsked = true;
    this.log.info(`account ${this.tag} needs signing in again`);
    try {
      const again = await this.deps.ui.askToSignIn(
        this.refValue,
        COPY.renewSignInAccount(this.email()),
        false,
      );
      if (again) void this.deps.owner.signIn({ kind: 'renew', ref: this.refValue });
    } finally {
      this.renewAsked = false;
    }
  }

  /**
   * HQ confirmed the grant is gone. A sign-out in ANOTHER window looks exactly like that here until
   * its removal of the account record arrives (globalState lags up to ~2 s; that window revokes
   * first and the record goes with it). So wait up to `SIGNOUT_GRACE_MS` for the record: if it goes,
   * the account was signed out on purpose: close it locally, quietly (MA-U11), no modal, no wipe
   * (the other window wiped). Otherwise it was revoked.
   */
  private async revokedUnlessSignedOutElsewhere(dead: string | null): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; ; waited += SIGNOUT_LOOK_MS) {
      const rec = this.account();
      if (!rec) {
        this.log.info(`account ${this.tag} was signed out in another window`);
        await this.wipeIfStillDead(dead);
        this.built = null;
        this.deps.owner.rederive('error');
        return;
      }
      if (dead !== null && rec.grantId !== dead) {
        // Review N2: renewed (or signed in again) elsewhere meanwhile: never wipe the new grant.
        this.log.info(`account ${this.tag} was renewed in another window`);
        this.noteGrant(rec.grantId);
        this.deps.owner.rederive('error');
        return;
      }
      if (waited >= SIGNOUT_GRACE_MS) break;
      await sleep(SIGNOUT_LOOK_MS);
    }
    await this.revoked(dead);
  }

  /**
   * Security L2: the record is gone (signed out elsewhere) but that window may have died before its
   * wipe: secrets still stamped with the dead grant are orphans, and go. Never a newer grant's
   * (another sign-in may already be writing the slot); the legacy slot only while its key is ours.
   * Idempotent.
   */
  private async wipeIfStillDead(dead: string | null): Promise<void> {
    const ref = this.refValue;
    try {
      if (ref.slot === 'user') {
        const device = await this.deps.store.loadDeviceKey(ref);
        if (!device || dead === null || device.grantId !== dead) return;
      } else if (!(await this.deps.store.legacyKeyIsOurs(ref))) {
        return;
      }
      await this.deps.store.wipe(ref);
      this.log.info(`account ${this.tag}: wiped what an interrupted sign-out left behind`);
    } catch {
      /* the keychain could not be read: nothing is wiped (decision 18) */
    }
  }

  /** This account's grant is gone: wipe its slot, close its things, say so once. */
  async revoked(dead: string | null = null): Promise<void> {
    // Review N2: re-checked right before wiping: a slot renewed meanwhile keeps its new grant.
    const rec = this.account();
    if (dead !== null && rec && rec.grantId !== dead) {
      this.noteGrant(rec.grantId);
      this.deps.owner.rederive('error');
      return;
    }
    const email = this.email();
    this.log.info(copy`account ${this.tag}: HQ confirmed its access ended; signed out here`);
    await this.deps.store.wipe(this.refValue);
    this.built = null;
    this.deps.owner.removed(this.refValue);
    if (this.revokedShown) return;
    this.revokedShown = true;
    try {
      const again = await this.deps.ui.askToSignIn(this.refValue, COPY.revokedAccount(email), true);
      if (again) {
        void this.deps.owner.signIn({
          kind: 'as',
          tag: this.tag,
          expectedUserId: this.refValue.userId,
        });
      }
    } finally {
      this.revokedShown = false;
    }
  }

  /** Sign out of THIS account: revoke its grant in HQ, then forget it here. */
  async signOut(): Promise<void> {
    const account = this.account();
    const email = this.email();
    let reached = true;
    // M2: never revoke a grant whose key is not this profile's (the shared legacy slot).
    if (account && !(await this.deps.store.legacyKeyIsOurs(this.refValue))) reached = false;
    else if (account) {
      let client: HqClient | null = null;
      try {
        client = await this.client();
        // The record goes FIRST (live re-test #1): another window then learns of this sign-out
        // from it, never from a token HQ refuses a moment later. A marker (its time and grant) says a
        // sign-out is under way, so a crash before the wipe is finished next time (security L2).
        await this.deps.store.markSigningOut(this.refValue.host, this.tag, account.grantId);
        await this.deps.store.forgetAccountRecord(this.refValue);
        await client.request(
          'DELETE',
          `/api/remote/grants/${encodeURIComponent(account.grantId)}`,
          {
            signed: true,
          },
        );
      } catch (err) {
        // A grant that is already dead means HQ already forgot this computer: fine. A 401 counts
        // only when HQ confirms it (B1); an unreadable key cannot revoke at all. Otherwise the
        // person is told to remove this computer in HQ rather than told it is done.
        // (The record is already gone here: ask HQ with this client directly.)
        reached =
          err instanceof HqApiError &&
          (err.status === 404 ||
            (err.status === 401 &&
              client !== null &&
              (await client.confirmRevoked().catch(() => false))));
      }
    }
    await this.deps.store.wipe(this.refValue, email);
    await this.deps.store.clearSigningOut(this.refValue.host, this.tag);
    this.built = null;
    this.deps.owner.removed(this.refValue);
    this.log.info(copy`account ${this.tag} signed out (HQ ${reached ? 'reached' : 'not reached'})`);
    const others = this.deps.owner.count() > 0;
    this.deps.ui.info(
      !reached ? COPY.signOutOffline : others ? COPY.signedOutAccount(email) : COPY.signedOut,
    );
  }
}
