/**
 * Every HQ account signed in on this editor + host, and which one THIS window uses
 * (hq-vscode-multi-account decisions 4, 6, 7, 22, 23, 26, 29). No `vscode` import.
 *
 *   bundles    one `AccountBundle` per account: its `HqService` (own client, own slot, own refresh
 *              lock), its `HqFsApi`, `EventsHub` and `HqFsCore`. Everything that talks to HQ reaches
 *              an account through the `AccountRef` the resource carries (a URI tag, a tree node, a
 *              terminal target, a forward spec), never through "the active account" (invariant T0).
 *   list       DERIVED from `globalState.keys()` (decision 4), re-derived on window focus, on any
 *              `secrets.onDidChange`, on an account error, and every 5 s from memory (decision 23):
 *              Cursor sends no cross-window secrets event, and nothing tells a window that another
 *              one signed an account out. The diff drives `onAccountAdded` / `onAccountRemoved` /
 *              `onAccountRenewed`.
 *   active     per window (workspaceState `hq.activeAccount` = a tag), resolved by decision 7. An
 *              active account that is signed out or revoked leaves the window with NO active
 *              account: never a silent switch to another identity.
 */
import type { FetchLike } from '@hq/client/api.js';
import type { SignInLockOptions } from '../auth/signin-lock.js';
import { COPY } from '../copy.js';
import { EventsHub } from '../fs/events-client.js';
import { HqFsApi } from '../fs/fs-api.js';
import { HqFsCore, type FsCoreUi } from '../fs/fs-core.js';
import { silentLog, type HqLog } from '../log.js';
import { Emitter } from '../util/emitter.js';
import {
  accountTag,
  isTag,
  USER_ID_RE,
  parseHqAuthority,
  sameAccount,
  shortAccountLabel,
  type AccountRef,
} from './account-ref.js';
import { HqService, type AccountOwner, type HqUi } from './hq-service.js';
import {
  runSignIn,
  type FlowState,
  type SignInHost,
  type SignInIntent,
  type SignInResult,
} from './sign-in.js';
import type { Account, SessionStore, SlotHealth } from './session-store.js';
import type { HostVerdict } from './hosts.js';
import { copy } from '@kpa/shared/active-dev-brand';
import { KEY_NS } from '../brand-keys.js';

export {
  AccountGoneError,
  NeedsSignInError,
  SecretsBusyError,
  SlotRenewedError,
} from './session-store.js';
export type { SignInIntent, SignInOutcome, SignInResult } from './sign-in.js';

export const ACTIVE_ACCOUNT_KEY = `${KEY_NS}.activeAccount`;
/** Decision 23's local poll. */
export const REDERIVE_POLL_MS = 5_000;
/** The active account's team listing is re-read when older than this (switch, poll). */
export const LISTING_STALE_MS = 60_000;
/** A sign-out marker younger than this is a sign-out still in progress somewhere: never swept. */
export const SIGNOUT_MARKER_STALE_MS = 60_000;

export type RederiveReason = 'init' | 'focus' | 'secrets' | 'error' | 'poll' | 'host';

export interface WindowStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The fs runtime's editor-facing hooks for ONE account (the extension passes VS Code's). */
export interface BundleFsHooks {
  ui: FsCoreUi;
  onRefused?(org: string): void;
}

export interface HqAccountsDeps {
  store: SessionStore;
  ui: HqUi;
  /** `hq.host`, already checked against the allow-list (decision 26). */
  host: () => HostVerdict;
  extensionVersion: string;
  appName: string;
  /** This window's workspaceState (the active account's tag). */
  windowState: WindowStateLike;
  /** Decision 7 rule 2: the authority of the first `hq://` workspace folder, if any. */
  firstFolderAuthority?: () => string | undefined;
  fsHooks?: (b: AccountBundle) => BundleFsHooks;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  signInLock?: Omit<SignInLockOptions, 'onCancelRequested' | 'intent'>;
  hostname?: () => string;
  /** The Output channel (redacting); silent by default. */
  log?: HqLog;
  platform?: string;
  /** Is this window focused? The poll re-lists only then. Default: yes. */
  windowFocused?: () => boolean;
  /** 0 disables the poll (tests drive `rederive` themselves). */
  pollMs?: number;
  /** Test seam (MA-S12): the tag function. */
  tagOf?: (host: string, userId: string) => string;
}

