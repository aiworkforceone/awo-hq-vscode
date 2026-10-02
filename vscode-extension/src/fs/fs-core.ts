/**
 * The logic of the `hq://` file system (FEATURE §7a), with no `vscode` import so the unit tier and
 * the real-server test drive it directly; `hq-fs-provider.ts` only translates to VS Code types.
 *
 *   stat       answered from the cache ONLY while the team's events stream is live (FEATURE C1),
 *              else asked of the server; read-only for a viewer or a plan that cannot write, a
 *              template/credential path, a file last served masked, or a file over 16 MiB.
 *   read       cached bytes with zero requests while the stream is live; otherwise one conditional
 *              request (`If-None-Match`, a 304 costs no body). A masked answer marks the cached stat
 *              and fires `changed`, so VS Code re-stats and the editor turns read-only before a save.
 *   write      `If-Match` the known etag (or create-only); a 412 updates the cached stat, fires
 *              `changed`, and says "Save again to compare" (VS Code's own pre-write check then shows
 *              Compare / Overwrite). Our own writes are remembered so their echo is dropped.
 *   off        cached listings and contents stay readable; an uncached read or any write says the
 *              team is off (with Wake Team). Nothing here ever wakes a machine.
 *   events     `fs-changed` invalidates and fires; `resync` (after any gap) re-reads what was cached.
 */
import { createHash } from 'node:crypto';
import {
  HqApiError,
  NotLoggedInError,
  RefreshBusyError,
  RefreshNeedsRenewingError,
} from '@hq/client/api.js';
import type { Team } from '@hq/client/teams.js';
import {
  FS_MAX_WRITE_BYTES,
  type EventsServerFrame,
  type FsStat,
} from '@kpa/shared/remote-fs.types';
import { COPY } from '../copy.js';
import {
  AccountGoneError,
  NeedsSignInError,
  SecretsBusyError,
  SlotRenewedError,
} from '../hq/session-store.js';
import { cleanLabel, CONTROL_RANGES, rangesSource, UNSAFE_RANGES } from '../util/text.js';
import { ContentCache, ListingCache, parentOf, type CachedStat } from './caches.js';
import type { EventsHub } from './events-client.js';
import { FsApiError, type HqFsApi } from './fs-api.js';

export type FsErrorKind =
  | 'not-found'
  | 'exists'
  | 'no-permissions'
  | 'unavailable'
  | 'too-large'
  | 'not-a-dir'
  | 'is-a-dir';

export class FsCoreError extends Error {
  constructor(
    readonly kind: FsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'FsCoreError';
  }
}

/** The answer arrived after a sign-out or revocation cleared everything: dropped, never cached. */
class SignedOutError extends FsCoreError {
  constructor() {
    super('unavailable', COPY.signedOutWelcome);
  }
}

export interface FsStatView {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
  readonly: boolean;
}

export interface FsChangeOut {
  team: Team;
  path: string;
  type: 'changed' | 'created' | 'deleted';
}

/**
 * Why a RUNNING (or replacing) machine cannot serve files, as the typed 409 said (FEATURE
 * §Backward compatibility, "States and copy"). "Off" is not one of these: it keeps `teamOff`.
 */
export type FsTeamIssue =
  | { kind: 'needs-update' }
  | { kind: 'updating'; etaSeconds: number | null };

export interface FsCoreUi {
  /** The team is off: one notification with Wake Team (the UI throttles repeats). */
  teamOff(team: Team, action: 'open' | 'save'): void;
  /** A file just opened masked: say why it is read-only (once per file). */
  masked(team: Team, path: string): void;
  /**
   * The team's issue CHANGED (null = it serves files again). Called once per change, never per
   * request, so the UI can notify and decorate without its own de-duplication.
   */
  teamIssue?(team: Team, issue: FsTeamIssue | null): void;
}

export interface FsCoreDeps {
  teams(): Team[];
  api: HqFsApi;
  events: EventsHub;
  ui: FsCoreUi;
  /** A 401/426/renew answer: the sign-in service decides (revocation, update prompt). */
  onApiError?(err: unknown): void;
  now?: () => number;
  /** The root refresh while a watched team's change stream is down (FEATURE §7a: 60 s). */
  rootRefreshMs?: number;
  /** Requests per team in flight at once; the rest queue (listings first). Default 6. */
  maxInFlight?: number;
  /** Test seam for the Retry-After wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** A file this size or larger is shown read-only (single-shot writes stop at 16 MiB). */
const MAX_EDIT_BYTES = FS_MAX_WRITE_BYTES;
/** How long our own write's echo is expected on the events stream. */
const OWN_WRITE_MS = 5_000;
/** How long a 404 is believed without asking again (VS Code probes the same config paths often). */
const ABSENT_TTL_MS = 30_000;
const ABSENT_MAX = 2_000;
/** A throttled read is tried this many more times, waiting what HQ asked each time. */
const THROTTLE_RETRIES = 3;
const THROTTLE_WAIT_MAX_MS = 10_000;
/** The 60 s refresh re-lists the root and at most this many other recently listed folders. */
const REFRESH_FOLDERS_MAX = 20;
/**
 * Live re-test #2 (round 3): a team that refused because it was off is asked again (a background
 * stat of its root, which never wakes it) this often after a sign that it may be up, for this long.
 */
export const TEAM_UP_PROBE_MS = 5_000;
export const TEAM_UP_BUDGET_MS = 180_000;

type Priority = 'listing' | 'normal';

/** A per-team request gate: `max` in flight, listings ahead of everything else in the queue. */
class TeamGate {
  private active = 0;
  private readonly queue: Array<{ priority: Priority; go: () => void }> = [];

  constructor(private readonly max: number) {}

  async run<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((go) => {
        const item = { priority, go };
        if (priority === 'listing') {
          const i = this.queue.findIndex((q) => q.priority !== 'listing');
          if (i === -1) this.queue.push(item);
          else this.queue.splice(i, 0, item);
        } else this.queue.push(item);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.go();
    }
  }
}

// Built from code points (never literal characters in the source): C0/C1 controls, THE shared list
// of invisible marks (`util/text.ts`, the same one labels use), and the two separators.
const UNSAFE_NAME = new RegExp(
  `[${rangesSource(CONTROL_RANGES)}${rangesSource(UNSAFE_RANGES)}/\\\\]`,
);

/** A name the Explorer may show: no separators, no controls, no bidi or zero-width marks, not . or .. */
export function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !UNSAFE_NAME.test(name);
}

const UNSAFE_CHARS = new RegExp(UNSAFE_NAME.source, 'g');
/** What replaces each unsafe character in a shown name (VS-18: shown cleaned, never run). */
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * VS-18: the name as the Explorer shows it. Every control, bidi or zero-width mark and separator
 * becomes U+FFFD, so an ESC sequence, a right-to-left override or a newline is visible and inert.
 */
