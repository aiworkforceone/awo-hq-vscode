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
import { withTeamAliases } from '@hq/client/teams.js';
import type { HqAccounts } from '../../src/hq/accounts.js';
import type { HqService } from '../../src/hq/hq-service.js';
import { HqPty } from '../../src/terminal/hq-pty.js';
import { teamIsRunning, Terminals } from '../../src/terminal/terminals.js';
import { forwardError, Ports } from '../../src/ports/ports.js';
import { COPY } from '../../src/copy.js';
import { HqApiError } from '@hq/client/api.js';
import { ConnectRefusedError } from '@hq/client/connect.js';
import { legacySignedIn, memento } from './harness.js';
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
  /** `GET …/sessions` answers these (0.2.2: the rights an ownership change is re-read from). */
  sessions: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startHq(): Promise<FakeHq> {
  const fake: FakeHq = {
    url: '',
    requests: [],
    terminal: () => undefined,
    tunnels: 0,
    revoked: false,
    sessions: [],
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
      if (p.endsWith('/sessions') && method === 'GET') return send(200, fake.sessions);
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

let fake: FakeHq;
let lockDir: string;
let svc: HqService;
let accounts: HqAccounts;
let mem: ReturnType<typeof memento>;

beforeEach(async () => {
  stub.reset();
  fake = await startHq();
  lockDir = mkdtempSync(path.join(tmpdir(), 'hq-vscode-t-'));
  mem = memento();
  ({ svc, accounts } = await legacySignedIn(fake.url, orgs(), lockDir, { mem }));
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
        account: svc.ref,
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

describe('0.2.2: a terminal that ended or lost its connection comes back', () => {
  const target = () => ({
    account: svc.ref,
    team: withTeamAliases(orgs())[0]!,
    session: { id: 's-1', name: 'x', ownerName: 'Jean', status: 'running' as const, canType: true },
  });
  const deps = () => ({
    service: svc,
    localEchoMode: () => 'off' as const,
    vsCodeTypeaheadOn: () => false,
    windowActive: () => true,
    offerPorts: () => undefined,
  });

  it('(a) an ended tab says "Press any key to reconnect"; a key reconnects IN PLACE, and that key is not sent', async () => {
    let sockets = 0;
    const inputs: unknown[] = [];
    fake.terminal = (ws) => {
      sockets += 1;
      const n = sockets;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') {
          ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
          if (n === 1) setTimeout(() => ws.close(1000), 20); // HQ ended it (the restart case)
        }
        if (f.type === 'input') inputs.push(f.data);
      });
    };
    const pty = new HqPty(deps(), target());
    let out = '';
    pty.onDidWrite((d) => (out += d));
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => out.includes(COPY.pressKeyToReconnect));
    pty.handleInput('x');
    await waitFor(() => sockets === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(inputs).toEqual([]); // the key was the reconnect, not input
    pty.handleInput('ls');
    await waitFor(() => inputs.length === 1);
    expect(inputs).toEqual(['ls']);
    pty.close();
  });

  it("(b) ownership-changed: the pty re-reads the session's rights and applies them (the tab says view only)", async () => {
    let sock: WebSocket | null = null;
    fake.terminal = (ws) => {
      sock = ws;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
      });
    };
    fake.sessions = [{ id: 's-1', name: 'x', ownerName: 'Ana', status: 'running', canType: false }];
    const pty = new HqPty(deps(), target());
    const names: string[] = [];
    pty.onDidChangeName((n) => names.push(n));
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => sock !== null);
    await new Promise((r) => setTimeout(r, 50));
    sock!.send(JSON.stringify({ type: 'ownership-changed', sessionId: 's-1' }));
    await waitFor(() => names.some((n) => n.endsWith(COPY.terminalSuffixViewOnly)));
    expect(fake.requests.some((r) => r.method === 'GET' && r.path.endsWith('/sessions'))).toBe(
      true,
    );
    pty.close();
  });

  it('(b) a status frame is said in the extension\'s words (never "hq:")', async () => {
    let sock: WebSocket | null = null;
    fake.terminal = (ws) => {
      sock = ws;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
      });
    };
    const pty = new HqPty(deps(), target());
    let out = '';
    pty.onDidWrite((d) => (out += d));
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => sock !== null);
    await new Promise((r) => setTimeout(r, 50));
    sock!.send(JSON.stringify({ type: 'status', sessionId: 's-1', status: 'stopped' }));
    await waitFor(() => out.includes(COPY.sessionStoppedTerminal));
    expect(out).not.toContain('hq: ');
    pty.close();
  });

  it('review MUST 1: a 4401 end with a key pressed DURING the grant check: exactly one new upgrade, and the next key is sent', async () => {
    let sockets = 0;
    const inputs: unknown[] = [];
    fake.terminal = (ws) => {
      sockets += 1;
      const n = sockets;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') {
          if (n === 1) {
            ws.close(4401, 'unauthorized'); // the OLD grant (renewed in another window)
            return;
          }
          ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
        }
        if (f.type === 'input') inputs.push(f.data);
      });
    };
    // The service as the pty sees it: the grant check is slow, and the slot is renewed meanwhile.
    let checking = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let renewed = false;
    const service = Object.create(svc) as typeof svc;
    service.refreshOrgs = async () => {
      checking = true;
      await gate;
      return [];
    };
    service.currentGrant = () => (renewed ? 'g-renewed' : svc.currentGrant());
    const pty = new HqPty({ ...deps(), service }, target());
    let out = '';
    pty.onDidWrite((d) => (out += d));
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => checking);
    pty.handleInput('a'); // a key while HQ is being asked: neither a reconnect nor input
    renewed = true;
    release();
    await waitFor(() => sockets === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(sockets).toBe(2);
    // The renew re-attached by itself: nobody was told to press a key.
    expect(out).not.toContain(COPY.pressKeyToReconnect);
    pty.handleInput('b');
    await waitFor(() => inputs.length === 1);
    expect(inputs).toEqual(['b']);
    pty.close();
  });

  it('review MUST 1: run() while an attach is live is a no-op (one socket)', async () => {
    let sockets = 0;
    fake.terminal = (ws) => {
      sockets += 1;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
      });
    };
    const pty = new HqPty(deps(), target());
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => sockets === 1);
    void (pty as unknown as { run(): Promise<void> }).run();
    await new Promise((r) => setTimeout(r, 150));
    expect(sockets).toBe(1);
    pty.close();
  });

  it('(a) attaching a session whose tab ENDED opens a fresh terminal (the dead tab is closed), not the dead one', async () => {
    fake.terminal = (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') {
          ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
          setTimeout(() => ws.close(1000), 20);
        }
      });
    };
    const terminals = new Terminals({ accounts, offerPorts: () => undefined });
    terminals.attach(target());
    await waitFor(() => stub.terminals.length === 1);
    await waitFor(() => terminals.stateOf(target()) === 'ended');
    terminals.attach(target());
    expect(stub.terminals).toHaveLength(2);
    expect(stub.terminals[0]!.disposed).toBe(true);
    // A live one is only shown, never doubled.
    fake.terminal = (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
      });
    };
    terminals.closeAll();
    terminals.attach(target());
    await waitFor(() => terminals.stateOf(target()) === 'attached');
    const before = stub.terminals.length;
    terminals.attach(target());
    expect(stub.terminals).toHaveLength(before);
    terminals.dispose();
  });
});

