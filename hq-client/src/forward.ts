/**
 * One port forward (remote-dev-access S1, shared by the `hq` CLI and the VS Code extension,
 * hq-vscode decision 4): ONE connection row for the whole invocation, one tunnel upgrade per
 * accepted local TCP connection, each with its own one-time code and signature. A 30 s heartbeat
 * keeps the row from the stale sweep; `close()` ends it.
 *
 * The heartbeat and a stream's code-then-upgrade run under one lock: a heartbeat poll on a row that
 * has not connected yet re-issues the row's code, which would void a code already in flight.
 *
 * ⛔ THE LAPTOP LISTENS ON 127.0.0.1 ONLY (hq-vscode D11, VS-20), never on every interface: the
 *    forwarded port is a credentialed pipe into the team machine.
 */
import net from 'node:net';
import type { RemoteClientKind } from '@kpa/shared/remote.types';
import type { HqClient } from './api.js';
import { closeConnection, connectionsPath, openConnection, type ConnectDeps } from './connect.js';
import type { Team } from './teams.js';
import {
  closeTunnel,
  openTunnelSocket,
  pipeTunnel,
  TunnelRefusedError,
  type WsFactory,
} from './tunnel-client.js';

export const HEARTBEAT_MS = 30_000;

export function parsePort(v: string | undefined, min: number): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= 65535 ? n : null;
}

class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface ForwardHandle {
  port: number;
  close: () => Promise<void>;
  done: Promise<number>;
}

export interface ForwardOptions {
  /** The connection's `client_kind` (the audit says which door carried it). */
  clientKind?: RemoteClientKind;
  wsFactory?: WsFactory;
  /**
   * `true` (the CLI, and a forward the person just asked for) wakes a sleeping team; a forward the
   * extension RESTORES after a reload is started only when clicked, so it never wakes on its own.
   */
  wake?: boolean;
}

export async function startForward(
  deps: ConnectDeps,
  client: HqClient,
  team: Team,
  remotePort: number,
  localPort: number,
  opts: ForwardOptions = {},
): Promise<ForwardHandle> {
  const wsFactory = opts.wsFactory;
  const conn = await openConnection(
    client,
    team,
    {
      scope: 'forward',
      port: remotePort,
      localPort,
      client: opts.clientKind ?? 'hq',
      intent: 'open',
      wake: opts.wake ?? true,
    },
    deps,
  );
  const lock = new Lock();
  const org = team.org.slug;
  let closed = false;

  const server = net.createServer((sock) => {
    // Review 2026-09-27: an 'error' listener BEFORE any await. A browser resetting a keep-alive
    // connection (ECONNRESET) or a write to a destroyed socket otherwise throws as an unhandled
    // 'error' event, and the whole process (every other forwarded stream) dies with it.
    let tunnel: Parameters<typeof closeTunnel>[0] | null = null;
    sock.on('error', () => {
      if (tunnel) closeTunnel(tunnel, 1000);
      sock.destroy();
    });
    sock.pause();
    void lock
      .run(async () => {
        const { body } = await client.request<{ connectCode: string }>(
          'POST',
          `${connectionsPath(team, conn.id)}/codes`,
          {
            org,
            signed: true,
          },
        );
        return openTunnelSocket(client, org, body.connectCode, wsFactory);
      })
      .then(async (ws) => {
        tunnel = ws;
        // Code S-e: the socket is still PAUSED here (`openTunnelSocket`), or paused again by the
        // pipe's backpressure later: `closeTunnel` resumes it, so the close reply is read.
        if (sock.destroyed) {
          closeTunnel(ws, 1000);
          return;
        }
        sock.on('close', () => closeTunnel(ws, 1000));
        sock.resume();
        await pipeTunnel(ws, sock, sock);
        if (!sock.destroyed) sock.end();
      })
      .catch((err: unknown) => {
        deps.say(
          err instanceof TunnelRefusedError
            ? err.message
            : `hq: stream failed (${(err as Error).message})`,
        );
        sock.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, '127.0.0.1', () => resolve());
  });
  const bound = (server.address() as net.AddressInfo).port;

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  const heartbeat = setInterval(() => {
    void lock
      .run(() => client.request('GET', connectionsPath(team, conn.id), { org, signed: true }))
      .catch((err: unknown) => {
        deps.say(`hq: the forward ended (${(err as Error).message}).`);
        void close(1);
      });
  }, HEARTBEAT_MS);

  const close = async (code = 0) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    await new Promise<void>((r) => server.close(() => r()));
    await closeConnection(client, team, conn.id);
    resolveDone(code);
  };
  return { port: bound, close: () => close(0), done };
}