const noFsUi: FsCoreUi = { teamOff: () => undefined, masked: () => undefined };

/** One signed-in account and everything that talks to HQ as it (decision 6). */
export class AccountBundle {
  /** Decision 18, from the last health read ('unknown' until one ran). */
  health: SlotHealth | 'unknown' = 'unknown';
  private fs: { fsApi: HqFsApi; events: EventsHub; core: HqFsCore } | null = null;
  private lastAccount: Account;
  private disposed = false;

  constructor(
    readonly tag: string,
    readonly service: HqService,
    account: Account,
    private readonly hooks: () => BundleFsHooks,
  ) {
    this.lastAccount = account;
  }

  get ref(): AccountRef {
    return this.service.ref;
  }

  /** The account record (the last one seen, kept for a closing notice after a wipe). */
  get account(): Account {
    const now = this.service.account();
    if (now) this.lastAccount = now;
    return this.lastAccount;
  }

  get email(): string {
    return this.account.user.email;
  }

  private runtime(): { fsApi: HqFsApi; events: EventsHub; core: HqFsCore } {
    if (this.fs) return this.fs;
    const hooks = this.hooks();
    const fsApi = new HqFsApi(() => this.service.client());
    const events = new EventsHub({
      client: () => this.service.client(),
      // A 4401 on THIS account's socket asks HQ as THIS account (MA-S3).
      onUnauthorized: () => this.service.refreshOrgs().catch(() => undefined),
      // A 4401 on a socket of the OLD grant after a renew elsewhere is a redial (review W3).
      grantOf: (c) => this.service.grantOfClient(c),
      currentGrant: () => this.service.currentGrant(),
      ...(hooks.onRefused ? { onRefused: (org: string) => hooks.onRefused!(org) } : {}),
    });
    const core = new HqFsCore({
      teams: () => this.service.teams(),
      api: fsApi,
      events,
      onApiError: (err) => void this.service.handleError(err),
      ui: hooks.ui,
    });
    this.fs = { fsApi, events, core };
    return this.fs;
  }

  get fsApi(): HqFsApi {
    return this.runtime().fsApi;
  }
  get events(): EventsHub {
    return this.runtime().events;
  }
  get core(): HqFsCore {
    return this.runtime().core;
  }
  /** The runtime exists (something used this account's files). */
  get hasRuntime(): boolean {
    return this.fs !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    if (!this.fs) return;
    this.fs.events.closeAll();
    this.fs.core.clear();
    this.fs.core.dispose();
  }
}

export class HqAccounts {
  private readonly bundles = new Map<string, AccountBundle>();
  /** Tags two present accounts share (about 2^-48): neither resolves (MA-S12). */
  private readonly collided = new Set<string>();
  private hostNow: string | null = null;
  private activeTag: string | null = null;
  /**
   * This window has had an active account. Until then, the first accounts that appear (signed in
   * from another window) are picked up by decision 7; after it, a removed active account leaves
   * the window with none until the person picks one (never a silent switch).
   */
  private everActive = false;
  private readonly flowState: FlowState = { signingIn: false, flow: null };
  /** The activation's own work (the interrupted sign-out sweep) has finished. */
  readonly settled: Promise<void>;
  /** The activation's first health check of every account (the init re-derive's). */
  private initHealth: Promise<void> = Promise.resolve();
  private readonly loaded: Promise<void>;
  private loadedNow = false;
  private disposedNow = false;
  private tooOldShown = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly subscriptions: Array<{ dispose(): unknown }> = [];

  private readonly changedEmitter = new Emitter<void>();
  private readonly removedEmitter = new Emitter<AccountRef>();
  private readonly renewedEmitter = new Emitter<AccountRef>();
  private readonly addedEmitter = new Emitter<AccountBundle>();
  private readonly usableEmitter = new Emitter<AccountBundle>();
  /** The list, an account's health or listing, or this window's active account changed. */
  readonly onDidChange = this.changedEmitter.event;
  /** Signed out or revoked (in any window), or the host changed: close its things. */
  readonly onAccountRemoved = this.removedEmitter.event;
  /** Decision 26: the slot holds a new grant; reconnect what captured the old client. */
  readonly onAccountRenewed = this.renewedEmitter.event;
  /** An account appeared (signed in here or in another window). */
  readonly onAccountAdded = this.addedEmitter.event;
  /**
   * An account became usable after the window started: it appeared, or came back from "needs sign
   * in". What VS Code gave up on for it (a "!" root, a failed editor) needs re-opening (U23).
   */
  readonly onAccountUsable = this.usableEmitter.event;

