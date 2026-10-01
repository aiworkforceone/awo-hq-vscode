/**
 * A cross-process lock file: created with O_EXCL (atomic on every local filesystem) and carrying OUR
 * random token. The release removes the file only while it still carries our token, so a lock broken
 * and re-taken by another process is never deleted from under it. Real time, not an injected clock:
 * file mtimes are wall-clock.
 *
 * ⛔ A LIVE HOLDER IS NEVER BROKEN (hq-vscode review W5). The holder HEARTBEATS the file's mtime
 *    (every `heartbeatMs`), so "stale" means a process that died holding it, not a slow one. A
 *    waiter breaks the lock only when its mtime is older than `staleMs`. A waiter that reaches its
 *    own `waitMs` deadline while the holder is alive does NOT break it (the old behaviour did, and a
 *    token refresh then presented a used refresh token next to the live holder's): it throws
 *    `FileLockBusyError`, and the caller decides (the refresh path re-reads the stored pair).
 * ⛔ A STALE LOCK IS MOVED ASIDE, NEVER DELETED IN PLACE (branch review). Two waiters can both judge
 *    the same lock stale; a plain delete by the slower one would remove the lock the faster one
 *    just took. `rename` is atomic, so only one waiter moves the file; the mover then checks what
 *    it moved, and a lock that turns out to be fresh is put back (`link`, which never overwrites).
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
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The waiter's deadline passed while the holder was still alive (its mtime is fresh). */
export class FileLockBusyError extends Error {
  constructor(readonly file: string) {
    super('Another process is holding the lock.');
    this.name = 'FileLockBusyError';
  }
}

export interface FileLockOptions {
  /** A lock whose mtime is older than this belongs to a process that died holding it. */
  staleMs?: number;
  /** How long to wait for a live holder before `FileLockBusyError`. */
  waitMs?: number;
  /** How often the holder refreshes the mtime. Default a third of `staleMs`. */
  heartbeatMs?: number;
  /** Test seam: runs after a lock is judged stale, just before it is broken. */
  beforeBreak?: () => void;
}

/**
 * Break a lock judged stale: move it aside atomically, then look at what was moved. Only a file
 * that is still stale is removed; a fresh one (another waiter took the lock in between) goes back.
 */
function breakStale(file: string, staleMs: number, aside: string): void {
  try {
    renameSync(file, aside);
  } catch {
    return; // someone else moved or released it first: just try again
  }
  try {
    if (Date.now() - statSync(aside).mtimeMs <= staleMs) {
      try {
        linkSync(aside, file); // back where it was, unless a newer lock is already there
      } catch {
        /* a newer lock exists: the one we moved lost anyway */
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

export async function acquireFileLock(
  file: string,
  opts: FileLockOptions = {},
): Promise<() => void> {
  const staleMs = opts.staleMs ?? 10_000;
  const heartbeatMs = opts.heartbeatMs ?? Math.max(250, Math.floor(staleMs / 3));
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  const mine = `${process.pid}:${randomBytes(8).toString('hex')}`;
  let delay = 10;
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      const beat = setInterval(() => {
        try {
          if (readFileSync(file, 'utf8') !== mine) return;
          const now = new Date();
          utimesSync(file, now, now);
        } catch {
          /* gone: nothing to keep fresh */
        }
      }, heartbeatMs);
      beat.unref?.();
      return () => {
        clearInterval(beat);
        try {
          if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // released between our open and our stat: try again at once
    }
    if (age > staleMs) {
      opts.beforeBreak?.();
      breakStale(file, staleMs, `${file}.stale-${mine.replace(':', '-')}`);
      continue;
    }
    if (Date.now() > deadline) throw new FileLockBusyError(file);
    await sleep(delay);
    delay = Math.min(delay * 2, 250);
  }
}
