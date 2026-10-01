/**
 * The Account view: who is signed in, to which HQ, and the two actions that manage it: sign out, and
 * HQ web's Account → Devices (this editor's grant is one row there, beside the CLI's). No device
 * list is built into the extension: one place to manage the same list.
 */
import * as vscode from 'vscode';
import { COPY } from '../copy.js';
import type { HqService } from '../hq/hq-service.js';
import { cleanLabel } from '../util/text.js';

type AccountNode = { kind: 'user' | 'host' | 'devices' | 'signOut' };

export class AccountTree implements vscode.TreeDataProvider<AccountNode> {
  private readonly changed = new vscode.EventEmitter<AccountNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly service: HqService) {
    service.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: AccountNode): AccountNode[] {
    if (node || !this.service.signedIn()) return [];
    return [{ kind: 'user' }, { kind: 'host' }, { kind: 'devices' }, { kind: 'signOut' }];
  }

  getTreeItem(node: AccountNode): vscode.TreeItem {
    const account = this.service.account();
    switch (node.kind) {
      case 'user': {
        const item = new vscode.TreeItem(cleanLabel(account?.user.email ?? ''));
        item.description = cleanLabel(account?.user.name ?? '');
        item.iconPath = new vscode.ThemeIcon('account');
        return item;
      }
      case 'host': {
        const item = new vscode.TreeItem(COPY.accountHost(this.service.host() ?? ''));
        item.iconPath = new vscode.ThemeIcon('globe');
        return item;
      }
      case 'devices': {
        const item = new vscode.TreeItem(COPY.manageDevices);
        item.iconPath = new vscode.ThemeIcon('link-external');
        item.command = { command: 'hq.manageDevices', title: COPY.manageDevices };
        return item;
      }
      case 'signOut': {
        const item = new vscode.TreeItem(COPY.signOut);
        item.iconPath = new vscode.ThemeIcon('sign-out');
        item.command = { command: 'hq.signOut', title: COPY.signOut };
        return item;
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