  constructor(private readonly deps: HqAccountsDeps) {
    this.rederive('init');
    this.activeTag = this.resolveActive();
    this.everActive = this.activeTag !== null;
    this.settled = this.finishInterruptedSignOuts().catch(() => undefined);
    this.loaded = Promise.all([this.settled, this.initHealth]).then(() => {
      this.loadedNow = true;
    });
    this.subscriptions.push(
      deps.store.onSecretChanged((key) => {
        // A renew elsewhere rewrote this slot's key: the built client is stale (decision 26).
        for (const b of this.bundles.values()) {
          if (key.startsWith(`${KEY_NS}:${b.ref.host}:`) && key.endsWith(':device'))
            b.service.invalidate();
        }
        this.rederive('secrets');
      }),
    );
    const pollMs = deps.pollMs ?? REDERIVE_POLL_MS;
    if (pollMs > 0) {
      this.poll = setInterval(() => this.rederive('poll'), pollMs);
      (this.poll as { unref?: () => void }).unref?.();
    }
  }

  private get log(): HqLog {
    return this.deps.log ?? silentLog;
  }

  private tagOf(host: string, userId: string): string {
    return (this.deps.tagOf ?? accountTag)(host, userId);
  }

  /** The allowed host, or null (a host outside the allow-list is never contacted). */
  host(): string | null {
    const v = this.deps.host();
    return v.ok ? v.host : null;
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────────

  /** Every account on the current host, by email. */
  list(): AccountBundle[] {
    return [...this.bundles.values()]
      .filter((b) => !this.collided.has(b.tag))
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  }

  count(): number {
    return this.list().length;
  }

  byTag(tag: string): AccountBundle | null {
    if (this.collided.has(tag)) return null;
    return this.bundles.get(tag) ?? null;
  }

  /** The account a ref names (by host and user: the slot may have moved, decision 3). */
  get(ref: AccountRef): AccountBundle | null {
    if (ref.host !== this.hostNow) return null;
    return this.byTag(this.tagOf(ref.host, ref.userId));
  }

  /**
   * Untagged `hq://` URIs: the 0.1.x USER (`legacyUser`, or the legacy record before it was
   * recorded), in whichever slot holds it now. Never the active account, never "the only one".
   */
  legacy(): AccountBundle | null {
    const host = this.hostNow;
    if (!host) return null;
    const userId =
      this.deps.store.legacyUser(host)?.userId ??
      this.deps.store.accounts(host, null).find((e) => e.ref.slot === 'legacy')?.ref.userId;
    return userId ? this.byTag(this.tagOf(host, userId)) : null;
  }

  /** Is this the 0.1.x user's account (its bundle also serves untagged URIs, decision 24)? */
  isLegacyUser(b: AccountBundle): boolean {
    return this.legacy()?.tag === b.tag;
  }

  /**
   * 0.2.2 live: the accounts have loaded (the activation sweep and the first health check). Until
   * then an authority that does not resolve may only be not known YET: no "not signed in" notice.
   */
  isReady(): boolean {
    return this.loadedNow;
  }

  whenReady(): Promise<void> {
    return this.loaded;
  }

  /** Closed (the extension host is shutting down): nothing resolves, and nobody is told so. */
  isDisposed(): boolean {
    return this.disposedNow;
  }

  /** The account a `hq://` authority names, or why not. */
  resolveAuthority(authority: string):
    | { kind: 'ok'; bundle: AccountBundle; orgSlug: string; key: string }
    | {
        kind: 'gone';
        key: string;
        email: string | null;
        tag: string | null;
        userId: string | null;
      } {
    const parsed = parseHqAuthority(authority);
    const host = this.hostNow;
    if (parsed.kind === 'invalid' || !host) {
      return { kind: 'gone', key: `invalid:${authority}`, email: null, tag: null, userId: null };
    }
    if (parsed.kind === 'tagged') {
      const b = this.byTag(parsed.tag);
      if (b && b.health !== 'needs-sign-in') {
        return { kind: 'ok', bundle: b, orgSlug: parsed.orgSlug, key: parsed.tag };
      }
      const t = this.deps.store.tombstone(host, parsed.tag);
      return {
        kind: 'gone',
        key: parsed.tag,
        email: b?.email ?? t?.email ?? null,
        tag: parsed.tag,
        userId: b?.ref.userId ?? t?.userId ?? null,
      };
    }
    const b = this.legacy();
    if (b && b.health !== 'needs-sign-in') {
      return { kind: 'ok', bundle: b, orgSlug: parsed.orgSlug, key: 'legacy' };
    }
    const lu = this.deps.store.legacyUser(host);
    return {
      kind: 'gone',
      key: 'legacy',
      email: lu?.email ?? null,
      tag: lu ? this.tagOf(host, lu.userId) : null,
      userId: lu?.userId ?? null,
    };
  }

  active(): AccountBundle | null {
    return this.activeTag ? this.byTag(this.activeTag) : null;
  }

  /** Decision 21: the short label, only while 2 or more accounts are signed in. */
  shortLabel(ref: AccountRef): string | undefined {
    const all = this.list();
    if (all.length < 2) return undefined;
    const b = this.get(ref);
    if (!b) return undefined;
    return shortAccountLabel(
      b.email,
      all.map((x) => x.email),
    );
  }

  // ── the active account ─────────────────────────────────────────────────────────────────────────

  /** Decision 7, at activation: saved tag, first hq:// folder, lastActive, first by email. */
  private resolveActive(): string | null {
    const saved = this.deps.windowState.get<string>(ACTIVE_ACCOUNT_KEY);
    if (saved && this.byTag(saved)) return saved;
    const authority = this.deps.firstFolderAuthority?.();
    if (authority) {
      const r = this.resolveAuthority(authority);
      if (r.kind === 'ok') return r.bundle.tag;
    }
    const host = this.hostNow;
    const last = host ? this.deps.store.lastActive(host) : null;
    if (last && this.byTag(last)) return last;
    return this.list()[0]?.tag ?? null;
  }

  async setActive(ref: AccountRef): Promise<void> {
    const b = this.get(ref);
    if (!b) return;
    if (this.activeTag !== b.tag) this.log.info(`this window now uses account ${b.tag}`);
    this.activeTag = b.tag;
    this.everActive = true;
    await this.deps.windowState.update(ACTIVE_ACCOUNT_KEY, b.tag);
    await this.deps.store.setLastActive(b.ref.host, b.tag);
    this.changedEmitter.fire();
    if (b.health !== 'needs-sign-in') void b.service.refreshOrgsIfOlder(LISTING_STALE_MS);
  }

  // ── decision 23 ────────────────────────────────────────────────────────────────────────────────

  /** Re-read the account list from globalState; fire added / removed / renewed. Cheap; called often. */
  rederive(reason: RederiveReason): void {
    const host = this.host();
    let changed = false;
    if (host !== this.hostNow) {
      // A different host needs its own sign-in: every bundle of the old one goes (decision 26).
      if (this.hostNow !== null)
        this.log.info(copy`the HQ address changed: its accounts here are closed`);
      for (const tag of [...this.bundles.keys()]) this.drop(tag);
      changed = this.hostNow !== null || host !== null;
      this.hostNow = host;
      if (reason !== 'init') this.activeTag = null;
    }
    if (!host) {
      if (changed) this.changedEmitter.fire();
      return;
    }
    const entries = this.deps.store.accounts(host, this.deps.store.profileKey());
    const byTag = new Map<string, Array<(typeof entries)[number]>>();
    for (const e of entries) {
      const tag = this.tagOf(host, e.ref.userId);
      byTag.set(tag, [...(byTag.get(tag) ?? []), e]);
    }
    const collided = new Set([...byTag].filter(([, v]) => v.length > 1).map(([t]) => t));
    if (collided.size !== this.collided.size || [...collided].some((t) => !this.collided.has(t))) {
      this.collided.clear();
      for (const t of collided) this.collided.add(t);
      changed = true;
    }
    for (const tag of [...this.bundles.keys()]) {
      if (!byTag.has(tag)) {
        this.drop(tag);
        changed = true;
      }
    }
    const added: AccountBundle[] = [];
    for (const [tag, list] of byTag) {
      const e = list[0]!;
      const b = this.bundles.get(tag);
      if (!b) {
        const bundle = this.build(tag, e.ref, e.account);
        this.bundles.set(tag, bundle);
        if (reason !== 'init') {
          this.log.info(`account ${tag} appeared (${e.ref.slot} slot, ${reason})`);
        } else this.log.info(`account ${tag} found (${e.ref.slot} slot)`);
        added.push(bundle);
        changed = true;
        continue;
      }
      if (b.ref.slot === 'legacy' && e.ref.slot === 'legacy') {
        // The legacy slot ignores the profile key: one minted later is not a move.
        if (b.ref.profileKey !== e.ref.profileKey) b.service.updateRef(e.ref);
      } else if (b.ref.slot !== e.ref.slot || b.ref.profileKey !== e.ref.profileKey) {
        // The legacy account was renewed into a `user` slot (here or elsewhere): same account.
        b.service.moveTo(e.ref, e.account.grantId);
        this.log.info(`account ${tag} moved to its user slot`);
        this.fireRenewed(e.ref);
        changed = true;
      }
      if (b.service.noteGrant(e.account.grantId)) changed = true;
    }
    if (this.activeTag && !this.bundles.has(this.activeTag)) {
      this.log.info('this window has no active account now (its account was signed out)');
      this.activeTag = null;
      changed = true;
    }
    if (!this.activeTag && !this.everActive && reason !== 'init' && this.bundles.size > 0) {
      this.activeTag = this.resolveActive();
      this.everActive = this.activeTag !== null;
      if (this.everActive) changed = true;
    }
    if (reason !== 'poll') {
      // Reads the legacy key once it is there; never on the 5 s poll (a zombie would re-read it).
      void this.deps.store.recordLegacyUser(host).catch(() => null);
      const health = this.refreshHealth().catch(() => undefined);
      if (reason === 'init') this.initHealth = health;
    } else {
      // Review C1: the shared legacy secrets can change hands with no event (another profile):
      // the poll re-checks that one slot's health, so its folders fail closed within 5 s.
      // An account already refused is re-read too, so one whose secrets came back recovers.
      void this.refreshHealth((b) => b.ref.slot === 'legacy' || b.health === 'needs-sign-in');
      // The window's own account's team states (running / off), at most once a minute, focused.
      const a = this.active();
      if (a && a.health === 'ok' && (this.deps.windowFocused?.() ?? true)) {
        void a.service.refreshOrgsIfOlder(LISTING_STALE_MS);
      }
    }
    for (const b of added) this.addedEmitter.fire(b);
    if (reason !== 'init') for (const b of added) this.usableEmitter.fire(b);
    if (changed) this.changedEmitter.fire();
  }

  /** Decision 18's state of every account, for the Account view and URI resolution. */
  async refreshHealth(which: (b: AccountBundle) => boolean = () => true): Promise<void> {
    let changed = false;
    for (const b of [...this.bundles.values()].filter(which)) {
      const h = await this.deps.store.health(b.ref).catch(() => 'busy' as const);
      if (b.isDisposed) continue;
      // Review M1/C1: the service refuses while needs-sign-in, and drops its built client.
      b.service.setHealth(h);
      if (h !== b.health) {
        if (b.health !== 'unknown' || h !== 'ok') this.log.info(`account ${b.tag}: ${h}`);
        // Review W1: ANY return to ok (from needs-sign-in, busy, or one through the other).
        const back = b.health !== 'ok' && b.health !== 'unknown' && h === 'ok';
        b.health = h;
        if (back) this.usableEmitter.fire(b);
        changed = true;
      }
    }
    if (changed) this.changedEmitter.fire();
  }

  private build(tag: string, ref: AccountRef, account: Account): AccountBundle {
    const owner: AccountOwner = {
      rederive: () => this.rederive('error'),
      removed: (r) => this.removedHere(r),
      renewed: (r) => this.fireRenewed(r),
      changed: () => this.changedEmitter.fire(),
      signIn: (intent) => this.signIn(intent),
      showTooOld: () => this.showTooOld(),
      count: () => this.count(),
    };
    const service = new HqService(
      {
        store: this.deps.store,
        ui: this.deps.ui,
        owner,
        extensionVersion: this.deps.extensionVersion,
        appName: this.deps.appName,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
        ...(this.deps.lockDir ? { lockDir: this.deps.lockDir } : {}),
        log: this.log,
      },
      ref,
    );
    const bundle: AccountBundle = new AccountBundle(tag, service, account, () =>
      this.deps.fsHooks ? this.deps.fsHooks(bundle) : { ui: noFsUi },
    );
    return bundle;
  }

  /** Forget an account here (no request: the slot is already wiped, or another window did it). */
  private drop(tag: string): void {
    const b = this.bundles.get(tag);
    if (!b) return;
    this.bundles.delete(tag);
    this.log.info(copy`account ${tag} closed here (signed out, revoked, or another HQ address)`);
    b.dispose();
    if (this.activeTag === tag) this.activeTag = null;
    this.removedEmitter.fire(b.ref);
  }

  private removedHere(ref: AccountRef): void {
    const tag = this.tagOf(ref.host, ref.userId);
    if (!this.bundles.has(tag)) return;
    this.drop(tag);
    this.changedEmitter.fire();
  }

  /** Async, so a listener that reconnects never re-enters the client build that noticed it. */
  private fireRenewed(ref: AccountRef): void {
    this.log.info(
      `account ${this.tagOf(ref.host, ref.userId)} renewed: reconnecting what it had open`,
    );
    setTimeout(() => this.renewedEmitter.fire(ref), 0);
  }

  showTooOld(): void {
    if (this.tooOldShown) return;
    this.tooOldShown = true;
    this.deps.ui.modal(COPY.tooOld);
  }

  // ── sign-in and sign-out ───────────────────────────────────────────────────────────────────────

  /** Is a sign-in running in this window? */
  get signingIn(): boolean {
    return this.flowState.signingIn;
  }

  signIn(intent: SignInIntent): Promise<SignInResult> {
    const h: SignInHost = {
      store: this.deps.store,
      ui: this.deps.ui,
      hostVerdict: this.deps.host,
      extensionVersion: this.deps.extensionVersion,
      appName: this.deps.appName,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.lockDir ? { lockDir: this.deps.lockDir } : {}),
      ...(this.deps.signInLock ? { signInLock: this.deps.signInLock } : {}),
      ...(this.deps.hostname ? { hostname: this.deps.hostname } : {}),
      ...(this.deps.platform ? { platform: this.deps.platform } : {}),
      log: this.log,
      rederive: () => this.rederive('error'),
      known: () => this.list().map((b) => ({ ref: b.ref, account: b.account })),
      adopt: () => {
        const host = this.hostNow;
        const last = host ? this.deps.store.lastActive(host) : null;
        const pick = (last ? this.byTag(last) : null) ?? this.list()[0] ?? null;
        if (!pick) return null;
        void this.setActive(pick.ref);
        return pick.ref;
      },
      added: (ref) => {
        this.get(ref)?.service.markListed(); // its listing came with this sign-in
        return this.setActive(ref);
      },
      renewedHere: (ref) => {
        this.rederive('error');
        const b = this.get(ref);
        if (b) {
          const back = b.health !== 'ok' && b.health !== 'unknown';
          b.service.invalidate();
          b.service.setHealth('ok');
          b.service.markListed(); // the renew's approval carried the listing
          b.health = 'ok';
          if (back) this.usableEmitter.fire(b);
        }
        this.changedEmitter.fire();
      },
    };
    return runSignIn(h, this.flowState, intent, { tooOld: () => this.showTooOld() });
  }

