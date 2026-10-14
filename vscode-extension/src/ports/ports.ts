/**
 * HQ Ports (D11, decision 18): forwards from a team machine to this computer over the existing
 * `forward` tunnel (`hq-client` `startForward`, the one `hq forward` runs), shown in the Ports view
 * with a status-bar count.
 *
 *   forwarded  `<remote> → localhost:<local>`, Open in Browser, Copy, Stop. The laptop listens on
 *              127.0.0.1 only (never every interface): a forward is a credentialed pipe into the
 *              machine. One connection row and one audit pair per forward.
 *   paused     a forward that was running when the window closed comes back PAUSED and starts only
 *              when clicked (D11/U22: a reload never wakes a machine or dials on its own).
 *   detected   ports the machine reports listening (`runner-metrics.listenPorts` on the terminal
 *              socket) are offered once; Dismiss sticks.
 *
 * The Node inspector ports are refused here before any request (decision 14; HQ refuses them too).
 *
 * Every forward and offer belongs to an ACCOUNT (hq-vscode-multi-account §6, D4): it starts and
 * resumes as that account only (a missing account says "Sign in as", never falls back to the active
 * one), its paused list lives in that account's slot, it restarts on the same local port when the
 * account is renewed elsewhere (decision 26), and only that account's sign-out closes it. A window
 * restores the paused forwards of its ACTIVE account. Known limitation kept from 0.1.1 (§Backend 10):
 * two windows with forwards on one account overwrite each other's paused list.
 */
import * as vscode from 'vscode';
import { ConnectRefusedError } from '@hq/client/connect.js';
import { parsePort, startForward, type ForwardHandle } from '@hq/client/forward.js';
import {
  DEVICE_SIGNATURE_MISSING_CODE,
  deviceSignatureMissingMessage,
} from '@hq/client/session-actions.js';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { accountTag, sameAccount, type AccountRef } from '../hq/account-ref.js';
import type { HqAccounts } from '../hq/accounts.js';
import { portsKey } from '../hq/session-store.js';
import { Emitter } from '../util/emitter.js';
import { cleanLabel } from '../util/text.js';
import { brandText } from '@kpa/shared/active-dev-brand';

/** Refused before any request (decision 14). HQ also refuses them. */
// docker-in-teams D27: and the Docker API (2375, 2376), matching HQ's and the runner's refusal.
export const DENIED_FORWARD_PORTS: readonly number[] = [2375, 2376, 9229, 9230];

export interface ForwardSpec {
  /** Whose forward this is. Absent only in a 0.1.x list (its slot then says whose). */
  account: AccountRef;
  orgSlug: string;
  workspaceId: string;
  teamName: string;
  remotePort: number;
  localPort: number;
}

export type PortEntry =
  | { kind: 'active'; spec: ForwardSpec; handle: ForwardHandle }
  | { kind: 'starting'; spec: ForwardSpec }
  | { kind: 'paused'; spec: ForwardSpec }
  | { kind: 'detected'; account: AccountRef; team: Team; port: number };

const tagOf = (a: AccountRef): string => accountTag(a.host, a.userId);
const specKey = (s: Pick<ForwardSpec, 'account' | 'workspaceId' | 'remotePort'>) =>
  `${tagOf(s.account)}:${s.workspaceId}:${s.remotePort}`;

/**
 * The sentence for a forward that could not start: ALWAYS the extension's own copy. The shared
 * connect code builds the `hq` CLI's sentences ("hq: ...", which says "asleep"); none of them is
 * ever shown here, only HQ's code and status are read (item 14).
 */
