/**
 * The terminal (D4/D5, U16-U18 unit tier) and the ports (D11, U20-U22 unit tier) against a loopback
 * HQ: real HTTP, real WebSocket upgrades, a real local TCP listener.
 *
 *   terminal  the attach frame carries VS Code's geometry; output reaches the terminal through the
 *             D5 filter (OSC 52 / OSC 633 / a DA query never arrive, a split one neither); the owner's
 *             keys go out as `input`; a FORBIDDEN flips the tab to "· view only" and later keys are
 *             never sent; the machine's listening ports are offered; closing the tab DETACHES.
 *   ports     one `forward` row per forward with `client: 'hq-vscode'`; the laptop listens on
 *             127.0.0.1 only; bytes flow through the tunnel; the inspector port is refused before any
 *             request; a restored forward stays paused until resumed; Stop closes the row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { generateDeviceKeyMaterial, toOpenSshPrivateKey } from '@hq/client/device-key.js';
import { withTeamAliases } from '@hq/client/teams.js';
import { HqService } from '../../src/hq/hq-service.js';
import { SessionStore, type MementoLike, type SecretsLike } from '../../src/hq/session-store.js';
import { HqPty } from '../../src/terminal/hq-pty.js';
import { teamIsRunning } from '../../src/terminal/terminals.js';
import { forwardError, Ports } from '../../src/ports/ports.js';
import { COPY } from '../../src/copy.js';
import { HqApiError } from '@hq/client/api.js';
import { ConnectRefusedError } from '@hq/client/connect.js';
import { stub } from './vscode-stub.js';

const WS_ID = '3f9a1c2e-1111-4222-8333-444455556666';

function orgs(): RemoteOrg[] {
  return [
    {
      id: 'o1',
      slug: 'awo',
      name: 'AI Workforce One',
      role: 'owner',
      remoteAccess: { allowed: true },
      workspaces: [
        {
          id: WS_ID,
          alias: 'hq-3f9a1c2e',
          name: 'Backend team',
          state: 'running',
          rights: { forward: true, attach: true, files: { read: true, write: true } },
          supported: true,
        },
      ],
    },
  ];
}

interface FakeHq {
  url: string;
  requests: Array<{ method: string; path: string; body: string }>;
  terminal: (ws: WebSocket, req: IncomingMessage) => void;
  tunnels: number;
  /** The grant was revoked in HQ: the remote routes answer 401 (the unsigned check too). */
  revoked: boolean;
  close: () => Promise<void>;
}

