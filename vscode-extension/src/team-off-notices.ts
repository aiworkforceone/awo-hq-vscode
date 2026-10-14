/**
 * "<team> is off. Wake it to open this file." with Wake Team (FEATURE U23), once per team, and gone
 * again once the team serves files (live re-test #2, item 5, 2026-10-02: it stayed in the
 * notification center after the team was running).
 *
 * The same shape as the account notice (src/account-notices.ts): VS Code cannot dismiss a warning
 * message from code, so this is a cancellable progress notification whose text carries a `Wake Team`
 * link to `hq.wakeTeamOf`, and it ends when the team answers again (or the person presses Cancel).
 * The modal an editor shows for the file itself is VS Code's and is unchanged.
 */
import * as vscode from 'vscode';
import { COPY } from './copy.js';
import { notificationText } from './util/text.js';
import { copy } from '@kpa/shared/active-dev-brand';

/** A command URI argument: JSON, percent-encoded, and no `)` or `(` left to end the link early. */
function uriArg(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value)).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export class TeamOffNotices {
  /** `tag:workspaceId` → ends that team's notice. */
  private readonly open = new Map<string, () => void>();
  /** Teams whose notice the person dismissed: not shown again until the team runs. */
  private readonly dismissed = new Set<string>();

  say(tag: string, workspaceId: string, name: string, action: 'open' | 'save'): void {
    const key = `${tag}:${workspaceId}`;
    if (this.open.has(key) || this.dismissed.has(key)) return;
    // Security L1: the team name is neutralized; only OUR link is a link.
    const text = notificationText(action === 'open' ? COPY.fsOffOpen(name) : COPY.fsOffSave(name));
    const title = copy`${text} [${COPY.wakeTeam}](command:hq.wakeTeamOf?${uriArg([tag, workspaceId])})`;
    let end: () => void = () => undefined;
    const ended = new Promise<void>((r) => (end = r));
    this.open.set(key, end);
    void Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => {
          token.onCancellationRequested(() => {
            this.dismissed.add(key);
            end();
          });
          return ended;
        },
      ),
    ).then(() => {
      if (this.open.get(key) === end) this.open.delete(key);
    });
  }

  /** The team serves files again: its notice goes, and a dismissal of it is forgotten. */
  closeFor(tag: string, workspaceId: string): void {
    const key = `${tag}:${workspaceId}`;
    this.dismissed.delete(key);
    this.open.get(key)?.();
  }

  /** The account was removed: all of its teams' notices go. */
  forgetAccount(tag: string): void {
    for (const key of [...this.dismissed])
      if (key.startsWith(`${tag}:`)) this.dismissed.delete(key);
    for (const [key, end] of this.open) if (key.startsWith(`${tag}:`)) end();
  }

  dispose(): void {
    for (const end of this.open.values()) end();
    this.open.clear();
  }
}
