/**
 * The sign-in flow (hq-vscode D1, moved out of `HqService` by hq-vscode-multi-account §Backend 4):
 * the device flow (`clientName: 'hq-vscode'`), a fresh ed25519 key made HERE for every grant, and
 * the approved USER checked BEFORE anything is stored.
 *
 *   intent     fixed at click time: `first` (no account known), `add`, `renew(ref)`, `as(tag)` (a
 *              folder whose account is not here). Only `first` may adopt an account another window
 *              added during the wait; the others never adopt (security M-7).
 *   duplicate  the browser approved someone already signed in here: the NEW grant is revoked with
 *              its own key and pair held in memory only (decision 14). Nothing is stored.
 *   mismatch   a `renew`/`as` approved as someone else: that grant is revoked too, the slot asked
 *              for is never written, and the person is told who they approved as (decision 13).
 *   renew      written under the renewed slot's REFRESH lock, so no rotation of the old family can
 *              land after the new pair. A legacy account moves to a `user` slot and the legacy slot
 *              is wiped (decision 3). The old grant is revoked best-effort, only while its access
 *              token is still fresh: a "needs renewing" refresh token is never presented.
 *
 * ONE device flow per (editor, host) at a time, across windows and versions: the sign-in lock file is
 * the 0.1.1 one, unchanged (decision 12).
 */
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  HqApiError,
  HqClient,
  REFRESH_LOCK_HEARTBEAT_MS,
  REFRESH_LOCK_STALE_MS,
  REFRESH_LOCK_WAIT_MS,
  REFRESH_MARGIN_MS,
  type FetchLike,
  type StoredTokens,
} from '@hq/client/api.js';
import {
  deviceKeyFromOpenSsh,
  generateDeviceKeyMaterial,
  publicLineOf,
  toOpenSshPrivateKey,
} from '@hq/client/device-key.js';
import { acquireFileLock } from '@hq/client/file-lock.js';
import { deviceLabelFor, runDeviceFlow, type DeviceFlowResult } from '../auth/device-flow.js';
import {
  acquireSignInLock,
  takeOverSignInLock,
  type SignInLockOptions,
  type SignInLockResult,
} from '../auth/signin-lock.js';
import { KEY_NS } from '../brand-keys.js';
import { COPY } from '../copy.js';
import { errText, silentLog, type HqLog } from '../log.js';
import {
  accountTag,
  USER_ID_RE,
  legacyLockName,
  newProfileKey,
  refreshLockName,
  type AccountRef,
} from './account-ref.js';
import { clientHeaders, defaultLockDir, type HqUi } from './hq-service.js';
import type { Account, SessionStore } from './session-store.js';
import type { HostVerdict } from './hosts.js';

export type SignInIntent =
  | { kind: 'first' }
  | { kind: 'add' }
  | { kind: 'renew'; ref: AccountRef }
  | { kind: 'as'; tag: string; expectedUserId: string };

export type SignInOutcome =
  | DeviceFlowResult['kind']
  | 'host-not-allowed'
  | 'busy'
  /** The browser approved someone already signed in here; the new grant was revoked. */
  | 'duplicate'
  /** A renew/as approved as someone else; that grant was revoked. */
  | 'mismatch'
  /** Not a request this editor acts on (`hq.signInAs` with a forged tag or user id). */
  | 'ignored';

export interface SignInResult {
  outcome: SignInOutcome;
  /** The account now signed in (added, renewed or adopted). */
  ref?: AccountRef;
}

/** The registry's side of a sign-in. */
export interface SignInHost {
  store: SessionStore;
  ui: HqUi;
  hostVerdict(): HostVerdict;
  extensionVersion: string;
  appName: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  signInLock?: Omit<SignInLockOptions, 'onCancelRequested' | 'intent'>;
  hostname?: () => string;
  log?: HqLog;
  platform?: string;
  /** Re-read the account list now (another window may have added one, or minted the profile key). */
  rederive(): void;
  /** The accounts on the host right now (after `rederive`). */
  known(): Array<{ ref: AccountRef; account: Account }>;
  /** `first` found an account another window added: make one active here. */
  adopt(): AccountRef | null;
  /** A new account was written here: make it this window's active one. */
  added(ref: AccountRef): Promise<void>;
  /** An account's slot was renewed (or moved) here. */
  renewedHere(ref: AccountRef): void;
}

/** One window's flow in progress: its code (once known) and how to cancel it. */
export interface FlowState {
  signingIn: boolean;
  /**
   * `shown`: every notice of the code on screen (the first, and each "show it again"): all of them
   * close when the flow ends, approved, cancelled or failed (live test 2026-10-02).
   */
  flow: { code: string | null; cancel: () => void; shown: Array<{ close(): void }> } | null;
}

