/**
 * The Account view: every HQ account signed in on this editor and host (hq-vscode-multi-account
 * §Wireframes), the one THIS window uses marked "Active in this window", a Sign out beside each
 * (inline), HQ web's Account → Devices under each (this editor's grant is one row there, beside the
 * CLI's), then Add another account and the host. Host-scoped, not window-scoped: it never goes blank
 * because this window's own pick was signed out elsewhere.
 *
 * An account whose sign-in cannot be used here (decision 18's zombie) says "Sign in again", and
 * clicking it renews that account.
 */
import * as vscode from 'vscode';
import { COPY } from '../copy.js';
import type { AccountRef } from '../hq/account-ref.js';
import type { AccountBundle, HqAccounts } from '../hq/accounts.js';
import { cleanLabel } from '../util/text.js';
import { brandText } from '@kpa/shared/active-dev-brand';

export type AccountNode =
  | { kind: 'account'; ref: AccountRef; email: string }
  | { kind: 'devices'; ref: AccountRef; email: string }
  | { kind: 'addAccount' }
  | { kind: 'host' };

export class AccountTree implements vscode.TreeDataProvider<AccountNode> {
  private readonly changed = new vscode.EventEmitter<AccountNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly accounts: Pick<HqAccounts, 'list' | 'active' | 'get' | 'host' | 'onDidChange'>,
  ) {
    accounts.onDidChange(() => this.changed.fire(undefined));
  }

  /** Active first, then by email (never by recency). */
  private ordered(): AccountBundle[] {
    const active = this.accounts.active();
    const rest = this.accounts.list().filter((b) => b !== active);
    return active ? [active, ...rest] : rest;
  }

  getChildren(node?: AccountNode): AccountNode[] {
    if (node?.kind === 'account') return [{ kind: 'devices', ref: node.ref, email: node.email }];
    if (node) return [];
    const all = this.ordered();
    if (all.length === 0) return [];
    return [
      ...all.map((b) => ({ kind: 'account' as const, ref: b.ref, email: b.email })),
      { kind: 'addAccount' },
      { kind: 'host' },
    ];
  }

  getTreeItem(node: AccountNode): vscode.TreeItem {
    switch (node.kind) {
      case 'account': {
        const b = this.accounts.get(node.ref);
        const active = b !== null && this.accounts.active() === b;
        const item = new vscode.TreeItem(
          cleanLabel(node.email),
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('account');
        item.contextValue = active ? 'account:active' : 'account:other';
        if (b?.health === 'needs-sign-in') {
          item.description = COPY.needsSignInDescription;
          item.command = {
            command: brandText('hq.renewAccount'),
            title: COPY.needsSignInDescription,
            arguments: [node.ref],
          };
        } else if (active) {
          item.description = COPY.accountActiveNote;
        } else {
          // Clicking another account's row makes it this window's (MA-U9). The active row does
          // nothing: it must not pretend to.
          item.command = {
            command: brandText('hq.switchAccount'),
            title: COPY.pickAccount,
            arguments: [node.ref],
          };
        }
        return item;
      }
      case 'devices': {
        const item = new vscode.TreeItem(COPY.manageDevices);
        item.iconPath = new vscode.ThemeIcon('link-external');
        item.tooltip = COPY.manageDevicesBrowserNote(cleanLabel(node.email));
        item.command = { command: brandText('hq.manageDevices'), title: COPY.manageDevices };
        return item;
      }
      case 'addAccount': {
        const item = new vscode.TreeItem(COPY.addAnotherAccount);
        item.iconPath = new vscode.ThemeIcon('add');
        item.command = { command: brandText('hq.addAccount'), title: COPY.addAnotherAccount };
        return item;
      }
      case 'host': {
        const item = new vscode.TreeItem(COPY.accountHost(this.accounts.host() ?? ''));
        item.iconPath = new vscode.ThemeIcon('globe');
        return item;
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
