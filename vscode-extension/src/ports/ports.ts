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
 */
import * as vscode from 'vscode';
import type { HqService } from '../hq/hq-service.js';
import { ConnectRefusedError } from '@hq/client/connect.js';
import { parsePort, startForward, type ForwardHandle } from '@hq/client/forward.js';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { Emitter } from '../util/emitter.js';
import { cleanLabel } from '../util/text.js';

/** Refused before any request (decision 14). HQ also refuses them. */
// docker-in-teams D27: and the Docker API (2375, 2376), matching HQ's and the runner's refusal.
export const DENIED_FORWARD_PORTS: readonly number[] = [2375, 2376, 9229, 9230];

export interface ForwardSpec {
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
  | { kind: 'detected'; team: Team; port: number };

const specKey = (s: Pick<ForwardSpec, 'workspaceId' | 'remotePort'>) =>
  `${s.workspaceId}:${s.remotePort}`;

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
      // S6: `stopped` = the machine exists but is stopped; `start_in_hq` = there is none yet.
      if (e.details?.hint === 'stopped') return COPY.forwardTeamStopped(team);
      return COPY.wakeNoMachine(team);
    }
    if (e.code === 'UPGRADE_REQUIRED' || e.status === 426) return COPY.tooOld;
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

export class Ports implements vscode.TreeDataProvider<PortEntry> {
  private readonly forwards = new Map<string, PortEntry>();
  /** Offers per team: listening ports not forwarded and not dismissed. */
  private readonly detected = new Map<string, { team: Team; ports: Set<number> }>();
  private readonly treeChanged = new vscode.EventEmitter<PortEntry | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private readonly countChanged = new Emitter<number>();
  readonly onDidChangeCount = this.countChanged.event;

  constructor(
    private readonly service: HqService,
    private readonly memento: vscode.Memento,
  ) {
    service.onRevoked(() => void this.closeAll(false));
    service.onDidChange(() => this.restorePaused());
    this.restorePaused();
  }

  private pausedKey(): string | null {
    const host = this.service.host();
    return host ? `hq:${host}:ports:forwards` : null;
  }
  private dismissedKey(): string | null {
    const host = this.service.host();
    return host ? `hq:${host}:ports:dismissed` : null;
  }

  /** Forwards that were on when the window closed come back paused (never started on their own). */
  private restorePaused(): void {
    const key = this.pausedKey();
    if (!key || !this.service.signedIn()) return;
    const specs = this.memento.get<ForwardSpec[]>(key) ?? [];
    for (const spec of specs) {
      if (!this.forwards.has(specKey(spec)))
        this.forwards.set(specKey(spec), { kind: 'paused', spec });
    }
    this.fire();
  }

  private async persist(): Promise<void> {
    const key = this.pausedKey();
    if (!key) return;
    const specs = [...this.forwards.values()]
      .filter((e): e is Exclude<PortEntry, { kind: 'detected' }> => e.kind !== 'detected')
      .map((e) => e.spec);
    await this.memento.update(key, specs);
  }

  private fire(): void {
    this.treeChanged.fire(undefined);
    this.countChanged.fire(this.activeCount());
  }

  activeCount(): number {
    return [...this.forwards.values()].filter((e) => e.kind === 'active').length;
  }

  /** The machine said these ports are listening: offer the new ones, once. */
  offer(team: Team, ports: number[]): void {
    const dismissed = new Set(
      (this.memento.get<string[]>(this.dismissedKey() ?? '') ?? []).filter((k) =>
        k.startsWith(`${team.workspace.id}:`),
      ),
    );
    const next = new Set(
      ports.filter(
        (p) =>
          p >= 1024 &&
          !DENIED_FORWARD_PORTS.includes(p) &&
          !dismissed.has(`${team.workspace.id}:${p}`) &&
          !this.forwards.has(specKey({ workspaceId: team.workspace.id, remotePort: p })),
      ),
    );
    const before = this.detected.get(team.workspace.id)?.ports;
    if (before && before.size === next.size && [...next].every((p) => before.has(p))) return;
    this.detected.set(team.workspace.id, { team, ports: next });
    this.fire();
  }

  async dismiss(entry: PortEntry): Promise<void> {
    if (entry.kind !== 'detected') return;
    const key = this.dismissedKey();
    if (key) {
      const list = new Set(this.memento.get<string[]>(key) ?? []);
      list.add(`${entry.team.workspace.id}:${entry.port}`);
      await this.memento.update(key, [...list]);
    }
    this.detected.get(entry.team.workspace.id)?.ports.delete(entry.port);
    this.fire();
  }

