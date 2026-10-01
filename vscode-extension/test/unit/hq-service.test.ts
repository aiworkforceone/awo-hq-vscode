/**
 * The sign-in lifecycle against a scripted HQ (U1-U3 unit tier, D1/D2/D14/D15):
 *
 *   - sign-in asks for the extension's OWN grant (`hq-vscode`), opens `/device` never prefilled,
 *     copies the code, and keeps the key and the tokens in SecretStorage only (globalState holds no
 *     token and no key, U1's assertion);
 *   - every call says `X-HQ-Client: vscode/<v>`;
 *   - two windows refreshing at once send exactly ONE `/token/refresh` (D2) and both keep working;
 *   - a 401 wipes everything and closes terminals and forwards (`onRevoked`); a 426 is said once;
 *   - sign-out revokes the grant in HQ (device-signed DELETE) and then wipes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { HqService, type HqUi } from '../../src/hq/hq-service.js';
import { COPY } from '../../src/copy.js';
import { SessionStore, type MementoLike, type SecretsLike } from '../../src/hq/session-store.js';

const HOST = 'https://hq-test.aiworkforceone.com';

/** One SecretStorage shared by every "window", firing onDidChange to all of them. */
function sharedSecrets(): SecretsLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const listeners = new Set<(e: { key: string }) => unknown>();
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => {
      data.set(k, v);
      for (const l of listeners) l({ key: k });
    },
    delete: async (k) => {
      data.delete(k);
      for (const l of listeners) l({ key: k });
    },
    onDidChange: (l) => {
      listeners.add(l);
      return { dispose: () => void listeners.delete(l) };
    },
  };
}

function memento(): MementoLike & { data: Map<string, unknown> } {
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

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const ORGS: RemoteOrg[] = [
  {
    id: 'o1',
    slug: 'awo',
    name: 'AI Workforce One',
    role: 'owner',
    remoteAccess: { allowed: true },
    workspaces: [
      {
        id: '3f9a1c2e-1111-4222-8333-444455556666',
        alias: 'hq-3f9a1c2e',
        name: 'Backend team',
        state: 'running',
        rights: { forward: true, attach: true },
        supported: true,
      },
    ],
  },
];

function fakeHq(
  opts: {
    accessTtlMs?: number;
    orgsStatus?: number;
    deleteStatus?: number;
    probeStatus?: number;
    /** The approval waits for this (a person still at the browser). */
    pollGate?: Promise<void>;
  } = {},
) {
  const seen: Seen[] = [];
  let refreshes = 0;
  let n = 0;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    seen.push({
      method: init.method ?? 'GET',
      path: u.pathname,
      headers,
      body: String(init.body ?? ''),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'x-hq-nonce': `n${(n += 1)}` } });
    switch (u.pathname) {
      case '/api/remote/device/start':
        return json(200, {
          deviceCode: 'dev-code-secret',
          userCode: 'WDJB-MJHT',
          verificationUrl: `${HOST}/device`,
          verificationUrlComplete: `${HOST}/device?code=WDJB-MJHT`,
          expiresIn: 600,
          interval: 5,
        });
      case '/api/remote/device/poll':
        if (opts.pollGate) await opts.pollGate;
        return json(200, {
          status: 'approved',
          grantId: 'grant-1',
          accessToken: `hqa_${'a'.repeat(43)}`,
          accessExpiresAt: new Date(Date.now() + (opts.accessTtlMs ?? 15 * 60_000)).toISOString(),
          refreshToken: `hqr_${'r'.repeat(43)}`,
          user: { id: 'u1', email: 'jean@example.com', name: 'Jean' },
          orgs: ORGS,
        });
      case '/api/remote/nonce':
        return json(200, { nonce: `nonce-${(n += 1)}`, expiresIn: 60 });
      case '/api/remote/token/refresh':
        refreshes += 1;
        // Slow enough that the second window is waiting on the lock, not racing past it.
        await new Promise((r) => setTimeout(r, 150));
        return json(200, {
          accessToken: `hqa_${'z'.repeat(43)}`,
          accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          refreshToken: `hqr_${'z'.repeat(43)}`,
        });
      case '/api/remote/orgs':
        return opts.orgsStatus
          ? json(opts.orgsStatus, {
              error: 'nope',
              code: opts.orgsStatus === 401 ? 'REMOTE_TOKEN_INVALID' : 'UPGRADE_REQUIRED',
            })
          : json(200, ORGS);
      case '/api/remote/grants/grant-1':
        return opts.deleteStatus
          ? json(opts.deleteStatus, { error: 'no', code: 'REMOTE_TOKEN_INVALID' })
          : new Response(null, { status: 204 });
      case '/api/remote/probe':
        return json(opts.probeStatus ?? 200, opts.probeStatus ? { error: 'no' } : {});
      default:
        return json(404, { error: 'not found' });
    }
  }) as unknown as typeof fetch;
  return { fetchFn, seen, refreshes: () => refreshes };
}