function lockDirOf(h: SignInHost): string {
  return h.lockDir ?? defaultLockDir();
}

function isFresh(t: StoredTokens, now: number): boolean {
  return !t.needsRenewing && Date.parse(t.accessExpiresAt) - now > REFRESH_MARGIN_MS;
}

/**
 * Revoke a grant with a key and pair held IN MEMORY only (decision 14): an ephemeral client whose
 * token store is a variable and whose refresh lock is a throwaway name. One retry.
 */
export async function revokeGrantInMemory(
  h: SignInHost,
  host: string,
  g: { openssh: string; tokens: StoredTokens; grantId: string },
): Promise<boolean> {
  let held: StoredTokens | null = g.tokens;
  const client = new HqClient({
    host,
    key: deviceKeyFromOpenSsh(g.openssh).privateKey,
    store: {
      load: () => held,
      save: (_h, t) => {
        held = t;
      },
    },
    lockDir: lockDirOf(h),
    lockName: `ephemeral-${randomBytes(6).toString('hex')}.lock`,
    clientHeaders: clientHeaders(h.extensionVersion),
    ...(h.fetch ? { fetch: h.fetch } : {}),
    ...(h.now ? { now: h.now } : {}),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await client.request('DELETE', `/api/remote/grants/${encodeURIComponent(g.grantId)}`, {
        signed: true,
      });
      return true;
    } catch (err) {
      if (err instanceof HqApiError && err.status === 404) return true;
    }
  }
  return false;
}

function reportFailure(h: SignInHost, result: DeviceFlowResult, tooOld: () => void): void {
  switch (result.kind) {
    case 'denied':
      h.ui.modal(COPY.signInDenied);
      return;
    case 'wrong-host':
      h.ui.modal(COPY.signInWrongHost(result.host));
      return;
    case 'expired':
      h.ui.modal(COPY.signInExpired);
      return;
    case 'expired-after-network':
      h.ui.modal(COPY.signInExpiredAfterNetwork);
      return;
    case 'unavailable':
      h.ui.modal(COPY.signInUnavailable);
      return;
    case 'throttled':
      h.ui.modal(COPY.signInThrottled);
      return;
    case 'too-old':
      tooOld();
      return;
    case 'failed':
      h.ui.modal(COPY.signInFailed(result.detail));
      return;
    default:
      return;
  }
}

/** "HQ: Sign In" and its intents. A click never does nothing: it starts, re-shows or explains a flow. */
export async function runSignIn(
  h: SignInHost,
  state: FlowState,
  intent: SignInIntent,
  opts: { takeOver?: boolean; tooOld: () => void },
): Promise<SignInResult> {
  const log = h.log ?? silentLog;
  log.info(
    `sign-in (${intent.kind}) started${opts.takeOver ? ', taking over another window' : ''}`,
  );
  const result = await signInFlow(h, state, intent, opts);
  const who = result.ref ? ` as account ${accountTag(result.ref.host, result.ref.userId)}` : '';
  log.info(`sign-in (${intent.kind}): ${result.outcome}${who}`);
  return result;
}

