/**
 * The Teams view (D3): org → team (running / starting / off, "update needed") → sessions (owner or
 * "you", "view only", engine). Orgs without Developer access are not listed; with none left the
 * welcome view says how to turn it on (`hq.hasOrgs`).
 *
 * READS ONLY. Expanding a team lists its sessions (`GET …/sessions`, which never wakes a machine);
 * nothing here starts one. Wake Team, New Session Terminal and Attach are the explicit actions.
 *
 * The window's ACTIVE account only (hq-vscode-multi-account decision 8): rows of two accounts look
 * alike and carry one-click actions. Every node carries its account, so an action on a row runs as
 * the account that listed it even if the window switched since.
 */
import * as vscode from 'vscode';
import type { RemoteOrg, RemoteSessionSummary } from '@kpa/shared/remote.types';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { accountTag, type AccountRef } from '../hq/account-ref.js';
import type { HqAccounts } from '../hq/accounts.js';
import { teamPath } from '../hq/wake.js';
import { cleanLabel } from '../util/text.js';
import {
  needsUpdate,
  sessionContextValue,
  sessionDescription,
  sessionLabel,
  teamContextValue,
  teamDescription,
  teamState,
} from './labels.js';

export type TeamsNode =
  | { kind: 'org'; account: AccountRef; org: RemoteOrg; teams: Team[] }
  | { kind: 'team'; account: AccountRef; team: Team }
  | { kind: 'session'; account: AccountRef; team: Team; session: RemoteSessionSummary }
  | { kind: 'message'; account: AccountRef; team: Team; text: string };

function tagOfNode(node: { account: AccountRef }): string {
  return accountTag(node.account.host, node.account.userId);
}

/** Sessions of an expanded team are re-read after this long (or on Refresh). */
const SESSIONS_TTL_MS = 30_000;

export class TeamsTree implements vscode.TreeDataProvider<TeamsNode> {
  private readonly changed = new vscode.EventEmitter<TeamsNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sessions = new Map<
    string,
    { at: number; list: RemoteSessionSummary[] | null }
  >();
  /** Teams a wake is in flight for (the row shows a spinner). */
  private readonly waking = new Set<string>();

  constructor(
    private readonly accounts: Pick<
      HqAccounts,
      'active' | 'get' | 'onDidChange' | 'onAccountRemoved'
    >,
  ) {
    accounts.onDidChange(() => this.refresh(false));
    accounts.onAccountRemoved(() => this.sessions.clear());
  }

  refresh(clearSessions = true): void {
    if (clearSessions) this.sessions.clear();
    this.changed.fire(undefined);
  }

  /** Keyed by the team ALONE: a wake is about the machine, whichever account asked. */
  setWaking(teamId: string, on: boolean): void {
    if (on) this.waking.add(teamId);
    else this.waking.delete(teamId);
    this.changed.fire(undefined);
  }

  getChildren(node?: TeamsNode): vscode.ProviderResult<TeamsNode[]> {
    if (!node) {
      const active = this.accounts.active();
      if (!active) return [];
      const account = active.ref;
      const byOrg = new Map<string, { org: RemoteOrg; teams: Team[] }>();
      for (const team of active.service.teams()) {
        const entry = byOrg.get(team.org.id) ?? { org: team.org, teams: [] };
        entry.teams.push(team);
        byOrg.set(team.org.id, entry);
      }
      return [...byOrg.values()].map((e) => ({
        kind: 'org' as const,
        account,
        org: e.org,
        teams: e.teams,
      }));
    }
    if (node.kind === 'org') {
      return node.teams.map((team) => ({ kind: 'team' as const, account: node.account, team }));
    }
    if (node.kind === 'team') return this.sessionNodes(node.account, node.team);
    return [];
  }

  private async sessionNodes(account: AccountRef, team: Team): Promise<TeamsNode[]> {
    const service = this.accounts.get(account)?.service;
    if (!service) return [];
    const key = `${service.tag}:${team.workspace.id}`;
    const cached = this.sessions.get(key);
    let list = cached && Date.now() - cached.at < SESSIONS_TTL_MS ? cached.list : undefined;
    if (list === undefined) {
      try {
        list = await service.call(
          async (c) =>
            (
              await c.request<RemoteSessionSummary[]>('GET', `${teamPath(team)}/sessions`, {
                org: team.org.slug,
              })
            ).body,
        );
      } catch {
        list = null;
      }
      this.sessions.set(key, { at: Date.now(), list });
    }
    if (list === null) return [{ kind: 'message', account, team, text: COPY.sessionsFailed }];
    if (list.length === 0) return [{ kind: 'message', account, team, text: COPY.noSessions }];
    return list.map((session) => ({ kind: 'session' as const, account, team, session }));
  }

  getTreeItem(node: TeamsNode): vscode.TreeItem {
    switch (node.kind) {
      case 'org': {
        const item = new vscode.TreeItem(
          cleanLabel(node.org.name) || node.org.slug,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = 'org';
        item.iconPath = new vscode.ThemeIcon('organization');
        return item;
      }
      case 'team': {
        const t = node.team;
        const item = new vscode.TreeItem(
          cleanLabel(t.workspace.name) || t.alias,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${tagOfNode(node)}:team:${t.workspace.id}`;
        item.description = teamDescription(t);
        item.contextValue = teamContextValue(t);
        const state = this.waking.has(t.workspace.id) ? 'starting' : teamState(t.workspace);
        item.iconPath =
          state === 'running'
            ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
            : state === 'starting'
              ? new vscode.ThemeIcon('sync~spin')
              : new vscode.ThemeIcon('circle-outline');
        item.tooltip = needsUpdate(t)
          ? COPY.updateNeededLong(cleanLabel(t.workspace.name))
          : state === 'off'
            ? COPY.teamOffTooltip(cleanLabel(t.workspace.name))
            : cleanLabel(t.workspace.name);
        return item;
      }
      case 'session': {
        const item = new vscode.TreeItem(sessionLabel(node.session));
        item.id = `${tagOfNode(node)}:session:${node.session.id}`;
        item.description = sessionDescription(node.session);
        item.contextValue = sessionContextValue(node.session);
        item.iconPath = new vscode.ThemeIcon(node.session.canType ? 'terminal' : 'eye');
        item.command = {
          command: 'hq.attachSession',
          title: 'Attach',
          arguments: [node],
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.contextValue = 'message';
        return item;
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
