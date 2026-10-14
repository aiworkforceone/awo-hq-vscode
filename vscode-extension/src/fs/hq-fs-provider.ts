/**
 * `hq://<tag>@<orgSlug>/<team-alias>/<path>` (FEATURE §7a, D7-D9, D12; hq-vscode-multi-account
 * decisions 9, 10, 24, 25): VS Code's view of a team folder. All the file logic is in each account's
 * `fs-core.ts`; this file routes a URI to ITS account and translates types, events and errors.
 *
 *   routing    the authority is parsed strictly (`parseHqAuthority`): a tag picks one of the
 *              accounts signed in here; an untagged (0.1.x) authority picks the 0.1.x USER, never
 *              the active account. Unknown, removed, malformed or colliding: `Unavailable`, one
 *              notice ("belongs to <email>" with Sign in as), and ZERO requests.
 *   one form   the 0.1.x user's changes go out for both authority forms while an untagged folder of
 *              that org is open, and `uriFor` reuses an open folder's form, so one file is never
 *              two documents (decision 24).
 *   deferred   a watch on a folder whose account is not here yet is remembered by tag and armed
 *              when the account appears, with `Changed` on the watched URI so the Explorer and open
 *              editors re-read (decision 25). A removed account's watches go back to waiting.
 *
 * Case-sensitive (the machine's disk is). Nothing from the folder is ever run.
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { accountTag, type AccountRef } from '../hq/account-ref.js';
import type { AccountBundle, HqAccounts } from '../hq/accounts.js';
import { cleanLabel } from '../util/text.js';
import { FsCoreError, type FsChangeOut } from './fs-core.js';
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';

/** The team-files URI scheme: the build's brand's (`hq` for AWO). */
export const HQ_SCHEME = ACTIVE_DEV_BRAND.vscode.fsScheme;
/**
 * 0.2.2 live: how long an fs call waits for the accounts to load at activation before an authority
 * that does not resolve is answered as gone (with its notice).
 */
export const ACCOUNTS_READY_MS = 5_000;
/** Review N3: a refused URI is reopened at most this often per usable/reachable episode. */
export const MAX_REOPENS = 2;

/** The team-relative path of an `hq://` URI ('' = the team root). */
export function relPathOf(uri: vscode.Uri): { alias: string; path: string } {
  const parts = uri.path.split('/').filter((p) => p.length > 0);
  const alias = parts.shift() ?? '';
  return { alias, path: parts.join('/') };
}

function teamPathOf(team: Team, path: string): string {
  return path === '' ? `/${team.alias}` : `/${team.alias}/${path}`;
}

/** A new folder's root: always tagged (decision 9). */
export function teamRootUri(ref: AccountRef, team: Team): vscode.Uri {
  return teamFileUri(ref, team, '');
}

export function teamFileUri(ref: AccountRef, team: Team, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: HQ_SCHEME,
    authority: `${accountTag(ref.host, ref.userId)}@${team.org.slug}`,
    path: teamPathOf(team, path),
  });
}

/** Is an untagged (0.1.x) folder of this team, or of any team of `orgSlug`, open in the window? */
function untaggedFolderOpen(orgSlug: string, alias?: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    (f) =>
      f.uri.scheme === HQ_SCHEME &&
      f.uri.authority === orgSlug &&
      (alias === undefined || relPathOf(f.uri).alias === alias),
  );
}

/**
 * Decision 24: ONE form per open team. The 0.1.x user's file opens under the untagged form when an
 * untagged folder of that team is open (search hits, wake notices, Open Team Files).
 */
export function uriFor(
  b: Pick<AccountBundle, 'tag'>,
  team: Team,
  path: string,
  isLegacyUser: boolean,
): vscode.Uri {
  const untagged = isLegacyUser && untaggedFolderOpen(team.org.slug, team.alias);
  return vscode.Uri.from({
    scheme: HQ_SCHEME,
    authority: untagged ? team.org.slug : `${b.tag}@${team.org.slug}`,
    path: teamPathOf(team, path),
  });
}