function fakeUi() {
  const ui = {
    codes: [] as string[],
    opened: [] as string[],
    clipboard: [] as string[],
    infos: [] as string[],
    modals: [] as string[],
    asked: [] as string[],
    showDeviceCode: (code: string) => {
      ui.codes.push(code);
      return { close: () => undefined };
    },
    openExternal: async (url: string) => void ui.opened.push(url),
    copyToClipboard: async (text: string) => void ui.clipboard.push(text),
    info: (m: string) => void ui.infos.push(m),
    askToSignIn: async (m: string) => {
      ui.asked.push(m);
      return false;
    },
    modal: (m: string) => void ui.modals.push(m),
  };
  return ui satisfies HqUi;
}

let lockDir: string;
beforeEach(() => {
  lockDir = mkdtempSync(path.join(tmpdir(), 'hq-vscode-lock-'));
});
afterEach(() => rmSync(lockDir, { recursive: true, force: true }));

function service(
  secrets: SecretsLike,
  mem: MementoLike,
  fetchFn: typeof fetch,
  ui = fakeUi(),
): { svc: HqService; ui: ReturnType<typeof fakeUi>; store: SessionStore } {
  const store = new SessionStore(secrets, mem);
  const svc = new HqService({
    store,
    ui,
    host: () => ({ ok: true, host: HOST }),
    extensionVersion: '0.1.0',
    appName: 'Cursor',
    fetch: fetchFn,
    sleep: async () => undefined,
    lockDir,
    hostname: () => 'jeans-mbp',
    platform: 'darwin',
  });
  return { svc, ui, store };
}

describe('sign-in (D1, U1)', () => {
  it('asks for its own grant, opens /device unprefilled, and keeps secrets out of globalState', async () => {
    const hq = fakeHq();
    const secrets = sharedSecrets();
    const mem = memento();
    const { svc, ui } = service(secrets, mem, hq.fetchFn);
    expect(await svc.signIn()).toBe('approved');

    const start = hq.seen.find((s) => s.path === '/api/remote/device/start')!;
    const body = JSON.parse(start.body) as Record<string, string>;
    expect(body.clientName).toBe('hq-vscode');
    expect(body.deviceLabel).toBe('Cursor on jeans-mbp');
    expect(body.devicePubkey).toMatch(/^ssh-ed25519 /);
    expect(start.headers['x-hq-client']).toBe('vscode/0.1.0');
    // The code is typed on the page, never prefilled (T2); it is copied for the person.
    expect(ui.opened).toEqual([`${HOST}/device`]);
    expect(ui.codes).toEqual(['WDJB-MJHT']);
    expect(ui.clipboard).toEqual(['WDJB-MJHT']);

    // SecretStorage holds the pair and the key; globalState holds no secret at all.
    expect(secrets.data.get(`hq:${HOST}:tokens`)).toContain('hqa_');
    expect(secrets.data.get(`hq:${HOST}:device`)).toContain('OPENSSH PRIVATE KEY');
    const everything = JSON.stringify([...mem.data.entries()]);
    expect(everything).not.toMatch(/hqa_|hqr_|PRIVATE KEY|dev-code-secret/);
    expect(svc.signedIn()).toBe(true);
    expect(svc.teams().map((t) => t.alias)).toEqual(['hq-3f9a1c2e']);
    expect(ui.infos).toEqual(['Signed in to AI Workforce One HQ as jean@example.com.']);
  });

  it('every call after sign-in carries X-HQ-Client and asks for its next nonce', async () => {
    const hq = fakeHq();
    const { svc } = service(sharedSecrets(), memento(), hq.fetchFn);
    await svc.signIn();
    await svc.refreshOrgs();
    const orgs = hq.seen.filter((s) => s.path === '/api/remote/orgs');
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.headers['x-hq-client']).toBe('vscode/0.1.0');
    expect(orgs[0]!.headers['x-hq-want-nonce']).toBe('1');
    expect(orgs[0]!.headers['x-hq-cli-version']).toBeUndefined();
  });
});

