/**
 * The one HQ status-bar item (D3): which account THIS window uses and, while an HQ session terminal
 * is active, its team's state (`HQ: <email> · <team> running|off`). A terminal opened as another
 * account than the window's shows ITS account's email, plus "other account" (hq-vscode-multi-account
 * decision 21): that is whose grant powers it. Click: the HQ sidebar with one account, the account
 * switcher with more (`hq.accounts.primaryAction`). A second, small item counts active port
 * forwards and opens the Ports view (decision 18); it hides at zero.
 *
 * Reads only: the item never triggers a request by itself.
 */
import * as vscode from 'vscode';
import { COPY } from './copy.js';
import { sameAccount } from './hq/account-ref.js';
import type { HqAccounts } from './hq/accounts.js';
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
    private readonly accounts: Pick<HqAccounts, 'active' | 'get' | 'onDidChange'>,
    private readonly terminals: Pick<Terminals, 'active' | 'onDidChange'>,
    portsView: Pick<Ports, 'onDidChangeCount' | 'activeCount'>,
  ) {
    this.main.name = COPY.statusTooltip;
    this.main.tooltip = COPY.statusTooltip;
    this.main.command = 'hq.accounts.primaryAction';
    this.ports.name = 'AI Workforce One HQ ports';
    this.ports.command = 'hq.ports.focus';
    this.subscriptions.push(
      accounts.onDidChange(() => this.render()),
      terminals.onDidChange(() => this.render()),
      portsView.onDidChangeCount((n) => this.renderPorts(n)),
    );
    this.render();
    this.renderPorts(portsView.activeCount());
  }

  /** The item's text now (also what the unit tier reads). */
  text(): string {
    return this.main.text;
  }

  private render(): void {
    const mine = this.accounts.active();
    const active = this.terminals.active();
    if (active) {
      const owner = this.accounts.get(active.account);
      const other = !mine || !sameAccount(mine.ref, active.account);
      const email = cleanLabel(owner?.email ?? mine?.email ?? '');
      const state =
        active.state === 'waking'
          ? COPY.stateStarting
          : this.stateOf(owner?.service.teams() ?? [], active.team.workspace.id);
      const team = COPY.statusTeam(email, cleanLabel(active.team.workspace.name), state);
      this.main.text = `$(terminal) ${team}${other ? ` · ${COPY.statusOtherAccount}` : ''}`;
      this.main.show();
      return;
    }
    this.main.text = mine
      ? `$(account) ${COPY.statusSignedIn(cleanLabel(mine.email))}`
      : `$(account) ${COPY.statusSignedOut}`;
    this.main.show();
  }

  /** The team's state from that account's last listing ("off", never "asleep"). */
  private stateOf(
    teams: ReadonlyArray<{ workspace: Parameters<typeof teamState>[0] }>,
    workspaceId: string,
  ): string {
    const team = teams.find((t) => t.workspace.id === workspaceId);
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
