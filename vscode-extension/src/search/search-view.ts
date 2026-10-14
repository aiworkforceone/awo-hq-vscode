/**
 * "HQ: Search in Team Files" (FEATURE D10, F8): ripgrep on the team machine, results in the HQ
 * Search view (file → matching lines). Previews arrive masked and re-matched on the server (a query
 * for a secret finds nothing); they are cleaned again here before display. Clicking a line opens the
 * file over `hq://` at the match.
 *
 * Every result carries the ACCOUNT that searched (hq-vscode-multi-account §6): opening a hit reads
 * it as that account, under the form the team's folder is open in (decision 24), never the active
 * account.
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import type { FsSearchMatch, FsSearchTextResponse } from '@kpa/shared/remote-fs.types';
import { COPY } from '../copy.js';
import type { AccountRef } from '../hq/account-ref.js';
import { cleanLabel } from '../util/text.js';
import { hasControlChars } from '../fs/fs-core.js';
import { brandText } from '@kpa/shared/active-dev-brand';

export type SearchNode =
  | { kind: 'summary'; text: string }
  | {
      kind: 'file';
      account: AccountRef;
      team: Team;
      path: string;
      matches: FsSearchMatch[];
      /** The path the Explorer shows (twins differ by their ~hash), set by `withShownPaths`. */
      shown?: string;
    }
  | { kind: 'match'; account: AccountRef; team: Team; match: FsSearchMatch };

/** Group matches by file, in the order the machine found them. */
export function groupByFile(
  account: AccountRef,
  team: Team,
  res: FsSearchTextResponse,
): SearchNode[] {
  const byPath = new Map<string, FsSearchMatch[]>();
  for (const m of res.matches) {
    const list = byPath.get(m.path) ?? [];
    list.push(m);
    byPath.set(m.path, list);
  }
  const summary: SearchNode = {
    kind: 'summary',
    text:
      res.matches.length === 0
        ? COPY.searchNone
        : COPY.searchResults(res.matches.length, res.truncated),
  };
  return [
    summary,
    ...[...byPath.entries()].map(([path, matches]) => ({
      kind: 'file' as const,
      account,
      team,
      path,
      matches,
    })),
  ];
}

/**
 * Label each file with the path the Explorer shows (`HqFsCore.shownPath`): two hostile twins whose
 * server paths clean to the same text read differently, by their ~hash (train 42 re-test).
 */
export async function withShownPaths(
  nodes: SearchNode[],
  shownPath: (team: Team, realPath: string) => Promise<string>,
): Promise<SearchNode[]> {
  return Promise.all(
    nodes.map(async (n) =>
      n.kind === 'file' ? { ...n, shown: await shownPath(n.team, n.path).catch(() => n.path) } : n,
    ),
  );
}

/** Globs typed as "a, b" → ["a", "b"] (empty entries dropped). */
export function parseGlobs(text: string | undefined): string[] {
  return (text ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

export class SearchView implements vscode.TreeDataProvider<SearchNode> {
  private readonly changed = new vscode.EventEmitter<SearchNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: SearchNode[] = [];

  show(nodes: SearchNode[]): void {
    this.roots = nodes;
    this.changed.fire(undefined);
  }

  clear(): void {
    this.show([]);
  }

  /** An account signed out: its results go (another account's stay). */
  clearAccount(isIt: (account: AccountRef) => boolean): void {
    if (this.roots.some((n) => n.kind === 'file' && isIt(n.account))) this.clear();
  }

  getChildren(node?: SearchNode): SearchNode[] {
    if (!node) return this.roots;
    if (node.kind === 'file') {
      return node.matches.map((match) => ({
        kind: 'match' as const,
        account: node.account,
        team: node.team,
        match,
      }));
    }
    return [];
  }

  getTreeItem(node: SearchNode): vscode.TreeItem {
    if (node.kind === 'summary') {
      const item = new vscode.TreeItem(node.text);
      item.contextValue = 'search:summary';
      return item;
    }
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(
        cleanLabel(node.shown ?? node.path),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(node.matches.length);
      item.iconPath = new vscode.ThemeIcon('file');
      item.contextValue = 'search:file';
      return item;
    }
    const m = node.match;
    const item = new vscode.TreeItem(cleanLabel(m.preview).trim() || `${m.line}`);
    item.description = `${m.line}`;
    item.contextValue = 'search:match';
    item.command = {
      command: brandText('hq.search.open'),
      title: COPY.searchTitle,
      arguments: [node],
    };
    return item;
  }
}

/** How a hit of ONE account becomes a URI: its shown path, and the form its folder is open in. */
export interface MatchOpener {
  shownPath(team: Team, realPath: string): Promise<string>;
  uriOf(team: Team, shownPath: string): vscode.Uri;
}

/**
 * Open a match's file at its line (the column is the preview's, so only the line is exact). The URI
 * is built from the path the Explorer SHOWS (W4: `HqFsCore.shownPath`), so a file with a cleaned
 * name has one URI, not two, and in the form its team's folder is open in (decision 24).
 */
export async function openMatch(node: SearchNode, opener: MatchOpener | null): Promise<void> {
  if (node.kind !== 'match') return;
  if (hasControlChars(node.match.path)) {
    void vscode.window.showWarningMessage(COPY.fsControlName);
    return;
  }
  if (!opener) return; // the account that searched is not signed in any more
  const uri = opener.uriOf(node.team, await opener.shownPath(node.team, node.match.path));
  const line = Math.max(0, node.match.line - 1);
  await vscode.window.showTextDocument(uri, {
    selection: new vscode.Range(line, 0, line, 0),
    preview: true,
  });
}
