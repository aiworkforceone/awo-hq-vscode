/**
 * The extension's side of `WS /ws/remote/events` (FEATURE decision 12, §7a "Events client"): ONE
 * socket per org, a `subscribe` per team whose folder is open, reconnect with backoff, the access
 * token rotated in band, and a `resync` handed to the file system after every gap (a reconnect, the
 * hourly cut, a pin move), because changes during the gap were not seen.
 *
 * `isLive(team)` is what lets `stat()` answer from the cache (FEATURE C1): only while this socket is
 * open AND the server said the team's watcher runs (`subscribed` with `watch: true`, and no later
 * state other than running). Frames of the wrong shape are dropped, never emitted. No `vscode`
 * import.
 */
import { WebSocket } from 'ws';
import { HqApiError, type HqClient } from '@hq/client/api.js';
import { wsUrl } from '@hq/client/tunnel-client.js';
import type { Team } from '@hq/client/teams.js';
import {
  REMOTE_EVENTS_WS_PATH,
  type EventsErrorCode,
  type EventsServerFrame,
  type RemoteWorkspaceLiveState,
} from '@kpa/shared/remote-fs.types';

export type EventsWsFactory = (url: string, headers: Record<string, string>) => WebSocket;

export interface EventsHubDeps {
  client(): Promise<HqClient | null>;
  ws?: EventsWsFactory;
  /** Reconnect backoff bounds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How often the current access token is offered to the socket. */
  tokenEveryMs?: number;
  /**
   * The wait after a `429` (too many sockets for this sign-in, or dialling too fast): long, so a
   * refused window never hammers the server, and never shorter than the ordinary backoff.
   */
  refusedBackoffMs?: number;
  /** A refusal the person should hear about (once per socket until it opens): 429 today. */
  onRefused?(org: string, status: number): void;
  /**
   * HQ closed the socket 4401 (the grant was revoked, expired, or remote access was turned off):
   * the sign-in service asks HQ at once (U28), instead of waiting for the next HTTP call.
   */
  onUnauthorized?(): void | Promise<unknown>;
  /**
   * After a check, how long before another 401 may start the next one (security review L2a): the
   * guard re-arms when the check has finished AND this long has passed. Default 30 s.
   */
  unauthorizedQuietMs?: number;
  /**
   * hq-vscode-multi-account decision 26: the grant a client was built for, and the account's grant
   * now. A 4401 on a socket dialled with an OLD grant (renewed in another window, which revoked the
   * old one) redials with the new one: it is not a revocation.
   */
  grantOf?(client: HqClient): string | undefined;
  currentGrant?(): string | null;
}

type Listener = (frame: EventsServerFrame) => void;

const LIVE_STATES: ReadonlySet<string> = new Set<RemoteWorkspaceLiveState>([
  'running',
  'starting',
  'asleep',
  'stopped',
]);
const CHANGE_KINDS: ReadonlySet<string> = new Set(['created', 'changed', 'deleted']);
/** The closed error vocabulary: any other code is dropped, so none ever reaches a label as sent. */
const ERROR_CODES: ReadonlySet<string> = new Set<EventsErrorCode>([
  'FORBIDDEN',
  'NOT_FOUND',
  'TOO_MANY_SUBSCRIPTIONS',
  'BAD_FRAME',
  'THROTTLED',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A server frame of the right shape, or null (review SHOULD: a bad frame never reaches the cache). */
export function parseEventsFrame(v: unknown): EventsServerFrame | null {
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  const ws = v.workspaceId;
  const hasWs = typeof ws === 'string' && ws.length > 0;
  const state = (s: unknown): s is RemoteWorkspaceLiveState =>
    typeof s === 'string' && LIVE_STATES.has(s);
  switch (v.type) {
    case 'fs-changed':
      if (
        !hasWs ||
        typeof v.seq !== 'number' ||
        !Array.isArray(v.changes) ||
        !v.changes.every(
          (c) =>
            isRecord(c) &&
            typeof c.path === 'string' &&
            (c.kind === undefined || (typeof c.kind === 'string' && CHANGE_KINDS.has(c.kind))),
        )
      ) {
        return null;
      }
      return v as unknown as EventsServerFrame;
    case 'workspace-state':
      return hasWs && state(v.state) ? (v as unknown as EventsServerFrame) : null;
    case 'listen-ports':
      return hasWs && Array.isArray(v.ports) && v.ports.every((p) => Number.isInteger(p))
        ? (v as unknown as EventsServerFrame)
        : null;
    case 'resync':
    case 'unsubscribed':
      return hasWs ? (v as unknown as EventsServerFrame) : null;
    case 'subscribed':
      return hasWs && state(v.state) && typeof v.watch === 'boolean'
        ? (v as unknown as EventsServerFrame)
        : null;
    case 'error':
      return typeof v.code === 'string' &&
        ERROR_CODES.has(v.code) &&
        (v.workspaceId === undefined || hasWs)
        ? (v as unknown as EventsServerFrame)
        : null;
    default:
      return null;
  }
}

const defaultWs: EventsWsFactory = (url, headers) =>
  // A handshake that never completes must not hold the org's one socket forever.
  new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 20_000 });