/** Every root a team of this account may show under: tagged, plus untagged for the 0.1.x user. */
export function rootsFor(
  b: Pick<AccountBundle, 'tag'>,
  team: Team,
  isLegacyUser: boolean,
): vscode.Uri[] {
  const path = teamPathOf(team, '');
  const tagged = vscode.Uri.from({
    scheme: HQ_SCHEME,
    authority: `${b.tag}@${team.org.slug}`,
    path,
  });
  if (!isLegacyUser) return [tagged];
  return [tagged, vscode.Uri.from({ scheme: HQ_SCHEME, authority: team.org.slug, path })];
}

function toType(t: 'file' | 'dir' | 'symlink'): vscode.FileType {
  if (t === 'dir') return vscode.FileType.Directory;
  if (t === 'symlink') return vscode.FileType.SymbolicLink;
  return vscode.FileType.File;
}

function toVsError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof vscode.FileSystemError) return err;
  if (!(err instanceof FsCoreError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.kind) {
    case 'not-found':
      return vscode.FileSystemError.FileNotFound(uri);
    case 'exists':
      return vscode.FileSystemError.FileExists(uri);
    case 'no-permissions':
      return vscode.FileSystemError.NoPermissions(err.message);
    case 'not-a-dir':
      return vscode.FileSystemError.FileNotADirectory(uri);
    case 'is-a-dir':
      return vscode.FileSystemError.FileIsADirectory(uri);
    case 'too-large':
      return vscode.FileSystemError.NoPermissions(err.message);
    default:
      return vscode.FileSystemError.Unavailable(err.message);
  }
}

/** A folder whose account is not signed in here: who it belongs to, if known (tombstone). */
export interface UnavailableAccount {
  /** The tag, or 'legacy', or `invalid:<authority>`: one notice per key. */
  key: string;
  email: string | null;
  tag: string | null;
  userId: string | null;
}

export interface FsProviderDeps {
  accounts: HqAccounts;
  /** Say once that this folder's account is not here (with Sign in as <email> when known). */
  onUnavailable(info: UnavailableAccount): void;
}

interface Watch {
  uri: vscode.Uri;
  /** The account it is armed on (null while deferred). */
  tag: string | null;
  sub: { dispose(): void } | null;
  /** It waited for its account: arming it fires `Changed` on its URI. */
  waited: boolean;
}

