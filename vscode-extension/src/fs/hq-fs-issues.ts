/**
 * What a team folder says when its machine cannot serve files (FEATURE "States and copy", Machine
 * needs update; nightly-fleet-update's WORKSPACE_UPDATING): one notification per CHANGE of the
 * team's issue (fs-core reports changes only, never per request), and the reason on the folder
 * itself as a decoration with a tooltip, so the Explorer never shows a bare error badge.
 *
 * Update machine is an owner/admin action in HQ web with no bearer route (FEATURE decision 13's
 * scope list has none), so the action opens the team's settings page; nothing here rebuilds.
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { teamSettingsUrl } from '../tree/labels.js';
import { cleanLabel } from '../util/text.js';
import type { FsTeamIssue } from './fs-core.js';
import { HQ_SCHEME, relPathOf, teamRootUri } from './hq-fs-provider.js';

export interface HqTeamIssuesDeps {
  /** The signed-in HQ host (null when signed out). */
  host(): string | null;
}

export class HqTeamIssues implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly byRoot = new Map<string, { team: Team; issue: FsTeamIssue }>();

  constructor(private readonly deps: HqTeamIssuesDeps) {}

  /** fs-core's `teamIssue`: the team's issue changed (null = it serves files again). */
  onIssue(team: Team, issue: FsTeamIssue | null): void {
    const uri = teamRootUri(team);
    if (issue) this.byRoot.set(uri.toString(), { team, issue });
    else this.byRoot.delete(uri.toString());
    this.emitter.fire([uri]);
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
    void vscode.window.showInformationMessage(COPY.fsUpdating(name, issue.etaSeconds));
  }

  private openSettings(team: Team): void {
    const host = this.deps.host();
    if (!host) return;
    void vscode.env.openExternal(vscode.Uri.parse(teamSettingsUrl(host, team.workspace.id)));
  }

  /** Only a team ROOT carries the reason; files below it keep VS Code's own decorations. */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const hit = this.byRoot.get(uri.toString());
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
          COPY.fsUpdating(name, issue.etaSeconds),
          new vscode.ThemeColor('list.warningForeground'),
        );
  }

  /** Sign-out or revocation: every folder loses its reason. */
  clear(): void {
    const uris = [...this.byRoot.values()].map(({ team }) => teamRootUri(team));
    this.byRoot.clear();
    if (uris.length > 0) this.emitter.fire(uris);
  }

  dispose(): void {
    this.byRoot.clear();
    this.emitter.dispose();
  }
}

/** What the "not openable" marks need from the file system core. */
export interface UnopenableSource {
  team(orgSlug: string, alias: string): Team;
  isUnopenable(team: Team, shownPath: string): boolean;
}

/**
 * Train 42 re-test: a file whose real name has a control character (ESC, newline) is listed but
 * HQ refuses to open it. The Explorer marks it, with the sentence that says what to do.
 */
export class UnopenableNames implements vscode.FileDecorationProvider {
  constructor(private readonly core: UnopenableSource) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== HQ_SCHEME) return undefined;
    const { alias, path } = relPathOf(uri);
    if (path === '') return undefined;
    let team: Team;
    try {
      team = this.core.team(uri.authority, alias);
    } catch {
      return undefined;
    }
    if (!this.core.isUnopenable(team, path)) return undefined;
    return new vscode.FileDecoration(
      '⊘',
      COPY.fsControlName,
      new vscode.ThemeColor('disabledForeground'),
    );
  }
}
