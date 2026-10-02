/**
 * "This folder belongs to <email>, who is not signed in on this computer." with Sign in as
 * <email> (hq-vscode-multi-account decision 10), once per account, and gone again once that
 * account is signed in (live re-test #3, 2026-10-02: it stayed in the notification center).
 *
 * VS Code cannot dismiss an information or warning message from code. A PROGRESS notification is
 * dismissed when its task ends, and notification text renders Markdown links, which VS Code opens
 * with commands allowed. So the notice is a cancellable progress notification whose text carries a
 * `Sign in as <email>` link to `hq.signInAs`, and it ends when the account becomes usable (or the
 * person presses Cancel). An account nobody remembers gets the plain warning (nothing to sign in as).
 */
import * as vscode from 'vscode';
import { COPY } from './copy.js';
import type { UnavailableAccount } from './fs/hq-fs-provider.js';
import { notificationText } from './util/text.js';

/** A command URI argument: JSON, percent-encoded, and no `)` or `(` left to end the link early. */
function uriArg(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value)).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export class AccountNotices {
  /** tag → ends that account's notice. */
  private readonly open = new Map<string, () => void>();
  private readonly unknownSaid = new Set<string>();
  /** Accounts whose notice the person dismissed (review N1): not shown again until usable/removed. */
  private readonly dismissed = new Set<string>();
  /** 0.2.2 live: the extension host is shutting down; what it can no longer resolve is not news. */
  private disposed = false;

  say(info: UnavailableAccount): void {
    if (this.disposed) return;
    if (!info.email || !info.tag || !info.userId) {
      if (this.unknownSaid.has(info.key)) return;
      this.unknownSaid.add(info.key);
      void vscode.window.showWarningMessage(COPY.fsAccountUnknown);
      return;
    }
    const tag = info.tag;
    if (this.open.has(tag) || this.dismissed.has(tag)) return;
    // Security L1: every interpolated string is neutralized; only OUR link is a link.
    const text = notificationText(COPY.fsAccountGone(info.email));
    const label = notificationText(COPY.signInAsAction(info.email));
    const title = `${text} [${label}](command:hq.signInAs?${uriArg([tag, info.userId])})`;
    let end: () => void = () => undefined;
    const ended = new Promise<void>((r) => (end = r));
    this.open.set(tag, end);
    void Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => {
          token.onCancellationRequested(() => {
            this.dismissed.add(tag);
            end();
          });
          return ended;
        },
      ),
    ).then(() => {
      if (this.open.get(tag) === end) this.open.delete(tag);
    });
  }

  /** The account is usable now: its notice goes, and a dismissal of it is forgotten. */
  closeFor(tag: string): void {
    this.dismissed.delete(tag);
    this.open.get(tag)?.();
  }

  /** The account was removed: a later notice for it may show again. */
  forget(tag: string): void {
    this.dismissed.delete(tag);
  }

  dispose(): void {
    this.disposed = true;
    for (const end of this.open.values()) end();
    this.open.clear();
  }
}