describe('0.2.2 live FAIL 2: after an extension-host restart, the dead HQ tab is replaced', () => {
  const target = () => ({
    account: svc.ref,
    team: withTeamAliases(orgs())[0]!,
    session: {
      id: 's-1',
      name: 'build',
      ownerName: 'Jean',
      status: 'running' as const,
      canType: true,
    },
  });
  const answering = () => {
    let sockets = 0;
    fake.terminal = (ws) => {
      sockets += 1;
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        if (f.type === 'attach') ws.send(JSON.stringify({ type: 'attached', sessionId: 's-1' }));
      });
    };
    return () => sockets;
  };
  /** A tab VS Code kept from the old extension host: a name, and nothing behind it. */
  const deadTab = (name: string) => {
    const t = { name, disposed: false, dispose: () => void (t.disposed = true) };
    return t;
  };

  it('the old host recorded the tab; the new host closes the dead one and attaches the session in a fresh terminal', async () => {
    const sockets = answering();
    const state = memento();
    const before = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    before.attach(target());
    await waitFor(() => sockets() === 1);
    const name = stub.terminals[0]!.name;
    // The extension host restarts: a new Terminals, the same window state, the old tab left over.
    const after = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    const dead = deadTab(name);
    const unrelated = deadTab('zsh');
    after.adoptOrphans([dead, unrelated] as never);
    expect(dead.disposed).toBe(true);
    expect(unrelated.disposed).toBe(false); // not ours: never touched
    expect(stub.terminals).toHaveLength(2);
    expect(stub.terminals[1]!.name).toBe(name);
    await waitFor(() => sockets() === 2);
    // HQ: Attach on the same session now shows that terminal; no second tab.
    after.attach(target());
    expect(stub.terminals).toHaveLength(2);
    after.dispose();
  });

  it('review nits: two recorded sessions with the SAME tab name each claim their own dead tab; adopted tabs do not take focus', () => {
    answering();
    const state = memento();
    const before = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    const one = target();
    const two = { ...target(), session: { ...target().session, id: 's-2' } }; // same name 'build'
    before.attach(one);
    before.attach(two);
    const name = stub.terminals[0]!.name;
    expect(stub.terminals[1]!.name).toBe(name);
    const after = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    const deadA = deadTab(name);
    const deadB = deadTab(name);
    after.adoptOrphans([deadA, deadB] as never);
    expect([deadA.disposed, deadB.disposed]).toEqual([true, true]);
    const adopted = stub.terminals.slice(2);
    expect(adopted).toHaveLength(2);
    for (const t of adopted) expect(t.shown).toEqual([true]); // preserveFocus
    after.dispose();
  });

  it('a tab that changed its suffix (waking, view only, stopped) is still recognised', () => {
    answering();
    const state = memento();
    const before = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    before.attach(target());
    const name = stub.terminals[0]!.name;
    const after = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    const dead = deadTab(`${name}${COPY.terminalSuffixStopped}`);
    after.adoptOrphans([dead] as never);
    expect(dead.disposed).toBe(true);
    after.dispose();
  });

  it('an account that is gone: the dead tab is closed, nothing is attached, and the record goes', () => {
    answering();
    const state = memento();
    const before = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    before.attach(target());
    const name = stub.terminals[0]!.name;
    const gone = { ...accounts, get: () => undefined } as unknown as typeof accounts;
    const after = new Terminals({ accounts: gone, offerPorts: () => undefined, memento: state });
    const dead = deadTab(name);
    after.adoptOrphans([dead] as never);
    expect(dead.disposed).toBe(true);
    expect(stub.terminals).toHaveLength(1);
    // A later activation finds nothing left to adopt.
    const again = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    const other = deadTab(name);
    again.adoptOrphans([other] as never);
    expect(other.disposed).toBe(false);
  });

  it('a tab the person closed is forgotten (a window reload leaves no stale record either)', () => {
    answering();
    const state = memento();
    const before = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    before.attach(target());
    const name = stub.terminals[0]!.name;
    before.closeAccount(svc.ref);
    const after = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    const dead = deadTab(name);
    after.adoptOrphans([dead] as never);
    expect(dead.disposed).toBe(false);
    // No tab at all after a reload: the records are pruned.
    const fresh = new Terminals({ accounts, offerPorts: () => undefined, memento: state });
    fresh.adoptOrphans([]);
    expect(state.keys().filter((k) => k.startsWith('hq.terminals'))).toEqual([]);
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
    accounts.onAccountRemoved(() => void (revoked += 1));
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
        account: svc.ref,
        team,
        session: { id: 's-1', name: 'x', ownerName: 'Jean', status: 'running', canType: true },
      },
    );
    pty.open({ columns: 80, rows: 24 });
    await waitFor(() => revoked === 1);
    expect(accounts.count()).toBe(0);
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
  it('S6 / ALSO-3: a STOPPED team (either hint) gets the stopped sentence, never "has no machine yet"', () => {
    const e = new ConnectRefusedError(
      'hq: x',
      new HqApiError(409, 'RUNNER_UNAVAILABLE', 'x', { state: 'stopped', hint: 'stopped' }),
    );
    expect(forwardError('Backend team', e)).toBe(COPY.forwardTeamStopped('Backend team'));
    const none = new ConnectRefusedError(
      'hq: x',
      new HqApiError(409, 'RUNNER_UNAVAILABLE', 'x', { state: 'stopped', hint: 'start_in_hq' }),
    );
    expect(forwardError('Backend team', none)).toBe(COPY.forwardTeamStopped('Backend team'));
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
        account: svc.ref,
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
        account: svc.ref,
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
    const ports = new Ports({ accounts, memento: mem as never });
    const team = withTeamAliases(orgs())[0]!;
    await ports.start(svc.ref, team, 5173, 0);
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
    const ports = new Ports({ accounts, memento: mem as never });
    await ports.start(svc.ref, withTeamAliases(orgs())[0]!, 9229, 9229);
    expect(fake.requests.filter((r) => r.path.endsWith('/connections'))).toEqual([]);
    expect(stub.messages.map((m) => m.text)).toEqual([
      'Port 9229 cannot be forwarded: the team machine uses it itself.',
    ]);
  });

  it.each([2375, 2376])(
    'docker-in-teams D27: refuses the Docker API port %i before any request',
    async (port) => {
      const ports = new Ports({ accounts, memento: mem as never });
      await ports.start(svc.ref, withTeamAliases(orgs())[0]!, port, port);
      expect(fake.requests.filter((r) => r.path.endsWith('/connections'))).toEqual([]);
      expect(stub.messages.map((m) => m.text)).toEqual([
        `Port ${port} cannot be forwarded: the team machine uses it itself.`,
      ]);
    },
  );

  it('docker-in-teams D27: a Docker API listener is never offered', () => {
    const ports = new Ports({ accounts, memento: mem as never });
    ports.offer(svc.ref, withTeamAliases(orgs())[0]!, [8000, 2375, 2376]);
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
    const ports = new Ports({ accounts, memento: mem as never });
    const [entry] = ports.getChildren();
    expect(entry?.kind).toBe('paused');
    expect(ports.getTreeItem(entry!).contextValue).toBe('port:paused');
    expect(fake.requests).toEqual([]);
    await ports.resume(entry!);
    expect(ports.getChildren()[0]?.kind).toBe('active');
    await ports.closeAll(false);
  });

  it('listening ports are offered once, never the inspector, and a dismissal sticks', async () => {
    const ports = new Ports({ accounts, memento: mem as never });
    const team = withTeamAliases(orgs())[0]!;
    ports.offer(svc.ref, team, [8000, 9229, 80]);
    const offers = ports.getChildren();
    expect(offers.map((e) => (e.kind === 'detected' ? e.port : null))).toEqual([8000]);
    await ports.dismiss(offers[0]!);
    ports.offer(svc.ref, team, [8000]);
    expect(ports.getChildren()).toEqual([]);
  });
});