async function startHq(): Promise<FakeHq> {
  const fake: FakeHq = {
    url: '',
    requests: [],
    terminal: () => undefined,
    tunnels: 0,
    revoked: false,
    close: async () => undefined,
  };
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const p = (req.url ?? '/').split('?')[0]!;
      const method = req.method ?? 'GET';
      fake.requests.push({ method, path: p, body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('x-hq-nonce', `n${(n += 1)}`);
      res.setHeader('content-type', 'application/json');
      const send = (status: number, body?: unknown) => {
        res.statusCode = status;
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (fake.revoked) return send(401, { error: 'unauthorized', code: 'REMOTE_TOKEN_INVALID' });
      if (p === '/api/remote/nonce') return send(200, { nonce: `n${(n += 1)}`, expiresIn: 60 });
      if (p === '/api/remote/orgs') return send(200, orgs());
      if (p.endsWith('/connections') && method === 'POST') {
        return send(201, {
          id: '9d9d9d9d-0000-4000-8000-000000000001',
          state: 'ready',
          connectCode: `hqc_${n}`,
          hostKey: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (p.endsWith('/codes') && method === 'POST') {
        return send(200, { connectCode: `hqc_${(n += 1)}`, expiresAt: new Date().toISOString() });
      }
      if (/\/connections\/[^/]+$/.test(p) && method === 'DELETE') return send(204);
      return send(404, { error: 'not found' });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if ((req.url ?? '').startsWith('/ws/remote/tunnel')) {
        fake.tunnels += 1;
        ws.on('message', (d, bin) => ws.send(d, { binary: bin }));
      } else fake.terminal(ws, req);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
  };
  return fake;
}

function secrets(): SecretsLike {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k),
    store: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function memento(): MementoLike & vscodeMemento {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string, fallback?: T) => (data.has(k) ? (data.get(k) as T) : fallback) as T,
    update: async (k: string, v: unknown) => {
      if (v === undefined) data.delete(k);
      else data.set(k, v);
    },
    keys: () => [...data.keys()],
  };
}
type vscodeMemento = { keys(): readonly string[] };

let fake: FakeHq;
let lockDir: string;
let svc: HqService;
let mem: ReturnType<typeof memento>;

beforeEach(async () => {
  stub.reset();
  fake = await startHq();
  lockDir = mkdtempSync(path.join(tmpdir(), 'hq-vscode-t-'));
  mem = memento();
  const store = new SessionStore(secrets(), mem);
  const { seed32, pub32 } = generateDeviceKeyMaterial();
  await store.saveDeviceKey(fake.url, toOpenSshPrivateKey(seed32, pub32, 'test'));
  await store.saveTokens(fake.url, {
    accessToken: `hqa_${'a'.repeat(43)}`,
    accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `hqr_${'r'.repeat(43)}`,
  });
  await store.saveOrgs(fake.url, orgs());
  await store.saveAccount(fake.url, {
    grantId: 'g1',
    user: { id: 'u1', email: 'jean@example.com', name: 'Jean' },
  });
  svc = new HqService({
    store,
    ui: {
      showDeviceCode: () => ({ close: () => undefined }),
      openExternal: async () => undefined,
      copyToClipboard: async () => undefined,
      info: () => undefined,
      askToSignIn: async () => false,
      modal: () => undefined,
      offerSignInHere: async () => false,
    },
    host: () => ({ ok: true, host: fake.url }),
    extensionVersion: '0.1.0',
    appName: 'Code',
    lockDir,
  });
});

afterEach(async () => {
  await fake.close();
  rmSync(lockDir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('HqPty (D4, D5)', () => {
  it('attaches at the terminal size, filters output, types as owner, flips to view-only, detaches on close', async () => {
    const frames: Array<Record<string, unknown>> = [];
    let upgradeHeaders: IncomingMessage['headers'] = {};
    fake.terminal = (ws, req) => {
      upgradeHeaders = req.headers;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        frames.push(f);
        if (f.type === 'attach') {
          ws.send(
            JSON.stringify({
              type: 'history',
              sessionId: 's-1',
              data: 'hello \x1b]52;c;ZXZpbA==\x07world\x1b]633;E;rm\x07 \x1b[c',
            }),
          );
          // A clipboard write split across two frames never reaches the terminal either.
          ws.send(JSON.stringify({ type: 'output', sessionId: 's-1', data: 'a\x1b]5' }));
          ws.send(JSON.stringify({ type: 'output', sessionId: 's-1', data: '2;c;QUFB\x07b' }));
          ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
          ws.send(
            JSON.stringify({ type: 'runner-metrics', sessionId: 's-1', listenPorts: [8000, 9229] }),
          );
        }
        if (f.type === 'input' && f.data === 'x') {
          ws.send(
            JSON.stringify({
              type: 'error',
              sessionId: 's-1',
              code: 'FORBIDDEN',
              message: 'View-only access',
            }),
          );
        }
      });
    };
    const team = withTeamAliases(orgs())[0]!;
    const offered: number[][] = [];
    const pty = new HqPty(
      {
        service: svc,
        localEchoMode: () => 'off',
        vsCodeTypeaheadOn: () => false,
        windowActive: () => true,
        offerPorts: (_t, p) => offered.push(p),
      },
      {
        team,
        session: {
          id: 's-1',
          name: 'fix login bug',
          ownerName: 'Jean',
          status: 'running',
          canType: true,
        },
      },
    );
    let out = '';
    const names: string[] = [];
    pty.onDidWrite((d) => (out += d));
    pty.onDidChangeName((n) => names.push(n));
    pty.open({ columns: 132, rows: 40 });

    await waitFor(() => out.includes('ab'));
    expect(frames[0]).toMatchObject({ type: 'attach', cols: 132, rows: 40, intent: 'open' });
    expect(upgradeHeaders['x-hq-client']).toBe('vscode/0.1.0');
    expect(out).toContain('hello world ');
    for (const leaked of ['\x1b]52', '\x1b]633', '\x1b[c', 'ZXZpbA', 'QUFB']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('Attached to "fix login bug" (Jean)');
    await waitFor(() => offered.length === 1);
    expect(offered[0]).toEqual([8000, 9229]);

    pty.handleInput('x');
    await waitFor(() => names.length === 1);
    expect(names[0]).toBe('HQ · Backend team · fix login bug · view only');
    pty.handleInput('y');
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.filter((f) => f.type === 'input').map((f) => f.data)).toEqual(['x']);

    pty.setDimensions({ columns: 100, rows: 30 });
    await waitFor(() => frames.some((f) => f.type === 'resize'));
    expect(frames.find((f) => f.type === 'resize')).toMatchObject({ cols: 100, rows: 30 });

    pty.close();
    await waitFor(() => frames.some((f) => f.type === 'detach'));
  });
});

describe('HqPty: revocation from HQ web (U28)', () => {
  it('a 4401 close makes the service ask HQ once; a confirmed revocation wipes and fires onRevoked', async () => {
    fake.terminal = (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') {
          fake.revoked = true;
          ws.close(4401, 'unauthorized');
        }
      });
    };
    let revoked = 0;
    svc.onRevoked(() => void (revoked += 1));
    const team = withTeamAliases(orgs())[0]!;
    const pty = new HqPty(
      {
        service: svc,
        localEchoMode: () => 'off',
        vsCodeTypeaheadOn: () => false,
        windowActive: () => true,
        offerPorts: () => undefined,
      },
      {
        team,
        session: { id: 's-1', name: 'x', ownerName: 'Jean', status: 'running', canType: true },
      },
    );
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => revoked === 1);
    expect(svc.signedIn()).toBe(false);
  });
});