  /** Start a forward the person asked for (a click is the one thing allowed to wake the team). */
  async start(team: Team, remotePort: number, localPort: number): Promise<void> {
    if (DENIED_FORWARD_PORTS.includes(remotePort)) {
      void vscode.window.showErrorMessage(COPY.forwardRefusedPort(remotePort));
      return;
    }
    const spec: ForwardSpec = {
      orgSlug: team.org.slug,
      workspaceId: team.workspace.id,
      teamName: cleanLabel(team.workspace.name) || team.alias,
      remotePort,
      localPort,
    };
    const key = specKey(spec);
    const current = this.forwards.get(key);
    if (current?.kind === 'active' || current?.kind === 'starting') return;
    this.forwards.set(key, { kind: 'starting', spec });
    this.detected.get(team.workspace.id)?.ports.delete(remotePort);
    this.fire();
    let handle: ForwardHandle;
    try {
      handle = await this.service.call((client) =>
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
      this.forwards.set(key, { kind: 'paused', spec });
      this.fire();
      void vscode.window.showErrorMessage(forwardError(spec.teamName, err));
      return;
    }
    const bound: ForwardSpec = { ...spec, localPort: handle.port };
    this.forwards.set(key, { kind: 'active', spec: bound, handle });
    await this.persist();
    this.fire();
    void vscode.window.setStatusBarMessage(
      COPY.forwarding(handle.port, spec.teamName, remotePort),
      5_000,
    );
    void handle.done.then((code) => {
      const now = this.forwards.get(key);
      if (now?.kind !== 'active' || now.handle !== handle) return;
      // It ended on its own (a heartbeat HQ refused): paused, so one click resumes it.
      this.forwards.set(key, { kind: 'paused', spec: bound });
      this.fire();
      if (code !== 0) {
        void vscode.window.showWarningMessage(COPY.forwardEnded(remotePort));
        // U28: a heartbeat HQ refused may be a revoked grant: ask HQ once now (a confirmed
        // revocation wipes the sign-in and shows the modal).
        void this.service.refreshOrgs().catch(() => undefined);
      }
    });
  }

  async resume(entry: PortEntry): Promise<void> {
    if (entry.kind !== 'paused') return;
    const team = this.service
      .teams()
      .find((t) => t.workspace.id === entry.spec.workspaceId && t.org.slug === entry.spec.orgSlug);
    if (!team) {
      void vscode.window.showErrorMessage(COPY.forwardNotAllowed(entry.spec.teamName));
      return;
    }
    await this.start(team, entry.spec.remotePort, entry.spec.localPort);
  }

  async stop(entry: PortEntry): Promise<void> {
    if (entry.kind === 'detected') return;
    const key = specKey(entry.spec);
    const current = this.forwards.get(key);
    this.forwards.delete(key);
    if (current?.kind === 'active') await current.handle.close();
    await this.persist();
    this.fire();
  }

  localUrl(entry: PortEntry): string | null {
    return entry.kind === 'active' ? `http://localhost:${entry.handle.port}` : null;
  }

  /** Close every forward. `keep` leaves them listed as paused for the next window. */
  async closeAll(keep: boolean): Promise<void> {
    const entries = [...this.forwards.values()];
    for (const e of entries) if (e.kind === 'active') await e.handle.close().catch(() => undefined);
    if (keep) {
      await this.persist();
    } else {
      this.forwards.clear();
      this.detected.clear();
      const key = this.pausedKey();
      if (key) await this.memento.update(key, []);
    }
    this.fire();
  }

  getChildren(entry?: PortEntry): PortEntry[] {
    if (entry) return [];
    const offers: PortEntry[] = [];
    for (const d of this.detected.values()) {
      for (const port of [...d.ports].sort((a, b) => a - b)) {
        offers.push({ kind: 'detected', team: d.team, port });
      }
    }
    return [...this.forwards.values(), ...offers];
  }

  getTreeItem(entry: PortEntry): vscode.TreeItem {
    if (entry.kind === 'detected') {
      const item = new vscode.TreeItem(COPY.forwardDetected(entry.port));
      item.description = cleanLabel(entry.team.workspace.name);
      item.contextValue = 'port:detected';
      item.iconPath = new vscode.ThemeIcon('radio-tower');
      return item;
    }
    const s = entry.spec;
    const item = new vscode.TreeItem(`${s.remotePort} → localhost:${s.localPort}`);
    item.description =
      entry.kind === 'paused' ? `${s.teamName} · ${COPY.forwardPaused}` : s.teamName;
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
      item.command = { command: 'hq.ports.resume', title: 'Resume', arguments: [entry] };
    }
    return item;
  }

  dispose(): void {
    void this.closeAll(true);
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
