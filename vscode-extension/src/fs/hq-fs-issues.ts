/**
 * What a team folder says when its machine cannot serve files (FEATURE "States and copy", Machine
 * needs update; nightly-fleet-update's WORKSPACE_UPDATING): one notification per CHANGE of the
 * team's issue (fs-core reports changes only, never per request), and the reason on the folder
 * itself as a decoration with a tooltip, so the Explorer never shows a bare error badge.
 *
 * Update machine is an owner/admin action in HQ web with no bearer route (FEATURE decision 13's
 * scope list has none), so the action opens the team's settings page; nothing here rebuilds.
 *
 * Per ACCOUNT (hq-vscode-multi-account review 3): issues are keyed by tag + team, the decoration
 * sits on that account's folder form(s) only (`uriFor`: both forms for the 0.1.x user), and an
 * account's issues go when it is signed out.
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { teamSettingsUrl } from '../tree/labels.js';
import { cleanLabel } from '../util/text.js';
import type { FsTeamIssue } from './fs-core.js';
import { HQ_SCHEME, relPathOf } from './hq-fs-provider.js';

export interface HqTeamIssuesDeps {
  /** The signed-in HQ host (null when signed out). */
  host(): string | null;
}

/** The folder roots an account's team shows under (the tagged one, and the untagged one if open). */
export type RootsOf = (team: Team) => vscode.Uri[];

export class HqTeamIssues implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** `<tag>:<workspaceId>` → the issue, and the roots it was put on. */
  private readonly byTeam = new Map<
    string,
    { team: Team; issue: FsTeamIssue; roots: vscode.Uri[] }
  >();

  constructor(private readonly deps: HqTeamIssuesDeps) {}

  private rootsWithIssue(): Map<string, { team: Team; issue: FsTeamIssue }> {
    const out = new Map<string, { team: Team; issue: FsTeamIssue }>();
    for (const v of this.byTeam.values()) {
      for (const r of v.roots) out.set(r.toString(), { team: v.team, issue: v.issue });
    }
    return out;
  }

  /** fs-core's `teamIssue` for ONE account: the team's issue changed (null = it serves files again). */
  onIssue(tag: string, rootsOf: RootsOf, team: Team, issue: FsTeamIssue | null): void {
    const key = `${tag}:${team.workspace.id}`;
    const roots = issue ? rootsOf(team) : (this.byTeam.get(key)?.roots ?? rootsOf(team));
    if (issue) this.byTeam.set(key, { team, issue, roots });
    else this.byTeam.delete(key);
    this.emitter.fire(roots);
    if (!issue) return;
    const name = cleanLabel(team.workspace.name) || team.alias;
    if (issue.kind === 'needs-update') {
      void Promise.resolve(
        vscode.window.showWarningMessage(COPY.updateNeededLong(name), COPY.openTeamSettings),
      ).then((choice) => {
        if (choice === COPY.openTeamSettings) this.openSettings(team);
      });
      return;
    }
    void vscode.window.showInformationMessage(COPY.fsUpdating(name));
  }

  private openSettings(team: Team): void {
    const host = this.deps.host();
    if (!host) return;
    void vscode.env.openExternal(vscode.Uri.parse(teamSettingsUrl(host, team.workspace.id)));
  }

  /** Only a team ROOT carries the reason; files below it keep VS Code's own decorations. */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const hit = this.rootsWithIssue().get(uri.toString());
    if (!hit) return undefined;
    const name = cleanLabel(hit.team.workspace.name) || hit.team.alias;
    const { issue } = hit;
    return issue.kind === 'needs-update'
      ? new vscode.FileDecoration(
          '↑',
          COPY.updateNeededLong(name),
          new vscode.ThemeColor('list.warningForeground'),
        )
      : new vscode.FileDecoration(
          '…',
          COPY.fsUpdating(name),
          new vscode.ThemeColor('list.warningForeground'),
        );
  }

  /** An account signed out or revoked (or, with no tag, every one): its folders lose their reason. */
  clear(tag?: string): void {
    const uris: vscode.Uri[] = [];
    for (const [k, v] of [...this.byTeam]) {
      if (tag !== undefined && !k.startsWith(`${tag}:`)) continue;
      uris.push(...v.roots);
      this.byTeam.delete(k);
    }
    if (uris.length > 0) this.emitter.fire(uris);
  }

  dispose(): void {
    this.byTeam.clear();
    this.emitter.dispose();
  }
}

/** What the "not openable" marks need from the file system core. */
export interface UnopenableSource {
  team(orgSlug: string, alias: string): Team;
  isUnopenable(team: Team, shownPath: string): boolean;
}

/** An `hq://` authority's own account core (review 3), or null: never another account's. */
export type UnopenableResolver = (
  authority: string,
) => { core: UnopenableSource; orgSlug: string } | null;

/**
 * Train 42 re-test: a file whose real name has a control character (ESC, newline) is listed but
 * HQ refuses to open it. The Explorer marks it, with the sentence that says what to do.
 */
export class UnopenableNames implements vscode.FileDecorationProvider {
  constructor(private readonly resolveCore: UnopenableResolver) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== HQ_SCHEME) return undefined;
    const { alias, path } = relPathOf(uri);
    if (path === '') return undefined;
    const owner = this.resolveCore(uri.authority);
    if (!owner) return undefined;
    let team: Team;
    try {
      team = owner.core.team(owner.orgSlug, alias);
    } catch {
      return undefined;
    }
    if (!owner.core.isUnopenable(team, path)) return undefined;
    return new vscode.FileDecoration(
      '⊘',
      COPY.fsControlName,
      new vscode.ThemeColor('disabledForeground'),
    );
  }
}