export function shownName(name: string): string {
  return isSafeName(name) ? name : name.replace(UNSAFE_CHARS, REPLACEMENT);
}

/**
 * W2: a unique shown name for a hostile name whose cleaned text collides: a short hash of the REAL
 * name, before the extension (so the file still opens with the right language).
 */
export function suffixedName(cleaned: string, real: string, hexLength = 6): string {
  const h = createHash('sha256').update(real).digest('hex').slice(0, hexLength);
  const dot = cleaned.lastIndexOf('.');
  return dot > 0 ? `${cleaned.slice(0, dot)} ~${h}${cleaned.slice(dot)}` : `${cleaned} ~${h}`;
}

// kr-api's own path rule (`validateFsPath`, CONTROL = C0, DEL and C1): such a path is refused
// with 400 PATH_TRAVERSAL, so it is never sent (train 42 re-test).
const CONTROL_IN_PATH = new RegExp(`[${rangesSource(CONTROL_RANGES)}]`);

/** Does this REAL path hold a character HQ refuses in a path (it can be listed, never opened)? */
export function hasControlChars(realPath: string): boolean {
  return CONTROL_IN_PATH.test(realPath);
}

/** The one error every open, save, rename or delete of such a path gives. */
function controlNameError(): FsCoreError {
  return new FsCoreError('no-permissions', COPY.fsControlName);
}