export class HqFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private pending: vscode.FileChangeEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly watches = new Set<Watch>();
  private readonly attached = new WeakSet<AccountBundle>();
  /**
   * Review W1: URIs this provider answered Unavailable, per account tag, until a read of them
   * succeeds. Only those tabs are ever re-opened when their account comes back.
   */
  private readonly refused = new Map<string, Set<string>>();
  private readonly reachableEmitter = new vscode.EventEmitter<string>();
  /**
   * A team with URIs this provider refused answered again (live re-test #2: a tab refused while its
   * team was asleep): the account's views may be revived now. Fires with the account's tag.
   */
  readonly onRefusedReachable = this.reachableEmitter.event;
  private readonly teamUpEmitter = new vscode.EventEmitter<{ tag: string; workspaceId: string }>();
  /** A team that refused because it was off (or updating) serves again (its notice may close). */
  readonly onTeamUp = this.teamUpEmitter.event;
  /** `tag:workspaceId` → the state the account's listing last gave the team. */
  private readonly listedState = new Map<string, string>();
  private readonly reachableCheck = new Set<string>();
  /** `tag:workspaceId` whose answer was a team-up (already signalled): no second signal for it. */
  private readonly upSignalled = new Set<string>();
  /** Review N3: revive reopens per refused URI in this episode (2 at most, then left alone). */
  private readonly reopens = new Map<string, number>();
  private readonly subscriptions: Array<{ dispose(): unknown }> = [];

  constructor(private readonly deps: FsProviderDeps) {
    for (const b of deps.accounts.list()) this.attach(b);
    this.subscriptions.push(
      deps.accounts.onAccountAdded((b) => {
        this.attach(b);
        this.armWaiting();
      }),
      deps.accounts.onAccountRemoved((ref) => this.disarm(accountTag(ref.host, ref.userId))),
      // A listing arrived, or an account's health changed: a waiting watch may resolve now.
      deps.accounts.onDidChange(() => {
        this.armWaiting();
        this.noteListedStates();
      }),
    );
    this.noteListedStates();
  }

  /**
   * ALSO-2 (live re-test, round 3): a team the listing now gives as running (or starting) that was
   * listed otherwise before: its core asks it again if it refused, since VS Code never re-reads a
   * failed root or tab by itself (a folder added while the team had no machine stayed empty).
   */
  private noteListedStates(): void {
    for (const b of this.deps.accounts.list()) {
      for (const team of b.service.teams()) {
        const key = `${b.tag}:${team.workspace.id}`;
        const prior = this.listedState.get(key);
        const now = team.workspace.state;
        this.listedState.set(key, now);
        if (prior !== undefined && prior !== now && (now === 'running' || now === 'starting')) {
          b.core.expectUp(team, { force: true });
        }
      }
    }
  }

  /** Each account's changes, under its own tag (and the bare form for the 0.1.x user). */
  private attach(b: AccountBundle): void {
    if (this.attached.has(b)) return;
    this.attached.add(b);
    b.core.onDidChange((changes) => this.queue(b, changes));
    b.core.onTeamAnswered((team) => this.teamAnswered(b, team));
    b.core.onTeamUp((team) => this.teamUp(b, team));
  }

  /**
   * The team serves again after refusing (live re-test #2, round 3): the reopens spent while it was
   * off or still booting do not count, and the account's views are revived (the failed tabs, and
   * the Explorer, whose failed root VS Code does not re-read by itself).
   */
  private teamUp(b: AccountBundle, team: Team): void {
    for (const u of this.refused.get(b.tag) ?? []) {
      if (this.underTeam(b.tag, team, u)) this.reopens.delete(u);
    }
    const key = `${b.tag}:${team.workspace.id}`;
    this.upSignalled.add(key);
    // `teamAnswered`'s check of this same answer was queued first and runs before this one.
    setTimeout(() => this.upSignalled.delete(key), 0);
    this.teamUpEmitter.fire({ tag: b.tag, workspaceId: team.workspace.id });
    this.reachableEmitter.fire(b.tag);
  }

  /** Is this URI in this team's folder (either authority form)? */
  private underTeam(tag: string, team: Team, u: string): boolean {
    return [`${tag}@${team.org.slug}`, team.org.slug]
      .map((a) => `${HQ_SCHEME}://${a}/${team.alias}`)
      .some((r) => u === r || u.startsWith(`${r}/`));
  }

  /** The account a URI names (present, or only remembered), or null. */
  private tagOf(uri: vscode.Uri): string | null {
    const r = this.deps.accounts.resolveAuthority(uri.authority);
    return r.kind === 'ok' ? r.bundle.tag : r.tag;
  }

  private refuse(err: Error, uri: vscode.Uri): Error {
    const tag = (err as { code?: unknown }).code === 'Unavailable' ? this.tagOf(uri) : null;
    if (tag) {
      const set = this.refused.get(tag) ?? new Set<string>();
      set.add(uri.toString());
      this.refused.set(tag, set);
    }
    return err;
  }

  private served(uri: vscode.Uri): void {
    for (const set of this.refused.values()) set.delete(uri.toString());
    this.reopens.delete(uri.toString());
  }

  /** Still worth reopening: refused, and fewer than 2 revive attempts this episode. */
  private eligible(u: string): boolean {
    return (this.reopens.get(u) ?? 0) < MAX_REOPENS;
  }

  /** A revive reopened this URI (counted whatever the read then answers). */
  noteReopened(uri: vscode.Uri): void {
    const u = uri.toString();
    this.reopens.set(u, (this.reopens.get(u) ?? 0) + 1);
  }

  /** A new episode (the account became usable): its refused URIs may be tried again. */
  resetReopens(tag: string): void {
    for (const u of this.refused.get(tag) ?? []) this.reopens.delete(u);
  }

  /** Does this account have refused URIs under this team (either authority form)? */
  private refusedUnder(tag: string, team: Team): boolean {
    const set = this.refused.get(tag);
    if (!set || set.size === 0) return false;
    return [...set].some((u) => this.eligible(u) && this.underTeam(tag, team, u));
  }

  /** Checked a tick later, so the read that just served (and cleared) its own URI is not news. */
  private teamAnswered(b: AccountBundle, team: Team): void {
    const key = `${b.tag}:${team.workspace.id}`;
    if (this.reachableCheck.has(key)) return;
    this.reachableCheck.add(key);
    setTimeout(() => {
      this.reachableCheck.delete(key);
      if (this.upSignalled.delete(key)) return; // the same answer was a team-up: said already
      if (this.refusedUnder(b.tag, team)) this.reachableEmitter.fire(b.tag);
    }, 0);
  }

  /** Does this account have any refused URI left? */
  hasRefused(tag: string): boolean {
    return [...(this.refused.get(tag) ?? [])].some((u) => this.eligible(u));
  }

  /** Was this URI refused (Unavailable) with no successful read since? */
  isRefused(uri: vscode.Uri): boolean {
    const tag = this.tagOf(uri);
    const u = uri.toString();
    return tag !== null && (this.refused.get(tag)?.has(u) ?? false) && this.eligible(u);
  }

  /** Coalesce 100 ms into one `FileChangeEvent[]` (FEATURE §7a). */
  private queue(b: AccountBundle, changes: FsChangeOut[]): void {
    const legacy = this.deps.accounts.isLegacyUser(b);
    for (const c of changes) {
      const type =
        c.type === 'deleted'
          ? vscode.FileChangeType.Deleted
          : c.type === 'created'
            ? vscode.FileChangeType.Created
            : vscode.FileChangeType.Changed;
      const path = teamPathOf(c.team, c.path);
      const authorities = [`${b.tag}@${c.team.org.slug}`];
      if (legacy && untaggedFolderOpen(c.team.org.slug)) authorities.push(c.team.org.slug);
      for (const authority of authorities) {
        this.pending.push({ type, uri: vscode.Uri.from({ scheme: HQ_SCHEME, authority, path }) });
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = [];
      if (batch.length > 0) this.emitter.fire(batch);
    }, 100);
  }

  /**
   * The account and team a URI names, or Unavailable (zero requests, one notice). 0.2.2 live: during
   * activation a call waits (bounded) for the accounts to load instead of answering gone, and once
   * they closed (the extension host is shutting down) it is refused with no notice.
   */
  private async resolve(
    uri: vscode.Uri,
  ): Promise<{ bundle: AccountBundle; team: Team; path: string }> {
    const accounts = this.deps.accounts;
    let r = accounts.resolveAuthority(uri.authority);
    if (r.kind === 'gone' && !accounts.isReady() && !accounts.isDisposed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        accounts.whenReady(),
        new Promise<void>((done) => (timer = setTimeout(done, ACCOUNTS_READY_MS))),
      ]);
      clearTimeout(timer);
      r = accounts.resolveAuthority(uri.authority);
    }
    if (r.kind === 'gone') {
      if (!accounts.isDisposed()) this.deps.onUnavailable(r);
      throw vscode.FileSystemError.Unavailable(
        r.email ? COPY.fsAccountGone(r.email) : COPY.fsAccountUnknown,
      );
    }
    const { alias, path } = relPathOf(uri);
    return { bundle: r.bundle, team: r.bundle.core.team(r.orgSlug, alias), path };
  }

  /** Arm `w` on its account's core when that account and team resolve; quietly wait otherwise. */
  private arm(w: Watch): void {
    if (w.sub) return;
    const r = this.deps.accounts.resolveAuthority(w.uri.authority);
    if (r.kind !== 'ok') return;
    let team: Team;
    try {
      team = r.bundle.core.team(r.orgSlug, relPathOf(w.uri).alias);
    } catch {
      return; // the team is not in this account's listing (yet)
    }
    w.sub = r.bundle.core.watch(team);
    w.tag = r.bundle.tag;
    if (w.waited) {
      w.waited = false;
      this.pending.push({ type: vscode.FileChangeType.Changed, uri: w.uri });
      this.scheduleFlush();
    }
  }

  private armWaiting(): void {
    for (const w of this.watches) if (!w.sub) this.arm(w);
  }

  /** The account went: its watches wait for it again. */
  private disarm(tag: string): void {
    for (const w of this.watches) {
      if (w.tag !== tag) continue;
      w.sub?.dispose();
      w.sub = null;
      w.tag = null;
      w.waited = true;
    }
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const w: Watch = { uri, tag: null, sub: null, waited: false };
    this.watches.add(w);
    this.arm(w);
    if (!w.sub) w.waited = true;
    return new vscode.Disposable(() => {
      w.sub?.dispose();
      w.sub = null;
      this.watches.delete(w);
    });
  }

  /** Deferred watches waiting for an account (test seam and diagnostics). */
  waitingWatches(): number {
    return [...this.watches].filter((w) => !w.sub).length;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const { bundle, team, path } = await this.resolve(uri);
      const s = await bundle.core.stat(team, path);
      return {
        type: toType(s.type),
        ctime: s.mtimeMs,
        mtime: s.mtimeMs,
        size: s.size,
        ...(s.readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
      };
    } catch (err) {
      throw this.refuse(toVsError(err, uri), uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const { bundle, team, path } = await this.resolve(uri);
      const entries = (await bundle.core.readDirectory(team, path)).map(
        ([n, t]): [string, vscode.FileType] => [n, toType(t)],
      );
      this.served(uri);
      return entries;
    } catch (err) {
      throw this.refuse(toVsError(err, uri), uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { bundle, team, path } = await this.resolve(uri);
      const bytes = await bundle.core.readFile(team, path);
      this.served(uri);
      return bytes;
    } catch (err) {
      throw this.refuse(toVsError(err, uri), uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    try {
      const { bundle, team, path } = await this.resolve(uri);
      await bundle.core.writeFile(team, path, content, options);
    } catch (err) {
      throw this.refuse(toVsError(err, uri), uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const { bundle, team, path } = await this.resolve(uri);
      await bundle.core.createDirectory(team, path);
    } catch (err) {
      throw this.refuse(toVsError(err, uri), uri);
    }
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    try {
      const { bundle, team, path } = await this.resolve(uri);
      await bundle.core.delete(team, path, options.recursive);
    } catch (err) {
      throw this.refuse(toVsError(err, uri), uri);
    }
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    try {
      const from = await this.resolve(oldUri);
      const to = await this.resolve(newUri);
      // Same account AND same team: VS Code falls back to copy + delete otherwise, each half under
      // its own account (decision 11).
      if (from.bundle !== to.bundle || from.team.workspace.id !== to.team.workspace.id) {
        throw new FsCoreError('no-permissions', COPY.fsViewOnly);
      }
      await from.bundle.core.rename(from.team, from.path, to.path, options.overwrite);
    } catch (err) {
      throw this.refuse(toVsError(err, oldUri), oldUri);
    }
  }

  dispose(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    for (const w of this.watches) w.sub?.dispose();
    this.watches.clear();
    for (const s of this.subscriptions) s.dispose();
    this.emitter.dispose();
    this.reachableEmitter.dispose();
    this.teamUpEmitter.dispose();
  }
}

/** The Explorer folder name for a team: "<team> (<org>)", plus the account's short label (decision 21). */
export function teamFolderName(team: Team, label?: string): string {
  return COPY.teamFolderName(
    cleanLabel(team.workspace.name) || team.alias,
    cleanLabel(team.org.name) || team.org.slug,
    label,
  );
}