export function forwardError(team: string, err: unknown): string {
  if (err instanceof ConnectRefusedError) {
    const e = err.apiError;
    if (!e) return COPY.forwardFailed(COPY.unreachable);
    if (e.code === 'REMOTE_UNSUPPORTED_RUNNER' && e.details?.reason === 'restart_required') {
      return COPY.forwardRestart(team);
    }
    if (e.code === 'REMOTE_UNSUPPORTED_RUNNER') return COPY.updateNeededLong(team);
    if (e.code === 'RUNNER_UNAVAILABLE') {
      if (e.details?.hint === 'reconnect') return COPY.forwardTeamOff(team);
      // S6 / ALSO-3: `stopped` and `start_in_hq` both mean no machine HQ can resume. HQ cannot
      // tell a stopped one from none (a stopped intent is not read), so never "no machine yet".
      return COPY.forwardTeamStopped(team);
    }
    if (e.code === 'UPGRADE_REQUIRED' || e.status === 426) return COPY.tooOld;
    // train 96 review W1: an unsigned request is a client bug, not a dead sign-in.
    if (e.code === DEVICE_SIGNATURE_MISSING_CODE) return deviceSignatureMissingMessage();
    if (e.code === 'REMOTE_TOKEN_INVALID' || e.status === 401) return COPY.renewSignIn;
    if (e.status === 403) return COPY.forwardNotAllowed(team);
    if (e.status === 404) return COPY.fsTeamGone;
    return COPY.forwardFailed(cleanLabel(e.message));
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE')
    return COPY.forwardFailed('the port is already in use on this computer');
  return COPY.forwardFailed(err instanceof Error ? cleanLabel(err.message) : COPY.unreachable);
}

export interface PortsDeps {
  accounts: Pick<
    HqAccounts,
    | 'get'
    | 'active'
    | 'list'
    | 'shortLabel'
    | 'onAccountRemoved'
    | 'onAccountRenewed'
    | 'onDidChange'
  >;
  memento: vscode.Memento;
  /** A forward whose account is not signed in here: "Sign in as <email>", and no request. */
  onAccountMissing?: (account: AccountRef) => void;
}

export class Ports implements vscode.TreeDataProvider<PortEntry> {
  private readonly forwards = new Map<string, PortEntry>();
  /** Offers per account + team: listening ports not forwarded and not dismissed. */
  private readonly detected = new Map<
    string,
    { account: AccountRef; team: Team; ports: Set<number> }
  >();
  private readonly treeChanged = new vscode.EventEmitter<PortEntry | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private readonly countChanged = new Emitter<number>();
  readonly onDidChangeCount = this.countChanged.event;
  private readonly subscriptions: Array<{ dispose(): unknown }> = [];

  constructor(private readonly deps: PortsDeps) {
    this.subscriptions.push(
      deps.accounts.onAccountRemoved((ref) => void this.closeAccount(ref)),
      deps.accounts.onAccountRenewed((ref) => void this.restartAccount(ref)),
      deps.accounts.onDidChange(() => this.restorePaused()),
    );
    this.restorePaused();
  }

  private get memento(): vscode.Memento {
    return this.deps.memento;
  }

  /** Forwards that were on when the window closed come back paused (never started on their own). */
  private restorePaused(): void {
    const active = this.deps.accounts.active();
    if (active) {
      const specs = this.memento.get<Array<Partial<ForwardSpec>>>(portsKey(active.ref, 'forwards'));
      for (const raw of specs ?? []) {
        // A 0.1.x list carries no account: the slot it was kept in says whose it is.
        const spec = { ...raw, account: raw.account ?? active.ref } as ForwardSpec;
        if (!sameAccount(spec.account, active.ref)) continue;
        if (!this.forwards.has(specKey(spec)))
          this.forwards.set(specKey(spec), { kind: 'paused', spec });
      }
    }
    this.fire();
  }

  /** This account's forwards, as its paused list (only its own key is written). */
  private async persist(account: AccountRef): Promise<void> {
    const b = this.deps.accounts.get(account);
    if (!b) return;
    const specs = [...this.forwards.values()]
      .filter((e): e is Exclude<PortEntry, { kind: 'detected' }> => e.kind !== 'detected')
      .map((e) => e.spec)
      .filter((spec) => sameAccount(spec.account, account));
    await this.memento.update(portsKey(b.ref, 'forwards'), specs);
  }

  private fire(): void {
    this.treeChanged.fire(undefined);
    this.countChanged.fire(this.activeCount());
  }

  activeCount(): number {
    return [...this.forwards.values()].filter((e) => e.kind === 'active').length;
  }

  private dismissedOf(account: AccountRef): string[] {
    const b = this.deps.accounts.get(account);
    return b ? (this.memento.get<string[]>(portsKey(b.ref, 'dismissed')) ?? []) : [];
  }

  /** The machine said these ports are listening (a terminal of `account`): offer the new ones, once. */
  offer(account: AccountRef, team: Team, ports: number[]): void {
    const dismissed = new Set(
      this.dismissedOf(account).filter((k) => k.startsWith(`${team.workspace.id}:`)),
    );
    const next = new Set(
      ports.filter(
        (p) =>
          p >= 1024 &&
          !DENIED_FORWARD_PORTS.includes(p) &&
          !dismissed.has(`${team.workspace.id}:${p}`) &&
          !this.forwards.has(specKey({ account, workspaceId: team.workspace.id, remotePort: p })),
      ),
    );
    const key = `${tagOf(account)}:${team.workspace.id}`;
    const before = this.detected.get(key)?.ports;
    if (before && before.size === next.size && [...next].every((p) => before.has(p))) return;
    this.detected.set(key, { account, team, ports: next });
    this.fire();
  }

  async dismiss(entry: PortEntry): Promise<void> {
    if (entry.kind !== 'detected') return;
    const b = this.deps.accounts.get(entry.account);
    if (b) {
      const list = new Set(this.dismissedOf(entry.account));
      list.add(`${entry.team.workspace.id}:${entry.port}`);
      await this.memento.update(portsKey(b.ref, 'dismissed'), [...list]);
    }
    this.detected
      .get(`${tagOf(entry.account)}:${entry.team.workspace.id}`)
      ?.ports.delete(entry.port);
    this.fire();
  }

  /**
   * Start a forward the person asked for, AS `account` (a click is the one thing allowed to wake
   * the team). `restart` replaces a running one (the account was renewed).
   */
  async start(
    account: AccountRef,
    team: Team,
    remotePort: number,
    localPort: number,
    opts: { restart?: boolean } = {},
  ): Promise<void> {
    if (DENIED_FORWARD_PORTS.includes(remotePort)) {
      void vscode.window.showErrorMessage(COPY.forwardRefusedPort(remotePort));
      return;
    }
    const service = this.deps.accounts.get(account)?.service;
    if (!service) {
      this.deps.onAccountMissing?.(account);
      return;
    }
    const spec: ForwardSpec = {
      account,
      orgSlug: team.org.slug,
      workspaceId: team.workspace.id,
      teamName: cleanLabel(team.workspace.name) || team.alias,
      remotePort,
      localPort,
    };
    const key = specKey(spec);
    const current = this.forwards.get(key);
    if (!opts.restart && (current?.kind === 'active' || current?.kind === 'starting')) return;
    this.forwards.set(key, { kind: 'starting', spec });
    this.detected.get(`${tagOf(account)}:${team.workspace.id}`)?.ports.delete(remotePort);
    this.fire();
    let handle: ForwardHandle;
    try {
      handle = await service.call((client) =>
        startForward(
          {
            now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            say: () => undefined,
          },
          client,
          team,
          remotePort,
          localPort,
          { clientKind: 'hq-vscode', wake: true },
        ),
      );
    } catch (err) {
      if (this.forwards.get(key)?.kind === 'starting') {
        this.forwards.set(key, { kind: 'paused', spec });
        this.fire();
        void vscode.window.showErrorMessage(forwardError(spec.teamName, err));
      }
      return;
    }
    if (this.forwards.get(key)?.kind !== 'starting') {
      // The account went while this was starting: nothing may keep listening for it.
      await handle.close().catch(() => undefined);
      return;
    }
    const grantAtStart = service.currentGrant();
    const bound: ForwardSpec = { ...spec, localPort: handle.port };
    this.forwards.set(key, { kind: 'active', spec: bound, handle });
    await this.persist(account);
    this.fire();
    void vscode.window.setStatusBarMessage(
      COPY.forwarding(handle.port, spec.teamName, remotePort),
      5_000,
    );
    void handle.done.then((code) => {
      const now = this.forwards.get(key);
      if (now?.kind !== 'active' || now.handle !== handle) return;
      // The slot was renewed in another window and the old grant's forward ended: restart it on
      // the same local port with the new one (decision 26), never a pause or a revocation check.
      const grantNow = service.currentGrant();
      if (code !== 0 && grantNow !== null && grantNow !== grantAtStart) {
        void this.start(account, team, remotePort, bound.localPort, { restart: true });
        return;
      }
      // It ended on its own (a heartbeat HQ refused): paused, so one click resumes it.
      this.forwards.set(key, { kind: 'paused', spec: bound });
      this.fire();
      if (code !== 0) {
        void vscode.window.showWarningMessage(COPY.forwardEnded(remotePort));
        // U28: a heartbeat HQ refused may be a revoked grant: ask HQ once now, as THIS account (a
        // confirmed revocation wipes its slot and shows the modal).
        void service.refreshOrgs().catch(() => undefined);
      }
    });
  }

  /** Resume a paused forward AS ITS ACCOUNT; a missing account says "Sign in as" and sends nothing. */
  async resume(entry: PortEntry): Promise<void> {
    if (entry.kind !== 'paused') return;
    const b = this.deps.accounts.get(entry.spec.account);
    if (!b) {
      this.deps.onAccountMissing?.(entry.spec.account);
      return;
    }
    const team = b.service
      .teams()
      .find((t) => t.workspace.id === entry.spec.workspaceId && t.org.slug === entry.spec.orgSlug);
    if (!team) {
      void vscode.window.showErrorMessage(COPY.forwardNotAllowed(entry.spec.teamName));
      return;
    }
    await this.start(entry.spec.account, team, entry.spec.remotePort, entry.spec.localPort);
  }

  async stop(entry: PortEntry): Promise<void> {
    if (entry.kind === 'detected') return;
    const key = specKey(entry.spec);
    const current = this.forwards.get(key);
    this.forwards.delete(key);
    if (current?.kind === 'active') await current.handle.close();
    await this.persist(entry.spec.account);
    this.fire();
  }

  localUrl(entry: PortEntry): string | null {
    return entry.kind === 'active' ? `http://localhost:${entry.handle.port}` : null;
  }

  /** One account signed out or revoked (any window): its forwards and offers go; others stay. */
  async closeAccount(ref: AccountRef): Promise<void> {
    for (const [k, e] of [...this.forwards]) {
      if (e.kind === 'detected' || !sameAccount(e.spec.account, ref)) continue;
      this.forwards.delete(k);
      if (e.kind === 'active') await e.handle.close().catch(() => undefined);
    }
    for (const [k, d] of [...this.detected])
      if (sameAccount(d.account, ref)) this.detected.delete(k);
    this.fire();
  }

  /** Decision 26: the account was renewed elsewhere: each live forward restarts on its local port. */
  async restartAccount(ref: AccountRef): Promise<void> {
    const b = this.deps.accounts.get(ref);
    for (const e of [...this.forwards.values()]) {
      if (e.kind !== 'active' || !sameAccount(e.spec.account, ref)) continue;
      const team = b?.service.teams().find((t) => t.workspace.id === e.spec.workspaceId);
      this.forwards.set(specKey(e.spec), { kind: 'starting', spec: e.spec });
      await e.handle.close().catch(() => undefined);
      if (!team) {
        this.forwards.set(specKey(e.spec), { kind: 'paused', spec: e.spec });
        continue;
      }
      await this.start(ref, team, e.spec.remotePort, e.spec.localPort, { restart: true });
    }
    this.fire();
  }

  /** Close every forward, keeping each account's list as paused for the next window. */
  async closeAll(keep: boolean): Promise<void> {
    const entries = [...this.forwards.values()];
    for (const e of entries) if (e.kind === 'active') await e.handle.close().catch(() => undefined);
    if (keep) {
      const accounts = new Map<string, AccountRef>();
      for (const e of entries)
        if (e.kind !== 'detected') accounts.set(tagOf(e.spec.account), e.spec.account);
      for (const a of accounts.values()) await this.persist(a);
    } else {
      this.forwards.clear();
      this.detected.clear();
    }
    this.fire();
  }

  getChildren(entry?: PortEntry): PortEntry[] {
    if (entry) return [];
    const offers: PortEntry[] = [];
    for (const d of this.detected.values()) {
      for (const port of [...d.ports].sort((a, b) => a - b)) {
        offers.push({ kind: 'detected', account: d.account, team: d.team, port });
      }
    }
    return [...this.forwards.values(), ...offers];
  }

  /** `team · <short label>` while 2 or more accounts are signed in (decision 21). */
  private withLabel(text: string, account: AccountRef): string {
    const label = this.deps.accounts.shortLabel(account);
    return label ? `${text} · ${label}` : text;
  }

  getTreeItem(entry: PortEntry): vscode.TreeItem {
    if (entry.kind === 'detected') {
      const item = new vscode.TreeItem(COPY.forwardDetected(entry.port));
      item.description = this.withLabel(cleanLabel(entry.team.workspace.name), entry.account);
      item.contextValue = 'port:detected';
      item.iconPath = new vscode.ThemeIcon('radio-tower');
      return item;
    }
    const s = entry.spec;
    const item = new vscode.TreeItem(`${s.remotePort} → localhost:${s.localPort}`);
    const team = this.withLabel(s.teamName, s.account);
    item.description = entry.kind === 'paused' ? `${team} · ${COPY.forwardPaused}` : team;
    item.contextValue =
      entry.kind === 'active'
        ? 'port:active'
        : entry.kind === 'paused'
          ? 'port:paused'
          : 'port:starting';
    item.iconPath = new vscode.ThemeIcon(
      entry.kind === 'active' ? 'plug' : entry.kind === 'starting' ? 'sync~spin' : 'debug-pause',
    );
    if (entry.kind === 'paused') {
      item.command = { command: brandText('hq.ports.resume'), title: 'Resume', arguments: [entry] };
    }
    return item;
  }

  dispose(): void {
    void this.closeAll(true);
    for (const s of this.subscriptions) s.dispose();
    this.treeChanged.dispose();
    this.countChanged.dispose();
  }
}

/** Ask for the ports of a new forward. Null when cancelled. */
export async function askForPorts(): Promise<{ remote: number; local: number } | null> {
  const remoteRaw = await vscode.window.showInputBox({
    prompt: COPY.forwardPrompt,
    validateInput: (v) => (parsePort(v.trim(), 1024) === null ? COPY.forwardBadPort : null),
  });
  if (remoteRaw === undefined) return null;
  const remote = parsePort(remoteRaw.trim(), 1024)!;
  const localRaw = await vscode.window.showInputBox({
    prompt: COPY.forwardLocalPrompt,
    value: String(remote),
    validateInput: (v) =>
      v.trim() === '' || parsePort(v.trim(), 1) !== null ? null : COPY.forwardBadLocal,
  });
  if (localRaw === undefined) return null;
  const local = localRaw.trim() === '' ? remote : parsePort(localRaw.trim(), 1)!;
  return { remote, local };
}
