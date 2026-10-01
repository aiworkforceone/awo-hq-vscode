/**
 * `WS /ws/remote/tunnel` from the laptop: the device-signed upgrade (Bearer + one-time connect
 * code + org + nonce + signature) and a byte pipe with backpressure. Binary frames only.
 */
import WebSocket from 'ws';
import {
  HQ_HEADER_CONNECT_CODE,
  REMOTE_CLOSE_RUNNER_UNAVAILABLE,
  REMOTE_CLOSE_SSH_CONN_REVOKED,
  REMOTE_CLOSE_SSH_IDLE_SLEEP,
  REMOTE_CLOSE_SSH_KEY_REFUSED,
  REMOTE_CLOSE_SSH_LIFETIME,
  REMOTE_CLOSE_UNAUTHORIZED,
} from '@kpa/shared/remote.types';
import type { Readable, Writable } from 'node:stream';
import type { HqClient } from './api.js';

export const REMOTE_TUNNEL_WS_PATH = '/ws/remote/tunnel';
export const REMOTE_TERMINAL_WS_PATH = '/ws/remote/terminal';

export function wsUrl(host: string, path: string): string {
  return `${host.replace(/^http/, 'ws')}${path}`;
}

export class TunnelRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TunnelRefusedError';
  }
}

export function upgradeRefusalMessage(status: number): string {
  if (status === 401)
    return 'hq: this connection was refused. Your login may have expired: run hq login.';
  if (status === 403) return 'hq: remote access to this team is not allowed for you right now.';
  if (status === 404) return 'hq: remote access is not available on this HQ.';
  if (status === 409)
    return 'hq: this team machine needs an update before it accepts this connection. An owner or admin can update it in HQ.';
  if (status === 429)
    return 'hq: too many connection attempts right now. Wait a minute and try again.';
  if (status === 501)
    return 'hq: connections to team machines are not switched on for this HQ yet. Ask an owner or admin.';
  if (status === 503) return 'hq: HQ is restarting. Try again in a moment.';
  if (status === 504) return 'hq: the team machine did not answer in time. Try again in a moment.';
  return `hq: the team machine could not be reached (HTTP ${status}).`;
}

/** The sentence for a close code the tunnel ended with (null = a normal close, say nothing). */
export function closeMessage(code: number): string | null {
  switch (code) {
    case 1000:
    case 1001:
    case 1005:
      return null;
    case REMOTE_CLOSE_UNAUTHORIZED:
      return 'hq: your access to this team ended (revoked, expired, or remote access was turned off).';
    case REMOTE_CLOSE_SSH_KEY_REFUSED:
      return "hq: the team machine refused this computer's key. Run hq login again.";
    case REMOTE_CLOSE_SSH_CONN_REVOKED:
      return 'hq: this connection was closed from HQ.';
    case REMOTE_CLOSE_SSH_IDLE_SLEEP:
      return 'hq: the team machine went to sleep.';
    case REMOTE_CLOSE_SSH_LIFETIME:
      return 'hq: connections end after 12 hours. Connect again to continue.';
    case REMOTE_CLOSE_RUNNER_UNAVAILABLE:
      return 'hq: the team machine is not available right now.';
    default:
      return `hq: the connection closed (${code}).`;
  }
}

export type WsFactory = (url: string, headers: Record<string, string>) => WebSocket;

const defaultWs: WsFactory = (url, headers) =>
  new WebSocket(url, { headers, perMessageDeflate: false });

/**
 * Open the signed tunnel upgrade. Resolves once the socket is OPEN; rejects with the refusal.
 *
 * ⛔ RESOLVES THE SOCKET PAUSED (review C1). The far end speaks first (an SSH server's
 *    identification string), and on a real network that frame arrives in the SAME read as the
 *    `101`: `ws` emits `open` and then the `message` in one tick, before the caller's `await` has
 *    returned and `pipeTunnel` listens, and the banner would be lost. So the socket is paused inside
 *    `open`, synchronously, and `pipeTunnel` resumes it as its last step.
 */
export async function openTunnelSocket(
  client: HqClient,
  org: string,
  connectCode: string,
  factory: WsFactory = defaultWs,
): Promise<WebSocket> {
  const headers = await client.upgradeHeaders(REMOTE_TUNNEL_WS_PATH, org, {
    [HQ_HEADER_CONNECT_CODE]: connectCode,
  });
  const ws = factory(wsUrl(client.host, REMOTE_TUNNEL_WS_PATH), headers);
  ws.binaryType = 'nodebuffer';
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => {
      ws.pause();
      resolve(ws);
    });
    ws.once('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
      reject(new TunnelRefusedError(status, upgradeRefusalMessage(status)));
    });
    ws.once('error', (err) =>
      reject(new TunnelRefusedError(0, `hq: could not reach HQ (${err.message}).`)),
    );
  });
}

/**
 * Close a tunnel socket that may still be PAUSED (code review S-e): handed over paused by
 * `openTunnelSocket`, or paused by `pipeTunnel` while its output drains. A paused socket never reads
 * the far end's close reply, so a bare `close()` would hold the connection open until `ws`'s close
 * timeout. Resumed first; a socket that is not open is left alone.
 */
export function closeTunnel(ws: WebSocket, code = 1000): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.resume();
  ws.close(code);
}

/**
 * Pipe `input` → socket and socket → `output` until either side ends. Resolves with the close code.
 * Backpressure both ways: pause the reader while the socket's buffer is over the high-water mark,
 * and pause the socket while `output` is draining.
 */
export function pipeTunnel(
  ws: WebSocket,
  input: Readable,
  output: Writable,
  highWater = 1 << 20,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      clearInterval(drainTimer);
      resolve(code);
    };
    // Review 2026-09-27: a local stream error (a reset socket, a closed stdout) ends THIS tunnel
    // cleanly; an unhandled 'error' event would throw and take the whole process down.
    const onLocalError = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close(1000);
      finish(1000);
    };
    input.on('error', onLocalError);
    // A net.Socket is both ends (`hq forward`): one listener is enough.
    if ((output as unknown) !== (input as unknown)) output.on('error', onLocalError);
    const onData = (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount > highWater) input.pause();
    };
    const onEnd = () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    };
    const drainTimer = setInterval(() => {
      if (input.isPaused() && ws.bufferedAmount <= highWater / 2) input.resume();
    }, 50);
    drainTimer.unref?.();
    input.on('data', onData);
    input.on('end', onEnd);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      if (output.destroyed || output.writableEnded) return;
      if (!output.write(data)) {
        ws.pause();
        output.once('drain', () => ws.resume());
      }
    });
    ws.on('close', (code) => finish(code));
    ws.on('error', () => finish(1006));
    // LAST: every listener is attached, so the frames held while the socket was paused (see
    // `openTunnelSocket`) are delivered to them in order.
    ws.resume();
  });
}