describe("the extension never shows the CLI's sentences (item 14)", () => {
  it('forward refusals use the extension\'s own copy: no "hq:", never "asleep"', () => {
    const team = 'Backend team';
    const refused = (code: string, status = 409, details?: Record<string, unknown>) =>
      new ConnectRefusedError(
        `hq: team "${team}" is asleep and this looks like an editor reconnect, so it was not woken.`,
        new HqApiError(status, code, 'server sentence', details),
      );
    const asleep = forwardError(team, refused('RUNNER_UNAVAILABLE', 409, { hint: 'reconnect' }));
    expect(asleep).toBe(COPY.forwardTeamOff(team));
    for (const err of [
      refused('RUNNER_UNAVAILABLE', 409, { hint: 'reconnect' }),
      refused('RUNNER_UNAVAILABLE'),
      refused('THROTTLED', 429),
      refused('UPGRADE_REQUIRED', 426),
      refused('REMOTE_TOKEN_INVALID', 401),
      refused('FEATURE_NOT_AVAILABLE', 403),
      refused('NOT_FOUND', 404),
      new ConnectRefusedError('hq: the team machine is asleep'),
    ]) {
      const text = forwardError(team, err);
      expect(text).not.toMatch(/^hq:|asleep/);
    }
  });
});

describe('a machine that started before Developer access was turned on', () => {
  it('restart_required names the cause and the one restart that fixes it, without sounding broken', () => {
    const e = new ConnectRefusedError(
      'hq: x',
      new HqApiError(409, 'REMOTE_UNSUPPORTED_RUNNER', 'x', { reason: 'restart_required' }),
    );
    const text = forwardError('tech & software', e);
    expect(text).toBe(
      'tech & software started before Developer access was turned on. Restart it once (Restart machine in HQ team settings) and ports will forward.',
    );
    expect(text).not.toMatch(/—| - |asleep|needs a restart/i);
  });
});