  /**
   * Security L2: a sign-out that died between dropping the record and wiping (its marker is still
   * there) is finished: a marked slot with no record is wiped (the legacy one only when its key is
   * this profile's); a marked slot whose record is back is left alone. Markers are cleared.
   */
  private async finishInterruptedSignOuts(): Promise<void> {
    const host = this.hostNow;
    if (!host) return;
    const store = this.deps.store;
    const profileKey = store.profileKey();
    // Only markers older than a minute (a younger one is a sign-out still running in some window,
    // between dropping its record and its DELETE), and only secrets of THAT sign-out's grant (a
    // sign-in writing the same slot has a new one).
    for (const { tag, grantId } of store.staleSigningOutMarkers(host, SIGNOUT_MARKER_STALE_MS)) {
      const userId = store.tombstone(host, tag)?.userId;
      if (grantId && userId && USER_ID_RE.test(userId) && this.tagOf(host, userId) === tag) {
        const refs: AccountRef[] = [{ host, userId, slot: 'legacy', profileKey: profileKey ?? '' }];
        if (profileKey) refs.push({ host, userId, slot: 'user', profileKey });
        for (const ref of refs) {
          if (store.accountRecord(ref)) continue;
          if (!(await this.slotHoldsGrant(ref, grantId))) continue;
          await store.wipe(ref).catch(() => undefined);
          this.log.info(`account ${tag}: finished a sign-out that was interrupted`);
        }
      }
      await store.clearSigningOut(host, tag);
    }
  }