class OrgSocket {
  ws: WebSocket | null = null;
  readonly subs = new Map<string, number>(); // workspaceId → refcount
  /** Teams whose watcher the server says runs now (`subscribed` with `watch: true`). */
  readonly acked = new Set<string>();
  private backoff: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tokenTimer: ReturnType<typeof setInterval> | null = null;
  private lastToken: string | null = null;
  private everConnected = false;
  private closedForGood = false;
  /**
   * A dial is in flight (between the first await and the socket existing). Set SYNCHRONOUSLY, so
   * VS Code's burst of `watch()` calls on a folder open shares ONE connect (nonprod 2026-09-30:
   * one window opened 7 sockets in 300 ms, 3 were refused 429 and the orphans held the slots).
   */
  private connecting = false;
  /** The refusal was already surfaced; cleared when a socket opens. */
  private refusalSaid = false;
  /** A 401 was already handed to the service; cleared when a socket opens. */
  private unauthorizedSaid = false;
  /** A reconnect was asked while a dial was in flight: dial again once it finishes. */
  private redial = false;
  /** Teams already subscribed once on this org's socket (any of its dials). */
  private readonly announced = new Set<string>();

  constructor(
    private readonly org: string,
    private readonly deps: EventsHubDeps,
    private readonly emit: Listener,
  ) {
    this.backoff = deps.minBackoffMs ?? 1_000;
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Closed for good (a 4401, or a close): a new watch builds a new socket. */
  get dead(): boolean {
    return this.closedForGood;
  }

  ensureConnected(): void {
    if (this.closedForGood || this.connecting || this.ws !== null || this.timer !== null) return;
    void this.connect();
  }

  /** Dial once. Callers go through `ensureConnected` (or the reconnect timer), never in parallel. */
  async connect(): Promise<void> {
    this.connecting = true;
    let client: HqClient | null;
    let headers: Record<string, string>;
    try {
      client = await this.deps.client().catch(() => null);
      if (!client || this.closedForGood) return this.scheduleReconnect();
      headers = await client.upgradeHeaders(REMOTE_EVENTS_WS_PATH, this.org);
    } catch (err) {
      // Item 12: a 401 while signing the upgrade (`GET /api/remote/nonce`) is a login HQ may have
      // revoked: the service confirms it now (modal, terminals and forwards closed), once.
      if (err instanceof HqApiError && err.status === 401) {
        // S3: a refused login is not a blip: wait the long backoff, never the 1 s ladder.
        this.backoff = this.deps.maxBackoffMs ?? 30_000;
        this.unauthorized();
      }
      return this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
    // Closed (last watch disposed, sign-out) while the headers were being built: never dial.
    if (this.closedForGood) return;
    // Renewed while this dial built its headers with the old client: start over with the new one.
    if (this.redial) {
      this.redial = false;
      return this.connect();
    }
    this.lastToken = /^Bearer (.+)$/.exec(headers.Authorization ?? '')?.[1] ?? null;
    const ws = (this.deps.ws ?? defaultWs)(wsUrl(client.host, REMOTE_EVENTS_WS_PATH), headers);
    this.adopt(ws);
    ws.on('open', () => {
      const gap = this.everConnected;
      this.everConnected = true;
      this.refusalSaid = false;
      this.unauthorizedSaid = false;
      this.backoff = this.deps.minBackoffMs ?? 1_000;
      for (const id of this.subs.keys()) this.sendSubscribe(id);
      this.startTokenRotation(client);
      // After a gap the subscriptions are re-made; the `subscribed` answers carry the resync.
      if (gap) this.gapPending = new Set(this.subs.keys());
    });
    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const frame = parseEventsFrame(raw);
      if (frame === null) return;
      if (frame.type === 'subscribed') {
        if (frame.watch && frame.state === 'running') this.acked.add(frame.workspaceId);
        else this.acked.delete(frame.workspaceId);
        if (this.gapPending?.delete(frame.workspaceId)) {
          this.emit(frame);
          this.emit({ type: 'resync', workspaceId: frame.workspaceId });
          return;
        }
      }
      if (frame.type === 'workspace-state' && frame.state !== 'running') {
        this.acked.delete(frame.workspaceId);
      }
      if (frame.type === 'unsubscribed' || (frame.type === 'error' && frame.workspaceId)) {
        if (frame.workspaceId) this.acked.delete(frame.workspaceId);
      }
      this.emit(frame);
    });
    const down = (): void => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.acked.clear();
      this.stopTokenRotation();
      if (this.subs.size > 0) this.scheduleReconnect();
    };
    ws.on('close', (code) => {
      // A socket this one replaced: whatever it says is about the old dial.
      if (this.ws !== ws) return;
      if (code === 4401) {
        const built = this.deps.grantOf?.(client);
        const now = this.deps.currentGrant?.();
        if (built !== undefined && now !== undefined && now !== null && built !== now) {
          // The OLD grant's socket after a renew elsewhere: dial again with the new grant.
          this.backoff = this.deps.minBackoffMs ?? 1_000;
          down();
          return;
        }
        // 4401: the login may be gone. Stop dialling, and have the service ask HQ now (U28).
        this.closedForGood = true;
        this.unauthorized();
      }
      down();
    });
    ws.on('error', () => undefined);
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      if (status === 404 || status === 401 || status === 403) {
        // Not available here (404), or not allowed: retry slowly, never in a loop.
        this.backoff = this.deps.maxBackoffMs ?? 30_000;
      }
      // L2b: the upgrade itself refused the token (a cached nonce skipped the nonce fetch).
      if (status === 401) this.unauthorized();
      if (status === 429) {
        // Too many sockets for this sign-in (other windows hold them) or dialling too fast: wait
        // long, and say so once. The 60 s root refresh keeps the Explorer moving meanwhile.
        this.backoff = Math.max(
          this.deps.refusedBackoffMs ?? 300_000,
          this.deps.minBackoffMs ?? 1_000,
        );
        if (!this.refusalSaid) {
          this.refusalSaid = true;
          try {
            this.deps.onRefused?.(this.org, status);
          } catch {
            /* a notice must never break the socket's own bookkeeping */
          }
        }
      }
      ws.terminate();
    });
  }

  /**
   * Hand a possible revocation to the service: one check at a time. The guard re-arms when that
   * check has finished and the quiet time has passed (L2a), or when a socket opens, so a later
   * real revocation is still reported.
   */
  private unauthorized(): void {
    if (this.unauthorizedSaid) return;
    this.unauthorizedSaid = true;
    let check: Promise<unknown>;
    try {
      check = Promise.resolve(this.deps.onUnauthorized?.());
    } catch {
      check = Promise.resolve();
    }
    const quiet = new Promise((r) => {
      const t = setTimeout(r, this.deps.unauthorizedQuietMs ?? 30_000);
      (t as { unref?: () => void }).unref?.();
    });
    void Promise.all([check.catch(() => undefined), quiet]).then(() => {
      this.unauthorizedSaid = false;
    });
  }

  /**
   * Make `ws` THE socket. One that was already there is closed first: a socket this client no
   * longer tracks would keep holding one of the server's per-sign-in slots and receive frames
   * nobody reads.
   */
  private adopt(ws: WebSocket): void {
    const old = this.ws;
    this.ws = ws;
    if (old !== null && old !== ws) {
      this.acked.clear();
      this.stopTokenRotation();
      old.terminate();
    }
  }

  private gapPending: Set<string> | null = null;

  private scheduleReconnect(): void {
    if (this.closedForGood || this.timer !== null || this.subs.size === 0) return;
    const wait = this.backoff;
    // After a 429 the long wait was just used; the next failure starts the ordinary ladder again
    // from its ceiling, which the next 429 lifts back up.
    this.backoff = Math.min(this.backoff * 2, this.deps.maxBackoffMs ?? 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private startTokenRotation(client: HqClient): void {
    this.stopTokenRotation();
    this.tokenTimer = setInterval(() => {
      void client
        .accessToken()
        .then((token) => {
          if (token !== this.lastToken && this.isOpen()) {
            this.lastToken = token;
            this.ws!.send(JSON.stringify({ type: 'remote-token', token }));
          }
        })
        .catch(() => undefined);
    }, this.deps.tokenEveryMs ?? 60_000);
    (this.tokenTimer as { unref?: () => void }).unref?.();
  }

  private stopTokenRotation(): void {
    if (this.tokenTimer !== null) clearInterval(this.tokenTimer);
    this.tokenTimer = null;
  }

  /**
   * fix/vscode-presence: the first subscribe of a team is a person opening its folder (`open`, which
   * HQ counts as presence on a running team); every later one, re-made after a drop, the hourly LB
   * recycle or a renewed sign-in, is the client's own (`reconnect`, which never counts).
   */
  sendSubscribe(id: string): void {
    if (!this.isOpen()) return;
    const intent = this.announced.has(id) ? 'reconnect' : 'open';
    this.announced.add(id);
    this.ws!.send(JSON.stringify({ type: 'subscribe', workspaceId: id, intent }));
  }

  /** The team's folder was closed: its next subscribe is a person opening it again. */
  forget(id: string): void {
    this.announced.delete(id);
  }

  sendUnsubscribe(id: string): void {
    if (this.isOpen()) this.ws!.send(JSON.stringify({ type: 'unsubscribe', workspaceId: id }));
  }

  /**
   * Drop the open socket and dial again now, through `deps.client()` (hq-vscode-multi-account
   * decision 26: the slot was renewed in another window, and the token timer above holds the old
   * client and swallows its errors). The re-made subscriptions carry a resync.
   */
  reconnectNow(): void {
    // A 4401 from the OLD grant closed it "for good"; the renewed grant may dial again. A socket
    // closed because its last watch went (no subscriptions) stays closed.
    if (this.closedForGood && this.subs.size === 0) return;
    this.closedForGood = false;
    this.unauthorizedSaid = false;
    if (this.connecting) {
      this.redial = true;
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.acked.clear();
    this.stopTokenRotation();
    ws?.terminate();
    this.everConnected = this.everConnected || ws !== null;
    this.backoff = this.deps.minBackoffMs ?? 1_000;
    if (this.subs.size > 0 && !this.connecting) void this.connect();
  }

  close(): void {
    this.closedForGood = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stopTokenRotation();
    const ws = this.ws;
    this.ws = null;
    this.acked.clear();
    ws?.close(1000, 'done');
  }
}

export class EventsHub {
  private readonly orgs = new Map<string, OrgSocket>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: EventsHubDeps) {}

  onFrame(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private emit(frame: EventsServerFrame): void {
    for (const l of [...this.listeners]) l(frame);
  }

  /** Watch one team (refcounted). The first watch of an org opens its socket. */
  subscribe(team: Team): { dispose(): void } {
    const slug = team.org.slug;
    let org = this.orgs.get(slug);
    if (!org || org.dead) {
      org = new OrgSocket(slug, this.deps, (f) => this.emit(f));
      this.orgs.set(slug, org);
    }
    const id = team.workspace.id;
    const n = org.subs.get(id) ?? 0;
    org.subs.set(id, n + 1);
    if (n === 0) org.sendSubscribe(id);
    org.ensureConnected();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const left = (org!.subs.get(id) ?? 1) - 1;
        if (left > 0) {
          org!.subs.set(id, left);
          return;
        }
        org!.subs.delete(id);
        org!.acked.delete(id);
        org!.forget(id);
        org!.sendUnsubscribe(id);
        if (org!.subs.size === 0) {
          org!.close();
          this.orgs.delete(slug);
        }
      },
    };
  }

  /** Is this team's change stream live right now (socket open, subscription acknowledged)? */
  isLive(team: Team): boolean {
    const org = this.orgs.get(team.org.slug);
    return org !== undefined && org.isOpen() && org.acked.has(team.workspace.id);
  }

  /** The account's slot was renewed: every open socket redials with the new grant. */
  reconnectAll(): void {
    for (const org of this.orgs.values()) org.reconnectNow();
  }

  /** Sign-out, revocation, host change: every socket goes. */
  closeAll(): void {
    for (const org of this.orgs.values()) org.close();
    this.orgs.clear();
  }
}
