/**
 * The extension's events client against a loopback WebSocket that speaks the server's frames: one
 * socket per org, subscribe on open, `isLive` only after the ack, a reconnect after a drop that
 * re-subscribes and hands the file system a `resync`, a 4401 that stops dialling, and the caches.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { HqApiError, type HqClient } from '@hq/client/api.js';
import type { Team } from '@hq/client/teams.js';
import type { EventsServerFrame } from '@kpa/shared/remote-fs.types';
import { EventsHub, parseEventsFrame } from '../../src/fs/events-client.js';
import { ContentCache, ListingCache } from '../../src/fs/caches.js';

const WS_ID = '3f9a1c2e-1111-4222-8333-444455556666';
const team = {
  alias: 'hq-3f9a1c2e',
  org: { slug: 'awo' },
  workspace: { id: WS_ID },
} as unknown as Team;

let server: Server | null = null;
/** Hubs a test left open (a failed assertion skips its own close): closed before the server. */
const hubs: EventsHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) h.closeAll();
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

async function fakeHq(onConnect: (ws: WebSocket, n: number) => void): Promise<string> {
  server = createServer();
  const wss = new WebSocketServer({ server });
  let n = 0;
  wss.on('connection', (ws, req) => {
    expect(req.headers['x-hq-org']).toBe('awo');
    expect(req.headers.authorization).toBe('Bearer hqa_tok');
    n += 1;
    onConnect(ws, n);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function client(host: string): HqClient {
  return {
    host,
    upgradeHeaders: async () => ({ Authorization: 'Bearer hqa_tok', 'x-hq-org': 'awo' }),
    accessToken: async () => 'hqa_tok',
  } as unknown as HqClient;
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('EventsHub', () => {
  it('subscribes on open, is live after the ack, and a drop re-subscribes with a resync', async () => {
    const seen: string[] = [];
    let first: WebSocket | null = null;
    const host = await fakeHq((ws, n) => {
      if (n === 1) first = ws;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as { type: string; workspaceId: string };
        seen.push(`${n}:${f.type}`);
        if (f.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'subscribed',
              workspaceId: f.workspaceId,
              state: 'running',
              watch: true,
            }),
          );
        }
      });
    });
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    const frames: EventsServerFrame[] = [];
    hub.onFrame((f) => void frames.push(f));
    const sub = hub.subscribe(team);
    await until(() => hub.isLive(team));
    expect(seen).toEqual(['1:subscribe']);
    expect(frames.map((f) => f.type)).toEqual(['subscribed']);
    first!.terminate();
    await until(() => frames.some((f) => f.type === 'resync'));
    expect(seen).toEqual(['1:subscribe', '2:subscribe']);
    expect(hub.isLive(team)).toBe(true);
    sub.dispose();
    await until(() => !hub.isLive(team));
  });

  it('fix/vscode-presence: a person opening a folder subscribes `open`; the client re-subscribing by itself (a drop, a renewed sign-in) says `reconnect`', async () => {
    const seen: string[] = [];
    const sockets: WebSocket[] = [];
    const B = '3f9a1c2e-2222-4222-8333-444455556666';
    const teamB = { ...team, alias: 'hq-b', workspace: { id: B } } as unknown as Team;
    const host = await fakeHq((ws, n) => {
      sockets.push(ws);
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as {
          type: string;
          workspaceId: string;
          intent?: string;
        };
        if (f.type !== 'subscribe') return;
        seen.push(`${n}:${f.workspaceId === WS_ID ? 'A' : 'B'}:${f.intent}`);
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            workspaceId: f.workspaceId,
            state: 'running',
            watch: true,
          }),
        );
      });
    });
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    hubs.push(hub);
    const subA = hub.subscribe(team); // the folder opens (before the socket exists)
    await until(() => seen.length === 1);
    hub.subscribe(teamB); // another folder opened later, on the open socket
    await until(() => seen.length === 2);
    expect(seen).toEqual(['1:A:open', '1:B:open']);
    sockets[0]!.terminate(); // the hourly LB recycle
    await until(() => seen.length === 4);
    expect(seen.slice(2).sort()).toEqual(['2:A:reconnect', '2:B:reconnect']);
    hub.reconnectAll(); // a renew elsewhere: the client dials again by itself
    await until(() => seen.length === 6);
    expect(seen.slice(4).sort()).toEqual(['3:A:reconnect', '3:B:reconnect']);
    subA.dispose(); // the folder closed ...
    hub.subscribe(team); // ... and opened again by the person
    await until(() => seen.length === 7);
    expect(seen[6]).toBe('3:A:open');
  });

  it('a 4401 close stops dialling (the sign-in service handles the revocation)', async () => {
    let connects = 0;
    const host = await fakeHq((ws) => {
      connects += 1;
      ws.close(4401, 'unauthorized');
    });
    let unauthorized = 0;
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 10,
      maxBackoffMs: 20,
      // U28: the service asks HQ at once, instead of waiting for the next HTTP call.
      onUnauthorized: () => void (unauthorized += 1),
    });
    hub.subscribe(team);
    await until(() => connects === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(connects).toBe(1);
    expect(hub.isLive(team)).toBe(false);
    expect(unauthorized).toBe(1);
  });
});

