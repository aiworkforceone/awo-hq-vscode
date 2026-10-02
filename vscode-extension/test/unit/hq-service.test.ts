/**
 * The sign-in lifecycle against a loopback HQ (U1-U3 unit tier, D1/D2/D14/D15), now per account
 * (hq-vscode-multi-account):
 *
 *   - sign-in asks for the extension's OWN grant (`hq-vscode`), opens `/device` never prefilled,
 *     copies the code, and keeps the key and the tokens in SecretStorage only, in a `user` slot
 *     (globalState holds no token and no key, U1's assertion; nothing under the 0.1.x keys, MA-S7);
 *   - every call says `X-HQ-Client: vscode/<v>`;
 *   - two windows refreshing at once send exactly ONE `/token/refresh` (D2) and both keep working;
 *   - a confirmed 401 wipes THAT account and closes its things (`onAccountRemoved`); a 426 is said
 *     once;
 *   - sign-out revokes the grant in HQ (device-signed DELETE) and then wipes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COPY } from '../../src/copy.js';
import { HqAccounts } from '../../src/hq/accounts.js';
import { SessionStore } from '../../src/hq/session-store.js';
import {
  fakeUi,
  memento,
  openWindow,
  PROFILE_A,
  secretsHub,
  seedUserSlot,
  startFakeHq,
  tempLockDir,
  USER_A,
  userRef,
  windowState,
  type FakeHq,
} from './harness.js';

let fake: FakeHq;
let lock: ReturnType<typeof tempLockDir>;
beforeEach(async () => {
  fake = await startFakeHq();
  lock = tempLockDir();
});
afterEach(async () => {
  await fake.close();
  lock.done();
});

const starts = () => fake.seen.filter((x) => x.path === '/api/remote/device/start').length;

describe('sign-in (D1, U1)', () => {
  it('asks for its own grant, opens /device unprefilled, and keeps secrets out of globalState', async () => {
    const hub = secretsHub();
    const mem = memento();
    const w = openWindow(fake, hub, mem, lock.dir, { appName: 'Cursor' });
    expect((await w.accounts.signIn({ kind: 'first' })).outcome).toBe('approved');

    const start = fake.seen.find((s) => s.path === '/api/remote/device/start')!;
    const body = JSON.parse(start.body) as Record<string, string>;
    expect(body.clientName).toBe('hq-vscode');
    expect(body.deviceLabel).toBe('Cursor on jeans-mbp');
    expect(body.devicePubkey).toMatch(/^ssh-ed25519 /);
    expect(start.headers['x-hq-client']).toBe('vscode/0.2.0');
    // The code is typed on the page, never prefilled (T2).
    expect(w.ui.opened).toEqual([`${fake.url}/device`]);
    expect(w.ui.codes).toEqual(['WDJB-MJHT']);

    // A `user` slot holds the pair and the key, each stamped with the grant; the 0.1.x keys are
    // never created (MA-S7); globalState holds no secret at all.
    const pk = w.store.profileKey()!;
    const slot = `hq:${fake.url}:u:${pk}:${USER_A.id}:`;
    const grantId = w.accounts.active()!.account.grantId;
    expect(JSON.parse(hub.data.get(`${slot}tokens`)!)).toMatchObject({ grantId });
    expect(JSON.parse(hub.data.get(`${slot}device`)!).grantId).toBe(grantId);
    expect(JSON.parse(hub.data.get(`${slot}device`)!).openssh).toContain('OPENSSH PRIVATE KEY');
    expect(hub.data.has(`hq:${fake.url}:tokens`)).toBe(false);
    expect(hub.data.has(`hq:${fake.url}:device`)).toBe(false);
    const everything = JSON.stringify([...mem.data.entries(), ...w.state.data.entries()]);
    expect(everything).not.toMatch(/hqa_|hqr_|PRIVATE KEY|dev-code-/);
    expect(w.accounts.active()?.email).toBe(USER_A.email);
    expect(
      w.accounts
        .active()
        ?.service.teams()
        .map((t) => t.alias),
    ).toEqual(['hq-3f9a1c2e']);
    expect(w.ui.infos).toEqual([`Signed in to AI Workforce One HQ as ${USER_A.email}.`]);
  });

  it('every call after sign-in carries X-HQ-Client and asks for its next nonce', async () => {
    const w = openWindow(fake, secretsHub(), memento(), lock.dir);
    await w.accounts.signIn({ kind: 'first' });
    await w.accounts.active()!.service.refreshOrgs();
    const orgs = fake.seen.filter((s) => s.path === '/api/remote/orgs');
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.headers['x-hq-client']).toBe('vscode/0.2.0');
    expect(orgs[0]!.headers['x-hq-want-nonce']).toBe('1');
    expect(orgs[0]!.headers['x-hq-cli-version']).toBeUndefined();
  });

  it('a poll that fails on the network (a dropped kept-alive socket) is tried again, not the end of the sign-in', async () => {
    let polls = 0;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/device/poll') && (polls += 1) <= 2) {
        throw new TypeError('fetch failed');
      }
      return fetch(url, init);
    }) as typeof fetch;
    const w = openWindow(fake, secretsHub(), memento(), lock.dir, { fetch: flaky });
    expect((await w.accounts.signIn({ kind: 'first' })).outcome).toBe('approved');
    expect(polls).toBe(3);
  });

  it('a code that expires right after a network failure says the approval may have gone through (review MUST 5)', async () => {
    let polls = 0;
    const lost = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/device/poll')) {
        polls += 1;
        if (polls === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ error: 'expired' }), { status: 410 });
      }
      return fetch(url, init);
    }) as typeof fetch;
    const w = openWindow(fake, secretsHub(), memento(), lock.dir, { fetch: lost });
    expect((await w.accounts.signIn({ kind: 'first' })).outcome).toBe('expired');
    expect(w.ui.modals).toEqual([COPY.signInExpiredAfterNetwork]);
    // A plain expiry still says only that.
    const plain = openWindow(fake, secretsHub(), memento(), lock.dir, {
      fetch: (async (url: string | URL, init?: RequestInit) =>
        String(url).endsWith('/device/poll')
          ? new Response(JSON.stringify({ error: 'expired' }), { status: 410 })
          : fetch(url, init)) as typeof fetch,
    });
    await plain.accounts.signIn({ kind: 'first' });
    expect(plain.ui.modals).toEqual([COPY.signInExpired]);
  });

  it('a poll that keeps failing on the network ends the sign-in with the reason, never silently', async () => {
    const down = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/device/poll')) throw new TypeError('fetch failed');
      return fetch(url, init);
    }) as typeof fetch;
    const w = openWindow(fake, secretsHub(), memento(), lock.dir, { fetch: down });
    expect((await w.accounts.signIn({ kind: 'first' })).outcome).toBe('failed');
    expect(w.ui.modals).toEqual([COPY.signInFailed(COPY.unreachable)]);
  });

  it('a throttled device start (5 pending per network) says wait a minute, not an error string', async () => {
    fake.startStatus = 429;
    const w = openWindow(fake, secretsHub(), memento(), lock.dir);
    expect((await w.accounts.signIn({ kind: 'first' })).outcome).toBe('throttled');
    expect(w.ui.modals).toEqual([COPY.signInThrottled]);
  });
});

describe('SessionStore fresh reads (review M-b)', () => {
  it('load(host, {fresh:true}) bypasses the 60 s in-memory copy; needsRenewing survives a round trip', async () => {
    const hub = secretsHub();
    const secrets = hub.window({ crossWindow: false });
    const mem = memento();
    const ref = userRef(fake.url, USER_A, PROFILE_A);
    const store = new SessionStore(secrets, mem);
    await mem.update('hq:profileKey', PROFILE_A);
    const g = await seedUserSlot(fake, store, ref, USER_A);
    const ts = store.tokenStore(ref, g.id);
    expect((await ts.load(fake.url))?.refreshToken).toBe(g.refresh);
    // Another window rotates; the event never reaches this one.
    const key = `hq:${fake.url}:u:${PROFILE_A}:${USER_A.id}:tokens`;
    hub.data.set(
      key,
      JSON.stringify({
        ...JSON.parse(hub.data.get(key)!),
        refreshToken: 'hqr_b',
        needsRenewing: true,
      }),
    );
    expect((await ts.load(fake.url))?.refreshToken).toBe(g.refresh);
    const fresh = await ts.load(fake.url, { fresh: true });
    expect(fresh?.refreshToken).toBe('hqr_b');
    expect(fresh?.needsRenewing).toBe(true);
    // A store closed over one slot refuses any other host (security B-1: never a fallback).
    await expect(Promise.resolve(ts.load('https://hq.aiworkforceone.com'))).rejects.toThrow(
      /host mismatch/,
    );
  });
});

describe('refresh across windows (D2, U2)', () => {
  it('two windows refreshing the same account at the same moment send exactly one /token/refresh', async () => {
    fake.refreshDelayMs = 150;
    const hub = secretsHub();
    const mem = memento();
    await mem.update('hq:profileKey', PROFILE_A);
    const a = openWindow(fake, hub, mem, lock.dir);
    await seedUserSlot(fake, a.store, userRef(fake.url, USER_A, PROFILE_A), USER_A, {
      accessTtlMs: 60_000, // inside the 2-minute refresh margin
    });
    a.accounts.rederive('focus');
    const b = openWindow(fake, hub, mem, lock.dir);
    const [ta, tb] = await Promise.all([
      (await a.accounts.list()[0]!.service.client()).accessToken(),
      (await b.accounts.list()[0]!.service.client()).accessToken(),
    ]);
    expect(fake.refreshes()).toBe(1);
    expect(ta).toBe(tb);
  });
});

describe('one device flow across windows (nonprod 2026-09-30: two grants from one sign-in)', () => {
  it('a second window never starts its own flow while one runs; once done, `first` adopts it', async () => {
    let approve!: () => void;
    fake.pollGate = new Promise<void>((r) => (approve = r));
    const hub = secretsHub();
    const mem = memento();
    const a = openWindow(fake, hub, mem, lock.dir);
    const b = openWindow(fake, hub, mem, lock.dir);
    const first = a.accounts.signIn({ kind: 'first' });
    await vi.waitFor(() => expect(a.ui.codes).toHaveLength(1));
    expect((await b.accounts.signIn({ kind: 'first' })).outcome).toBe('busy');
    expect(b.ui.offered).toEqual([COPY.signInOtherWindow]);
    approve();
    expect((await first).outcome).toBe('approved');
    // The other window finished it: this one adopts it, with no second grant.
    expect((await b.accounts.signIn({ kind: 'first' })).outcome).toBe('approved');
    expect(b.accounts.active()?.email).toBe(USER_A.email);
    expect(starts()).toBe(1);
  });
});

/** The sign-in lock file of the test editor ('Code') on the fake host: the 0.1.1 name. */
function signInLockFile(): string {
  const id = createHash('sha256').update(`Code|${fake.url}`).digest('hex').slice(0, 12);
  return path.join(lock.dir, `signin-${id}.lock`);
}

