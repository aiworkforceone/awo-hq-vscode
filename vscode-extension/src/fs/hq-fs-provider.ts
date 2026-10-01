/**
 * `hq://<orgSlug>/<team-alias>/<path>` (FEATURE §7a, D7-D9, D12): VS Code's view of a team folder.
 * All the logic is in `fs-core.ts`; this file translates URIs, file types, permissions, events and
 * errors to VS Code's. Case-sensitive (the machine's disk is). Nothing from the folder is ever run.
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { cleanLabel } from '../util/text.js';
import { FsCoreError, type FsChangeOut, type HqFsCore } from './fs-core.js';

export const HQ_SCHEME = 'hq';

/** The team-relative path of an `hq://` URI ('' = the team root). */
export function relPathOf(uri: vscode.Uri): { alias: string; path: string } {
  const parts = uri.path.split('/').filter((p) => p.length > 0);
  const alias = parts.shift() ?? '';
  return { alias, path: parts.join('/') };
}

export function teamRootUri(team: Team): vscode.Uri {
  return vscode.Uri.from({ scheme: HQ_SCHEME, authority: team.org.slug, path: `/${team.alias}` });
}

export function teamFileUri(team: Team, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: HQ_SCHEME,
    authority: team.org.slug,
    path: path === '' ? `/${team.alias}` : `/${team.alias}/${path}`,
  });
}

function toType(t: 'file' | 'dir' | 'symlink'): vscode.FileType {
  if (t === 'dir') return vscode.FileType.Directory;
  if (t === 'symlink') return vscode.FileType.SymbolicLink;
  return vscode.FileType.File;
}

function toVsError(err: unknown, uri: vscode.Uri): Error {
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

export class HqFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private pending: vscode.FileChangeEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly core: HqFsCore) {
    core.onDidChange((changes) => this.queue(changes));
  }

  /** Coalesce 100 ms into one `FileChangeEvent[]` (FEATURE §7a). */
  private queue(changes: FsChangeOut[]): void {
    for (const c of changes) {
      this.pending.push({
        type:
          c.type === 'deleted'
            ? vscode.FileChangeType.Deleted
            : c.type === 'created'
              ? vscode.FileChangeType.Created
              : vscode.FileChangeType.Changed,
        uri: teamFileUri(c.team, c.path),
      });
    }
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = [];
      if (batch.length > 0) this.emitter.fire(batch);
    }, 100);
  }

  private resolve(uri: vscode.Uri): { team: Team; path: string } {
    const { alias, path } = relPathOf(uri);
    return { team: this.core.team(uri.authority, alias), path };
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    try {
      const { team } = this.resolve(uri);
      const sub = this.core.watch(team);
      return new vscode.Disposable(() => sub.dispose());
    } catch {
      return new vscode.Disposable(() => undefined);
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const { team, path } = this.resolve(uri);
      const s = await this.core.stat(team, path);
      return {
        type: toType(s.type),
        ctime: s.mtimeMs,
        mtime: s.mtimeMs,
        size: s.size,
        ...(s.readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
      };
    } catch (err) {
      throw toVsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const { team, path } = this.resolve(uri);
      return (await this.core.readDirectory(team, path)).map(([n, t]) => [n, toType(t)]);
    } catch (err) {
      throw toVsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { team, path } = this.resolve(uri);
      return await this.core.readFile(team, path);
    } catch (err) {
      throw toVsError(err, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    try {
      const { team, path } = this.resolve(uri);
      await this.core.writeFile(team, path, content, options);
    } catch (err) {
      throw toVsError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const { team, path } = this.resolve(uri);
      await this.core.createDirectory(team, path);
    } catch (err) {
      throw toVsError(err, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    try {
      const { team, path } = this.resolve(uri);
      await this.core.delete(team, path, options.recursive);
    } catch (err) {
      throw toVsError(err, uri);
    }
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    try {
      const from = this.resolve(oldUri);
      const to = this.resolve(newUri);
      if (from.team.workspace.id !== to.team.workspace.id) {
        throw new FsCoreError('no-permissions', COPY.fsViewOnly);
      }
      await this.core.rename(from.team, from.path, to.path, options.overwrite);
    } catch (err) {
      throw toVsError(err, oldUri);
    }
  }

  dispose(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.emitter.dispose();
  }
}

/** The Explorer folder name for a team: "<team> (<org>)". */
export function teamFolderName(team: Team): string {
  return COPY.teamFolderName(
    cleanLabel(team.workspace.name) || team.alias,
    cleanLabel(team.org.name) || team.org.slug,
  );
}
