/**
 * The extension's one connection to HQ: who is signed in, the shared `HqClient` (hq-vscode decision
 * 4) built over SecretStorage, the org/team listing, and what every HQ answer means for the person.
 *
 *   sign in    the device flow (`clientName: 'hq-vscode'`), a fresh ed25519 key made HERE, both the
 *              key and the token pair in SecretStorage only (D1).
 *   sign out   the grant is revoked server-side (device-signed `DELETE /api/remote/grants/:id`), then
 *              every secret and cache of this host is wiped.
 *   refresh    shared `HqClient`: one refresh per window, a cross-window lock under `~/.hq/vscode`
 *              (profile-independent, §7c), and on `409 REFRESH_RACE` up to 10 re-reads 500 ms apart.
 *              A refresh that cannot finish is NEVER retried by presenting the used token: the
 *              person is asked to sign in again ("Your HQ sign-in needs renewing").
 *              A presentation that went unanswered is re-presented once within 30 s (§7c 2b); past
 *              that the pair is marked "needs renewing" and never presented again.
 *   401        only when HQ CONFIRMS it (an unsigned `GET /api/remote/orgs` also answers 401,
 *              security review B1: a signed call's 401 can be a nonce that died while the editor
 *              sat idle) is the grant gone: everything is wiped, terminals and forwards close
 *              (`onRevoked`), and one modal says so. Unconfirmed, nothing is wiped.
 *   426        this version is below `KR_REMOTE_MIN_VSCODE_VERSION`: one modal, once.
 *
 * Every request carries `X-HQ-Client: vscode/<version>` (decision 22) and asks for its next nonce
 * (`X-HQ-Want-Nonce`, decision 24). Nothing here logs a token, a nonce, a code or a signature.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
import {
  deviceKeyFromOpenSsh,
  generateDeviceKeyMaterial,
  publicLineOf,
  toOpenSshPrivateKey,
} from '@hq/client/device-key.js';
import { partitionTeams, type Team } from '@hq/client/teams.js';
import { deviceLabelFor, runDeviceFlow, type DeviceFlowResult } from '../auth/device-flow.js';
import {
  acquireSignInLock,
  takeOverSignInLock,
  type SignInLockOptions,
  type SignInLockResult,
} from '../auth/signin-lock.js';
import { COPY } from '../copy.js';
import { Emitter } from '../util/emitter.js';
import { type Account, type SessionStore } from './session-store.js';

/** The refresh fetch is abandoned after this long (§7c step 2). */
export const REFRESH_TIMEOUT_MS = 10_000;
/** `409 REFRESH_RACE`: this many re-reads of SecretStorage, this far apart (§7c step 4). */
export const RACE_REREADS = 10;
export const RACE_REREAD_MS = 500;

/** What the service needs from the editor. The extension passes VS Code's; tests pass a fake. */
export interface HqUi {
  /** Show the code (and a Cancel). The returned `close` hides it again. */
  showDeviceCode(code: string, onCancel: () => void): { close(): void };
  openExternal(url: string): Promise<unknown>;
  copyToClipboard(text: string): Promise<unknown>;
  info(message: string): void;
  /** A notification with a Sign in action; resolves true when it was chosen. */
  askToSignIn(message: string, modal: boolean): Promise<boolean>;
  modal(message: string): void;
  /** Another window is signing in: offer "Sign in here instead"; resolves true when it was chosen. */
  offerSignInHere(message: string): Promise<boolean>;
}

export interface HqServiceDeps {
  store: SessionStore;
  ui: HqUi;
  /** `hq.host`, already checked against the allow-list (decision 26). */
  host: () => { ok: true; host: string } | { ok: false; host: string };
  extensionVersion: string;
  /** `vscode.env.appName` (Visual Studio Code, Cursor, VSCodium, ...): the device label and the lock name. */
  appName: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where the cross-window refresh and sign-in locks live. Default `~/.hq/vscode`. */
  lockDir?: string;
  /** Test seam: the sign-in lock's TTL, heartbeat and take-over wait (defaults in signin-lock.ts). */
  signInLock?: Omit<SignInLockOptions, 'onCancelRequested'>;
  hostname?: () => string;
  platform?: string;
}

export type SignInOutcome = DeviceFlowResult['kind'] | 'host-not-allowed' | 'busy';

