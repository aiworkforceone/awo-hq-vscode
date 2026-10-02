/**
 * The multi-account unit tier's shared pieces (hq-vscode-multi-account §Test Plan): a loopback HQ
 * with several users and grants that RECORDS, for every request and WebSocket upgrade, which grant's
 * bearer it carried and which grant's device key signed it (MA-S1's recorder); a SecretStorage
 * shared by several "windows" whose change events can be made not to cross windows (Cursor, P0
 * check 2) or whose reads can fail (decision 18); a globalState with `keys()`; and a recording UI.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RemoteOrg, RemoteWorkspace } from '@kpa/shared/remote.types';
import { deviceSignaturePayload } from '@kpa/shared/remote.types';
import {
  generateDeviceKeyMaterial,
  publicLineOf,
  toOpenSshPrivateKey,
} from '@hq/client/device-key.js';
import type { HqService, HqUi } from '../../src/hq/hq-service.js';
import { SessionStore, type MementoLike, type SecretsLike } from '../../src/hq/session-store.js';
import { HqAccounts, type HqAccountsDeps, type WindowStateLike } from '../../src/hq/accounts.js';
import type { AccountRef } from '../../src/hq/account-ref.js';

export const WS_ID = '3f9a1c2e-1111-4222-8333-444455556666';
export const WS_B_ONLY = '7c1e2a90-2222-4333-8444-555566667777';

export interface FakeUser {
  id: string;
  email: string;
  name: string;
}

export const USER_A: FakeUser = {
  id: '4f7c2a90-1d3e-4b6a-9c11-2b0e5d7f8a31',
  email: 'a@agency.com',
  name: 'Agency A',
};
export const USER_B: FakeUser = {
  id: '0b5e9a12-3c4d-4e6f-8a90-1b2c3d4e5f60',
  email: 'owner@client.com',
  name: 'Client Owner',
};
export const USER_C: FakeUser = {
  id: '9a9a9a9a-0000-4000-8000-0000000000cc',
  email: 'c@third.io',
  name: 'Third',
};

/** The org both users share (one team), plus one org only B sees. */
export function orgsFor(user: FakeUser): RemoteOrg[] {
  const shared: RemoteOrg = {
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
  } as unknown as RemoteOrg;
  if (user.id !== USER_B.id) return [shared];
  const clientOrg = {
    id: 'o2',
    slug: 'client-co',
    name: 'Client Co',
    role: 'owner',
    remoteAccess: { allowed: true },
    workspaces: [
      {
        id: WS_B_ONLY,
        alias: 'hq-7c1e2a90',
        name: 'Website',
        state: 'running',
        rights: { forward: true, attach: true, files: { read: true, write: true } },
        supported: true,
      },
    ],
  } as unknown as RemoteOrg;
  return [shared, clientOrg];
}

// ── SecretStorage shared by windows ─────────────────────────────────────────────────────────────

export interface SecretsWindow extends SecretsLike {
  /** `secrets.get` THROWS for these keys (keychain locked, decision 18 "busy"). */
  throwOn: (key: string) => boolean;
  /** `secrets.get` answers undefined for these keys (decision 18 "needs sign-in"). */
  hideOn: (key: string) => boolean;
}

export interface SecretsHub {
  data: Map<string, string>;
  /** A window's SecretStorage. `crossWindow: false` = Cursor: no event for other windows' writes. */
  window(opts?: { crossWindow?: boolean }): SecretsWindow;
}