async function signInFlow(
  h: SignInHost,
  state: FlowState,
  intent: SignInIntent,
  opts: { takeOver?: boolean; tooOld: () => void },
): Promise<SignInResult> {
  const verdict = h.hostVerdict();
  if (!verdict.ok) {
    // A brand with no default address: until one is set, say how to set it.
    h.ui.modal(verdict.unset ? COPY.hostUnset : COPY.hostNotAllowed(verdict.host));
    return { outcome: 'host-not-allowed' };
  }
  if (state.signingIn) {
    // This window is already signing in: show its code again (the first notice may be hidden).
    const flow = state.flow;
    if (flow?.code) flow.shown.push(h.ui.showDeviceCode(flow.code, flow.cancel));
    else h.ui.info(COPY.signInInProgress);
    return { outcome: 'busy' };
  }
  state.signingIn = true;
  const host = verdict.host;
  let cancelled = false;
  let wake: () => void = () => undefined;
  const woken = new Promise<void>((r) => (wake = r));
  const cancel = (): void => {
    cancelled = true;
    wake();
  };
  let movedAway = false;
  const lockOpts: SignInLockOptions = {
    ...h.signInLock,
    intent: intent.kind,
    onCancelRequested: () => {
      movedAway = true;
      cancel();
    },
  };
  let acquired: SignInLockResult;
  try {
    mkdirSync(lockDirOf(h), { recursive: true, mode: 0o700 });
    const file = path.join(lockDirOf(h), legacyLockName('signin', h.appName, host));
    acquired = opts.takeOver
      ? await takeOverSignInLock(file, lockOpts)
      : acquireSignInLock(file, lockOpts);
  } catch (err) {
    state.signingIn = false;
    (h.log ?? silentLog).error(`sign-in (${intent.kind}) failed: ${errText(err)}`);
    h.ui.modal(COPY.signInFailed(err instanceof Error ? err.message : COPY.unreachable));
    return { outcome: 'failed' };
  }
  if (acquired.kind === 'busy') {
    state.signingIn = false;
    void h.ui.offerSignInHere(COPY.signInOtherWindow).then((here) => {
      if (here) void runSignIn(h, state, intent, { ...opts, takeOver: true });
    });
    return { outcome: 'busy' };
  }
  const release = () => acquired.lock.release();
  try {
    // Decision 22: this profile's key is minted under the lock, after a re-read, so two windows of a
    // fresh profile can never mint two.
    const profileKey = await h.store.ensureProfileKey(newProfileKey);
    h.rederive();
    // Another window finished a sign-in while this one waited: `first` adopts it (never a second
    // grant); `add`, `renew` and `as` never adopt (security M-7).
    if (intent.kind === 'first' && h.known().length > 0) {
      const ref = h.adopt();
      return { outcome: 'approved', ...(ref ? { ref } : {}) };
    }
    state.flow = { code: null, cancel, shown: [] };
    const sleep = h.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // A fresh key for every sign-in: a new grant never reuses an old grant's key.
    const { seed32, pub32 } = generateDeviceKeyMaterial();
    const hostname = (h.hostname ?? (() => os.hostname().split('.')[0] ?? ''))();
    const openssh = toOpenSshPrivateKey(
      seed32,
      pub32,
      `${KEY_NS}-vscode@${hostname || 'computer'}`,
    );
    const result = await runDeviceFlow(
      {
        fetch: h.fetch ?? globalThis.fetch,
        host,
        clientHeaders: clientHeaders(h.extensionVersion),
        now: h.now ?? Date.now,
        // A cancel (this window's Cancel, or another window signing in instead) ends the wait.
        sleep: (ms) => Promise.race([sleep(ms), woken]),
        cancelled: () => cancelled,
        onCode: async (code, pageUrl) => {
          if (state.flow) state.flow.code = code;
          // A clipboard that cannot be written (a headless or locked-down desktop) must not end
          // the sign-in: the code is on screen either way.
          await Promise.resolve(h.ui.copyToClipboard(code)).catch(() => undefined);
          state.flow?.shown.push(h.ui.showDeviceCode(code, cancel));
          // Never awaited: an open-website prompt left unanswered must not stall the flow (and
          // hold the sign-in lock) before its first poll.
          void h.ui.openExternal(pageUrl).then(undefined, () => undefined);
        },
      },
      {
        clientVersion: h.extensionVersion,
        platform: `${h.platform ?? process.platform}-${process.arch}`,
        deviceLabel: deviceLabelFor(h.appName, hostname),
        devicePubkey: publicLineOf(pub32),
      },
    );
    if (result.kind !== 'approved') {
      if (movedAway) h.ui.info(COPY.signInMovedToOtherWindow);
      else reportFailure(h, result, opts.tooOld);
      // Either way the code is gone; the message says which.
      return { outcome: result.kind === 'expired-after-network' ? 'expired' : result.kind };
    }
    // Held in memory until the approved user is checked: nothing is stored before.
    const a = result.approved;
    const fresh = {
      openssh,
      grantId: a.grantId,
      tokens: {
        accessToken: a.accessToken,
        accessExpiresAt: a.accessExpiresAt,
        refreshToken: a.refreshToken,
      } satisfies StoredTokens,
    };
    const revokeNew = async (): Promise<void> => {
      if (!(await revokeGrantInMemory(h, host, fresh))) h.ui.modal(COPY.revokeNewFailed);
    };
    // Security L4: a user id that cannot name a slot is never stored (nor used in a key).
    if (!USER_ID_RE.test(a.user.id)) {
      await revokeNew();
      h.ui.modal(COPY.signInFailed(COPY.signInUnstorableUser));
      return { outcome: 'failed' };
    }
    h.rederive();
    const known = h.known();
    const held = known.find((k) => k.ref.userId === a.user.id);
    const userRef: AccountRef = { host, userId: a.user.id, slot: 'user', profileKey };

    if (intent.kind === 'renew' || intent.kind === 'as') {
      const expectedId = intent.kind === 'renew' ? intent.ref.userId : intent.expectedUserId;
      if (a.user.id !== expectedId) {
        await revokeNew();
        const expected =
          known.find((k) => k.ref.userId === expectedId)?.account.user.email ??
          h.store.tombstone(host, accountTag(host, expectedId))?.email;
        // I2: never a raw user id in a sentence.
        h.ui.modal(
          expected
            ? COPY.renewMismatch(expected, a.user.email)
            : COPY.renewMismatchUnknown(a.user.email),
        );
        return { outcome: 'mismatch' };
      }
    }

    if (intent.kind === 'renew') {
      const from = held?.ref ?? intent.ref;
      const to: AccountRef = from.slot === 'user' ? from : userRef;
      if (from.slot === 'legacy') {
        const free = await slotIsFree(h, to);
        if (free !== 'free') {
          await revokeNew();
          h.ui.modal(free === 'busy' ? COPY.keychainBusy(a.user.email) : COPY.slotInUse);
          return { outcome: 'failed' };
        }
      }
      // M2: the shared legacy secrets may be another profile's sign-in: never read or revoke them.
      const old = (await h.store.legacyKeyIsOurs(from)) ? await readOldGrant(h, from) : null;
      // The renewed slot's own refresh lock (the same one `HqClient` rotates under).
      const unlock = await acquireFileLock(
        path.join(lockDirOf(h), refreshLockName(h.appName, from)),
        {
          staleMs: REFRESH_LOCK_STALE_MS,
          waitMs: REFRESH_LOCK_WAIT_MS,
          heartbeatMs: REFRESH_LOCK_HEARTBEAT_MS,
        },
      );
      try {
        await h.store.writeUserSlot(to, { ...fresh, orgs: a.orgs, user: a.user });
        if (from.slot === 'legacy') {
          await h.store.carryPortLists(from, to);
          await h.store.wipe(from);
        }
      } finally {
        unlock();
      }
      if (old && isFresh(old.tokens, (h.now ?? Date.now)())) {
        void revokeGrantInMemory(h, host, old).catch(() => false);
      }
      h.renewedHere(to);
      h.ui.info(COPY.signedIn(a.user.email));
      return { outcome: 'approved', ref: to };
    }

    // first / add / as: a NEW account, unless it is one already signed in here.
    if (held) {
      await revokeNew();
      h.ui.modal(COPY.accountAlreadySignedIn(a.user.email));
      return { outcome: 'duplicate' };
    }
    const free = await slotIsFree(h, userRef);
    if (free !== 'free') {
      await revokeNew();
      h.ui.modal(free === 'busy' ? COPY.keychainBusy(a.user.email) : COPY.slotInUse);
      return { outcome: 'failed' };
    }
    await h.store.writeUserSlot(userRef, { ...fresh, orgs: a.orgs, user: a.user });
    h.rederive();
    await h.added(userRef);
    h.ui.info(
      intent.kind === 'first' && known.length === 0
        ? COPY.signedIn(a.user.email)
        : COPY.addedAccount(a.user.email),
    );
    return { outcome: 'approved', ref: userRef };
  } catch (err) {
    (h.log ?? silentLog).error(`sign-in (${intent.kind}) failed: ${errText(err)}`);
    h.ui.modal(COPY.signInFailed(err instanceof Error ? err.message : COPY.unreachable));
    return { outcome: 'failed' };
  } finally {
    for (const notice of state.flow?.shown ?? []) notice.close();
    release();
    state.flow = null;
    state.signingIn = false;
  }
}

/**
 * The last guard of decision 22 (MA-S26): a `user` slot's device secret that exists with no
 * `account` record in this profile belongs to someone else's state (a profile-key collision).
 */
async function slotIsFree(h: SignInHost, ref: AccountRef): Promise<'free' | 'taken' | 'busy'> {
  if (h.store.accountRecord(ref)) return 'free';
  try {
    return (await h.store.loadDeviceKey(ref)) === null ? 'free' : 'taken';
  } catch {
    // Security L1: a keychain that cannot be read is not "free": never overwrite blind.
    return 'busy';
  }
}

/** The grant a renew replaces, for its best-effort revocation. Read before anything is written. */
async function readOldGrant(
  h: SignInHost,
  ref: AccountRef,
): Promise<{ openssh: string; tokens: StoredTokens; grantId: string } | null> {
  try {
    const record = h.store.accountRecord(ref);
    const device = await h.store.loadDeviceKey(ref);
    const tokens = await h.store.loadStamped(ref, true);
    if (!record || !device || !tokens) return null;
    return { openssh: device.openssh, tokens, grantId: record.grantId };
  } catch {
    return null;
  }
}