export class HqService {
  private readonly changed = new Emitter<void>();
  private readonly revokedEmitter = new Emitter<void>();
  /** Signed in / out, or the team listing changed. */
  readonly onDidChange = this.changed.event;
  /** The grant ended: close every terminal and forward, forget every cache. */
  readonly onRevoked = this.revokedEmitter.event;

  private clientCache: { host: string; client: HqClient } | null = null;
  private signingIn = false;
  /** The flow running in THIS window: its code (once known) and how to cancel it. */
  private flow: { code: string | null; cancel: () => void } | null = null;
  private tooOldShown = false;
  private revokedShown = false;

  constructor(private readonly deps: HqServiceDeps) {}

  /** The allowed host, or null (a host outside the allow-list is never contacted). */
  host(): string | null {
    const v = this.deps.host();
    return v.ok ? v.host : null;
  }

  account(): Account | null {
    const host = this.host();
    return host ? this.deps.store.account(host) : null;
  }

  signedIn(): boolean {
    return this.account() !== null;
  }

  clientHeaders(): Record<string, string> {
    return {
      [HQ_HEADER_CLIENT]: `vscode/${this.deps.extensionVersion}`,
      [HQ_HEADER_WANT_NONCE]: '1',
    };
  }

  /** The signed-in client for the current host, or null when signed out. */
  private lockDir(): string {
    return this.deps.lockDir ?? path.join(os.homedir(), '.hq', 'vscode');
  }

  /** One lock file per (editor, host) and purpose, shared by every window of this editor. */
  private lockName(purpose: 'refresh' | 'signin', host: string): string {
    return `${purpose}-${createHash('sha256')
      .update(`${this.deps.appName}|${host}`)
      .digest('hex')
      .slice(0, 12)}.lock`;
  }

