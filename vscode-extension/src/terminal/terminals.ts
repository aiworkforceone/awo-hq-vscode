/**
 * The HQ session terminals of this window: Attach (one terminal per session per ACCOUNT; attaching
 * an open one shows it), New Session Terminal (F12, then attach), and closing an account's terminals
 * when THAT account is signed out or revoked (hq-vscode-multi-account D4, D5). Switching the
 * window's account closes nothing: a terminal belongs to the account that opened it.
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
import { KEY_NS } from '../brand-keys.js';
import { COPY } from '../copy.js';
import { accountTag, sameAccount, type AccountRef } from '../hq/account-ref.js';
import type { HqAccounts } from '../hq/accounts.js';
import type { HqService } from '../hq/hq-service.js';
import { teamPath } from '../hq/wake.js';
import { Emitter } from '../util/emitter.js';
import { HqPty, terminalName, type SessionTarget } from './hq-pty.js';
import { teamState } from '../tree/labels.js';
import { cleanLabel } from '../util/text.js';
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';

/** A listing younger than this is not re-read when a terminal attaches. */
const LISTING_FRESH_MS = 10_000;

export interface TerminalsDeps {
  accounts: Pick<
    HqAccounts,
    'get' | 'shortLabel' | 'onAccountRemoved' | 'onAccountRenewed' | 'onDidChange'
  >;
  offerPorts: (account: AccountRef, team: Team, ports: number[]) => void;
  /** A target whose account is not signed in here: "Sign in as <email>" (never another account). */
  onAccountMissing?: (account: AccountRef) => void;
  /** A terminal of `account` attached to `team` (the team is up). */
  onAttached?: (account: AccountRef, team: Team) => void;
  /**
   * 0.2.2 live FAIL 2: where this window records its HQ terminals (the workspace state), so the next
   * extension host can recognise the tabs VS Code kept and replace them. Absent: nothing recorded.
   */
  memento?: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
  };
  /** hq-vscode-image-paste: the drop rewrite for one terminal's input (see `HqPty`). */
  rewriteInput?: (target: SessionTarget) => (chunk: string) => Promise<string | null> | null;
}

/** One HQ terminal as this window recorded it (0.2.2 live FAIL 2). Names and ids only. */
interface RecordedTerminal {
  /** The tab's name without a state suffix (`· waking`, `· view only`, `· stopped`). */
  name: string;
  account: AccountRef;
  teamId: string;
  session: RemoteSessionSummary;
}