describe('SessionStore fresh reads (review M-b)', () => {
  it('load(host, {fresh:true}) bypasses the 60 s in-memory copy; needsRenewing survives a round trip', async () => {
    const data = new Map<string, string>();
    // A SecretStorage whose onDidChange does NOT cross windows (the fallback case).
    const secrets: SecretsLike = {
      get: async (k) => data.get(k),
      store: async (k, v) => void data.set(k, v),
      delete: async (k) => void data.delete(k),
      onDidChange: () => ({ dispose: () => undefined }),
    };
    const store = new SessionStore(secrets, memento()).tokenStore();
    const pair = (r: string) => ({
      accessToken: `hqa_${r.repeat(43)}`,
      accessExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: `hqr_${r.repeat(43)}`,
    });
    data.set(`hq:${HOST}:tokens`, JSON.stringify(pair('a')));
    expect((await store.load(HOST))?.refreshToken).toBe(pair('a').refreshToken);
    // Another window rotates; the event never reaches this one.
    data.set(`hq:${HOST}:tokens`, JSON.stringify({ ...pair('b'), needsRenewing: true }));
    expect((await store.load(HOST))?.refreshToken).toBe(pair('a').refreshToken);
    const fresh = await store.load(HOST, { fresh: true });
    expect(fresh?.refreshToken).toBe(pair('b').refreshToken);
    expect(fresh?.needsRenewing).toBe(true);
  });
});

describe('refresh across windows (D2, U2)', () => {
  it('two windows refreshing at the same moment send exactly one /token/refresh', async () => {
    const hq = fakeHq({ accessTtlMs: 60_000 }); // inside the 2-minute refresh margin
    const secrets = sharedSecrets();
    const mem = memento();
    const a = service(secrets, mem, hq.fetchFn);
    await a.svc.signIn();
    const b = service(secrets, mem, hq.fetchFn);
    const [ta, tb] = await Promise.all([
      (await a.svc.client())!.accessToken(),
      (await b.svc.client())!.accessToken(),
    ]);
    expect(hq.refreshes()).toBe(1);
    expect(ta).toBe(`hqa_${'z'.repeat(43)}`);
    expect(tb).toBe(ta);
  });
});

describe('one device flow across windows (nonprod 2026-09-30: two grants from one sign-in)', () => {
  it('a second window never starts its own flow while one runs; once done, it adopts the sign-in', async () => {
    let approve!: () => void;
    const hq = fakeHq({ pollGate: new Promise<void>((r) => (approve = r)) });
    const secrets = sharedSecrets();
    const mem = memento();
    const a = service(secrets, mem, hq.fetchFn);
    const b = service(secrets, mem, hq.fetchFn);
    const first = a.svc.signIn();
    await new Promise((r) => setTimeout(r, 50));
    expect(await b.svc.signIn()).toBe('busy');
    expect(b.ui.infos).toEqual([COPY.signInOtherWindow]);
    approve();
    expect(await first).toBe('approved');
    // The other window finished it: this one is signed in with no second grant.
    expect(await b.svc.signIn()).toBe('approved');
    expect(hq.seen.filter((x) => x.path === '/api/remote/device/start')).toHaveLength(1);
  });
});