  async client(): Promise<HqClient | null> {
    const host = this.host();
    if (!host || !this.deps.store.account(host)) return null;
    if (this.clientCache?.host === host) return this.clientCache.client;
    const pem = await this.deps.store.loadDeviceKey(host);
    if (!pem) return null;
    const key = deviceKeyFromOpenSsh(pem);
    const client = new HqClient({
      host,
      key: key.privateKey,
      store: this.deps.store.tokenStore(),
      lockDir: this.lockDir(),
      lockName: this.lockName('refresh', host),
      clientHeaders: this.clientHeaders(),
      refreshTimeoutMs: REFRESH_TIMEOUT_MS,
      raceRereads: RACE_REREADS,
      raceRereadMs: RACE_REREAD_MS,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    this.clientCache = { host, client };
    return client;
  }

  /** The teams this sign-in can reach, from the last listing (no request). */
  teams(): Team[] {
    const host = this.host();
    if (!host) return [];
    return partitionTeams(this.deps.store.cachedOrgs(host)).teams.filter(
      (t) => t.org.remoteAccess.allowed,
    );
  }

  orgs(): RemoteOrg[] {
    const host = this.host();
    return host ? this.deps.store.cachedOrgs(host) : [];
  }

  /** `GET /api/remote/orgs`, cached in globalState (no secret). */
  async refreshOrgs(): Promise<RemoteOrg[]> {
    const host = this.host();
    const orgs = await this.call(
      async (c) => (await c.request<RemoteOrg[]>('GET', '/api/remote/orgs')).body,
    );
    if (host) await this.deps.store.saveOrgs(host, orgs);
    this.changed.fire();
    return orgs;
  }

  /**
   * Run one HQ call, turning the answers that change the sign-in into what the person sees. The
   * error is rethrown for the caller's own message, except where this already said everything.
   */
  async call<T>(fn: (client: HqClient) => Promise<T>): Promise<T> {
    const client = await this.client();
    if (!client) throw new NotLoggedInError(COPY.signedOutWelcome);
    try {
      return await fn(client);
    } catch (err) {
      await this.handleError(err);
      throw err;
    }
  }

  /** What an error means for the sign-in (see the header). */
  async handleError(err: unknown): Promise<void> {
    if (err instanceof RefreshBusyError || err instanceof RefreshNeedsRenewingError) {
      void this.askToSignIn(COPY.renewSignIn, false);
      return;
    }
    if (err instanceof HqApiError) {
      if (err.code === 'REFRESH_RACE') {
        void this.askToSignIn(COPY.renewSignIn, false);
        return;
      }
      if (err.status === 401) {
        if (await this.revocationConfirmed()) await this.revoked();
        return;
      }
      if (err.status === 426) {
        this.showTooOld();
      }
      return;
    }
    if (err instanceof NotLoggedInError) {
      const host = this.host();
      if (host && this.deps.store.account(host)) await this.revoked();
    }
  }

  /** B1: is the login really gone? Only HQ's unsigned answer says so (`confirmRevoked`). */
  private async revocationConfirmed(): Promise<boolean> {
    const client = await this.client().catch(() => null);
    return client === null ? true : client.confirmRevoked();
  }

  showTooOld(): void {
    if (this.tooOldShown) return;
    this.tooOldShown = true;
    this.deps.ui.modal(COPY.tooOld);
  }

  /** The grant is gone: wipe, close everything, say so once. */
  async revoked(): Promise<void> {
    const host = this.host();
    if (host) await this.deps.store.wipe(host);
    this.clientCache = null;
    this.revokedEmitter.fire();
    this.changed.fire();
    if (this.revokedShown) return;
    this.revokedShown = true;
    const again = await this.deps.ui.askToSignIn(COPY.revoked, true);
    this.revokedShown = false;
    if (again) void this.signIn();
  }

  private async askToSignIn(message: string, modal: boolean): Promise<void> {
    if (await this.deps.ui.askToSignIn(message, modal)) void this.signIn();
  }

  /** "HQ: Sign In" (D1). A click never does nothing: it starts, re-shows or explains a flow. */
  async signIn(opts: { takeOver?: boolean } = {}): Promise<SignInOutcome> {
    const verdict = this.deps.host();
    if (!verdict.ok) {
      this.deps.ui.modal(COPY.hostNotAllowed(verdict.host));
      return 'host-not-allowed';
    }
    if (this.signingIn) {
      // This window is already signing in: show its code again (the first notice may be hidden).
      const flow = this.flow;
      if (flow?.code) this.deps.ui.showDeviceCode(flow.code, flow.cancel);
      else this.deps.ui.info(COPY.signInInProgress);
      return 'busy';
    }
    this.signingIn = true;
    const host = verdict.host;
    // ONE device flow per editor at a time, across windows (nonprod 2026-09-30: several windows
    // at a relaunch each ran one, and one sign-in made two grants). The lock is held for the whole
    // flow and never past the device code's life (signin-lock.ts); a window that finds it held by a
    // live flow offers "Sign in here instead".
    let cancelled = false;
    let wake: () => void = () => undefined;
    const woken = new Promise<void>((r) => (wake = r));
    const cancel = (): void => {
      cancelled = true;
      wake();
    };
    let movedAway = false;
    const lockOpts: SignInLockOptions = {
      ...this.deps.signInLock,
      onCancelRequested: () => {
        movedAway = true;
        cancel();
      },
    };
    let acquired: SignInLockResult;
    try {
      mkdirSync(this.lockDir(), { recursive: true, mode: 0o700 });
      const file = path.join(this.lockDir(), this.lockName('signin', host));
      acquired = opts.takeOver
        ? await takeOverSignInLock(file, lockOpts)
        : acquireSignInLock(file, lockOpts);
    } catch (err) {
      this.signingIn = false;
      this.deps.ui.modal(COPY.signInFailed(err instanceof Error ? err.message : COPY.unreachable));
      return 'failed';
    }
    if (acquired.kind === 'busy') {
      this.signingIn = false;
      void this.deps.ui.offerSignInHere(COPY.signInOtherWindow).then((here) => {
        if (here) void this.signIn({ takeOver: true });
      });
      return 'busy';
    }
    const release = () => acquired.lock.release();
    // Another window finished a sign-in while this one waited: adopt it, never make a second grant.
    if (this.deps.store.account(host) && (await this.deps.store.loadDeviceKey(host))) {
      release();
      this.signingIn = false;
      this.clientCache = null;
      this.changed.fire();
      return 'approved';
    }
    let shown: { close(): void } | null = null;
    this.flow = { code: null, cancel };
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      // A fresh key for every sign-in: a new grant never reuses an old grant's key.
      const { seed32, pub32 } = generateDeviceKeyMaterial();
      const hostname = (this.deps.hostname ?? (() => os.hostname().split('.')[0] ?? ''))();
      const pem = toOpenSshPrivateKey(seed32, pub32, `hq-vscode@${hostname || 'computer'}`);
      const result = await runDeviceFlow(
        {
          fetch: this.deps.fetch ?? globalThis.fetch,
          host,
          clientHeaders: this.clientHeaders(),
          now: this.deps.now ?? Date.now,
          // A cancel (this window's Cancel, or another window signing in instead) ends the wait.
          sleep: (ms) => Promise.race([sleep(ms), woken]),
          cancelled: () => cancelled,
          onCode: async (code, pageUrl) => {
            if (this.flow) this.flow.code = code;
            await this.deps.ui.copyToClipboard(code);
            shown = this.deps.ui.showDeviceCode(code, cancel);
            // Never awaited: an open-website prompt left unanswered must not stall the flow (and
            // hold the sign-in lock) before its first poll.
            void this.deps.ui.openExternal(pageUrl).then(undefined, () => undefined);
          },
        },
        {
          clientVersion: this.deps.extensionVersion,
          platform: `${this.deps.platform ?? process.platform}-${process.arch}`,
          deviceLabel: deviceLabelFor(this.deps.appName, hostname),
          devicePubkey: publicLineOf(pub32),
        },
      );
      if (result.kind !== 'approved') {
        if (movedAway) this.deps.ui.info(COPY.signInMovedToOtherWindow);
        else this.reportSignInFailure(result);
        return result.kind;
      }
      const a = result.approved;
      // The key first, then the pair, then the account: an account is only ever recorded once
      // everything it needs is stored.
      await this.deps.store.saveDeviceKey(host, pem);
      await this.deps.store.saveTokens(host, {
        accessToken: a.accessToken,
        accessExpiresAt: a.accessExpiresAt,
        refreshToken: a.refreshToken,
      });
      await this.deps.store.saveOrgs(host, a.orgs);
      await this.deps.store.saveAccount(host, { grantId: a.grantId, user: a.user });
      this.clientCache = null;
      this.changed.fire();
      this.deps.ui.info(COPY.signedIn(a.user.email));
      return 'approved';
    } catch (err) {
      this.deps.ui.modal(COPY.signInFailed(err instanceof Error ? err.message : COPY.unreachable));
      return 'failed';
    } finally {
      (shown as { close(): void } | null)?.close();
      release();
      this.flow = null;
      this.signingIn = false;
    }
  }

  private reportSignInFailure(result: DeviceFlowResult): void {
    switch (result.kind) {
      case 'denied':
        this.deps.ui.modal(COPY.signInDenied);
        return;
      case 'expired':
        this.deps.ui.modal(COPY.signInExpired);
        return;
      case 'unavailable':
        this.deps.ui.modal(COPY.signInUnavailable);
        return;
      case 'too-old':
        this.showTooOld();
        return;
      case 'failed':
        this.deps.ui.modal(COPY.signInFailed(result.detail));
        return;
      default:
        return;
    }
  }

  /** "HQ: Sign Out": revoke THIS grant in HQ, then forget it here. */
  async signOut(): Promise<void> {
    const host = this.host();
    if (!host) return;
    const account = this.deps.store.account(host);
    let reached = true;
    if (account) {
      try {
        const client = await this.client();
        await client?.request('DELETE', `/api/remote/grants/${account.grantId}`, { signed: true });
      } catch (err) {
        // A grant that is already dead means HQ already forgot this computer: fine. A 401 counts
        // only when HQ confirms it (B1): otherwise the grant may still be live, and the person is
        // told to remove this computer in HQ rather than told it is done.
        reached =
          err instanceof HqApiError &&
          (err.status === 404 || (err.status === 401 && (await this.revocationConfirmed())));
      }
    }
    await this.deps.store.wipe(host);
    this.clientCache = null;
    this.revokedEmitter.fire();
    this.changed.fire();
    this.deps.ui.info(reached ? COPY.signedOut : COPY.signOutOffline);
  }

  /** The host setting changed: a different host needs its own sign-in (decision 26). */
  hostChanged(): void {
    this.clientCache = null;
    this.revokedEmitter.fire();
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
    this.revokedEmitter.dispose();
  }
}