  /**
   * Are this slot's secrets the ones of `grantId` (the wipeIfStillDead rule)? A user slot by its
   * device stamp; the legacy slot only while its key is this profile's AND it was that grant's.
   */
  private async slotHoldsGrant(ref: AccountRef, grantId: string): Promise<boolean> {
    const store = this.deps.store;
    try {
      if (ref.slot === 'user') return (await store.loadDeviceKey(ref))?.grantId === grantId;
      const legacy = store.legacyUser(ref.host);
      return (
        legacy?.userId === ref.userId &&
        legacy.grantId === grantId &&
        (await store.legacyKeyIsOurs(ref))
      );
    } catch {
      return false; // the keychain could not be read: nothing is wiped
    }
  }

  /**
   * "Sign in as <email>" from a folder whose account cannot be used here (review W1, security L3):
   * an account still listed (its sign-in needs renewing, or its legacy key changed hands) is
   * RENEWED; one that is gone is signed in `as` that user. Anything but a real tag of a valid user
   * id on this host is ignored (the command can be reached from a notification link).
   */
  async signInAs(tag: string, userId: string): Promise<SignInResult> {
    const host = this.hostNow;
    if (!host || !isTag(tag) || !USER_ID_RE.test(userId) || this.tagOf(host, userId) !== tag) {
      this.log.warn('a "Sign in as" for something that is not an account here was ignored');
      return { outcome: 'ignored' };
    }
    const held = this.byTag(tag);
    return held && held.ref.userId === userId
      ? this.signIn({ kind: 'renew', ref: held.ref })
      : this.signIn({ kind: 'as', tag, expectedUserId: userId });
  }