describe('what HQ answers means for the sign-in', () => {
  it('401: everything is wiped, terminals and forwards close, and one modal says so', async () => {
    const hq = fakeHq({ orgsStatus: 401 });
    const secrets = sharedSecrets();
    const mem = memento();
    const { svc, ui } = service(secrets, mem, hq.fetchFn);
    await svc.signIn();
    let revoked = 0;
    svc.onRevoked(() => (revoked += 1));
    await expect(svc.refreshOrgs()).rejects.toMatchObject({ status: 401 });
    expect(revoked).toBe(1);
    expect(svc.signedIn()).toBe(false);
    expect([...secrets.data.keys()]).toEqual([]);
    expect(ui.asked).toEqual(['Your access to HQ from this computer ended. Sign in again.']);
  });

  it('B1: a signed call that 401s twice while an unsigned read still works is NOT a revocation', async () => {
    const hq = fakeHq({ probeStatus: 401 });
    const secrets = sharedSecrets();
    const { svc, ui } = service(secrets, memento(), hq.fetchFn);
    await svc.signIn();
    let revoked = 0;
    svc.onRevoked(() => (revoked += 1));
    await expect(
      svc.call((c) => c.request('POST', '/api/remote/probe', { signed: true })),
    ).rejects.toMatchObject({ status: 401 });
    // Retried once with a fresh nonce, then confirmed against GET /api/remote/orgs (which answered).
    expect(hq.seen.filter((s) => s.path === '/api/remote/probe')).toHaveLength(2);
    expect(hq.seen.filter((s) => s.path === '/api/remote/orgs').length).toBeGreaterThan(0);
    expect(revoked).toBe(0);
    expect(svc.signedIn()).toBe(true);
    expect(secrets.data.get(`hq:${HOST}:device`)).toContain('OPENSSH PRIVATE KEY');
    expect(ui.asked).toEqual([]);
  });

  it('M-a: a login marked "needs renewing" asks to sign in again and wipes nothing', async () => {
    const hq = fakeHq({ accessTtlMs: 60_000 });
    const secrets = sharedSecrets();
    const { svc, ui } = service(secrets, memento(), hq.fetchFn);
    await svc.signIn();
    const key = `hq:${HOST}:tokens`;
    const pair = JSON.parse(secrets.data.get(key)!) as Record<string, unknown>;
    await secrets.store(key, JSON.stringify({ ...pair, needsRenewing: true }));
    await expect(svc.refreshOrgs()).rejects.toThrow(/needs renewing/);
    expect(hq.refreshes()).toBe(0);
    expect(ui.asked).toEqual(['Your HQ sign-in needs renewing.']);
    expect(secrets.data.get(key)).toContain('needsRenewing');
  });

  it('426: the update sentence, once however many calls are refused', async () => {
    const hq = fakeHq({ orgsStatus: 426 });
    const { svc, ui } = service(sharedSecrets(), memento(), hq.fetchFn);
    await svc.signIn();
    await expect(svc.refreshOrgs()).rejects.toMatchObject({ status: 426 });
    await expect(svc.refreshOrgs()).rejects.toMatchObject({ status: 426 });
    expect(ui.modals).toEqual([
      'This version of AI Workforce One HQ is no longer supported. Update it from the Extensions view.',
    ]);
    expect(svc.signedIn()).toBe(true);
  });

  it('sign-out revokes the grant with a signed DELETE, then wipes', async () => {
    const hq = fakeHq();
    const secrets = sharedSecrets();
    const { svc, ui } = service(secrets, memento(), hq.fetchFn);
    await svc.signIn();
    await svc.signOut();
    const del = hq.seen.find((s) => s.method === 'DELETE')!;
    expect(del.path).toBe('/api/remote/grants/grant-1');
    expect(del.headers['x-hq-device-sig']).toBeDefined();
    expect([...secrets.data.keys()]).toEqual([]);
    expect(svc.signedIn()).toBe(false);
    expect(ui.infos.at(-1)).toMatch(/Signed out/);
  });

  it('B1: sign-out never reports success on an UNCONFIRMED 401 (the grant may still be live)', async () => {
    const hq = fakeHq({ deleteStatus: 401 });
    const secrets = sharedSecrets();
    const { svc, ui } = service(secrets, memento(), hq.fetchFn);
    await svc.signIn();
    await svc.signOut();
    expect(hq.seen.filter((s) => s.method === 'DELETE')).toHaveLength(2);
    expect(ui.infos.at(-1)).toBe(
      'Signed out on this computer. HQ could not be reached to end this computer’s access; remove it in HQ, under Account, Devices.',
    );
  });

  it('B1: a sign-out 401 that HQ confirms (the login is already gone) is a normal sign-out', async () => {
    const hq = fakeHq({ deleteStatus: 401, orgsStatus: 401 });
    const { svc, ui } = service(sharedSecrets(), memento(), hq.fetchFn);
    await svc.signIn();
    await svc.signOut();
    expect(ui.infos.at(-1)).toMatch(/^Signed out of AI Workforce One HQ/);
  });

  it('a host outside the allow-list is never contacted', async () => {
    const hq = fakeHq();
    const store = new SessionStore(sharedSecrets(), memento());
    const ui = fakeUi();
    const svc = new HqService({
      store,
      ui,
      host: () => ({ ok: false, host: 'https://evil.example' }),
      extensionVersion: '0.1.0',
      appName: 'Code',
      fetch: hq.fetchFn,
      lockDir,
    });
    expect(await svc.signIn()).toBe('host-not-allowed');
    expect(hq.seen).toEqual([]);
    expect(ui.modals[0]).toMatch(/not an HQ address/);
  });
});