describe('EventsHub: one socket per org (nonprod blocker 2026-09-30)', () => {
  const teamN = (i: number) =>
    ({
      alias: `hq-${i}`,
      org: { slug: 'awo' },
      workspace: { id: `3f9a1c2e-1111-4222-8333-${String(i).padStart(12, '0')}` },
    }) as unknown as Team;

  /** A client whose token and headers take a while, like the real keychain + nonce path. */
  function slowClient(host: string): HqClient {
    const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 15));
    return {
      host,
      upgradeHeaders: () => later({ Authorization: 'Bearer hqa_tok', 'x-hq-org': 'awo' }),
      accessToken: async () => 'hqa_tok',
    } as unknown as HqClient;
  }

  it('10 concurrent watch() calls for one org open exactly ONE socket, which subscribes them all', async () => {
    const subscribed = new Set<string>();
    let sockets = 0;
    const host = await fakeHq((ws) => {
      sockets += 1;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as { type: string; workspaceId: string };
        if (f.type !== 'subscribe') return;
        subscribed.add(f.workspaceId);
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            workspaceId: f.workspaceId,
            state: 'running',
            watch: true,
          }),
        );
      });
    });
    const hub = new EventsHub({
      client: () => new Promise((r) => setTimeout(() => r(slowClient(host)), 15)),
    });
    hubs.push(hub);
    const teams = Array.from({ length: 10 }, (_, i) => teamN(i));
    for (const t of teams) hub.subscribe(t);
    await until(() => teams.every((t) => hub.isLive(t)));
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets).toBe(1);
    expect(subscribed.size).toBe(10);
  });

  it('a replaced socket is closed, never orphaned holding a server slot', async () => {
    const closed: number[] = [];
    let n = 0;
    const host = await fakeHq((ws) => {
      const mine = (n += 1);
      ws.on('close', () => void closed.push(mine));
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as { type: string; workspaceId: string };
        if (f.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'subscribed',
              workspaceId: f.workspaceId,
              state: 'running',
              watch: true,
            }),
          );
        }
      });
    });
    const hub = new EventsHub({ client: async () => client(host) });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => hub.isLive(team));
    // Force a second dial on the same org (the path a stray reconnect would take).
    const org = (hub as unknown as { orgs: Map<string, { connect(): Promise<void> }> }).orgs.get(
      'awo',
    )!;
    await org.connect();
    await until(() => n === 2 && closed.includes(1));
    await until(() => hub.isLive(team));
    expect(closed).toEqual([1]);
  });

  it('disposing every watch while the dial is in flight leaves no socket open', async () => {
    let sockets = 0;
    const host = await fakeHq(() => void (sockets += 1));
    const hub = new EventsHub({
      client: () => new Promise((r) => setTimeout(() => r(slowClient(host)), 15)),
    });
    hubs.push(hub);
    hub.subscribe(team).dispose();
    await new Promise((r) => setTimeout(r, 120));
    expect(sockets).toBe(0);
  });

  it('a 429 refusal backs off (no tight loop) and is surfaced once until a socket opens', async () => {
    server = createServer();
    let attempts = 0;
    server.on('upgrade', (_req, socket) => {
      attempts += 1;
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const refused: Array<[string, number]> = [];
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 5,
      maxBackoffMs: 10,
      refusedBackoffMs: 150,
      onRefused: (org, status) => void refused.push([org, status]),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => attempts === 1);
    await new Promise((r) => setTimeout(r, 100));
    // The ordinary backoff (5-10 ms) would have dialled ~10 more times by now.
    expect(attempts).toBe(1);
    await until(() => attempts === 2, 1000);
    expect(refused).toEqual([['awo', 429]]);
    expect(hub.isLive(team)).toBe(false);
  });
});