describe('code review S5/S6', () => {
  it('S6: a STOPPED team gets its own sentence, not "has no machine yet"', () => {
    const e = new ConnectRefusedError(
      'hq: x',
      new HqApiError(409, 'RUNNER_UNAVAILABLE', 'x', { state: 'stopped', hint: 'stopped' }),
    );
    expect(forwardError('Backend team', e)).toBe(COPY.forwardTeamStopped('Backend team'));
    const none = new ConnectRefusedError(
      'hq: x',
      new HqApiError(409, 'RUNNER_UNAVAILABLE', 'x', { state: 'stopped', hint: 'start_in_hq' }),
    );
    expect(forwardError('Backend team', none)).toBe(COPY.wakeNoMachine('Backend team'));
  });

  it('S5: a team that is STARTING attaches passively and comes back by itself (no key needed)', async () => {
    const frames: Array<Record<string, unknown>> = [];
    let attaches = 0;
    fake.terminal = (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        frames.push(f);
        if (f.type !== 'attach') return;
        attaches += 1;
        if (attaches === 1) {
          ws.send(
            JSON.stringify({
              type: 'error',
              sessionId: 's-1',
              code: 'SESSION_RESUMING',
              message: 'Waking the machine',
            }),
          );
          ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'history', sessionId: 's-1', data: 'back' }));
        ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
      });
    };
    const team = withTeamAliases(orgs())[0]!;
    const pty = new HqPty(
      {
        service: svc,
        localEchoMode: () => 'off',
        vsCodeTypeaheadOn: () => false,
        windowActive: () => true,
        offerPorts: () => undefined,
        teamRunning: async () => teamIsRunning({ ...team.workspace, state: 'starting' }),
      },
      {
        team,
        session: { id: 's-1', name: 'x', ownerName: 'Jean', status: 'running', canType: true },
      },
    );
    let out = '';
    pty.onDidWrite((d) => (out += d));
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => out.includes('back'), 8_000);
    const intents = frames.filter((f) => f.type === 'attach').map((f) => f.intent);
    expect(intents[0]).toBe('reconnect');
    expect(out).not.toContain(COPY.pressKeyToWake);
    pty.close();
  }, 15_000);
});

describe('HqPty on a team that is off (item 10)', () => {
  it('attaches passively: "Press any key to wake it", and only the key sends the waking attach', async () => {
    const frames: Array<Record<string, unknown>> = [];
    fake.terminal = (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        frames.push(f);
        if (f.type === 'attach' && f.intent === 'reconnect') {
          ws.send(
            JSON.stringify({
              type: 'notice',
              sessionId: 's-1',
              code: 'workspace_asleep',
              text: 'The team machine is asleep.',
            }),
          );
          ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
        }
      });
    };
    const team = withTeamAliases(orgs())[0]!;
    const pty = new HqPty(
      {
        service: svc,
        localEchoMode: () => 'off',
        vsCodeTypeaheadOn: () => false,
        windowActive: () => true,
        offerPorts: () => undefined,
        teamRunning: async () => false,
      },
      {
        team,
        session: { id: 's-1', name: 'x', ownerName: 'Jean', status: 'running', canType: true },
      },
    );
    let out = '';
    pty.onDidWrite((d) => (out += d));
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => out.includes(COPY.pressKeyToWake));
    expect(out).toContain(COPY.teamOffTerminal('Backend team'));
    expect(out).not.toContain('asleep');
    expect(frames.filter((f) => f.type === 'attach').map((f) => f.intent)).toEqual(['reconnect']);
    pty.handleInput('x');
    await waitFor(() => frames.filter((f) => f.type === 'attach').length === 2);
    expect(frames.filter((f) => f.type === 'attach').map((f) => f.intent)).toEqual([
      'reconnect',
      'open',
    ]);
    pty.close();
  });
});