const RECORD_KEY = `${KEY_NS}.terminals`;

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
            this.forget(id); // the person closed it: nothing to bring back
            this.changed.fire();
          }
        }
      }),
      vscode.window.onDidChangeActiveTerminal((t) => {
        this.changed.fire();
        // terminal-shared-geometry: an HQ terminal brought to the front claims the pty's size.
        if (t && vscode.window.state.focused) this.claimFor(t);
      }),
      vscode.window.onDidChangeWindowState((state) => {
        const t = vscode.window.activeTerminal;
        if (state.focused && t) this.claimFor(t);
      }),
      deps.accounts.onAccountRemoved((ref) => this.closeAccount(ref)),
      deps.accounts.onAccountRenewed((ref) => {
        for (const o of this.open.values()) {
          if (sameAccount(o.pty.target.account, ref)) o.pty.reattach();
        }
      }),
      // Decision 28: the label appears or goes when the account count crosses 1 ↔ 2.
      deps.accounts.onDidChange(() => {
        for (const o of this.open.values()) o.pty.relabel();
      }),
    );
  }

  /** terminal-shared-geometry: the HQ terminal `t` came to the front (debounced in the attach). */
  private claimFor(t: vscode.Terminal): void {
    for (const o of this.open.values()) if (o.terminal === t) o.pty.claim();
  }

  private static key(target: Pick<SessionTarget, 'account' | 'session'>): string {
    return `${accountTag(target.account.host, target.account.userId)}:${target.session.id}`;
  }

  /** The state of the terminal open for this session as this account, if any. */
  stateOf(target: Pick<SessionTarget, 'account' | 'session'>): Open['state'] | null {
    return this.open.get(Terminals.key(target))?.state ?? null;
  }

  /** The active terminal and its HQ session, if it is one of ours. */
  activeTerminal(): { terminal: vscode.Terminal; target: SessionTarget } | null {
    const t = vscode.window.activeTerminal;
    if (!t) return null;
    for (const o of this.open.values()) {
      if (o.terminal === t) return { terminal: t, target: o.pty.target };
    }
    return null;
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

  /** `preserveFocus`: show the tab without taking focus (a tab adopted at activation). */
  attach(target: SessionTarget, opts?: { preserveFocus?: boolean }): void {
    const key = Terminals.key(target);
    const existing = this.open.get(key);
    if (existing && existing.state !== 'ended') {
      existing.terminal.show(opts?.preserveFocus);
      return;
    }
    if (existing) {
      // 0.2.2: its attach ended (an extension-host restart, a lost link): showing that tab again
      // would show a dead terminal. It is closed, and a fresh one attaches.
      this.open.delete(key);
      existing.terminal.dispose();
      existing.pty.dispose();
      this.changed.fire();
    }
    const service = this.deps.accounts.get(target.account)?.service;
    if (!service) {
      this.deps.onAccountMissing?.(target.account);
      return;
    }
    const entry: Partial<Open> = { state: 'attached' };
    const label = () => this.deps.accounts.shortLabel(target.account);
    const pty = new HqPty(
      {
        service,
        accountLabel: label,
        localEchoMode: () =>
          vscode.workspace
            .getConfiguration(ACTIVE_DEV_BRAND.vscode.idPrefix)
            .get<LocalEchoMode>('localEcho', 'auto'),
        vsCodeTypeaheadOn: () => {
          const c = vscode.workspace.getConfiguration('terminal.integrated');
          return vsCodeTypeaheadActive(
            { enabled: c.get('localEchoEnabled'), threshold: c.get('localEchoLatencyThreshold') },
            vscode.env.remoteName !== undefined,
          );
        },
        onEchoOrgOff: (team) => this.echoOrgOff.show(team),
        ...(this.deps.rewriteInput ? { rewriteInput: this.deps.rewriteInput(target) } : {}),
        windowActive: () =>
          vscode.window.state.focused ||
          (vscode.window.state as { active?: boolean }).active === true,
        inFront: () =>
          vscode.window.state.focused && vscode.window.activeTerminal === entry.terminal,
        offerPorts: (team, ports) => this.deps.offerPorts(target.account, team, ports),
        // The team's live state (F11), else the last listing: an off team attaches passively.
        teamRunning: async (team) => {
          try {
            const ws = await service.call(
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
          // A session that attached (or woke) means its team's state may have moved on: re-list,
          // so the status bar and the pickers stop saying "off" (live test 2026-10-02).
          if (state === 'attached') {
            void service.refreshOrgsIfOlder(LISTING_FRESH_MS);
            this.deps.onAttached?.(target.account, target.team);
          }
        },
      },
      target,
    );
    const terminal = vscode.window.createTerminal({
      name: terminalName(target, { canType: target.session.canType }, label()),
      pty,
      iconPath: new vscode.ThemeIcon(target.session.canType ? 'terminal' : 'eye'),
      isTransient: true,
    });
    entry.terminal = terminal;
    entry.pty = pty;
    this.open.set(key, entry as Open);
    this.remember(key, {
      name: terminalName(target, { canType: true }, label()),
      account: target.account,
      teamId: target.team.workspace.id,
      session: target.session,
    });
    terminal.show(opts?.preserveFocus);
    this.changed.fire();
  }

  /** F12: start an HQ session on this team, as `account`, from this computer, then attach it. */
  async newSession(account: AccountRef, team: Team): Promise<void> {
    const service: HqService | undefined = this.deps.accounts.get(account)?.service;
    if (!service) {
      this.deps.onAccountMissing?.(account);
      return;
    }
    const body: RemoteSessionCreateRequest = { cols: 120, rows: 32 };
    let created: RemoteSessionSummary;
    try {
      created = await service.call(
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
    this.attach({ account, team, session: created });
  }

  private records(): Record<string, RecordedTerminal> {
    return this.deps.memento?.get<Record<string, RecordedTerminal>>(RECORD_KEY) ?? {};
  }

  private saveRecords(all: Record<string, RecordedTerminal>): void {
    void this.deps.memento?.update(RECORD_KEY, Object.keys(all).length > 0 ? all : undefined);
  }

  private remember(key: string, rec: RecordedTerminal): void {
    if (!this.deps.memento) return;
    this.saveRecords({ ...this.records(), [key]: rec });
  }

  private forget(key: string): void {
    if (!this.deps.memento) return;
    const all = this.records();
    if (!(key in all)) return;
    delete all[key];
    this.saveRecords(all);
  }

  /**
   * 0.2.2 live FAIL 2: VS Code keeps an HQ tab across an extension-host restart, but the pty behind
   * it lived in the old host: the tab is dead (no output, typing goes nowhere, no "press any key").
   * At activation, each tab recorded by this window that this host does not run is closed and its
   * session attached again in a fresh terminal (the same name). An account or team that is gone
   * only closes it. Records that match no tab (the window was reloaded) are dropped.
   */
  adoptOrphans(existing: ReadonlyArray<Pick<vscode.Terminal, 'name' | 'dispose'>>): void {
    if (!this.deps.memento) return;
    const all = this.records();
    const suffixes = [
      '',
      COPY.terminalSuffixViewOnly,
      COPY.terminalSuffixWaking,
      COPY.terminalSuffixStopped,
    ];
    // A tab claimed once is ours: two sessions with the same name each take their own dead tab.
    const ours = new Set([...this.open.values()].map((o) => o.terminal as unknown));
    const kept: Record<string, RecordedTerminal> = {};
    for (const [key, rec] of Object.entries(all)) {
      const dead = existing.find(
        (t) => !ours.has(t) && suffixes.some((sfx) => t.name === `${rec.name}${sfx}`),
      );
      if (!dead) continue; // no tab left (a reload): forgotten
      ours.add(dead);
      dead.dispose();
      const team = this.deps.accounts
        .get(rec.account)
        ?.service.teams()
        .find((t) => t.workspace.id === rec.teamId);
      if (!team) continue; // the account or the team went: the dead tab is just closed
      kept[key] = rec;
    }
    this.saveRecords(kept);
    for (const rec of Object.values(kept)) {
      const team = this.deps.accounts
        .get(rec.account)!
        .service.teams()
        .find((t) => t.workspace.id === rec.teamId)!;
      this.attach({ account: rec.account, team, session: rec.session }, { preserveFocus: true });
    }
  }

  /** One account signed out or revoked (any window): only its terminals close. */
  closeAccount(ref: AccountRef): void {
    let closed = false;
    for (const [k, o] of [...this.open]) {
      if (!sameAccount(o.pty.target.account, ref)) continue;
      this.open.delete(k);
      this.forget(k);
      o.terminal.dispose();
      closed = true;
    }
    if (closed) this.changed.fire();
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