describe('EventsHub: a revoked login seen at the upgrade (item 12)', () => {
  it('a 401 while signing the upgrade (GET /api/remote/nonce) asks the service at once, once', async () => {
    let unauthorized = 0;
    let tries = 0;
    const hub = new EventsHub({
      client: async () =>
        ({
          host: 'http://127.0.0.1:9',
          upgradeHeaders: async () => {
            tries += 1;
            throw new HqApiError(401, 'REMOTE_TOKEN_INVALID', 'Unauthorized', undefined);
          },
          accessToken: async () => 'x',
        }) as unknown as HqClient,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      onUnauthorized: () => void (unauthorized += 1),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => tries >= 3);
    expect(unauthorized).toBe(1);
  });
});

describe('EventsHub: 401 handling (security review of 509bdcb4, L2)', () => {
  it('(a) re-armed once the service check finished: a later revocation is reported again', async () => {
    let calls = 0;
    let finish!: () => void;
    let tries = 0;
    const hub = new EventsHub({
      client: async () =>
        ({
          host: 'http://127.0.0.1:9',
          upgradeHeaders: async () => {
            tries += 1;
            throw new HqApiError(401, 'REMOTE_TOKEN_INVALID', 'Unauthorized', undefined);
          },
          accessToken: async () => 'x',
        }) as unknown as HqClient,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      unauthorizedQuietMs: 20,
      onUnauthorized: () => {
        calls += 1;
        return new Promise<void>((r) => (finish = r));
      },
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => tries >= 5);
    expect(calls).toBe(1); // the check is still running
    finish();
    const at = tries;
    await until(() => tries >= at + 3);
    expect(calls).toBe(2);
  });

  it('(b) a 401 on the upgrade itself is handed to the service too', async () => {
    server = createServer();
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let calls = 0;
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 5,
      maxBackoffMs: 10,
      onUnauthorized: () => void (calls += 1),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => calls === 1);
  });
});

describe('EventsHub: code review S3', () => {
  it('a 401 at the nonce waits the LONG backoff (never the 1 s ladder)', async () => {
    let tries = 0;
    const hub = new EventsHub({
      client: async () =>
        ({
          host: 'http://127.0.0.1:9',
          upgradeHeaders: async () => {
            tries += 1;
            throw new HqApiError(401, 'REMOTE_TOKEN_INVALID', 'Unauthorized', undefined);
          },
          accessToken: async () => 'x',
        }) as unknown as HqClient,
      minBackoffMs: 5,
      maxBackoffMs: 300,
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => tries === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(tries).toBe(1);
  });

  it('401, then a socket that opens, then a later 401: the second is reported too (even inside the quiet time)', async () => {
    let first: WebSocket | null = null;
    const host = await fakeHq((ws, n) => {
      if (n === 1) first = ws;
    });
    let failNext = true;
    let calls = 0;
    const hub = new EventsHub({
      client: async () =>
        ({
          host,
          upgradeHeaders: async () => {
            if (failNext) {
              failNext = false;
              throw new HqApiError(401, 'REMOTE_TOKEN_INVALID', 'Unauthorized', undefined);
            }
            return { Authorization: 'Bearer hqa_tok', 'x-hq-org': 'awo' };
          },
          accessToken: async () => 'hqa_tok',
        }) as unknown as HqClient,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      unauthorizedQuietMs: 60_000,
      onUnauthorized: () => void (calls += 1),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => first !== null);
    expect(calls).toBe(1);
    failNext = true;
    first!.terminate();
    await until(() => calls === 2);
  });
});

describe('EventsHub (phase 2 security review)', () => {
  /** A fake HQ that answers each subscribe with `ack`, then sends `then` frames (raw strings). */
  async function hubWith(ack: Record<string, unknown>, then: string[] = []) {
    let sock: WebSocket | null = null;
    const host = await fakeHq((ws) => {
      sock = ws;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as { type: string; workspaceId: string };
        if (f.type !== 'subscribe') return;
        ws.send(JSON.stringify({ type: 'subscribed', workspaceId: f.workspaceId, ...ack }));
        for (const t of then) ws.send(t);
      });
    });
    const hub = new EventsHub({ client: async () => client(host), minBackoffMs: 20 });
    hubs.push(hub);
    const frames: EventsServerFrame[] = [];
    hub.onFrame((f) => void frames.push(f));
    hub.subscribe(team);
    return { hub, frames, send: (f: unknown) => sock!.send(JSON.stringify(f)) };
  }

  it('is live only on watch:true; a later watch:true makes it live, a stopped machine does not', async () => {
    const { hub, frames, send } = await hubWith({ state: 'running', watch: false });
    await until(() => frames.some((f) => f.type === 'subscribed'));
    expect(hub.isLive(team)).toBe(false);
    send({ type: 'subscribed', workspaceId: WS_ID, state: 'running', watch: true });
    await until(() => hub.isLive(team));
    send({ type: 'workspace-state', workspaceId: WS_ID, state: 'asleep' });
    await until(() => !hub.isLive(team));
  });

  it('frames of the wrong shape are dropped (never emitted, never make a team live)', async () => {
    const bad = [
      JSON.stringify({ type: 'subscribed', workspaceId: 7, state: 'running', watch: true }),
      JSON.stringify({ type: 'fs-changed', workspaceId: WS_ID, seq: 1, changes: 'x' }),
      JSON.stringify({ type: 'fs-changed', workspaceId: WS_ID, seq: 1, changes: [{ path: 3 }] }),
      JSON.stringify({ type: 'resync' }),
      JSON.stringify({ type: 'nope', workspaceId: WS_ID }),
      // An error code outside the closed set never reaches a label or a notification.
      JSON.stringify({ type: 'error', code: '\u202eKCOL\u001b[31m', workspaceId: WS_ID }),
      JSON.stringify({ type: 'error', code: 'NOT_FOUND', workspaceId: 42 }),
      JSON.stringify([1, 2]),
      JSON.stringify({ type: 'resync', workspaceId: WS_ID }),
    ];
    const { hub, frames } = await hubWith({ state: 'running', watch: 'yes' }, bad);
    await until(() => frames.some((f) => f.type === 'resync'));
    expect(frames).toEqual([{ type: 'resync', workspaceId: WS_ID }]);
    expect(hub.isLive(team)).toBe(false);
  });
});

describe('caches', () => {
  it('content is keyed by etag (a new etag misses) and bounded (LRU by bytes and entries)', () => {
    const c = new ContentCache(10, 2);
    c.put('a', '"1"', new Uint8Array(4));
    expect(c.get('a', '"1"')).toBeDefined();
    expect(c.get('a', '"2"')).toBeUndefined();
    c.put('b', '"1"', new Uint8Array(4));
    c.put('c', '"1"', new Uint8Array(4));
    expect(c.last('a')).toBeUndefined(); // evicted
    expect(c.size).toBe(8);
    c.put('huge', '"1"', new Uint8Array(11));
    expect(c.last('huge')).toBeUndefined();
  });

  it('listings expire after the TTL unless the stream is live; the masked flag lives with its etag', () => {
    let now = 0;
    const l = new ListingCache(() => now);
    l.putFolder('t', 'src', [{ path: 'src/a', type: 'file', size: 1, mtimeMs: 1, etag: '"1"' }]);
    now = 31_000;
    expect(l.folder('t', 'src', false)).toBeUndefined();
    expect(l.folder('t', 'src', true)).toHaveLength(1);
    expect(l.staleFolder('t', 'src')).toHaveLength(1);
    l.markMasked('t', 'src/a', '"1"');
    l.putStat('t', { path: 'src/a', type: 'file', size: 1, mtimeMs: 1, etag: '"1"' });
    expect(l.stat('t', 'src/a')?.masked).toBe(true);
    l.putStat('t', { path: 'src/a', type: 'file', size: 2, mtimeMs: 2, etag: '"2"' });
    expect(l.stat('t', 'src/a')?.masked).toBeUndefined();
    l.invalidate('t', 'src');
    expect(l.stat('t', 'src/a')).toBeUndefined();
  });
});

/** A socket the test drives by hand (hq-vscode-multi-account W3). */
class HandWs extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  terminated = false;
  send(d: string): void {
    this.sent.push(d);
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
}

describe('EventsHub across a renew (hq-vscode-multi-account decision 26, review W3)', () => {
  const handClient = (grant: string) =>
    ({
      host: 'http://127.0.0.1:1',
      grant,
      upgradeHeaders: async () => ({ Authorization: `Bearer hqa_${grant}` }),
      accessToken: async () => `hqa_${grant}`,
    }) as unknown as HqClient & { grant: string };

  it('a 4401 from a socket of the OLD grant redials with the new one; it is not a stop', async () => {
    const sockets: HandWs[] = [];
    let current = 'g1';
    let unauthorized = 0;
    const hub = new EventsHub({
      client: async () => handClient(current),
      ws: () => {
        const s = new HandWs();
        sockets.push(s);
        return s as never;
      },
      grantOf: (c) => (c as unknown as { grant: string }).grant,
      currentGrant: () => current,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      onUnauthorized: () => void (unauthorized += 1),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => sockets.length === 1);
    sockets[0]!.open();
    current = 'g2'; // another window renewed the account and revoked g1
    sockets[0]!.emit('close', 4401);
    await until(() => sockets.length === 2);
    expect(unauthorized).toBe(0);
  });

  it('a 4401 on the CURRENT grant still stops and asks the service', async () => {
    const sockets: HandWs[] = [];
    let unauthorized = 0;
    const hub = new EventsHub({
      client: async () => handClient('g1'),
      ws: () => {
        const s = new HandWs();
        sockets.push(s);
        return s as never;
      },
      grantOf: (c) => (c as unknown as { grant: string }).grant,
      currentGrant: () => 'g1',
      minBackoffMs: 5,
      maxBackoffMs: 10,
      onUnauthorized: () => void (unauthorized += 1),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.emit('close', 4401);
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets).toHaveLength(1);
    expect(unauthorized).toBe(1);
  });

  it('a 4401 from a socket that was already replaced is ignored', async () => {
    const sockets: HandWs[] = [];
    let unauthorized = 0;
    const hub = new EventsHub({
      client: async () => handClient('g1'),
      ws: () => {
        const s = new HandWs();
        sockets.push(s);
        return s as never;
      },
      minBackoffMs: 5,
      maxBackoffMs: 10,
      onUnauthorized: () => void (unauthorized += 1),
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => sockets.length === 1);
    sockets[0]!.open();
    hub.reconnectAll();
    await until(() => sockets.length === 2);
    sockets[1]!.open();
    sockets[0]!.emit('close', 4401); // the stale one
    await new Promise((r) => setTimeout(r, 50));
    expect(unauthorized).toBe(0);
    expect(sockets).toHaveLength(2);
    // The live socket still carries the subscription: a second watch adds no socket.
    hub.subscribe(team);
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(2);
  });

  it('a reconnect asked while a dial is in flight redials once that dial finishes', async () => {
    const sockets: HandWs[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const hub = new EventsHub({
      client: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return handClient(calls === 1 ? 'g1' : 'g2');
      },
      ws: (_url, headers) => {
        const s = new HandWs();
        (s as unknown as { auth: string }).auth = headers.Authorization ?? '';
        sockets.push(s);
        return s as never;
      },
      minBackoffMs: 5,
      maxBackoffMs: 10,
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => calls === 1);
    hub.reconnectAll(); // renewed while the first dial waits for its client
    release();
    await until(() => sockets.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(2);
    expect(sockets.map((s) => (s as unknown as { auth: string }).auth)).toEqual(['Bearer hqa_g2']);
  });
});

describe('0.2.2: `secrets-changed` is a frame the client takes', () => {
  it('with a team id it is passed on (content-free); without one it is dropped', () => {
    expect(parseEventsFrame({ type: 'secrets-changed', workspaceId: WS_ID })).toEqual({
      type: 'secrets-changed',
      workspaceId: WS_ID,
    });
    expect(parseEventsFrame({ type: 'secrets-changed' })).toBeNull();
  });
});

describe('0.2.3: make-before-break before the hourly LB cut', () => {
  /** A fake HQ whose nth upgrade may be refused with `refuse(n)` (an HTTP status) or accepted. */
  async function hqWith(
    refuse: (n: number) => number | null,
    onConnect: (ws: WebSocket, n: number) => void,
  ): Promise<{ host: string; closes: Map<number, number> }> {
    server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const closes = new Map<number, number>();
    let n = 0;
    server.on('upgrade', (req, socket, head) => {
      n += 1;
      const k = n;
      const status = refuse(k);
      if (status !== null) {
        socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('close', (code) => closes.set(k, code));
        onConnect(ws, k);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, closes };
  }

  const ack = (ws: WebSocket, id: string) =>
    ws.send(JSON.stringify({ type: 'subscribed', workspaceId: id, state: 'running', watch: true }));

  it('a new socket subscribes every team `reconnect`; once all are acked it takes over and the old closes 1000: no resync, live throughout', async () => {
    const seen: string[] = [];
    const sockets = new Map<number, WebSocket>();
    const { host, closes } = await hqWith(
      () => null,
      (ws, n) => {
        sockets.set(n, ws);
        ws.on('message', (d) => {
          const f = JSON.parse(d.toString()) as {
            type: string;
            workspaceId: string;
            intent: string;
          };
          seen.push(`${n}:${f.type}:${f.intent ?? ''}`);
          if (f.type === 'subscribe') ack(ws, f.workspaceId);
        });
      },
    );
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 20,
      maxBackoffMs: 40,
      handoverAfterMs: 150,
      handoverJitterMs: 0,
    });
    hubs.push(hub);
    const frames: EventsServerFrame[] = [];
    hub.onFrame((f) => void frames.push(f));
    const sub = hub.subscribe(team);
    await until(() => hub.isLive(team));
    let notLive = 0;
    const sampler = setInterval(() => {
      if (!hub.isLive(team)) notLive += 1;
    }, 2);
    try {
      await until(() => closes.get(1) !== undefined, 2_000);
      expect(closes.get(1)).toBe(1000);
      expect(seen.slice(0, 2)).toEqual(['1:subscribe:open', '2:subscribe:reconnect']);
      expect(frames.some((f) => f.type === 'resync')).toBe(false);
      expect(notLive).toBe(0);
      // The new socket is THE socket now: its frames come through.
      sockets.get(2)!.send(
        JSON.stringify({
          type: 'fs-changed',
          workspaceId: WS_ID,
          seq: 1,
          changes: [{ path: 'a.txt' }],
        }),
      );
      await until(() => frames.some((f) => f.type === 'fs-changed'));
    } finally {
      clearInterval(sampler);
      sub.dispose();
    }
  });

  it('a team opened while the new socket was being acked is subscribed on it after the switch', async () => {
    const B = '3f9a1c2e-2222-4222-8333-444455556666';
    const teamB = { ...team, alias: 'hq-b', workspace: { id: B } } as unknown as Team;
    const seen: string[] = [];
    const { host, closes } = await hqWith(
      () => null,
      (ws, n) => {
        ws.on('message', (d) => {
          const f = JSON.parse(d.toString()) as { type: string; workspaceId: string };
          if (f.type !== 'subscribe') return;
          seen.push(`${n}:${f.workspaceId === WS_ID ? 'A' : 'B'}`);
          // The new socket's ack is slow: a folder opens meanwhile.
          if (n === 2 && f.workspaceId === WS_ID) setTimeout(() => ack(ws, f.workspaceId), 120);
          else ack(ws, f.workspaceId);
        });
      },
    );
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 20,
      maxBackoffMs: 40,
      handoverAfterMs: 100,
      handoverJitterMs: 0,
    });
    hubs.push(hub);
    hub.subscribe(team);
    await until(() => seen.includes('2:A'), 2_000);
    hub.subscribe(teamB); // on the old socket, before the switch
    await until(() => closes.get(1) === 1000, 2_000);
    await until(() => seen.includes('2:B'));
    await until(() => hub.isLive(teamB));
    expect(seen.filter((s) => s.startsWith('1:'))).toEqual(['1:A', '1:B']);
  });

  it('a refused new socket (429: other windows hold the slots) is quiet: the old one stays, and it is tried again', async () => {
    const refusals: number[] = [];
    const { host, closes } = await hqWith(
      (n) => (n === 2 ? 429 : null),
      (ws) => {
        ws.on('message', (d) => {
          const f = JSON.parse(d.toString()) as { type: string; workspaceId: string };
          if (f.type === 'subscribe') ack(ws, f.workspaceId);
        });
      },
    );
    const hub = new EventsHub({
      client: async () => client(host),
      minBackoffMs: 20,
      maxBackoffMs: 40,
      handoverAfterMs: 80,
      handoverJitterMs: 0,
      handoverRetryMs: 100,
      onRefused: (_org, status) => void refusals.push(status),
    });
    hubs.push(hub);
    const frames: EventsServerFrame[] = [];
    hub.onFrame((f) => void frames.push(f));
    hub.subscribe(team);
    await until(() => hub.isLive(team));
    await until(() => closes.get(1) === 1000, 2_000); // the third dial took over
    expect(refusals).toEqual([]);
    expect(frames.some((f) => f.type === 'resync')).toBe(false);
    expect(hub.isLive(team)).toBe(true);
  });
});
