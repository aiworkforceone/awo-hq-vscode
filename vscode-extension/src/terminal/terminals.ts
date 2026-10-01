/**
 * The HQ session terminals of this window: Attach (one terminal per session; attaching an open one
 * shows it), New Session Terminal (F12, then attach), and closing them all when the sign-in ends.
 */
import * as vscode from 'vscode';
import type {
  RemoteSessionCreateRequest,
  RemoteSessionSummary,
  RemoteWorkspace,
} from '@kpa/shared/remote.types';
import type { LocalEchoMode } from '@kpa/shared/local-echo-engine';
import { HqApiError } from '@hq/client/api.js';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import type { HqService } from '../hq/hq-service.js';
import { teamPath } from '../hq/wake.js';
import { Emitter } from '../util/emitter.js';
import { HqPty, terminalName, type SessionTarget } from './hq-pty.js';
import { teamState } from '../tree/labels.js';
import { cleanLabel } from '../util/text.js';

export interface TerminalsDeps {
  service: HqService;
  offerPorts: (team: Team, ports: number[]) => void;
}

interface Open {
  terminal: vscode.Terminal;
  pty: HqPty;
  state: 'attached' | 'waking' | 'ended';
}

/**
 * Does a terminal attach as the person's gesture (`open`)? Only on a RUNNING team. Off, stopped
 * and starting teams attach passively: an off one says "Press any key to wake it", a starting one
 * (someone is waking it) shows the wake's progress and comes back by itself (S5).
 */
export function teamIsRunning(ws: Pick<RemoteWorkspace, 'state'>): boolean {
  return teamState(ws as RemoteWorkspace) === 'running';
}

/**
 * Is VS Code's OWN terminal typeahead drawing in this window (verified in the 1.90 and 1.140
 * workbench sources, `TerminalTypeAheadContribution._loadTypeAheadAddon`)? The addon loads when
 * `terminal.integrated.localEchoEnabled` is `on`, or `auto` in a REMOTE window (`remoteAuthority`);
 * its predictions are disabled when `terminal.integrated.localEchoLatencyThreshold` is -1. The
 * default is `auto` on 1.90 and `off` on stable. Two predictors on one screen draw every key twice.
 */
export function vsCodeTypeaheadActive(
  settings: { enabled: unknown; threshold: unknown },
  remoteWindow: boolean,
): boolean {
  if (settings.threshold === -1) return false;
  return settings.enabled === 'on' || (settings.enabled === 'auto' && remoteWindow);
}

/** Gap 1: "local echo is off for this org", once per org in this window. */
export class EchoOrgOffNotice {
  private readonly said = new Set<string>();

  show(team: Team): void {
    if (this.said.has(team.org.id)) return;
    this.said.add(team.org.id);
    void vscode.window.showInformationMessage(
      COPY.localEchoOrgOff(cleanLabel(team.org.name) || team.org.slug),
    );
  }
}

export class Terminals {
  private readonly echoOrgOff = new EchoOrgOffNotice();
  private readonly open = new Map<string, Open>();
  private readonly changed = new Emitter<void>();
  /** A terminal opened, closed, or changed state (the status bar listens). */
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: TerminalsDeps) {
    this.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [id, o] of this.open) {
          if (o.terminal === t) {
            this.open.delete(id);
            o.pty.dispose();
            this.changed.fire();
          }
        }
      }),
      vscode.window.onDidChangeActiveTerminal(() => this.changed.fire()),
    );
    deps.service.onRevoked(() => this.closeAll());
  }

  /** The HQ session behind the active terminal, if it is one of ours. */
  active(): (SessionTarget & { state: Open['state'] }) | null {
    const t = vscode.window.activeTerminal;
    if (!t) return null;
    for (const o of this.open.values()) {
      if (o.terminal === t) return { ...o.pty.target, state: o.state };
    }
    return null;
  }

  attach(target: SessionTarget): void {
    const existing = this.open.get(target.session.id);
    if (existing) {
      existing.terminal.show();
      return;
    }
    const entry: Partial<Open> = { state: 'attached' };
    const pty = new HqPty(
      {
        service: this.deps.service,
        localEchoMode: () =>
          vscode.workspace.getConfiguration('hq').get<LocalEchoMode>('localEcho', 'auto'),
        vsCodeTypeaheadOn: () => {
          const c = vscode.workspace.getConfiguration('terminal.integrated');
          return vsCodeTypeaheadActive(
            { enabled: c.get('localEchoEnabled'), threshold: c.get('localEchoLatencyThreshold') },
            vscode.env.remoteName !== undefined,
          );
        },
        onEchoOrgOff: (team) => this.echoOrgOff.show(team),
        windowActive: () =>
          vscode.window.state.focused ||
          (vscode.window.state as { active?: boolean }).active === true,
        offerPorts: this.deps.offerPorts,
        // The team's live state (F11), else the last listing: an off team attaches passively.
        teamRunning: async (team) => {
          try {
            const ws = await this.deps.service.call(
              async (c) =>
                (await c.request<RemoteWorkspace>('GET', teamPath(team), { org: team.org.slug }))
                  .body,
            );
            return teamIsRunning(ws);
          } catch {
            return teamIsRunning(team.workspace);
          }
        },
        onState: (state) => {
          entry.state = state;
          this.changed.fire();
        },
      },
      target,
    );
    const terminal = vscode.window.createTerminal({
      name: terminalName(target, { canType: target.session.canType }),
      pty,
      iconPath: new vscode.ThemeIcon(target.session.canType ? 'terminal' : 'eye'),
      isTransient: true,
    });
    entry.terminal = terminal;
    entry.pty = pty;
    this.open.set(target.session.id, entry as Open);
    terminal.show();
    this.changed.fire();
  }

  /** F12: start an HQ session on this team from this computer, then attach it. */
  async newSession(team: Team): Promise<void> {
    const body: RemoteSessionCreateRequest = { cols: 120, rows: 32 };
    let created: RemoteSessionSummary;
    try {
      created = await this.deps.service.call(
        async (c) =>
          (
            await c.request<RemoteSessionSummary>('POST', `${teamPath(team)}/sessions`, {
              body,
              org: team.org.slug,
              signed: true,
            })
          ).body,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(newSessionError(err));
      return;
    }
    this.attach({ team, session: created });
  }

  closeAll(): void {
    for (const o of this.open.values()) o.terminal.dispose();
    this.open.clear();
    this.changed.fire();
  }

  dispose(): void {
    this.closeAll();
    for (const s of this.subscriptions) s.dispose();
    this.changed.dispose();
  }
}

/** The sentence for a refused new session. */
export function newSessionError(err: unknown): string {
  if (err instanceof HqApiError) {
    if (err.status === 402) return COPY.planReadOnly;
    if (err.code === 'LIMIT_EXCEEDED') return COPY.sessionLimit;
    if (err.status === 403) return COPY.viewOnlyTeam;
    if (err.status === 404) return COPY.signInUnavailable;
    return COPY.newSessionFailed(err.message);
  }
  return COPY.newSessionFailed(err instanceof Error ? err.message : COPY.unreachable);
}
