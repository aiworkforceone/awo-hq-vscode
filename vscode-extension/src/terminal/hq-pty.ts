/**
 * One HQ session in a VS Code terminal (D4, decision 19): a `Pseudoterminal` over the shared
 * `AttachSession` (`hq-client`), the SAME attach `hq attach` runs: the browser's rules for typing
 * (owner only; the server still drops a viewer's input), masking, geometry, wake progress, presence
 * and reconnect. What differs is only where bytes go:
 *
 *   - output passes the D5 terminal filter (`createTerminalFilter`) before VS Code's xterm sees it;
 *   - status lines are dim lines in the terminal itself;
 *   - a `FORBIDDEN` flips the terminal to view-only instead of ending it;
 *   - presence is sent only while this window is focused or active (decision 17);
 *   - a 30 s client ping with a 10 s pong deadline turns a silently dead socket into a reconnect;
 *   - closing the tab DETACHES: the HQ session keeps running.
 *
 * `open()` waits for the first `setDimensions` (250 ms) when VS Code did not pass one, so the attach
 * never paints at 80x24 and then reflows (DEF-192).
 *
 * A terminal belongs to the ACCOUNT that opened it (hq-vscode-multi-account §6): its service is that
 * account's, its tab name carries the account's short label while 2 or more accounts are signed in,
 * and when another window renews the account the terminal re-attaches in the same tab (decision 26).
 */
import * as vscode from 'vscode';
import type { RemoteSessionSummary } from '@kpa/shared/remote.types';
import type { LocalEchoMode } from '@kpa/shared/local-echo-engine';
import {
  createAttachSession,
  type AttachEnd,
  type AttachSession,
} from '@hq/client/attach-session.js';
import { LocalEchoSession } from '@hq/client/local-echo/engine-adapter.js';
import { createTerminalFilter } from '@hq/client/terminal-filter.js';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import type { AccountRef } from '../hq/account-ref.js';
import type { HqService } from '../hq/hq-service.js';
import { AccountGoneError, NeedsSignInError, SecretsBusyError } from '../hq/session-store.js';
import { cleanLabel } from '../util/text.js';

export interface PtyDeps {
  /** The service of the account that opened this terminal (never the window's active one). */
  service: HqService;
  /** The account's short label while 2 or more accounts are signed in (decision 21). */
  accountLabel?: () => string | undefined;
  localEchoMode: () => LocalEchoMode;
  /** VS Code's own typeahead forced on (`terminal.integrated.localEchoEnabled: "on"`). */
  vsCodeTypeaheadOn: () => boolean;
  /** Is this window focused or active (presence is sent only then, decision 17)? */
  windowActive: () => boolean;
  /** The machine reported listening ports: offer them in HQ Ports. */
  offerPorts: (team: Team, ports: number[]) => void;
  /** The terminal's state for the status bar. */
  onState?: (state: 'attached' | 'waking' | 'ended') => void;
  /**
   * Is the team's machine running right now? When it is not, the terminal attaches passively and
   * says "Press any key to wake it"; only the key wakes it (the design's "Team off, terminal").
   * Absent or failing: treated as running (today's attach).
   */
  teamRunning?: (team: Team) => Promise<boolean>;
  /**
   * 'auto' and the org has Instant local echo off: the window says so once (the Terminals'
   * `EchoOrgOffNotice`), so a person can tell why nothing is echoed ahead. Nothing in the terminal.
   */
  onEchoOrgOff?: (team: Team) => void;
}

export interface SessionTarget {
  account: AccountRef;
  team: Team;
  session: RemoteSessionSummary;
}

/** The terminal's tab name: `HQ · [<account> ·] <team> · <session>` plus the state suffix. */
export function terminalName(
  target: Pick<SessionTarget, 'team' | 'session'>,
  state: { canType: boolean; waking?: boolean; stopped?: boolean },
  label?: string,
): string {
  const base = COPY.terminalName(
    cleanLabel(target.team.workspace.name) || target.team.alias,
    cleanLabel(target.session.name) || target.session.id.slice(0, 8),
    label,
  );
  if (state.stopped) return `${base}${COPY.terminalSuffixStopped}`;
  if (state.waking) return `${base}${COPY.terminalSuffixWaking}`;
  return state.canType ? base : `${base}${COPY.terminalSuffixViewOnly}`;
}

/**
 * A status line as the terminal shows it: dim, on its own line(s), with no control characters (a
 * server sentence is data, never an escape sequence).
 */
