/**
 * Bring back what VS Code gave up on while an account was not usable here (hq-vscode-multi-account
 * U23, nonprod 2026-10-02). A workspace root whose first `stat`/`readDirectory` failed stays "!" and
 * an editor whose read failed stays on "could not be opened": VS Code re-resolves NEITHER on a
 * `FileChangeType.Changed` (decision 25's armed watch), only on an explicit refresh or a reopen.
 *
 * So when an account becomes usable (signed in, or back to `ok` from any other health):
 *   - the Explorer is refreshed when one of the window's folders belongs to it (harmless: it only
 *     re-lists);
 *   - a TEXT tab is closed and opened again only when the provider REFUSED its URI and its document
 *     never loaded. ⛔ A loaded tab is never touched: closing it would throw away its undo history,
 *     cursor, scroll and folding. Never a tab with unsaved changes, never another account's.
 *   - the reopened tab keeps its group and preview state, takes focus only when it was the active
 *     tab of the active group, and is pinned again when it was pinned and active.
 *
 * Not revived (documented): tab ORDER (a reopened tab lands at the end of its group), diff tabs
 * and custom editors (their inputs carry no single text URI); a pinned tab that was not the active
 * one comes back unpinned (VS Code pins only the active editor).
 */
import * as vscode from 'vscode';

export interface ReviveTarget {
  /** Does this URI belong to the account that became usable? */
  belongs(uri: vscode.Uri): boolean;
  /** Did the provider refuse this URI (Unavailable) with no successful read since? */
  refused(uri: vscode.Uri): boolean;
  /** A reopen of this URI was attempted (review N3 counts them). */
  reopened?(uri: vscode.Uri): void;
}

export async function reviveAccountViews(
  t: ReviveTarget,
): Promise<{ explorer: boolean; reopened: number }> {
  const explorer = (vscode.workspace.workspaceFolders ?? []).some((f) => t.belongs(f.uri));
  if (explorer) {
    await Promise.resolve(
      vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer'),
    ).catch(() => undefined);
  }
  const loaded = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
  let reopened = 0;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of [...group.tabs]) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const uri = tab.input.uri;
      if (tab.isDirty || loaded.has(uri.toString()) || !t.belongs(uri) || !t.refused(uri)) {
        continue;
      }
      const focus = group.isActive && tab.isActive;
      t.reopened?.(uri);
      try {
        await vscode.window.tabGroups.close(tab, true);
        await vscode.commands.executeCommand('vscode.open', uri, {
          viewColumn: group.viewColumn,
          preview: tab.isPreview,
          preserveFocus: !focus,
        });
        if (focus && tab.isPinned) {
          await vscode.commands.executeCommand('workbench.action.pinEditor');
        }
        reopened += 1;
      } catch {
        /* a tab that cannot come back stays closed; the Explorer still lists the file */
      }
    }
  }
  return { explorer, reopened };
}

/**
 * At most one revive per account in `windowMs` (a flapping account must not churn the tabs), but
 * never a dropped one: a request inside the window runs once, at its end (an account revoked and
 * signed in again within 30 s still gets its failed tabs back).
 */
export class ReviveGate {
  /** When the account's last revive ran, or is planned to run. */
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** How long to wait before reviving `tag`; null when a revive is already planned. */
  schedule(tag: string): number | null {
    const now = this.now();
    const last = this.last.get(tag);
    // `>=`: a request in the same millisecond as a planned (or just started) revive is that one.
    if (last !== undefined && last >= now) return null;
    const at = last === undefined ? now : Math.max(now, last + this.windowMs);
    this.last.set(tag, at);
    return at - now;
  }
}
