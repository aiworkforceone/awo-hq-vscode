/**
 * The cross-window SIGN-IN lock: one device flow per editor at a time (nonprod 2026-09-30, several
 * windows at a relaunch each ran one and one sign-in made two grants). A file under `~/.hq/vscode`,
 * created with O_EXCL and carrying a record: the owner's random token, its pid, and an expiry.
 *
 * ⛔ A LOCK NEVER OUTLIVES ITS SIGN-IN (0.1.1: "Signing in from another VS Code window" and nothing
 *    else, for good). The 0.1.0 lock was kept fresh by a heartbeat for as long as its window lived,
 *    so a flow stuck in that window (an open-website prompt never answered) held it forever. Now
 *    a lock is stale, and taken over, when ANY of these holds:
 *      - its owner's process is gone (the pid in the file no longer runs: a closed or crashed window);
 *      - its heartbeat stopped (mtime older than `staleMs`);
 *      - it is past its expiry, the device code's own life plus a minute, heartbeat or not.
 * ⛔ A LIVE HOLDER IS ASKED, NOT BROKEN. "Sign in here instead" writes a cancel request next to the
 *    lock naming the holder's token; the holder's heartbeat sees it and ends its flow. Only a holder
 *    that does not answer within `takeoverWaitMs` (a 0.1.0 window, or one that hangs) is moved aside.
 * ⛔ A LOCK IS MOVED ASIDE, NEVER DELETED IN PLACE (as `@hq/client/file-lock`): `rename` is atomic, so
 *    only one waiter moves a given file; the mover checks what it moved and puts back (`link`, never
 *    overwriting) a lock that turns out not to be the one it meant to break.
 *
 * The record also names the sign-in's INTENT kind (`first`, `add`, `renew`, `as`; hq-vscode-multi-account
 * decision 12): never an email or a user id. 0.1.1's `parse` reads only `pid`/`expiresAt`, so the
 * extra field is safe for an older window sharing the file.
 *
 * Real time, not an injected clock: file mtimes are wall-clock.
 */
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { REMOTE_DEVICE_CODE_TTL_SEC } from '@kpa/shared/remote.types';

/** The device code's life plus a minute: no sign-in outlives it, so neither does its lock. */
export const SIGNIN_LOCK_TTL_MS = (REMOTE_DEVICE_CODE_TTL_SEC + 60) * 1000;
export const SIGNIN_LOCK_STALE_MS = 30_000;
export const SIGNIN_LOCK_HEARTBEAT_MS = 5_000;
/** "Sign in here instead": how long the holder has to end its flow before its lock is moved aside. */
export const SIGNIN_TAKEOVER_WAIT_MS = 20_000;

export interface SignInLockOptions {
  ttlMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  takeoverWaitMs?: number;
  /** Another window chose "Sign in here instead": end this window's flow. Called at most once. */
  onCancelRequested?: () => void;
  /** What this sign-in is for, recorded in the lock (a kind only). */
  intent?: 'first' | 'add' | 'renew' | 'as';
}

export interface SignInLock {
  release(): void;
}

export type SignInLockResult = { kind: 'acquired'; lock: SignInLock } | { kind: 'busy' };