describe('Ports (D11)', () => {
  it('forwards on 127.0.0.1 only, one hq-vscode row, bytes through the tunnel; Stop closes the row', async () => {
    const ports = new Ports(svc, mem as never);
    const team = withTeamAliases(orgs())[0]!;
    await ports.start(team, 5173, 0);
    const conn = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/connections'))!;
    expect(JSON.parse(conn.body)).toMatchObject({
      scope: 'forward',
      port: 5173,
      client: 'hq-vscode',
      wake: true,
    });
    const [entry] = ports.getChildren();
    expect(entry?.kind).toBe('active');
    const url = ports.localUrl(entry!)!;
    const localPort = Number(new URL(url).port);

    // Loopback IPv4 only: a listener on every interface (`::`) would also answer on ::1.
    const v6 = net.connect(localPort, '::1');
    const v6err = await new Promise<string>((r) => {
      v6.once('error', (e: NodeJS.ErrnoException) => r(e.code ?? 'error'));
      v6.once('connect', () => r('connected'));
    });
    v6.destroy();
    expect(v6err).not.toBe('connected');
    const sock = net.connect(localPort, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const echoed = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    sock.write('GET / HTTP/1.1\r\n\r\n');
    expect(await echoed).toContain('GET / HTTP/1.1');
    sock.destroy();
    expect(fake.tunnels).toBe(1);
    expect(ports.activeCount()).toBe(1);

    await ports.stop(entry!);
    expect(
      fake.requests.some((r) => r.method === 'DELETE' && r.path.includes('/connections/')),
    ).toBe(true);
    expect(ports.getChildren()).toEqual([]);
  });

  it('refuses the inspector port before any request', async () => {
    const ports = new Ports(svc, mem as never);
    await ports.start(withTeamAliases(orgs())[0]!, 9229, 9229);
    expect(fake.requests.filter((r) => r.path.endsWith('/connections'))).toEqual([]);
    expect(stub.messages.map((m) => m.text)).toEqual([
      'Port 9229 cannot be forwarded: the team machine uses it itself.',
    ]);
  });

  it.each([2375, 2376])(
    'docker-in-teams D27: refuses the Docker API port %i before any request',
    async (port) => {
      const ports = new Ports(svc, mem as never);
      await ports.start(withTeamAliases(orgs())[0]!, port, port);
      expect(fake.requests.filter((r) => r.path.endsWith('/connections'))).toEqual([]);
      expect(stub.messages.map((m) => m.text)).toEqual([
        `Port ${port} cannot be forwarded: the team machine uses it itself.`,
      ]);
    },
  );

  it('docker-in-teams D27: a Docker API listener is never offered', () => {
    const ports = new Ports(svc, mem as never);
    ports.offer(withTeamAliases(orgs())[0]!, [8000, 2375, 2376]);
    expect(ports.getChildren().map((e) => (e.kind === 'detected' ? e.port : null))).toEqual([8000]);
  });

  it('a forward restored after a reload stays paused: no connection until resumed', async () => {
    await mem.update(`hq:${fake.url}:ports:forwards`, [
      {
        orgSlug: 'awo',
        workspaceId: WS_ID,
        teamName: 'Backend team',
        remotePort: 5173,
        localPort: 0,
      },
    ]);
    const ports = new Ports(svc, mem as never);
    const [entry] = ports.getChildren();
    expect(entry?.kind).toBe('paused');
    expect(ports.getTreeItem(entry!).contextValue).toBe('port:paused');
    expect(fake.requests).toEqual([]);
    await ports.resume(entry!);
    expect(ports.getChildren()[0]?.kind).toBe('active');
    await ports.closeAll(false);
  });

  it('listening ports are offered once, never the inspector, and a dismissal sticks', async () => {
    const ports = new Ports(svc, mem as never);
    const team = withTeamAliases(orgs())[0]!;
    ports.offer(team, [8000, 9229, 80]);
    const offers = ports.getChildren();
    expect(offers.map((e) => (e.kind === 'detected' ? e.port : null))).toEqual([8000]);
    await ports.dismiss(offers[0]!);
    ports.offer(team, [8000]);
    expect(ports.getChildren()).toEqual([]);
  });
});