/** A sleep that never ends on its own: the flow only moves on when it is cancelled. */
const forever = () => new Promise<void>(() => undefined);

describe('a stuck sign-in lock (0.1.1: "Signing in from another VS Code window" and nothing else)', () => {
  it('a window whose flow hangs (browser prompt never answered) does not hold the lock past its TTL', async () => {
    const hub = secretsHub();
    const mem = memento();
    const signInLock = { ttlMs: 300, heartbeatMs: 50 };
    const a = openWindow(fake, hub, mem, lock.dir, { sleep: forever, signInLock });
    a.ui.openExternal = () => new Promise(() => undefined);
    void a.accounts.signIn({ kind: 'first' });
    await vi.waitFor(() => expect(a.ui.codes).toHaveLength(1));
    const b = openWindow(fake, hub, mem, lock.dir, { signInLock });
    expect((await b.accounts.signIn({ kind: 'first' })).outcome).toBe('busy');
    await new Promise((r) => setTimeout(r, 400));
    expect((await b.accounts.signIn({ kind: 'first' })).outcome).toBe('approved');
    expect(starts()).toBe(2);
    expect(b.accounts.active()).not.toBeNull();
  });

  it('a lock left by a window that is gone (its process exited) is taken over at once', async () => {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(signInLockFile(), `${gone}:0123456789abcdef`);
    const w = openWindow(fake, secretsHub(), memento(), lock.dir);
    expect((await w.accounts.signIn({ kind: 'first' })).outcome).toBe('approved');
  });

  it('another window really signing in: "Sign in here instead" cancels it and signs in here', async () => {
    const hub = secretsHub();
    const mem = memento();
    const signInLock = { heartbeatMs: 20, takeoverWaitMs: 5_000 };
    const a = openWindow(fake, hub, mem, lock.dir, { sleep: forever, signInLock });
    const first = a.accounts.signIn({ kind: 'add' });
    await vi.waitFor(() => expect(a.ui.codes).toHaveLength(1));
    const b = openWindow(fake, hub, mem, lock.dir, { signInLock });
    b.ui.signInHere = true;
    expect((await b.accounts.signIn({ kind: 'first' })).outcome).toBe('busy');
    expect(b.ui.offered).toEqual([COPY.signInOtherWindow]);
    expect((await first).outcome).toBe('cancelled');
    expect(a.ui.infos).toEqual([COPY.signInMovedToOtherWindow]);
    await vi.waitFor(() => expect(b.accounts.active()).not.toBeNull());
    expect(starts()).toBe(2);
  });

  it('"Sign in here instead" against a window that never answers (0.1.0) takes the lock after a wait', async () => {
    writeFileSync(signInLockFile(), `${process.pid}:fedcba9876543210`);
    const b = openWindow(fake, secretsHub(), memento(), lock.dir, {
      signInLock: { takeoverWaitMs: 200 },
    });
    b.ui.signInHere = true;
    expect((await b.accounts.signIn({ kind: 'first' })).outcome).toBe('busy');
    await vi.waitFor(() => expect(b.accounts.active()).not.toBeNull());
  });

  it('clicking Sign in again in the window that is signing in shows its code again', async () => {
    const w = openWindow(fake, secretsHub(), memento(), lock.dir, { sleep: forever });
    const first = w.accounts.signIn({ kind: 'first' });
    await vi.waitFor(() => expect(w.ui.codes).toHaveLength(1));
    expect((await w.accounts.signIn({ kind: 'add' })).outcome).toBe('busy');
    expect(w.ui.codes).toEqual(['WDJB-MJHT', 'WDJB-MJHT']);
    expect(starts()).toBe(1);
    w.ui.cancelCode?.();
    expect((await first).outcome).toBe('cancelled');
    expect(readdirSync(lock.dir).filter((f) => f.startsWith('signin-'))).toEqual([]);
  });

  it('every device-code notice of a flow closes when it ends: approved, cancelled, failed (live test 2026-10-02)', async () => {
    // Approved.
    const a = openWindow(fake, secretsHub(), memento(), lock.dir);
    await a.accounts.signIn({ kind: 'first' });
    expect(a.ui.codes).toHaveLength(1);
    expect(a.ui.openNotices).toBe(0);
    // Cancelled, after the code was shown again twice.
    const b = openWindow(fake, secretsHub(), memento(), lock.dir, { sleep: forever });
    const first = b.accounts.signIn({ kind: 'add' });
    await vi.waitFor(() => expect(b.ui.codes).toHaveLength(1));
    await b.accounts.signIn({ kind: 'add' });
    await b.accounts.signIn({ kind: 'add' });
    expect(b.ui.openNotices).toBe(3);
    b.ui.cancelCode?.();
    await first;
    expect(b.ui.openNotices).toBe(0);
    // Failed (the code expired).
    const c = openWindow(fake, secretsHub(), memento(), lock.dir);
    const realFetch = globalThis.fetch;
    c.accounts.dispose();
    const expired = openWindow(fake, secretsHub(), memento(), lock.dir, {
      fetch: (async (url: string | URL, init?: RequestInit) =>
        String(url).endsWith('/device/poll')
          ? new Response(JSON.stringify({ error: 'expired' }), { status: 410 })
          : realFetch(url, init)) as typeof fetch,
    });
    expect((await expired.accounts.signIn({ kind: 'first' })).outcome).toBe('expired');
    expect(expired.ui.openNotices).toBe(0);
  });

  it('the lock records the intent kind only (never an email or a user id)', async () => {
    let approve!: () => void;
    fake.pollGate = new Promise<void>((r) => (approve = r));
    const w = openWindow(fake, secretsHub(), memento(), lock.dir);
    const p = w.accounts.signIn({ kind: 'add' });
    await vi.waitFor(() => expect(w.ui.codes).toHaveLength(1));
    const { readFileSync } = await import('node:fs');
    const record = JSON.parse(readFileSync(signInLockFile(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['expiresAt', 'intent', 'owner', 'pid']);
    expect(record.intent).toBe('add');
    approve();
    await p;
  });
});

describe('what HQ answers means for the account', () => {
  async function signedIn() {
    const hub = secretsHub();
    const mem = memento();
    const w = openWindow(fake, hub, mem, lock.dir);
    await w.accounts.signIn({ kind: 'first' });
    return { ...w, hub, mem, b: w.accounts.active()! };
  }

  it('401 confirmed: this account is wiped, its things close, and one modal names it', async () => {
    const { hub, ui, accounts, b } = await signedIn();
    let removed = 0;
    accounts.onAccountRemoved(() => (removed += 1));
    fake.orgsStatus = 401;
    await expect(b.service.refreshOrgs()).rejects.toMatchObject({ status: 401 });
    expect(removed).toBe(1);
    expect(accounts.count()).toBe(0);
    expect(accounts.active()).toBeNull();
    expect([...hub.data.keys()]).toEqual([]);
    expect(ui.asked.map((a) => a.message)).toEqual([COPY.revokedAccount(USER_A.email)]);
  });

  it('B1: a signed call that 401s twice while an unsigned read still works is NOT a revocation', async () => {
    const { hub, ui, accounts, b } = await signedIn();
    fake.probeStatus = 401;
    let removed = 0;
    accounts.onAccountRemoved(() => (removed += 1));
    await expect(
      b.service.call((c) => c.request('POST', '/api/remote/probe', { signed: true })),
    ).rejects.toMatchObject({ status: 401 });
    expect(fake.seen.filter((s) => s.path === '/api/remote/probe')).toHaveLength(2);
    expect(fake.seen.filter((s) => s.path === '/api/remote/orgs').length).toBeGreaterThan(0);
    expect(removed).toBe(0);
    expect(accounts.count()).toBe(1);
    expect([...hub.data.keys()].some((k) => k.endsWith(':device'))).toBe(true);
    expect(ui.asked).toEqual([]);
  });

  it('M-a: an account marked "needs renewing" asks to sign in again AS IT and wipes nothing', async () => {
    const { hub, ui, b } = await signedIn();
    const key = [...hub.data.keys()].find((k) => k.endsWith(':tokens'))!;
    const pair = JSON.parse(hub.data.get(key)!) as Record<string, unknown>;
    hub.data.set(
      key,
      JSON.stringify({
        ...pair,
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        needsRenewing: true,
      }),
    );
    b.service.invalidate();
    await expect(b.service.refreshOrgs()).rejects.toThrow(/needs renewing/);
    expect(fake.refreshes()).toBe(0);
    expect(ui.asked.map((a) => a.message)).toEqual([COPY.renewSignInAccount(USER_A.email)]);
    expect(hub.data.get(key)).toContain('needsRenewing');
  });

  it('426: the update sentence, once however many calls are refused', async () => {
    const { ui, accounts, b } = await signedIn();
    fake.orgsStatus = 426;
    await expect(b.service.refreshOrgs()).rejects.toMatchObject({ status: 426 });
    await expect(b.service.refreshOrgs()).rejects.toMatchObject({ status: 426 });
    expect(ui.modals).toEqual([COPY.tooOld]);
    expect(accounts.count()).toBe(1);
  });

  it('sign-out revokes the grant with a signed DELETE, then wipes', async () => {
    const { hub, ui, accounts, b } = await signedIn();
    await accounts.signOut(b.ref, { confirm: true });
    const grantId = b.account.grantId;
    const del = fake.seen.find((s) => s.method === 'DELETE')!;
    expect(del.path).toBe(`/api/remote/grants/${grantId}`);
    expect(del.signer).toBe(grantId);
    expect(del.bearer).toBe(grantId);
    expect([...hub.data.keys()]).toEqual([]);
    expect(accounts.count()).toBe(0);
    // One account: no confirmation (decision 16).
    expect(ui.confirms).toEqual([]);
    expect(ui.infos.at(-1)).toMatch(/Signed out/);
  });

  it('B1: sign-out never reports success on an UNCONFIRMED 401 (the grant may still be live)', async () => {
    const { ui, accounts, b } = await signedIn();
    fake.deleteStatus = 401;
    await accounts.signOut(b.ref, { confirm: true });
    expect(fake.seen.filter((s) => s.method === 'DELETE')).toHaveLength(2);
    expect(ui.infos.at(-1)).toBe(COPY.signOutOffline);
  });

  it('B1: a sign-out 401 that HQ confirms (the login is already gone) is a normal sign-out', async () => {
    const { ui, accounts, b } = await signedIn();
    fake.deleteStatus = 401;
    fake.orgsStatus = 401;
    await accounts.signOut(b.ref, { confirm: true });
    expect(ui.infos.at(-1)).toMatch(/^Signed out of AI Workforce One HQ/);
  });

  it('a host outside the allow-list is never contacted', async () => {
    const ui = fakeUi();
    const accounts = new HqAccounts({
      store: new SessionStore(secretsHub().window(), memento()),
      ui,
      host: () => ({ ok: false, host: 'https://evil.example' }),
      extensionVersion: '0.2.0',
      appName: 'Code',
      windowState: windowState(),
      lockDir: lock.dir,
      pollMs: 0,
    });
    expect((await accounts.signIn({ kind: 'first' })).outcome).toBe('host-not-allowed');
    expect(fake.seen).toEqual([]);
    expect(ui.modals[0]).toMatch(/not an HQ address/);
  });
});