interface Held {
  raw: string;
  /** Why the lock may be broken, or null while its holder is alive and inside its expiry. */
  stale: 'owner-gone' | 'no-heartbeat' | 'expired' | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid and expiry in a lock file: this version's JSON record, or 0.1.0's `<pid>:<token>`. */
function parse(raw: string): { pid: number | null; expiresAt: number | null } {
  try {
    const r = JSON.parse(raw) as { pid?: unknown; expiresAt?: unknown };
    return {
      pid: typeof r.pid === 'number' && r.pid > 0 ? r.pid : null,
      expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null,
    };
  } catch {
    const legacy = /^(\d+):[0-9a-f]+$/.exec(raw.trim());
    const pid = legacy ? Number(legacy[1]) : 0;
    return { pid: pid > 0 ? pid : null, expiresAt: null };
  }
}

/** What is at `file` now; null when there is no lock. */
function inspect(file: string, staleMs: number): Held | null {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { pid, expiresAt } = parse(raw);
  const now = Date.now();
  // An empty file is a holder between its create and its write: alive while its mtime is fresh.
  if (pid !== null && !pidAlive(pid)) return { raw, stale: 'owner-gone' };
  if (now - mtimeMs > staleMs) return { raw, stale: 'no-heartbeat' };
  if (expiresAt !== null && now > expiresAt) return { raw, stale: 'expired' };
  return { raw, stale: null };
}

/** Move the lock aside; remove it only if `shouldBreak(what was moved)`, else put it back. */
function breakIf(file: string, aside: string, shouldBreak: (aside: string) => boolean): void {
  try {
    renameSync(file, aside);
  } catch {
    return; // someone else moved or released it first
  }
  try {
    if (!shouldBreak(aside)) {
      try {
        linkSync(aside, file);
      } catch {
        /* a newer lock is already there: the one we moved lost anyway */
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

const cancelFileOf = (file: string) => `${file}.cancel`;

function tryCreate(file: string, opts: SignInLockOptions): SignInLock | null {
  const raw = JSON.stringify({
    owner: randomBytes(8).toString('hex'),
    pid: process.pid,
    expiresAt: Date.now() + (opts.ttlMs ?? SIGNIN_LOCK_TTL_MS),
    ...(opts.intent ? { intent: opts.intent } : {}),
  });
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  try {
    writeSync(fd, raw);
  } finally {
    closeSync(fd);
  }
  let cancelAsked = false;
  const beat = setInterval(() => {
    try {
      if (readFileSync(file, 'utf8') !== raw) return; // taken over: nothing of ours to keep fresh
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      return;
    }
    try {
      if (readFileSync(cancelFileOf(file), 'utf8') !== raw || cancelAsked) return;
      cancelAsked = true;
      rmSync(cancelFileOf(file), { force: true });
      opts.onCancelRequested?.();
    } catch {
      /* no cancel request */
    }
  }, opts.heartbeatMs ?? SIGNIN_LOCK_HEARTBEAT_MS);
  beat.unref?.();
  return {
    release: () => {
      clearInterval(beat);
      try {
        if (readFileSync(file, 'utf8') === raw) rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

/** Take the lock now, breaking a stale one; `busy` while a live holder is inside its expiry. */
export function acquireSignInLock(file: string, opts: SignInLockOptions = {}): SignInLockResult {
  const staleMs = opts.staleMs ?? SIGNIN_LOCK_STALE_MS;
  for (let attempt = 0; attempt < 5; attempt++) {
    const lock = tryCreate(file, opts);
    if (lock) return { kind: 'acquired', lock };
    const held = inspect(file, staleMs);
    if (!held) continue; // released between our open and our read
    if (held.stale === null) return { kind: 'busy' };
    breakIf(file, `${file}.stale-${randomBytes(4).toString('hex')}`, (aside) => {
      const moved = inspect(aside, staleMs);
      return moved !== null && moved.stale !== null;
    });
  }
  return { kind: 'busy' };
}

/**
 * "Sign in here instead": ask the holder to end its flow, wait for it to let go, and move its lock
 * aside if it never does. `busy` only when a third window took the lock in between.
 */
export async function takeOverSignInLock(
  file: string,
  opts: SignInLockOptions = {},
): Promise<SignInLockResult> {
  const staleMs = opts.staleMs ?? SIGNIN_LOCK_STALE_MS;
  const first = acquireSignInLock(file, opts);
  if (first.kind === 'acquired') return first;
  const target = inspect(file, staleMs);
  if (target) {
    // Review I1: never write through whatever already sits at the cancel path (a link, a stale
    // request): remove it, then create it exclusively.
    rmSync(cancelFileOf(file), { force: true });
    try {
      writeFileSync(cancelFileOf(file), target.raw, { mode: 0o600, flag: 'wx' });
    } catch {
      /* another window is asking the same holder: its request does the same */
    }
    const deadline = Date.now() + (opts.takeoverWaitMs ?? SIGNIN_TAKEOVER_WAIT_MS);
    while (Date.now() < deadline && inspect(file, staleMs)?.raw === target.raw) await sleep(100);
    breakIf(file, `${file}.takeover-${randomBytes(4).toString('hex')}`, (aside) => {
      try {
        return readFileSync(aside, 'utf8') === target.raw;
      } catch {
        return false;
      }
    });
    rmSync(cancelFileOf(file), { force: true });
  }
  return acquireSignInLock(file, opts);
}