export function statusLine(line: string): string {
  const lines = line
    .split(/\r?\n/)
    .map((l) => cleanLabel(l, 400))
    .filter((l) => l.length > 0);
  return lines.length === 0 ? '' : `\r\n\x1b[2m${lines.join('\r\n')}\x1b[0m\r\n`;
}

export class HqPty implements vscode.Pseudoterminal {
  private readonly out = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number | void>();
  private readonly name = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.out.event;
  readonly onDidClose = this.closed.event;
  readonly onDidChangeName = this.name.event;

  private dims = { cols: 80, rows: 24 };
  private session: AttachSession | null = null;
  private echo: LocalEchoSession | null = null;
  private inputHandler: ((chunk: Buffer) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private closedByUser = false;
  private canType: boolean;
  private waking = false;
  private stopped = false;
  /** A re-attach was asked for (the account was renewed): the current attach ends quietly. */
  private reattaching = false;
  /** The grant the current attach was made with. */
  private attachedGrant: string | undefined;
  /** The name the tab was given last (relabels that change nothing are not sent). */
  private lastName: string;

  constructor(
    private readonly deps: PtyDeps,
    readonly target: SessionTarget,
  ) {
    this.canType = target.session.canType;
    this.lastName = terminalName(target, { canType: this.canType }, deps.accountLabel?.());
  }

  open(initial: vscode.TerminalDimensions | undefined): void {
    if (initial) this.dims = { cols: initial.columns, rows: initial.rows };
    setTimeout(() => void this.run(), initial ? 0 : 250);
  }

  handleInput(data: string): void {
    this.inputHandler?.(Buffer.from(data, 'utf8'));
  }

  setDimensions(d: vscode.TerminalDimensions): void {
    this.dims = { cols: d.columns, rows: d.rows };
    this.resizeHandler?.();
  }

  close(): void {
    this.closedByUser = true;
    this.session?.detach();
    this.echo?.close();
  }

  private say(line: string): void {
    const s = statusLine(line);
    if (s.length === 0) return;
    this.echo?.undrawNow();
    this.out.fire(s);
  }

  private rename(): void {
    const next = terminalName(
      this.target,
      { canType: this.canType, waking: this.waking, stopped: this.stopped },
      this.deps.accountLabel?.(),
    );
    if (next === this.lastName) return;
    this.lastName = next;
    this.name.fire(next);
  }

  /** The account count crossed 1 ↔ 2: the tab gains or loses the account label (decision 28). */
  relabel(): void {
    this.rename();
  }

  private end(): void {
    this.stopped = true;
    this.rename();
  }

  /**
   * Decision 26: the account's slot holds a new grant. Detach the session attached with the old
   * client and attach again with the new one, in this tab (it says "reconnecting").
   */
  reattach(): void {
    if (this.closedByUser || this.stopped || !this.session) return;
    // Already attached with the new grant (the old one's 4401 got here first): nothing to do.
    if (this.attachedGrant === this.deps.service.currentGrant()) return;
    this.reattaching = true;
    this.session.detach();
  }

  private async createEcho(): Promise<LocalEchoSession | null> {
    const mode = this.deps.localEchoMode();
    if (mode === 'off' || !this.target.session.canType) return null;
    if (this.target.session.localEchoAvailable !== true) {
      if (mode === 'always') this.say(COPY.localEchoUnavailable);
      // `false` is the org's switch (an older HQ omits the field: nothing to point at).
      else if (this.target.session.localEchoAvailable === false) {
        this.deps.onEchoOrgOff?.(this.target.team);
      }
      return null;
    }
    // Two predictors on one screen would draw every character twice (U26).
    if (this.deps.vsCodeTypeaheadOn()) {
      this.say(COPY.localEchoTypeaheadConflict);
      return null;
    }
    return LocalEchoSession.create({
      mode,
      write: (bytes) => this.out.fire(bytes),
      cols: this.dims.cols,
      rows: this.dims.rows,
    });
  }

  private async run(): Promise<void> {
    // A run that starts is the re-attach (or a first attach): no detach from before may end it.
    this.reattaching = false;
    let client;
    try {
      client = await this.deps.service.client();
    } catch (err) {
      await this.deps.service.handleError(err);
      const ours =
        err instanceof AccountGoneError ||
        err instanceof NeedsSignInError ||
        err instanceof SecretsBusyError;
      this.say(ours ? err.message : COPY.signedOutWelcome);
      this.closed.fire(1);
      return;
    }
    this.attachedGrant = this.deps.service.grantOfClient(client);
    const { team, session } = this.target;
    const teamName = cleanLabel(team.workspace.name) || team.alias;
    this.echo = await this.createEcho();
    const running = this.deps.teamRunning
      ? await this.deps.teamRunning(team).catch(() => true)
      : true;
    const attach = createAttachSession(
      client,
      this.target,
      {
        write: (bytes) => this.out.fire(bytes),
        say: (line) => this.say(line),
        size: () => this.dims,
        onInput: (fn) => {
          this.inputHandler = fn;
          return () => {
            if (this.inputHandler === fn) this.inputHandler = null;
          };
        },
        onResize: (fn) => {
          this.resizeHandler = fn;
          return () => {
            if (this.resizeHandler === fn) this.resizeHandler = null;
          };
        },
      },
      {
        echo: this.echo,
        createFilter: createTerminalFilter,
        onForbidden: 'view-only',
        initialIntent: running ? 'open' : 'reconnect',
        presenceWhen: this.deps.windowActive,
        livenessPingMs: 30_000,
        livenessTimeoutMs: 10_000,
        onFirstOpen: () => {
          this.say(
            COPY.attached(cleanLabel(session.name), cleanLabel(session.ownerName), this.canType),
          );
          this.deps.onState?.('attached');
        },
        onCanTypeChanged: (can) => {
          this.canType = can;
          this.rename();
        },
        onWaking: (on) => {
          this.waking = on;
          this.rename();
          this.deps.onState?.(on ? 'waking' : 'attached');
        },
        onListenPorts: (ports) => this.deps.offerPorts(team, ports),
        noticeText: (code, text) =>
          code === 'workspace_asleep'
            ? `${COPY.teamOffTerminal(teamName)}\r\n${COPY.pressKeyToWake}`
            : text,
        wakeText: (code, message) =>
          code === 'SESSION_RESUME_COLD_RESTART' ? message : COPY.waking(teamName),
        copy: {
          prefix: '',
          stillOnIt: COPY.stillOnIt,
          wakeTimeout: () => COPY.wakeTimeout(teamName),
          reconnecting: COPY.reconnecting,
          accessEnded: COPY.sessionAccessEnded,
          detached: COPY.detached,
          nowViewOnly: COPY.nowViewOnly,
        },
      },
    );
    this.session = attach;
    let end: AttachEnd;
    try {
      end = await attach.run();
    } catch (err) {
      if (this.again()) return;
      await this.deps.service.handleError(err);
      this.say(err instanceof Error ? err.message : COPY.unreachable);
      this.deps.onState?.('ended');
      return;
    } finally {
      this.echo?.close();
    }
    if (this.again()) return;
    this.deps.onState?.('ended');
    if (this.closedByUser) return;
    if (end.kind === 'refused') {
      if (end.status === 426) this.deps.service.showTooOld();
      if (end.status === 401) {
        // The upgrade's token was refused: ask HQ once over HTTP, which knows whether the grant is
        // really gone (and wipes and says so if it is).
        await this.deps.service.refreshOrgs().catch(() => undefined);
        if (this.renewedUnder()) return;
      }
      this.say(COPY.terminalRefused(end.status));
      this.end();
      return;
    }
    if (end.kind === 'lost') {
      this.say(COPY.connectionLost);
      this.end();
      return;
    }
    if (end.message) this.say(end.message);
    this.end();
    // U28: HQ closed the terminal 4401. Ask HQ once over HTTP now: a confirmed revocation wipes the
    // account, shows the modal, and closes its terminals and forwards (`onAccountRemoved`). The
    // OLD grant's 4401 after a renew in another window is not that: attach again (decision 26).
    if (end.unauthorized) {
      await this.deps.service.refreshOrgs().catch(() => undefined);
      this.renewedUnder();
    }
    // The session ended on the server's side (it stopped, access ended): the tab stays, so the
    // person can read why; closing it is theirs.
  }

  /**
   * The account's slot holds another grant than the one this attach used (renewed elsewhere, and
   * its 4401/401 arrived before the renew was noticed): attach again in this tab. True if so.
   */
  private renewedUnder(): boolean {
    const now = this.deps.service.currentGrant();
    if (this.closedByUser || now === null || now === this.attachedGrant) return false;
    this.stopped = false;
    this.rename();
    this.say(COPY.reconnecting);
    void this.run();
    return true;
  }

  /** The attach ended because `reattach` asked: say so and attach again with the new grant. */
  private again(): boolean {
    if (!this.reattaching || this.closedByUser) return false;
    this.reattaching = false;
    this.session = null;
    this.say(COPY.reconnecting);
    void this.run();
    return true;
  }

  dispose(): void {
    this.out.dispose();
    this.closed.dispose();
    this.name.dispose();
  }
}