export function secretsHub(): SecretsHub {
  const data = new Map<string, string>();
  const windows: Array<{ cross: boolean; listeners: Set<(e: { key: string }) => unknown> }> = [];
  const fire = (from: unknown, key: string) => {
    for (const w of windows) {
      if (w !== from && !w.cross) continue;
      for (const l of [...w.listeners]) l({ key });
    }
  };
  return {
    data,
    window(opts = {}) {
      const w = {
        cross: opts.crossWindow !== false,
        listeners: new Set<(e: { key: string }) => unknown>(),
      };
      windows.push(w);
      const view: SecretsWindow = {
        throwOn: () => false,
        hideOn: () => false,
        get: async (k) => {
          if (view.throwOn(k)) throw new Error('keychain locked');
          if (view.hideOn(k)) return undefined;
          return data.get(k);
        },
        store: async (k, v) => {
          data.set(k, v);
          fire(w, k);
        },
        delete: async (k) => {
          data.delete(k);
          fire(w, k);
        },
        onDidChange: (l) => {
          w.listeners.add(l);
          return { dispose: () => void w.listeners.delete(l) };
        },
      };
      return view;
    },
  };
}

export function memento(): MementoLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k, v) => {
      if (v === undefined) data.delete(k);
      else data.set(k, v);
    },
    keys: () => [...data.keys()],
  };
}

export function windowState(): WindowStateLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k, v) => {
      if (v === undefined) data.delete(k);
      else data.set(k, v);
    },
  };
}

// ── the UI ──────────────────────────────────────────────────────────────────────────────────────

export interface FakeUi extends HqUi {
  codes: string[];
  opened: string[];
  infos: string[];
  modals: string[];
  /** Every Sign in prompt: whose account, what it said, modal or not. */
  asked: Array<{ ref: AccountRef; message: string; modal: boolean }>;
  offered: string[];
  confirms: string[];
  signInHere: boolean;
  /** What the person answers a Sign in prompt (default: dismiss). */
  answerSignIn: (message: string) => boolean;
  /** Hold every Sign in prompt open until this resolves (MA-S36's latch). */
  holdPrompts: Promise<void> | null;
  confirmAnswer: boolean;
  cancelCode: (() => void) | null;
  /** Device-code notices still on screen (shown and not yet closed). */
  openNotices: number;
}

export function fakeUi(): FakeUi {
  const ui: FakeUi = {
    codes: [],
    opened: [],
    infos: [],
    modals: [],
    asked: [],
    offered: [],
    confirms: [],
    signInHere: false,
    answerSignIn: () => false,
    holdPrompts: null,
    confirmAnswer: true,
    cancelCode: null,
    openNotices: 0,
    showDeviceCode: (code, onCancel) => {
      ui.codes.push(code);
      ui.cancelCode = onCancel;
      ui.openNotices += 1;
      let closed = false;
      return {
        close: () => {
          if (!closed) ui.openNotices -= 1;
          closed = true;
        },
      };
    },
    openExternal: async (url) => void ui.opened.push(url),
    copyToClipboard: async () => undefined,
    info: (m) => void ui.infos.push(m),
    askToSignIn: async (ref, message, modal) => {
      ui.asked.push({ ref, message, modal });
      if (ui.holdPrompts) await ui.holdPrompts;
      return ui.answerSignIn(message);
    },
    modal: (m) => void ui.modals.push(m),
    offerSignInHere: async (m) => {
      ui.offered.push(m);
      return ui.signInHere;
    },
    confirm: async (m) => {
      ui.confirms.push(m);
      return ui.confirmAnswer;
    },
  };
  return ui;
}

// ── the fake HQ ─────────────────────────────────────────────────────────────────────────────────

export interface Grant {
  id: string;
  user: FakeUser;
  pub: KeyObject;
  access: string;
  refresh: string;
  /** Refresh tokens already presented (and when). */
  used: Map<string, number>;
  accessExpiresAt: number;
  revoked: boolean;
}

