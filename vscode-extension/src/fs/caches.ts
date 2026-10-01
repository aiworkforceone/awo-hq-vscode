/**
 * The two in-memory caches behind `hq://` (FEATURE decision 8). MEMORY ONLY: team source is masked
 * but still sensitive, so nothing is written to disk, and a sign-out or revocation clears both.
 *
 *   ListingCache  per team: folder → its entries, plus a stat index by path. The events socket keeps
 *                 it fresh; while that socket is down an entry lives `LISTING_TTL_MS` at most.
 *   ContentCache  (uri, etag) → bytes, LRU, at most `CONTENT_MAX_BYTES` and `CONTENT_MAX_ENTRIES`.
 *                 A new etag misses by construction, so a stale file is never served as current.
 */
import type { FsStat } from '@kpa/shared/remote-fs.types';

export const LISTING_TTL_MS = 30_000;
export const CONTENT_MAX_BYTES = 20 * 1024 * 1024;
export const CONTENT_MAX_ENTRIES = 200;

/** What the cache adds to a server stat: the masked flag of the last read (kept until the etag moves). */
export interface CachedStat extends FsStat {
  masked?: true;
}

interface Folder {
  entries: CachedStat[];
  at: number;
}

export class ListingCache {
  private readonly folders = new Map<string, Map<string, Folder>>();
  private readonly stats = new Map<string, Map<string, CachedStat>>();

  constructor(private readonly now: () => number = Date.now) {}

  private team(teamId: string): { folders: Map<string, Folder>; stats: Map<string, CachedStat> } {
    let folders = this.folders.get(teamId);
    if (!folders) {
      folders = new Map();
      this.folders.set(teamId, folders);
    }
    let stats = this.stats.get(teamId);
    if (!stats) {
      stats = new Map();
      this.stats.set(teamId, stats);
    }
    return { folders, stats };
  }

  /** A folder's entries, or undefined when not cached (or older than the TTL while `fresh` is false). */
  folder(teamId: string, dir: string, fresh: boolean): CachedStat[] | undefined {
    const f = this.folders.get(teamId)?.get(dir);
    if (!f) return undefined;
    if (!fresh && this.now() - f.at > LISTING_TTL_MS) return undefined;
    return f.entries;
  }

  /** The last folder listing whatever its age (a machine that is off still shows what it had). */
  staleFolder(teamId: string, dir: string): CachedStat[] | undefined {
    return this.folders.get(teamId)?.get(dir)?.entries;
  }

  putFolder(teamId: string, dir: string, entries: FsStat[]): CachedStat[] {
    const t = this.team(teamId);
    const merged = entries.map((e) => this.keepMasked(t.stats.get(e.path), e));
    t.folders.set(dir, { entries: merged, at: this.now() });
    for (const e of merged) t.stats.set(e.path, e);
    return merged;
  }

  stat(teamId: string, path: string): CachedStat | undefined {
    return this.stats.get(teamId)?.get(path);
  }

  /** Record one stat (a save, a stat call); the masked flag survives while the etag is the same. */
  putStat(teamId: string, stat: FsStat): CachedStat {
    const t = this.team(teamId);
    const merged = this.keepMasked(t.stats.get(stat.path), stat);
    t.stats.set(stat.path, merged);
    const dir = parentOf(stat.path);
    const f = t.folders.get(dir);
    if (f) {
      const i = f.entries.findIndex((e) => e.path === stat.path);
      if (i === -1) f.entries = [...f.entries, merged];
      else f.entries[i] = merged;
    }
    return merged;
  }

  markMasked(teamId: string, path: string, etag: string): void {
    const s = this.stats.get(teamId)?.get(path);
    if (s && s.etag === etag) s.masked = true;
  }

  /** A path changed on the machine: forget it, its folder's listing, and (for a folder) below it. */
  invalidate(teamId: string, path: string): void {
    const t = this.team(teamId);
    t.stats.delete(path);
    t.folders.delete(parentOf(path));
    const prefix = path === '' ? '' : `${path}/`;
    for (const key of [...t.folders.keys()]) {
      if (key === path || (prefix !== '' && key.startsWith(prefix))) t.folders.delete(key);
    }
    for (const key of [...t.stats.keys()]) {
      if (prefix !== '' && key.startsWith(prefix)) t.stats.delete(key);
    }
  }

  /** Forget one path's stat only (its folder's listing stays). */
  dropStat(teamId: string, path: string): void {
    this.stats.get(teamId)?.delete(path);
  }

  /** The `n` most recently listed folders other than the root (the refresh re-reads these). */
  recentFolders(teamId: string, n: number): string[] {
    return [...(this.folders.get(teamId)?.entries() ?? [])]
      .filter(([dir]) => dir !== '')
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, n)
      .map(([dir]) => dir);
  }

  /** The folders this team has listed (the resync re-reads exactly these). */
  cachedFolders(teamId: string): string[] {
    return [...(this.folders.get(teamId)?.keys() ?? [])];
  }

  clearTeam(teamId: string): void {
    this.folders.delete(teamId);
    this.stats.delete(teamId);
  }

  clear(): void {
    this.folders.clear();
    this.stats.clear();
  }

  private keepMasked(prior: CachedStat | undefined, next: FsStat): CachedStat {
    return prior?.masked === true && prior.etag === next.etag
      ? { ...next, masked: true }
      : { ...next };
  }
}

/** The team-relative parent of a path ('' for a top-level entry). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export class ContentCache {
  private readonly entries = new Map<string, { etag: string; bytes: Uint8Array }>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number = CONTENT_MAX_BYTES,
    private readonly maxEntries: number = CONTENT_MAX_ENTRIES,
  ) {}

  /** The bytes for exactly this etag (a different etag is a miss). */
  get(key: string, etag: string | undefined): Uint8Array | undefined {
    const e = this.entries.get(key);
    if (!e || etag === undefined || e.etag !== etag) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e); // most recently used
    return e.bytes;
  }

  /** Whatever was last read for this key, whatever its etag (served only while the machine is off). */
  last(key: string): Uint8Array | undefined {
    return this.entries.get(key)?.bytes;
  }

  put(key: string, etag: string, bytes: Uint8Array): void {
    this.drop(key);
    if (bytes.byteLength > this.maxBytes) return;
    this.entries.set(key, { etag, bytes });
    this.bytes += bytes.byteLength;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.bytes -= e.bytes.byteLength;
  }

  /** Every cached key under a prefix (a team, or a folder that went away). */
  dropPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.drop(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }
}