/** A segment that may never become a URI: the root marker, `.`, `..`. */
function isDotSegment(seg: string): boolean {
  return seg === '' || seg === '.' || seg === '..';
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export class HqFsCore {
  readonly listings: ListingCache;
  readonly contents = new ContentCache();
  private readonly ownWrites = new Map<string, { etag: string; at: number }>();
  private readonly listeners = new Set<(changes: FsChangeOut[]) => void>();
  private readonly answered = new Set<(team: Team) => void>();
  private readonly upListeners = new Set<(team: Team) => void>();
  /** Teams that refused a person's request because they could not serve (off, updating). */
  private readonly down = new Set<string>();
  /** A probe round per team: until when it asks (a forced sign pushes this out). */
  private readonly probeUntil = new Map<string, number>();
  private readonly now: () => number;
  /** Watched teams (refcounted), for the root refresh while their stream is down. */
  private readonly watched = new Map<string, { team: Team; n: number }>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** The last issue per team (absent = none), so the UI hears a change once. */
  private readonly issues = new Map<string, FsTeamIssue>();
  private readonly gates = new Map<string, TeamGate>();
  /** `team:path` → until when a 404 is believed (the negative cache). */
  private readonly absent = new Map<string, number>();
  /** Listings being fetched now: a probe below one waits for it instead of asking. */
  private readonly listing = new Map<string, Promise<CachedStat[] | undefined>>();
  /** Stats being fetched now: the same path asked twice at once is asked once. */
  private readonly stating = new Map<string, Promise<FsStat>>();
  private readonly sleep: (ms: number) => Promise<void>;
  /** VS-18: `team:realDir\0shown` → the real name behind a cleaned one. */
  private readonly realNames = new Map<string, string>();
  /** The reverse: `team:realDir\0real` → the name it is shown under. */
  private readonly shownOf = new Map<string, string>();
  /** Hostile names given a suffix, kept while the real name exists (W2: stable names). */
  private readonly suffixed = new Set<string>();
  /**
   * LOW 1c: `team:shownPath` → the REAL path whose bytes were served under it. A shown name can move
   * to another file between listings (a plain file later takes the cleaned name); a save of the old
   * tab must never land on the new file.
   */
  private readonly servedFrom = new Map<string, string>();
  /**
   * Bumped by `clear()` (sign-out, revocation). An answer to a request that started before it is
   * dropped, never written into the caches it just emptied (security review L3).
   */
  private generation = 0;

  constructor(private readonly deps: FsCoreDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.listings = new ListingCache(this.now);
    deps.events.onFrame((f) => void this.onEvent(f));
  }

  /**
   * The team's machine answered a file request (it is awake and serving). The provider uses it to
   * retry tabs it refused while the team was asleep (live re-test #2).
   */
  onTeamAnswered(listener: (team: Team) => void): { dispose(): void } {
    this.answered.add(listener);
    return { dispose: () => void this.answered.delete(listener) };
  }

  /**
   * A team that refused because it could not serve answers again (a TRANSITION: once per episode).
   * The provider retries what it refused then, with fresh tries (live re-test #2, round 3).
   */
  onTeamUp(listener: (team: Team) => void): { dispose(): void } {
    this.upListeners.add(listener);
    return { dispose: () => void this.upListeners.delete(listener) };
  }

  /**
   * A sign that a team which refused may be up now (a wake was asked for or answered, a terminal
   * attached, the listing or the events stream says running). Nothing in VS Code asks a failed tab
   * or root again by itself, so the core asks: a background stat of the root every 5 s for 3 min,
   * until one answers (then `onTeamUp`). A team that never refused is never asked. `force` (a
   * person's action) starts a new 3 min even right after one ran out.
   */
  expectUp(team: Team, opts: { force?: boolean } = {}): void {
    const id = team.workspace.id;
    if (!this.down.has(id)) return;
    const running = this.probeUntil.has(id);
    if (running && !opts.force) return;
    this.probeUntil.set(id, this.now() + TEAM_UP_BUDGET_MS);
    if (!running) void this.probeUntilUp(team);
  }

  private async probeUntilUp(team: Team): Promise<void> {
    const id = team.workspace.id;
    const generation = this.generation;
    try {
      while (
        this.down.has(id) &&
        generation === this.generation &&
        this.now() < (this.probeUntil.get(id) ?? 0)
      ) {
        try {
          // The extension's own read: never a wake, never presence (`X-HQ-Activity: background`).
          await this.call(team, () => this.deps.api.stat(team, '', { background: true }), {
            read: true,
          });
          return; // `call` saw the answer: `onTeamUp` has fired
        } catch (err) {
          this.reportAuth(err);
          // Review P1: an account error is the sign-in service's to settle (one prompt, one
          // revocation check), never asked again every 5 s.
          if (!this.probeAgainAfter(err)) return;
        }
        await this.sleep(TEAM_UP_PROBE_MS);
      }
    } finally {
      this.probeUntil.delete(id);
    }
  }

  /**
   * Worth another probe: the team still cannot serve (409 off or updating), HQ throttled us, or the
   * network failed on the way. Anything else (an account error, a 401 or 426, another refusal)
   * ends the round.
   */
  private probeAgainAfter(err: unknown): boolean {
    if (err instanceof FsApiError) {
      if (err.status === 409) return this.isOff(err) || this.isIssue(err);
      // 502-504: the gateway in front of HQ (a network failure on the way, not an answer).
      return isThrottled(err) || err.status === 502 || err.status === 503 || err.status === 504;
    }
    return !(
      err instanceof HqApiError ||
      err instanceof NotLoggedInError ||
      err instanceof FsCoreError ||
      isAccountError(err)
    );
  }

  onDidChange(listener: (changes: FsChangeOut[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private fire(changes: FsChangeOut[]): void {
    if (changes.length === 0) return;
    // Everything inside is a REAL path; VS Code only ever sees the shown one (VS-18).
    const shown = changes.map((c) => ({ ...c, path: this.toShown(c.team, c.path) }));
    for (const l of [...this.listeners]) l(shown);
  }

  private nameKey(team: Team, dir: string, name: string): string {
    return `${team.workspace.id}:${dir}\0${name}`;
  }

  /** Drop every shown-name record of `path` itself and of everything below it (M1). */
  private forgetShownNames(team: Team, path: string): void {
    const id = team.workspace.id;
    if (path !== '') {
      const own = this.nameKey(team, parentOf(path), baseName(path));
      const shown = this.shownOf.get(own);
      if (shown !== undefined) this.realNames.delete(this.nameKey(team, parentOf(path), shown));
      this.shownOf.delete(own);
      this.suffixed.delete(own);
    }
    const inside = `${id}:${path}\0`;
    const below = path === '' ? `${id}:` : `${id}:${path}/`;
    for (const map of [this.realNames, this.shownOf, this.suffixed]) {
      for (const k of [...map.keys()]) {
        if (k.startsWith(inside) || k.startsWith(below)) map.delete(k);
      }
    }
  }

  /**
   * The path VS Code shows for a real one (W4: search results use it too, one URI per file). A
   * hostile segment in a folder we hold no listing of lists that folder ONCE first (LOW 3), so a
   * search hit never opens under its plain twin's name.
   */
  async shownPath(team: Team, realPath: string): Promise<string> {
    const generation = this.generation;
    const budget = { listed: false };
    let dir = '';
    for (const seg of realPath === '' ? [] : realPath.split('/')) {
      if (!isSafeName(seg)) await this.listOnce(team, dir, generation, budget);
      dir = dir === '' ? seg : `${dir}/${seg}`;
    }
    return this.toShown(team, realPath);
  }

  /**
   * List `dir` if we hold no listing of it, at most ONCE per resolution (LOW 2): after one lazy
   * listing, or a failed one, the rest of the path is passed through unchanged. True when a
   * listing of `dir` is now held.
   */
  private async listOnce(
    team: Team,
    dir: string,
    generation: number,
    budget: { listed: boolean },
  ): Promise<boolean> {
    if (this.listings.staleFolder(team.workspace.id, dir) !== undefined) return true;
    if (budget.listed) return false;
    // A folder a listing already said is not there, or one below it, is never listed (LOW 2).
    const parts = dir === '' ? [] : dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const until = this.absent.get(this.key(team, parts.slice(0, i).join('/')));
      if (until !== undefined && until > this.now()) return false;
    }
    budget.listed = true;
    await this.fetchListing(team, dir, generation).catch(() => undefined);
    return this.listings.staleFolder(team.workspace.id, dir) !== undefined;
  }

  /** Each real segment as the Explorer shows it: plain as is, hostile cleaned (and suffixed). */
  private toShown(team: Team, realPath: string): string {
    if (realPath === '') return '';
    let dir = '';
    const out: string[] = [];
    for (const seg of realPath.split('/')) {
      out.push(this.shownSegment(team, dir, seg));
      dir = dir === '' ? seg : `${dir}/${seg}`;
    }
    return out.join('/');
  }

  private shownSegment(team: Team, dir: string, real: string): string {
    if (isSafeName(real)) return real;
    const known = this.shownOf.get(this.nameKey(team, dir, real));
    if (known !== undefined) return known;
    // Not listed yet (an event ran ahead of the listing). Its cleaned text belongs to someone else
    // when a listed plain entry or another hostile file already shows under it: then the suffixed
    // name, so an event for a twin never fires under the winner's path (W2).
    const cleaned = shownName(real);
    const owner = this.realNames.get(this.nameKey(team, dir, cleaned));
    const plainTaken = (this.listings.staleFolder(team.workspace.id, dir) ?? []).some(
      (e) => baseName(e.path) === cleaned,
    );
    return (owner !== undefined && owner !== real) || plainTaken
      ? suffixedName(cleaned, real)
      : cleaned;
  }

  /** `toReal` from what is mapped already, never a request (the Explorer decoration asks it). */
  private toRealKnown(team: Team, shown: string): string {
    let real = '';
    for (const seg of shown === '' ? [] : shown.split('/')) {
      const next = this.realNames.get(this.nameKey(team, real, seg)) ?? seg;
      real = real === '' ? next : `${real}/${next}`;
    }
    return real;
  }

  /**
   * Is this shown path a file HQ can list but never open (a control character in its real name)?
   * The Explorer marks it; every open, save, rename and delete refuses it without a request.
   */
  isUnopenable(team: Team, shown: string): boolean {
    return hasControlChars(this.toRealKnown(team, shown));
  }

  /**
   * The real path behind a path VS Code gave us (the reverse of `toShown`, via the listings). A
   * cleaned segment whose folder was not listed this session (a restored editor tab, after a
   * sign-out) lists that folder once and looks again (W3).
   */
  private async toReal(
    team: Team,
    shown: string,
    generation: number = this.generation,
  ): Promise<string> {
    if (shown === '') return '';
    let real = '';
    const budget = { listed: false };
    for (const seg of shown.split('/')) {
      let name = this.realNames.get(this.nameKey(team, real, seg));
      // Only a folder we hold NO listing of (a listed one was mapped when it was stored), and at
      // most ONE lazy listing per path (LOW 2).
      if (name === undefined && seg.includes(REPLACEMENT)) {
        const held = this.listings.staleFolder(team.workspace.id, real) !== undefined;
        const listedNow = !held && (await this.listOnce(team, real, generation, budget));
        if (listedNow) {
          name = this.realNames.get(this.nameKey(team, real, seg));
          const listing = this.listings.staleFolder(team.workspace.id, real) ?? [];
          const child = real === '' ? seg : `${real}/${seg}`;
          // Listed, and neither mapped nor a real entry: remembered as absent (and below it).
          if (name === undefined && !listing.some((e) => e.path === child)) {
            this.noteAbsent(team, child);
          }
        }
      }
      const next = name ?? seg;
      real = real === '' ? next : `${real}/${next}`;
    }
    return real;
  }

  /**
   * The entries of one folder as VS Code sees them: `.`/`..` dropped, hostile names cleaned and
   * remembered, so operations reach the real file. Rebuilt from THIS listing only (security review
   * M1). A hostile name whose cleaned text collides (with a plain name or with another hostile one)
   * gets a stable, unique suffix from its REAL name, whatever the listing order (W2), and keeps it
   * for as long as that real name exists.
   */
  private shownEntries(
    team: Team,
    dir: string,
    entries: CachedStat[],
  ): Array<[string, FsStat['type']]> {
    const prefix = `${team.workspace.id}:${dir}\0`;
    for (const k of [...this.realNames.keys()]) if (k.startsWith(prefix)) this.realNames.delete(k);
    for (const k of [...this.shownOf.keys()]) if (k.startsWith(prefix)) this.shownOf.delete(k);
    const present = new Set(entries.map((e) => this.nameKey(team, dir, baseName(e.path))));
    for (const k of [...this.suffixed]) {
      if (k.startsWith(prefix) && !present.has(k)) this.suffixed.delete(k);
    }
    const out: Array<[string, FsStat['type']]> = [];
    const taken = new Set<string>();
    const hostile: CachedStat[] = [];
    for (const e of entries) {
      const name = baseName(e.path);
      if (isSafeName(name)) {
        taken.add(name);
        out.push([name, e.type]);
      } else if (!isDotSegment(name)) hostile.push(e);
    }
    // LOW 1a: the order names are handed out never depends on the server's listing order.
    hostile.sort((x, y) => (baseName(x.path) < baseName(y.path) ? -1 : 1));
    const cleanedCount = new Map<string, number>();
    for (const e of hostile) {
      const c = shownName(baseName(e.path));
      cleanedCount.set(c, (cleanedCount.get(c) ?? 0) + 1);
    }
    for (const e of hostile) {
      const real = baseName(e.path);
      const key = this.nameKey(team, dir, real);
      const cleaned = shownName(real);
      const suffix =
        this.suffixed.has(key) || taken.has(cleaned) || (cleanedCount.get(cleaned) ?? 0) > 1;
      let shown = suffix ? suffixedName(cleaned, real) : cleaned;
      // LOW 1b: a suffix that collides (with a real name, or another hash) gets LONGER, never
      // hidden: 12, then 24 hex, then the whole hash.
      for (const len of [12, 24, 64]) {
        if (!taken.has(shown)) break;
        shown = suffixedName(cleaned, real, len);
      }
      if (taken.has(shown)) continue;
      taken.add(shown);
      if (suffix) this.suffixed.add(key);
      this.realNames.set(this.nameKey(team, dir, shown), real);
      this.shownOf.set(key, shown);
      out.push([shown, e.type]);
    }
    return out;
  }

  private key(team: Team, path: string): string {
    return `${team.workspace.id}:${path}`;
  }

  /** The team an `hq://<org>/<alias>` names, among this sign-in's teams. */
  team(orgSlug: string, alias: string): Team {
    const t = this.deps.teams().find((x) => x.org.slug === orgSlug && x.alias === alias);
    if (!t) throw new FsCoreError('unavailable', COPY.fsTeamGone);
    return t;
  }

  private rootReadOnly(team: Team): boolean {
    return team.workspace.rights.files?.write !== true;
  }

  private view(team: Team, s: CachedStat): FsStatView {
    return {
      type: s.type,
      size: s.size,
      mtimeMs: s.mtimeMs,
      readonly:
        this.rootReadOnly(team) ||
        s.readonly !== undefined ||
        s.masked === true ||
        (s.type === 'file' && s.size > MAX_EDIT_BYTES),
    };
  }

  /**
   * Every server call. It waits its turn at the team's gate (nonprod 2026-09-30: opening a window
   * sent 100+ requests at once and HQ throttled them all), a throttled READ waits what HQ asked and
   * tries again (a write is never replayed), a success clears the team's issue and a typed 409
   * records one.
   */
  private async call<T>(
    team: Team,
    run: () => Promise<T>,
    opts: { read?: boolean; priority?: Priority } = {},
  ): Promise<T> {
    const gate = this.gateFor(team);
    const generation = this.generation;
    let out: T;
    let renewRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        out = await gate.run(opts.priority ?? 'normal', run);
        break;
      } catch (err) {
        // Another window renewed this account's slot (hq-vscode-multi-account decision 26): the
        // service rebuilds its client and the request is retried ONCE with the new grant.
        if (err instanceof SlotRenewedError && !renewRetried) {
          renewRetried = true;
          this.deps.onApiError?.(err);
          continue;
        }
        if (opts.read && attempt < THROTTLE_RETRIES && isThrottled(err)) {
          await this.sleep(retryAfterMs(err));
          continue;
        }
        if (generation !== this.generation) throw new SignedOutError();
        const issue = this.issueOf(err);
        if (issue) this.setIssue(team, issue);
        throw err;
      }
    }
    if (generation !== this.generation) throw new SignedOutError();
    this.setIssue(team, null);
    const wasDown = this.down.delete(team.workspace.id);
    for (const l of [...this.answered]) l(team);
    if (wasDown) for (const l of [...this.upListeners]) l(team);
    return out;
  }

  private gateFor(team: Team): TeamGate {
    let g = this.gates.get(team.workspace.id);
    if (!g) {
      g = new TeamGate(this.deps.maxInFlight ?? 6);
      this.gates.set(team.workspace.id, g);
    }
    return g;
  }

  // ── known absent (VS Code's own probes: .vscode/*, .github/*, .claude/*, ...) ─────────────────

  private noteAbsent(team: Team, path: string): void {
    if (this.absent.size >= ABSENT_MAX) this.absent.clear();
    this.absent.set(this.key(team, path), this.now() + ABSENT_TTL_MS);
  }

  /** Forget what we believed absent at `path` and below it (it may exist now). */
  private forgetAbsent(team: Team, path: string): void {
    const key = this.key(team, path);
    this.absent.delete(key);
    const below = `${key}/`;
    for (const k of [...this.absent.keys()]) if (k.startsWith(below)) this.absent.delete(k);
  }

  /** A listing we may answer from now: live or fresh in the cache, or one being fetched. */
  private async knownListing(team: Team, dir: string): Promise<CachedStat[] | undefined> {
    const cached = this.listings.folder(team.workspace.id, dir, this.deps.events.isLive(team));
    if (cached) return cached;
    const pending = this.listing.get(this.key(team, dir));
    return pending ? pending.catch(() => undefined) : undefined;
  }

  /**
   * Is `path` certainly not there? Yes when a recent 404 said so, or when the nearest listed
   * ancestor has no such child (or has a FILE where the path needs a folder). Never a request.
   */
  private async knownAbsent(team: Team, path: string): Promise<boolean> {
    if (path === '') return false;
    const until = this.absent.get(this.key(team, path));
    if (until !== undefined) {
      if (until > this.now()) return true;
      this.absent.delete(this.key(team, path));
    }
    const parts = path.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const listing = await this.knownListing(team, parts.slice(0, i).join('/'));
      if (!listing) continue;
      const child = parts.slice(0, i + 1).join('/');
      const entry = listing.find((e) => e.path === child);
      if (!entry) return true;
      return child !== path && entry.type !== 'dir';
    }
    return false;
  }

  private issueOf(err: unknown): FsTeamIssue | null {
    if (!(err instanceof FsApiError) || err.status !== 409) return null;
    if (err.code === 'REMOTE_UNSUPPORTED_RUNNER') return { kind: 'needs-update' };
    if (err.code === 'WORKSPACE_UPDATING') {
      const eta = err.details?.etaSeconds;
      return {
        kind: 'updating',
        etaSeconds: typeof eta === 'number' && Number.isFinite(eta) && eta > 0 ? eta : null,
      };
    }
    return null;
  }

  /** Tell the UI only when the KIND changes (a new ETA while updating is not news). */
  private setIssue(team: Team, issue: FsTeamIssue | null): void {
    const id = team.workspace.id;
    const prior = this.issues.get(id);
    if ((prior?.kind ?? null) === (issue?.kind ?? null)) return;
    if (issue) this.issues.set(id, issue);
    else this.issues.delete(id);
    this.deps.ui.teamIssue?.(team, issue);
  }

  /** The team's current issue, if any (the folder decoration reads it). */
  issueFor(team: Team): FsTeamIssue | undefined {
    return this.issues.get(team.workspace.id);
  }

  /**
   * A 401 or 426 (or any HqApiError) goes to the sign-in service, which decides (revocation,
   * update prompt). Background paths call this too: a refused re-list is never swallowed (L2c).
   */
  private reportAuth(err: unknown): void {
    if (err instanceof HqApiError || isAccountError(err)) {
      this.deps.onApiError?.(err);
      return;
    }
    if (err instanceof FsApiError && (err.status === 401 || err.status === 426)) {
      this.deps.onApiError?.(new HqApiError(err.status, err.code, err.message, err.details));
    }
  }

  /** Map an API failure to the error VS Code shows, telling the sign-in service first. */
  private fail(team: Team, err: unknown, action: 'open' | 'save'): FsCoreError {
    if (err instanceof FsCoreError) return err;
    if (err instanceof NotLoggedInError)
      return new FsCoreError('unavailable', COPY.signedOutWelcome);
    this.reportAuth(err);
    if (isAccountError(err)) {
      // The shared client's own sentences are the CLI's ("Run hq login"): never shown here.
      const cli = err instanceof RefreshNeedsRenewingError || err instanceof RefreshBusyError;
      return new FsCoreError('unavailable', cli ? COPY.renewSignIn : err.message);
    }
    if (err instanceof HqApiError) return new FsCoreError('unavailable', err.message);
    if (!(err instanceof FsApiError)) {
      return new FsCoreError('unavailable', COPY.unreachable);
    }
    const name = cleanLabel(team.workspace.name) || team.alias;
    switch (err.status) {
      case 404:
        return new FsCoreError('not-found', err.message);
      case 402:
        return new FsCoreError('no-permissions', COPY.fsPlanReadOnly);
      case 403:
        return new FsCoreError('no-permissions', err.message);
      case 413:
        return new FsCoreError('too-large', COPY.fsTooLarge);
      case 422:
        return new FsCoreError('no-permissions', err.message);
      case 409:
        if (this.isOff(err) || this.isIssue(err)) this.down.add(team.workspace.id);
        if (err.code === 'RUNNER_UNAVAILABLE') {
          this.deps.ui.teamOff(team, action);
          return new FsCoreError(
            'unavailable',
            action === 'open' ? COPY.fsOffOpen(name) : COPY.fsOffSave(name),
          );
        }
        if (err.code === 'REMOTE_UNSUPPORTED_RUNNER') {
          return new FsCoreError('unavailable', COPY.updateNeededLong(name));
        }
        if (err.code === 'WORKSPACE_UPDATING') {
          const issue = this.issueOf(err);
          return new FsCoreError(
            'unavailable',
            COPY.fsUpdating(name, issue?.kind === 'updating' ? issue.etaSeconds : null),
          );
        }
        if (err.code === 'CONFLICT') return new FsCoreError('exists', err.message);
        if (err.code === 'NOT_A_DIRECTORY') return new FsCoreError('not-a-dir', err.message);
        if (err.code === 'IS_A_DIRECTORY') return new FsCoreError('is-a-dir', err.message);
        return new FsCoreError('unavailable', err.message);
      default:
        return new FsCoreError('unavailable', err.message);
    }
  }

  private isOff(err: unknown): boolean {
    return err instanceof FsApiError && err.status === 409 && err.code === 'RUNNER_UNAVAILABLE';
  }

  /**
   * A machine that needs an update or is being updated: the ROOT still mounts (a dir with no
   * entries) so the Explorer shows the folder with its reason (decoration, notice) instead of a
   * bare error badge. Anything below the root says the sentence.
   */
  private isIssue(err: unknown): boolean {
    return this.issueOf(err) !== null;
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────

  async stat(team: Team, shown: string): Promise<FsStatView> {
    const generation = this.generation;
    const path = await this.toReal(team, shown, generation);
    const live = this.deps.events.isLive(team);
    const cached = this.listings.stat(team.workspace.id, path);
    if (hasControlChars(path)) {
      // Listed, never openable: described from the listing, read-only, no request.
      if (cached) return { ...this.view(team, cached), readonly: true };
      throw controlNameError();
    }
    if (live && cached) return this.view(team, cached);
    if (path === '' && live)
      return { type: 'dir', size: 0, mtimeMs: 0, readonly: this.rootReadOnly(team) };
    if (await this.knownAbsent(team, path)) throw new FsCoreError('not-found', path);
    try {
      const s = await this.statOnce(team, path);
      if (generation !== this.generation) throw new SignedOutError();
      return this.view(team, this.listings.putStat(team.workspace.id, s));
    } catch (err) {
      if (err instanceof FsApiError && err.status === 404) this.noteAbsent(team, path);
      if (this.isOff(err)) {
        // Off (U23): the last thing we knew is still the best answer, READ-ONLY (a save could not
        // land), and nothing retries into a wake. A file whose stat an event dropped but whose
        // bytes we still hold is described from those bytes.
        if (cached) return { ...this.view(team, cached), readonly: true };
        const bytes = this.contents.last(this.key(team, path));
        if (bytes) return { type: 'file', size: bytes.byteLength, mtimeMs: 0, readonly: true };
      }
      if ((this.isOff(err) || this.isIssue(err)) && path === '') {
        return { type: 'dir', size: 0, mtimeMs: 0, readonly: this.rootReadOnly(team) };
      }
      throw this.fail(team, err, 'open');
    }
  }

  /** One stat per path at a time: VS Code asks the same path several times while a folder opens. */
  private statOnce(team: Team, path: string): Promise<FsStat> {
    const key = this.key(team, path);
    const pending = this.stating.get(key);
    if (pending) return pending;
    const p = this.call(team, () => this.deps.api.stat(team, path), { read: true }).finally(() =>
      this.stating.delete(key),
    );
    this.stating.set(key, p);
    return p;
  }

  async readDirectory(team: Team, shown: string): Promise<Array<[string, FsStat['type']]>> {
    const generation = this.generation;
    const path = await this.toReal(team, shown, generation);
    if (hasControlChars(path)) throw controlNameError();
    const live = this.deps.events.isLive(team);
    let entries = this.listings.folder(team.workspace.id, path, live);
    if (!entries) {
      if (path !== '' && (await this.knownAbsent(team, path))) {
        throw new FsCoreError('not-found', path);
      }
      try {
        entries = await this.fetchListing(team, path, generation);
        if (generation !== this.generation) throw new SignedOutError();
      } catch (err) {
        // Off, or throttled past the retries: the last listing stands. Never an empty folder
        // made up from a refusal (nonprod 2026-09-30: a 429 on the root showed an empty team).
        const stale =
          this.isOff(err) || isThrottled(err)
            ? this.listings.staleFolder(team.workspace.id, path)
            : undefined;
        if (!stale && path === '' && this.isIssue(err)) {
          this.fail(team, err, 'open');
          return [];
        }
        if (!stale) throw this.fail(team, err, 'open');
        entries = stale;
      }
    }
    return this.shownEntries(team, path, entries);
  }

  /** Fetch one folder's listing (ahead of other requests), cache it, and let probes wait on it. */
  /** `generation`: the caller's, when the listing answers a request that began before a clear (L3). */
  /** `background`: the extension's own re-list, not a person's (sent as `X-HQ-Activity`). */
  private fetchListing(
    team: Team,
    dir: string,
    generation: number = this.generation,
    background = false,
  ): Promise<CachedStat[]> {
    const key = this.key(team, dir);
    const pending = this.listing.get(key);
    if (pending) {
      return pending.then((v) => {
        if (v) return v;
        return this.fetchListing(team, dir, generation, background);
      });
    }
    let fail: unknown;
    const p = this.call(team, () => this.deps.api.listAll(team, dir, { background }), {
      read: true,
      priority: 'listing',
    })
      .then((list) => {
        if (generation !== this.generation) throw new SignedOutError();
        for (const e of list) this.forgetAbsent(team, e.path);
        const stored = this.listings.putFolder(team.workspace.id, dir, list);
        // The shown names follow every listing we store (a hostile file announced on the stream is
        // reachable under its cleaned name before VS Code re-reads the folder).
        this.shownEntries(team, dir, stored);
        return stored;
      })
      .catch((err: unknown) => {
        fail = err;
        return undefined;
      })
      .finally(() => this.listing.delete(key));
    this.listing.set(key, p);
    return p.then((v) => {
      if (v) return v;
      throw fail;
    });
  }

  async readFile(team: Team, shown: string): Promise<Uint8Array> {
    const generation = this.generation;
    const path = await this.toReal(team, shown, generation);
    if (hasControlChars(path)) throw controlNameError();
    const key = this.key(team, path);
    const cached = this.listings.stat(team.workspace.id, path);
    if (this.deps.events.isLive(team)) {
      const hit = this.contents.get(key, cached?.etag);
      if (hit) {
        this.servedFrom.set(this.key(team, shown), path);
        return hit;
      }
    }
    const last = this.contents.last(key);
    if (!last && (await this.knownAbsent(team, path))) throw new FsCoreError('not-found', path);
    const lastEtag = last ? this.contentEtag(key) : undefined;
    let r;
    try {
      r = await this.call(team, () => this.deps.api.read(team, path, lastEtag), { read: true });
    } catch (err) {
      if (err instanceof FsApiError && err.status === 404) this.noteAbsent(team, path);
      if (this.isOff(err) && last) {
        // U23: what was opened before stays readable while the team is off (read-only, see stat).
        // It opened, so no "off" notice (train 42 re-test): that is only for an open that fails.
        return last;
      }
      throw this.fail(team, err, 'open');
    }
    // L3: signed out while this read was on its way: nothing is cached or returned.
    if (generation !== this.generation) throw new SignedOutError();
    if (this.servedFrom.size >= 5_000) this.servedFrom.clear();
    this.servedFrom.set(this.key(team, shown), path);
    if (r.kind === 'not-modified') return last ?? new Uint8Array();
    this.contents.put(key, r.etag, r.bytes);
    this.etags.set(key, r.etag);
    if (r.masked) await this.markMasked(team, path, r.etag);
    return r.bytes;
  }

  /** The etag of what the content cache holds for `key` (kept beside it). */
  private readonly etags = new Map<string, string>();
  private contentEtag(key: string): string | undefined {
    return this.etags.get(key);
  }

  private async markMasked(team: Team, path: string, etag: string): Promise<void> {
    let s = this.listings.stat(team.workspace.id, path);
    if (!s || s.etag !== etag) {
      try {
        s = this.listings.putStat(team.workspace.id, await this.statOnce(team, path));
      } catch {
        return;
      }
    }
    this.listings.markMasked(team.workspace.id, path, etag);
    this.deps.ui.masked(team, path);
    // VS Code reads permissions from stat(), which ran before this read: make it ask again.
    this.fire([{ team, path, type: 'changed' }]);
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────

  private assertWritable(team: Team): void {
    if (this.rootReadOnly(team)) throw new FsCoreError('no-permissions', COPY.fsViewOnly);
  }

  async writeFile(
    team: Team,
    shown: string,
    bytes: Uint8Array,
    opts: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const generation = this.generation;
    const path = await this.toReal(team, shown, generation);
    if (hasControlChars(path)) throw controlNameError();
    this.assertWritable(team);
    // LOW 1c: the tab's bytes came from another real file than this name reaches now.
    const served = this.servedFrom.get(this.key(team, shown));
    if (served !== undefined && served !== path) {
      throw new FsCoreError('unavailable', COPY.fsChangedOnMachine);
    }
    if (bytes.byteLength > MAX_EDIT_BYTES) throw new FsCoreError('too-large', COPY.fsTooLarge);
    let known = this.listings.stat(team.workspace.id, path);
    // The version the editor LOADED is what a save replaces. With no cached stat (an event forgot
    // it), that is the etag of the bytes we served, never a fresh stat: a fresh stat would carry a
    // change the person never saw straight into `If-Match` and overwrite it.
    const loaded = this.etags.get(this.key(team, path));
    if (!known && loaded !== undefined) {
      known = { path, type: 'file', size: 0, mtimeMs: 0, etag: loaded };
    }
    if (!known) {
      try {
        known = this.listings.putStat(
          team.workspace.id,
          await this.call(team, () => this.deps.api.stat(team, path)),
        );
      } catch (err) {
        if (!(err instanceof FsApiError && err.status === 404)) throw this.fail(team, err, 'save');
      }
    }
    if (!known && !opts.create) throw new FsCoreError('not-found', path);
    if (known && !opts.overwrite) throw new FsCoreError('exists', path);
    if (known?.masked) throw new FsCoreError('no-permissions', COPY.fsMasked);
    if (known?.readonly) throw new FsCoreError('no-permissions', COPY.fsProtected);
    let s: FsStat;
    try {
      s = await this.call(team, () =>
        this.deps.api.write(
          team,
          path,
          bytes,
          known ? { ifMatch: known.etag } : { createOnly: true },
        ),
      );
    } catch (err) {
      if (err instanceof FsApiError && err.status === 412) {
        const current = err.details?.current as FsStat | undefined;
        if (current) this.listings.putStat(team.workspace.id, current);
        else this.listings.invalidate(team.workspace.id, path);
        this.fire([{ team, path, type: 'changed' }]);
        throw new FsCoreError('unavailable', COPY.fsChangedOnMachine);
      }
      throw this.fail(team, err, 'save');
    }
    const key = this.key(team, path);
    this.servedFrom.set(this.key(team, shown), path);
    this.forgetAbsent(team, path);
    this.ownWrites.set(key, { etag: s.etag, at: this.now() });
    this.listings.putStat(team.workspace.id, s);
    this.contents.put(key, s.etag, bytes);
    this.etags.set(key, s.etag);
  }

  async createDirectory(team: Team, shown: string): Promise<void> {
    const generation = this.generation;
    const path = await this.toReal(team, shown, generation);
    if (hasControlChars(path)) throw controlNameError();
    this.assertWritable(team);
    this.forgetAbsent(team, path);
    try {
      this.listings.putStat(
        team.workspace.id,
        await this.call(team, () => this.deps.api.mkdir(team, path)),
      );
    } catch (err) {
      throw this.fail(team, err, 'save');
    }
  }

  async delete(team: Team, shown: string, recursive: boolean): Promise<void> {
    const generation = this.generation;
    const path = await this.toReal(team, shown, generation);
    if (hasControlChars(path)) throw controlNameError();
    this.assertWritable(team);
    try {
      await this.call(team, () => this.deps.api.remove(team, path, recursive));
    } catch (err) {
      throw this.fail(team, err, 'save');
    }
    this.forget(team, path);
    this.fire([{ team, path, type: 'deleted' }]);
  }

  async rename(team: Team, shownFrom: string, shownTo: string, overwrite: boolean): Promise<void> {
    const from = await this.toReal(team, shownFrom);
    const to = await this.toReal(team, shownTo);
    if (hasControlChars(from) || hasControlChars(to)) throw controlNameError();
    this.assertWritable(team);
    let s: FsStat;
    try {
      s = await this.call(team, () => this.deps.api.rename(team, from, to, overwrite));
    } catch (err) {
      throw this.fail(team, err, 'save');
    }
    this.forget(team, from);
    this.forgetAbsent(team, to);
    this.listings.invalidate(team.workspace.id, to);
    this.listings.putStat(team.workspace.id, s);
    this.fire([
      { team, path: from, type: 'deleted' },
      { team, path: to, type: 'created' },
    ]);
  }

  /**
   * Forget what we knew about `path` (and below it). `keepBytes`: a change on the stream keeps the
   * last bytes, which are only ever served while the team is off (U23, read-only, with the off
   * notice); while it is up, the next read is a conditional request that brings the new version.
   */
  private forget(team: Team, path: string, opts: { keepBytes?: boolean } = {}): void {
    this.listings.invalidate(team.workspace.id, path);
    this.forgetShownNames(team, path);
    if (opts.keepBytes) return;
    const key = this.key(team, path);
    this.contents.drop(key);
    this.contents.dropPrefix(`${key}/`);
    // S2: the etag of bytes we no longer hold must not make the next read conditional.
    this.etags.delete(key);
    for (const k of [...this.etags.keys()]) if (k.startsWith(`${key}/`)) this.etags.delete(k);
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Watch one team's folder (refcounted): its events stream is live while any watch is. While the
   * stream is NOT live (down, refused, or the server has no watcher running), the root is refreshed
   * every 60 s instead, so the Explorer never sits on a stale listing.
   */
  watch(team: Team): { dispose(): void } {
    const sub = this.deps.events.subscribe(team);
    const id = team.workspace.id;
    const w = this.watched.get(id);
    if (w) {
      w.n += 1;
      w.team = team;
    } else this.watched.set(id, { team, n: 1 });
    this.startRootRefresh();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        sub.dispose();
        const cur = this.watched.get(id);
        if (cur && --cur.n <= 0) this.watched.delete(id);
        if (this.watched.size === 0) this.stopRootRefresh();
      },
    };
  }

  private startRootRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setInterval(() => this.refreshRoots(), this.deps.rootRefreshMs ?? 60_000);
    (this.refreshTimer as { unref?: () => void }).unref?.();
  }

  private stopRootRefresh(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Every watched team whose stream is not live (down, refused by the socket cap, no watcher):
   * re-list its root and its most recently listed folders OURSELVES and fire per child. A
   * `Changed` on a folder is not enough: VS Code's Explorer does not re-read a folder for it.
   */
  private refreshRoots(): void {
    for (const { team } of this.watched.values()) {
      if (this.deps.events.isLive(team)) continue;
      const folders = ['', ...this.listings.recentFolders(team.workspace.id, REFRESH_FOLDERS_MAX)];
      void this.relistAndFire(team, [...new Set(folders)]);
    }
  }

  /** Re-list each folder we had listed, and fire what differs (plus `changed` for `alsoChanged`). */
  private async relistAndFire(
    team: Team,
    dirs: string[],
    alsoChanged: string[] = [],
    before?: Map<string, CachedStat[] | undefined>,
  ): Promise<void> {
    const out: FsChangeOut[] = alsoChanged.map((path) => ({ team, path, type: 'changed' }));
    const diffs = await Promise.all(
      dirs.map((dir) =>
        this.relist(
          team,
          dir,
          before ? before.get(dir) : this.listings.staleFolder(team.workspace.id, dir),
        ),
      ),
    );
    for (const d of diffs) out.push(...d);
    this.fire(dedupe(out));
  }

  /**
   * Re-list `dir` and diff it against what VS Code was shown (`prior`): new children `created`,
   * gone ones `deleted` (and forgotten), a new etag `changed`. A folder never listed is skipped (the
   * Explorer is not showing it); a machine that cannot answer keeps the old listing.
   */
  private async relist(
    team: Team,
    dir: string,
    prior: CachedStat[] | undefined,
  ): Promise<FsChangeOut[]> {
    if (!prior) return [];
    let next: CachedStat[];
    try {
      // Every re-list is the extension's own (the 60 s refresh, a stream change, a resync): background.
      next = await this.fetchListing(team, dir, this.generation, true);
    } catch (err) {
      if (err instanceof SignedOutError) return [];
      this.reportAuth(err);
      this.listings.putFolder(team.workspace.id, dir, prior);
      return [];
    }
    const was = new Map(prior.map((e) => [e.path, e]));
    const out: FsChangeOut[] = [];
    for (const e of next) {
      if (!isSafePath(e.path)) continue;
      const old = was.get(e.path);
      if (!old) out.push({ team, path: e.path, type: 'created' });
      else if (old.etag !== e.etag || old.type !== e.type)
        out.push({ team, path: e.path, type: 'changed' });
      was.delete(e.path);
    }
    for (const gone of was.keys()) {
      if (!isSafePath(gone)) continue;
      this.forget(team, gone);
      out.push({ team, path: gone, type: 'deleted' });
    }
    return out;
  }

  /** Extension deactivation: no timer outlives the window. */
  dispose(): void {
    this.stopRootRefresh();
    this.watched.clear();
    this.probeUntil.clear(); // a probe round ends at its next turn
  }

  private teamById(workspaceId: string): Team | undefined {
    return this.deps.teams().find((t) => t.workspace.id === workspaceId);
  }

  async onEvent(frame: EventsServerFrame): Promise<void> {
    if (frame.type === 'fs-changed') {
      const team = this.teamById(frame.workspaceId);
      if (!team) return;
      // The runner's changes carry no kind: the PARENT folders VS Code shows are re-listed and
      // diffed (created / deleted per child; the Explorer ignores a `changed` on a folder). A path
      // whose folder is not listed gets `changed` only (an open editor re-reads it).
      const before = new Map<string, CachedStat[] | undefined>();
      const direct: FsChangeOut[] = [];
      for (const change of frame.changes) {
        if (!isSafePath(change.path)) continue;
        if (await this.isOwnEcho(team, change.path)) continue;
        const parent = parentOf(change.path);
        if (!before.has(parent)) {
          before.set(parent, this.listings.staleFolder(team.workspace.id, parent));
        }
        const hadListing = before.get(parent) !== undefined;
        this.forgetAbsent(team, change.path);
        this.forget(team, change.path, { keepBytes: change.kind !== 'deleted' });
        if (change.kind) direct.push({ team, path: change.path, type: change.kind });
        else if (!hadListing) direct.push({ team, path: change.path, type: 'changed' });
      }
      const listed = [...before.entries()].filter(([, v]) => v !== undefined).map(([k]) => k);
      if (listed.length === 0) {
        this.fire(dedupe(direct));
        return;
      }
      const diffs = await Promise.all(listed.map((dir) => this.relist(team, dir, before.get(dir))));
      this.fire(dedupe([...direct, ...diffs.flat()]));
      return;
    }
    if (frame.type === 'resync') {
      const team = this.teamById(frame.workspaceId);
      if (team) await this.resync(team);
      return;
    }
    // HQ says the machine runs: a team that refused is asked again (it may still be booting).
    if (
      (frame.type === 'workspace-state' || frame.type === 'subscribed') &&
      frame.state === 'running'
    ) {
      const team = this.teamById(frame.workspaceId);
      if (team) this.expectUp(team, { force: true });
    }
  }

  /** Our own save coming back on the stream: dropped when the file still has our etag. */
  private async isOwnEcho(team: Team, path: string): Promise<boolean> {
    const key = this.key(team, path);
    const own = this.ownWrites.get(key);
    if (!own) return false;
    if (this.now() - own.at > OWN_WRITE_MS) {
      this.ownWrites.delete(key);
      return false;
    }
    try {
      // Our own echo check is not a person's action: background.
      const s = await this.call(team, () => this.deps.api.stat(team, path, { background: true }));
      return s.etag === own.etag;
    } catch (err) {
      this.reportAuth(err);
      return false;
    }
  }

  /**
   * After any gap (changes were not seen): re-list every folder VS Code was shown and fire per
   * child, and `changed` for every file whose bytes we hold (an open editor re-reads it). The cache
   * is kept, not cleared: a team that is off right now still shows what it had (U23).
   */
  async resync(team: Team): Promise<void> {
    const id = team.workspace.id;
    const prefix = `${id}:`;
    for (const k of [...this.absent.keys()]) if (k.startsWith(prefix)) this.absent.delete(k);
    const files = this.contents
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    const folders = this.listings.cachedFolders(id);
    const before = new Map(folders.map((d) => [d, this.listings.staleFolder(id, d)]));
    // A held file's stat may be stale: the next stat asks (its folder's re-list refreshes it too).
    for (const f of files) this.listings.dropStat(id, f);
    await this.relistAndFire(team, folders, files, before);
  }

  /** Sign-out or revocation: nothing cached survives. */
  clear(): void {
    this.generation += 1;
    this.issues.clear();
    this.down.clear();
    this.probeUntil.clear();
    this.absent.clear();
    this.realNames.clear();
    this.shownOf.clear();
    this.suffixed.clear();
    this.servedFrom.clear();
    this.listings.clear();
    this.contents.clear();
    this.ownWrites.clear();
    this.etags.clear();
  }
}

/**
 * The account cannot make this request right now (signed out elsewhere, needs signing in again,
 * keychain busy, renewing): the service decides what to say; the file is Unavailable, never
 * "unreachable", and nothing was sent.
 */
function isAccountError(err: unknown): err is Error {
  return (
    err instanceof AccountGoneError ||
    err instanceof NeedsSignInError ||
    err instanceof SecretsBusyError ||
    err instanceof SlotRenewedError ||
    err instanceof RefreshNeedsRenewingError ||
    err instanceof RefreshBusyError
  );
}

function isThrottled(err: unknown): boolean {
  return err instanceof FsApiError && err.status === 429;
}

/** What HQ asked us to wait (`Retry-After` / `details.retryAfterSeconds`), bounded. */
function retryAfterMs(err: unknown): number {
  const s = err instanceof FsApiError ? err.details?.retryAfterSeconds : undefined;
  const sec = typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
  return Math.min(THROTTLE_WAIT_MAX_MS, Math.round(sec * 1000));
}

/** A path from the machine we may pass on: no `.`/`..`/empty segment (hostile names are cleaned). */
function isSafePath(path: string): boolean {
  return path === '' || !path.split('/').some(isDotSegment);
}

function dedupe(changes: FsChangeOut[]): FsChangeOut[] {
  const seen = new Set<string>();
  return changes.filter((c) => {
    const k = `${c.team.workspace.id}:${c.type}:${c.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