export interface Seen {
  method: string;
  path: string;
  /** The grant whose access/refresh token was the bearer (null: none, or unknown). */
  bearer: string | null;
  /** The grant whose device key verifies the signature (null: unsigned; 'bad': no grant's key). */
  signer: string | null;
  upgrade: boolean;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeHq {
  url: string;
  seen: Seen[];
  grants: Map<string, Grant>;
  /** Who the browser approves the next device code as. */
  approveAs: FakeUser;
  /** The approval waits for this (a person still at the browser). */
  pollGate: Promise<void> | null;
  startStatus: number | null;
  refreshes: () => number;
  /** Access tokens issued live this long (default 15 min). */
  accessTtlMs: number;
  /** The refresh answer is this slow (so a second window waits on the lock). */
  refreshDelayMs: number;
  probeStatus: number;
  orgsStatus: number | null;
  /** `DELETE /api/remote/grants/:id` answers this instead (unconfirmed-401 sign-out cases). */
  deleteStatus: number | null;
  /** The team machine is off: its file routes answer 409 RUNNER_UNAVAILABLE. */
  teamOff: boolean;
  /** The file routes answer this status instead (null: as usual). */
  fsStatus: number | null;
  /** The state every team is listed with (null: as `orgsFor` has it, `running`). */
  teamState: RemoteWorkspace['state'] | null;
  /** `POST …/wake` answers this (null: 200 `{state:'running'}`). */
  wakeAnswer: { status: number; body: unknown } | null;
  terminal: (ws: WebSocket, req: IncomingMessage) => void;
  /** Every open socket and the grant it was upgraded with. */
  sockets: Array<{ grant: string; path: string; ws: WebSocket }>;
  /** Revoke a grant as HQ web's Devices page does: its sockets close 4401. */
  revoke(grantId: string): void;
  /** A grant of `user` made directly (as if approved earlier), with its key's public half. */
  issue(user: FakeUser, pub: KeyObject, opts?: { accessTtlMs?: number }): Grant;
  userOf(grantId: string | null): string | null;
  close(): Promise<void>;
}

/** `ssh-ed25519 <base64>` → the public key. */
export function pubFromLine(line: string): KeyObject {
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  const raw = blob.subarray(blob.length - 32);
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
}

export async function startFakeHq(): Promise<FakeHq> {
  let n = 0;
  let refreshes = 0;
  const nonces = new Set<string>();
  const starts = new Map<string, KeyObject>();
  /** The listing as HQ answers it now (`fake.teamState` on every team when set). */
  const listed = (orgs: RemoteOrg[]): RemoteOrg[] =>
    fake.teamState === null
      ? orgs
      : orgs.map((o) => ({
          ...o,
          workspaces: o.workspaces.map((w) => ({ ...w, state: fake.teamState! })),
        }));
  const fake: FakeHq = {
    url: '',
    seen: [],
    grants: new Map(),
    approveAs: USER_A,
    pollGate: null,
    startStatus: null,
    refreshes: () => refreshes,
    accessTtlMs: 15 * 60_000,
    refreshDelayMs: 0,
    probeStatus: 200,
    orgsStatus: null,
    deleteStatus: null,
    teamOff: false,
    fsStatus: null,
    teamState: null,
    wakeAnswer: null,
    terminal: (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as { type: string; sessionId?: string };
        if (f.type === 'attach')
          ws.send(JSON.stringify({ type: 'attached', sessionId: f.sessionId }));
      });
    },
    sockets: [],
    revoke(grantId) {
      const g = fake.grants.get(grantId);
      if (g) g.revoked = true;
      for (const s of fake.sockets) if (s.grant === grantId) s.ws.close(4401, 'unauthorized');
    },
    issue(user, pub, opts = {}) {
      n += 1;
      const id = `grant-${n}`;
      const g: Grant = {
        id,
        user,
        pub,
        access: `hqa_${id}_${'a'.repeat(30)}`,
        refresh: `hqr_${id}_${'r'.repeat(30)}`,
        used: new Map(),
        accessExpiresAt: Date.now() + (opts.accessTtlMs ?? fake.accessTtlMs),
        revoked: false,
      };
      fake.grants.set(id, g);
      return g;
    },
    userOf(grantId) {
      return grantId ? (fake.grants.get(grantId)?.user.id ?? null) : null;
    },
    close: async () => undefined,
  };

  const byBearer = (auth: string | undefined): Grant | null => {
    const t = /^Bearer (.+)$/.exec(auth ?? '')?.[1];
    if (!t) return null;
    for (const g of fake.grants.values()) if (g.access === t || g.refresh === t) return g;
    return null;
  };
  const signerOf = (
    headers: IncomingMessage['headers'],
    method: string,
    target: string,
    body: Buffer,
  ): { signer: string | null; nonce: string | null } => {
    const sig = headers['x-hq-device-sig'];
    const nonce = headers['x-hq-nonce'];
    if (typeof sig !== 'string' || typeof nonce !== 'string') return { signer: null, nonce: null };
    const payload = Buffer.from(
      deviceSignaturePayload(
        nonce,
        method,
        target,
        createHash('sha256').update(body).digest('hex'),
      ),
      'utf8',
    );
    for (const g of fake.grants.values()) {
      if (verify(null, payload, g.pub, Buffer.from(sig, 'base64'))) return { signer: g.id, nonce };
    }
    return { signer: 'bad', nonce };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const target = req.url ?? '/';
        const p = target.split('?')[0]!;
        const method = req.method ?? 'GET';
        const body = Buffer.concat(chunks);
        const bearer = byBearer(req.headers.authorization);
        const { signer, nonce } = signerOf(req.headers, method, target, body);
        fake.seen.push({
          method,
          path: p,
          bearer: bearer?.id ?? null,
          signer,
          upgrade: false,
          headers: req.headers,
          body: body.toString('utf8'),
        });
        res.setHeader('content-type', 'application/json');
        const send = (status: number, b?: unknown) => {
          res.statusCode = status;
          res.end(b === undefined ? undefined : JSON.stringify(b));
        };
        const unauthorized = () =>
          send(401, { error: 'unauthorized', code: 'REMOTE_TOKEN_INVALID' });
        const json = (): Record<string, unknown> => {
          try {
            return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          } catch {
            return {};
          }
        };
        if (p === '/api/remote/device/start') {
          if (fake.startStatus) return send(fake.startStatus, { error: 'Too many requests.' });
          n += 1;
          const code = `dev-code-${n}`;
          starts.set(code, pubFromLine(String(json().devicePubkey)));
          return send(200, {
            deviceCode: code,
            userCode: 'WDJB-MJHT',
            verificationUrl: `${fake.url}/device`,
            verificationUrlComplete: `${fake.url}/device?code=WDJB-MJHT`,
            expiresIn: 600,
            interval: 5,
          });
        }
        if (p === '/api/remote/device/poll') {
          if (fake.pollGate) await fake.pollGate;
          const pub = starts.get(String(json().deviceCode));
          if (!pub) return send(410, { error: 'expired' });
          const user = fake.approveAs;
          const g = fake.issue(user, pub);
          return send(200, {
            status: 'approved',
            grantId: g.id,
            accessToken: g.access,
            accessExpiresAt: new Date(g.accessExpiresAt).toISOString(),
            refreshToken: g.refresh,
            user,
            orgs: orgsFor(user),
          });
        }
        if (p === '/api/remote/token/refresh') {
          // No bearer: the grant is the one whose refresh token (current or used) was presented.
          const presented = String(json().refreshToken);
          const g = [...fake.grants.values()].find(
            (x) => x.refresh === presented || x.used.has(presented),
          );
          fake.seen.at(-1)!.bearer = g?.id ?? null;
          if (!g || g.revoked || signer !== g.id || !nonce || !nonces.delete(nonce)) {
            return unauthorized();
          }
          if (presented !== g.refresh) {
            const at = g.used.get(presented)!;
            if (Date.now() - at < 30_000) return send(409, { error: 'race', code: 'REFRESH_RACE' });
            g.revoked = true; // reuse past the grace window: the family and the grant go
            return unauthorized();
          }
          refreshes += 1;
          if (fake.refreshDelayMs) await new Promise((r) => setTimeout(r, fake.refreshDelayMs));
          g.used.set(presented, Date.now());
          n += 1;
          g.access = `hqa_${g.id}_${n}_${'z'.repeat(26)}`;
          g.refresh = `hqr_${g.id}_${n}_${'z'.repeat(26)}`;
          g.accessExpiresAt = Date.now() + 15 * 60_000;
          return send(200, {
            accessToken: g.access,
            accessExpiresAt: new Date(g.accessExpiresAt).toISOString(),
            refreshToken: g.refresh,
          });
        }
        // Every other route: a live grant's token, and a signature from THAT grant when signed.
        if (!bearer || bearer.revoked) return unauthorized();
        if (signer !== null) {
          if (!nonce || !nonces.delete(nonce) || signer !== bearer.id) return unauthorized();
        }
        res.setHeader('x-hq-nonce', `n-${(n += 1)}`);
        nonces.add(`n-${n}`);
        if (p === '/api/remote/nonce') {
          n += 1;
          nonces.add(`nonce-${n}`);
          return send(200, { nonce: `nonce-${n}`, expiresIn: 60 });
        }
        if (req.headers.authorization !== `Bearer ${bearer.access}`) return unauthorized();
        if (p === '/api/remote/orgs') {
          if (fake.orgsStatus) {
            return send(fake.orgsStatus, {
              error: 'nope',
              code: fake.orgsStatus === 401 ? 'REMOTE_TOKEN_INVALID' : 'UPGRADE_REQUIRED',
            });
          }
          return send(200, listed(orgsFor(bearer.user)));
        }
        const del = /^\/api\/remote\/grants\/([^/]+)$/.exec(p);
        if (del && method === 'DELETE') {
          if (fake.deleteStatus)
            return send(fake.deleteStatus, { error: 'no', code: 'REMOTE_TOKEN_INVALID' });
          if (signer !== bearer.id || del[1] !== bearer.id) return unauthorized();
          fake.revoke(bearer.id);
          return send(204);
        }
        if (p === '/api/remote/probe') {
          return send(fake.probeStatus, fake.probeStatus === 200 ? {} : { error: 'no' });
        }
        const ws = /^\/api\/remote\/orgs\/([^/]+)\/workspaces\/([^/]+)(\/.*)?$/.exec(p);
        if (ws) {
          const org = listed(orgsFor(bearer.user)).find((o) => o.slug === ws[1]);
          const team = org?.workspaces?.find((w) => w.id === ws[2]);
          if (!team) return send(404, { error: 'not found' });
          const rest = ws[3] ?? '';
          if (rest === '') return send(200, team);
          if (rest === '/wake') {
            return fake.wakeAnswer
              ? send(fake.wakeAnswer.status, fake.wakeAnswer.body)
              : send(200, { state: 'running' });
          }
          if (rest === '/sessions' && method === 'GET') return send(200, []);
          if (rest === '/sessions' && method === 'POST') {
            return send(201, {
              id: `s-${(n += 1)}`,
              name: 'new',
              ownerName: bearer.user.name,
              status: 'running',
              canType: true,
            });
          }
          if (fake.fsStatus !== null && rest.startsWith('/fs/')) {
            return send(fake.fsStatus, { error: 'no', code: 'REMOTE_TOKEN_INVALID' });
          }
          if (fake.teamOff && rest.startsWith('/fs/')) {
            return send(409, {
              error: 'off',
              code: 'RUNNER_UNAVAILABLE',
              details: { state: 'stopped' },
            });
          }
          if (rest === '/fs/tree') {
            return send(200, {
              entries: [{ path: 'src', type: 'dir', size: 0, mtimeMs: 1, etag: 'd1' }],
            });
          }
          if (rest === '/fs/stat') {
            return send(200, { path: 'src/a.py', type: 'file', size: 2, mtimeMs: 1, etag: 'e1' });
          }
          if (rest === '/fs/file' && method === 'GET') {
            res.setHeader('etag', 'e1');
            res.setHeader('content-type', 'application/octet-stream');
            res.statusCode = 200;
            return res.end(Buffer.from('hi'));
          }
          if (rest === '/fs/file' && method === 'PUT') {
            return send(200, { path: 'src/a.py', type: 'file', size: 2, mtimeMs: 2, etag: 'e2' });
          }
          if (rest === '/fs/search/text') return send(200, { matches: [], truncated: false });
          if (rest === '/connections' && method === 'POST') {
            return send(201, {
              id: '9d9d9d9d-0000-4000-8000-000000000001',
              state: 'ready',
              connectCode: `hqc_${n}`,
              hostKey: null,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
          }
          if (rest.startsWith('/connections/') && method === 'DELETE') return send(204);
          if (rest.endsWith('/codes') && method === 'POST') {
            return send(200, {
              connectCode: `hqc_${(n += 1)}`,
              expiresAt: new Date().toISOString(),
            });
          }
        }
        return send(404, { error: 'not found' });
      })();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const target = req.url ?? '/';
    const bearer = byBearer(req.headers.authorization);
    const { signer, nonce } = signerOf(req.headers, 'GET', target.split('?')[0]!, Buffer.alloc(0));
    fake.seen.push({
      method: 'GET',
      path: target.split('?')[0]!,
      bearer: bearer?.id ?? null,
      signer,
      upgrade: true,
      headers: req.headers,
      body: '',
    });
    if (!bearer || bearer.revoked || signer !== bearer.id || !nonce || !nonces.delete(nonce)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const p = target.split('?')[0]!;
      fake.sockets.push({ grant: bearer.id, path: p, ws });
      ws.on('close', () => {
        fake.sockets = fake.sockets.filter((s) => s.ws !== ws);
      });
      if (p.startsWith('/ws/remote/tunnel')) {
        ws.on('message', (d, bin) => ws.send(d, { binary: bin }));
      } else if (p.startsWith('/ws/remote/events')) {
        ws.on('message', (d) => {
          const f = JSON.parse(d.toString()) as { type: string; workspaceId?: string };
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
      } else fake.terminal(ws, req);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = async () => {
    for (const c of wss.clients) c.terminate();
    // A re-list still in flight (a switch, a poll) must not hold the next test's teardown.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return fake;
}

export function tempLockDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-vscode-ma-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── signed-in accounts, as earlier sign-ins left them ───────────────────────────────────────────

/** A fresh device key: its OpenSSH text (what the slot stores) and its public half (what HQ has). */
export function deviceKey(): { openssh: string; pub: KeyObject } {
  const { seed32, pub32 } = generateDeviceKeyMaterial();
  return {
    openssh: toOpenSshPrivateKey(seed32, pub32, 'hq-vscode@test'),
    pub: pubFromLine(publicLineOf(pub32)),
  };
}

/** A `user` slot signed in as `user` (as a 0.2.0 sign-in writes it). */
export async function seedUserSlot(
  fake: FakeHq,
  store: SessionStore,
  ref: AccountRef,
  user: FakeUser,
  opts: { accessTtlMs?: number } = {},
): Promise<Grant> {
  const key = deviceKey();
  const g = fake.issue(user, key.pub, opts);
  await store.writeUserSlot(ref, {
    grantId: g.id,
    openssh: key.openssh,
    tokens: {
      accessToken: g.access,
      accessExpiresAt: new Date(g.accessExpiresAt).toISOString(),
      refreshToken: g.refresh,
    },
    orgs: orgsFor(user),
    user,
  });
  return g;
}

/** The 0.1.x slot exactly as 0.1.1 writes it: `hq:<host>:device|tokens|account|orgs`. */
export async function seedLegacySlot(
  fake: FakeHq,
  secrets: SecretsLike,
  mem: MementoLike,
  host: string,
  user: FakeUser,
  opts: { accessTtlMs?: number } = {},
): Promise<Grant & { openssh: string }> {
  const key = deviceKey();
  const g = fake.issue(user, key.pub, opts);
  await secrets.store(`hq:${host}:device`, key.openssh);
  await secrets.store(
    `hq:${host}:tokens`,
    JSON.stringify({
      accessToken: g.access,
      accessExpiresAt: new Date(g.accessExpiresAt).toISOString(),
      refreshToken: g.refresh,
    }),
  );
  await mem.update(`hq:${host}:orgs`, orgsFor(user));
  await mem.update(`hq:${host}:account`, { grantId: g.id, user });
  return { ...g, openssh: key.openssh };
}

export function userRef(host: string, user: FakeUser, profileKey: string): AccountRef {
  return { host, userId: user.id, slot: 'user', profileKey };
}

export const PROFILE_A = 'p0a0a0a0a';
export const PROFILE_B = 'p0b0b0b0b';

/** One editor window: its SecretStorage view, its workspaceState, its UI and its `HqAccounts`. */
export interface TestWindow {
  secrets: SecretsWindow;
  store: SessionStore;
  state: ReturnType<typeof windowState>;
  ui: FakeUi;
  accounts: HqAccounts;
}

export function openWindow(
  fake: FakeHq,
  hub: SecretsHub,
  mem: MementoLike,
  lockDir: string,
  opts: Partial<HqAccountsDeps> & {
    crossWindow?: boolean;
    appName?: string;
    /** The store's clock (its 60 s token cache). */
    storeNow?: () => number;
  } = {},
): TestWindow {
  const secrets = hub.window({ crossWindow: opts.crossWindow ?? true });
  const store = new SessionStore(secrets, mem, opts.storeNow);
  const state = windowState();
  const ui = fakeUi();
  const accounts = new HqAccounts({
    store,
    ui,
    host: () => ({ ok: true, host: fake.url }),
    extensionVersion: '0.2.0',
    appName: opts.appName ?? 'Code',
    windowState: state,
    lockDir,
    sleep: async () => undefined,
    pollMs: 0,
    hostname: () => 'jeans-mbp',
    platform: 'darwin',
    ...opts,
  });
  return { secrets, store, state, ui, accounts };
}

/**
 * A window signed in on a 0.1.x (legacy) slot against a fake HQ that does not check keys (the
 * terminal, ports and echo suites): its `HqAccounts` and that one account's service.
 */
export async function legacySignedIn(
  host: string,
  orgs: RemoteOrg[],
  lockDir: string,
  opts: { extensionVersion?: string; mem?: ReturnType<typeof memento> } = {},
): Promise<{ accounts: HqAccounts; svc: HqService; mem: ReturnType<typeof memento>; ui: FakeUi }> {
  const mem = opts.mem ?? memento();
  const secrets = secretsHub().window();
  await secrets.store(`hq:${host}:device`, deviceKey().openssh);
  await secrets.store(
    `hq:${host}:tokens`,
    JSON.stringify({
      accessToken: `hqa_${'a'.repeat(43)}`,
      accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      refreshToken: `hqr_${'r'.repeat(43)}`,
    }),
  );
  await mem.update(`hq:${host}:orgs`, orgs);
  await mem.update(`hq:${host}:account`, {
    grantId: 'g1',
    user: { id: 'u1', email: 'jean@example.com', name: 'Jean' },
  });
  const ui = fakeUi();
  const accounts = new HqAccounts({
    store: new SessionStore(secrets, mem),
    ui,
    host: () => ({ ok: true, host }),
    extensionVersion: opts.extensionVersion ?? '0.1.0',
    appName: 'Code',
    windowState: windowState(),
    lockDir,
    pollMs: 0,
    sleep: async () => undefined,
  });
  return { accounts, svc: accounts.list()[0]!.service, mem, ui };
}
