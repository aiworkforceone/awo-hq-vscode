/**
 * The one HQ status-bar item (D3): who is signed in and, while an HQ session terminal is active,
 * its team's state (`HQ: <email> · <team> running|off`). Click: the HQ sidebar. A second, small item
 * counts active port forwards and opens the Ports view (decision 18); it hides at zero.
 *
 * Reads only: the item never triggers a request by itself.
 */
import * as vscode from 'vscode';
import { COPY } from './copy.js';
import type { HqService } from './hq/hq-service.js';
import type { Ports } from './ports/ports.js';
import type { Terminals } from './terminal/terminals.js';
import { teamState } from './tree/labels.js';
import { cleanLabel } from './util/text.js';

export class StatusBar implements vscode.Disposable {
  private readonly main = vscode.window.createStatusBarItem(
    'aiworkforceone.hq.status',
    vscode.StatusBarAlignment.Left,
    10,
  );
  private readonly ports = vscode.window.createStatusBarItem(
    'aiworkforceone.hq.ports',
    vscode.StatusBarAlignment.Left,
    9,
  );
  private readonly subscriptions: Array<{ dispose(): unknown }> = [];

  constructor(
    private readonly service: HqService,
    private readonly terminals: Terminals,
    portsView: Ports,
  ) {
    this.main.name = COPY.statusTooltip;
    this.main.tooltip = COPY.statusTooltip;
    this.main.command = 'workbench.view.extension.hq';
    this.ports.name = 'AI Workforce One HQ ports';
    this.ports.command = 'hq.ports.focus';
    this.subscriptions.push(
      service.onDidChange(() => this.render()),
      terminals.onDidChange(() => this.render()),
      portsView.onDidChangeCount((n) => this.renderPorts(n)),
    );
    this.render();
    this.renderPorts(portsView.activeCount());
  }

  private render(): void {
    const account = this.service.account();
    if (!account) {
      this.main.text = `$(account) ${COPY.statusSignedOut}`;
      this.main.show();
      return;
    }
    const email = cleanLabel(account.user.email);
    const active = this.terminals.active();
    if (active) {
      const state =
        active.state === 'waking' ? COPY.stateStarting : this.stateOf(active.team.workspace.id);
      this.main.text = `$(terminal) ${COPY.statusTeam(email, cleanLabel(active.team.workspace.name), state)}`;
    } else {
      this.main.text = `$(account) ${COPY.statusSignedIn(email)}`;
    }
    this.main.show();
  }

  /** The team's state from the last listing ("off", never "asleep"). */
  private stateOf(workspaceId: string): string {
    const team = this.service.teams().find((t) => t.workspace.id === workspaceId);
    if (!team) return COPY.stateRunning;
    const s = teamState(team.workspace);
    return s === 'running'
      ? COPY.stateRunning
      : s === 'starting'
        ? COPY.stateStarting
        : COPY.stateOff;
  }

  private renderPorts(n: number): void {
    if (n === 0) {
      this.ports.hide();
      return;
    }
    this.ports.text = `$(plug) ${n}`;
    this.ports.show();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.main.dispose();
    this.ports.dispose();
  }
}