  /**
   * Sign out of ONE account: its grant revoked in HQ, its slot wiped, its terminals, forwards and
   * sockets closed in every window. With 2 or more accounts signed in, ask once, naming the email
   * (decision 16), unless VS Code already asked (the Accounts menu).
   */
  async signOut(ref: AccountRef, opts: { confirm: boolean }): Promise<boolean> {
    const b = this.get(ref);
    if (!b) return false;
    this.log.info(`signing out of account ${b.tag}`);
    if (opts.confirm && this.count() >= 2) {
      const ok = await this.deps.ui.confirm(COPY.confirmSignOut(b.email), COPY.signOut);
      if (!ok) return false;
    }
    await b.service.signOut();
    return true;
  }

  /** Is `ref` this window's active account? */
  isActive(ref: AccountRef): boolean {
    const a = this.active();
    return a !== null && sameAccount(a.ref, ref);
  }

  dispose(): void {
    this.disposedNow = true;
    if (this.poll) clearInterval(this.poll);
    for (const s of this.subscriptions) s.dispose();
    for (const b of this.bundles.values()) b.dispose();
    this.bundles.clear();
    this.changedEmitter.dispose();
    this.removedEmitter.dispose();
    this.renewedEmitter.dispose();
    this.addedEmitter.dispose();
    this.usableEmitter.dispose();
  }
}
