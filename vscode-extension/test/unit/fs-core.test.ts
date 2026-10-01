/**
 * The `hq://` logic (FEATURE §7a) against a scripted HQ: when a stat comes from the cache (only
 * while the events stream is live), zero-request reopen, the masked-on-first-open flip, the 412
 * conflict flow, our own write's echo, the team-is-off behaviour (cached stays readable, nothing
 * wakes), read-only rules, unsafe names, and resync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from '@hq/client/teams.js';
import type { EventsServerFrame, FsStat } from '@kpa/shared/remote-fs.types';
import { FsApiError, type FsRead, type HqFsApi } from '../../src/fs/fs-api.js';
import {
  FsCoreError,
  HqFsCore,
  isSafeName,
  type FsChangeOut,
  type FsTeamIssue,
  suffixedName,
} from '../../src/fs/fs-core.js';
import type { EventsHub } from '../../src/fs/events-client.js';
import { COPY } from '../../src/copy.js';

const WS = '3f9a1c2e-1111-4222-8333-444455556666';

function team(write = true): Team {
  return {
    alias: 'hq-3f9a1c2e',
    org: { id: 'o1', slug: 'awo', name: 'AWO', role: 'owner', remoteAccess: { allowed: true } },
    workspace: {
      id: WS,
      alias: 'hq-3f9a1c2e',
      name: 'Backend team',
      state: 'running',
      rights: { ssh: false, forward: write, attach: true, files: { read: true, write } },
      supported: true,
    },
  } as unknown as Team;
}

const stat = (path: string, etag: string, over: Partial<FsStat> = {}): FsStat => ({
  path,
  type: 'file',
  size: 3,
  mtimeMs: 1,
  etag,
  ...over,
});

class FakeApi {
  calls: string[] = [];
  /** Calls sent with the background marker (`X-HQ-Activity: background`): not a person's action. */
  bg: string[] = [];
  files = new Map<string, { bytes: Uint8Array; etag: string; masked?: boolean }>();
  off = false;
  /** Every call fails with this (a typed 409 the machine's state answers with). */
  err: FsApiError | null = null;
  staleOnWrite = false;
  private n = 0;
  private offErr(): FsApiError {
    return new FsApiError(409, 'RUNNER_UNAVAILABLE', 'off', { state: 'stopped' });
  }
  async listAll(_t: Team, path: string, opts?: { background?: boolean }): Promise<FsStat[]> {
    this.calls.push(`list:${path}`);
    if (opts?.background) this.bg.push(`list:${path}`);
    if (this.err) throw this.err;
    if (this.off) throw this.offErr();
    // Direct children: files, plus one folder entry per sub-folder (as the runner lists them).
    const prefix = path === '' ? '' : `${path}/`;
    const out = new Map<string, FsStat>();
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const i = rest.indexOf('/');
      if (i === -1) out.set(p, stat(p, f.etag));
      else
        out.set(
          `${prefix}${rest.slice(0, i)}`,
          stat(`${prefix}${rest.slice(0, i)}`, '"d"', { type: 'dir' }),
        );
    }
    return [...out.values()];
  }
  async stat(_t: Team, path: string, opts?: { background?: boolean }): Promise<FsStat> {
    this.calls.push(`stat:${path}`);
    if (opts?.background) this.bg.push(`stat:${path}`);
    if (this.err) throw this.err;
    if (this.off) throw this.offErr();
    const f = this.files.get(path);
    if (!f) throw new FsApiError(404, 'NOT_FOUND', 'Not found', undefined);
    return stat(path, f.etag);
  }
  async read(_t: Team, path: string, ifNoneMatch?: string): Promise<FsRead> {
    this.calls.push(`read:${path}${ifNoneMatch ? `:${ifNoneMatch}` : ''}`);
    if (this.err) throw this.err;
    if (this.off) throw this.offErr();
    const f = this.files.get(path);
    if (!f) throw new FsApiError(404, 'NOT_FOUND', 'Not found', undefined);
    if (ifNoneMatch === f.etag) return { kind: 'not-modified', etag: f.etag };
    return { kind: 'bytes', bytes: f.bytes, etag: f.etag, masked: f.masked === true };
  }
  async write(
    _t: Team,
    path: string,
    bytes: Uint8Array,
    pre: { ifMatch: string } | { createOnly: true },
  ): Promise<FsStat> {
    this.calls.push(`write:${path}`);
    if (this.err) throw this.err;
    if (this.off) throw this.offErr();
    const f = this.files.get(path);
    if ('ifMatch' in pre && (!f || f.etag !== pre.ifMatch || this.staleOnWrite)) {
      throw new FsApiError(412, 'PRECONDITION_FAILED', 'changed', {
        current: stat(path, f ? `${f.etag}-new` : '"x"'),
      });
    }
    const etag = `"e${(this.n += 1)}"`;
    this.files.set(path, { bytes, etag });
    return stat(path, etag, { size: bytes.byteLength });
  }
  async mkdir(_t: Team, path: string): Promise<FsStat> {
    this.calls.push(`mkdir:${path}`);
    return stat(path, '"d"', { type: 'dir' });
  }
  async remove(_t: Team, path: string): Promise<void> {
    this.calls.push(`delete:${path}`);
    this.files.delete(path);
  }
  async rename(_t: Team, from: string, to: string): Promise<FsStat> {
    this.calls.push(`rename:${from}:${to}`);
    const f = this.files.get(from)!;
    this.files.delete(from);
    this.files.set(to, f);
    return stat(to, f.etag);
  }
}

class FakeEvents {
  live = false;
  listeners: Array<(f: EventsServerFrame) => void> = [];
  subscribed = 0;
  onFrame(l: (f: EventsServerFrame) => void) {
    this.listeners.push(l);
    return { dispose: () => undefined };
  }
  subscribe() {
    this.subscribed += 1;
    return { dispose: () => void (this.subscribed -= 1) };
  }
  isLive() {
    return this.live;
  }
  emit(f: EventsServerFrame) {
    for (const l of this.listeners) l(f);
  }
}

let api: FakeApi;
let events: FakeEvents;
let core: HqFsCore;
let changes: FsChangeOut[];
let off: string[];
let masked: string[];
let issues: Array<FsTeamIssue | null>;
let sleeps: number[];
/** Added to the core's clock (listing TTLs, the negative cache). */
let skew = 0;
let apiErrors: unknown[];
let t: Team;

function make(write = true): void {
  t = team(write);
  api = new FakeApi();
  events = new FakeEvents();
  off = [];
  masked = [];
  issues = [];
  sleeps = [];
  skew = 0;
  apiErrors = [];
  changes = [];
  core = new HqFsCore({
    onApiError: (err) => void apiErrors.push(err),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => Date.now() + skew,
    teams: () => [t],
    api: api as unknown as HqFsApi,
    events: events as unknown as EventsHub,
    ui: {
      teamOff: (_team, action) => void off.push(action),
      masked: (_team, path) => void masked.push(path),
      teamIssue: (_team, issue) => void issues.push(issue),
    },
  });
  core.onDidChange((c) => void changes.push(...c));
}

const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => make());

describe('stat and cache authority (FEATURE C1)', () => {
  it('answers from the cache only while the stream is live; otherwise it asks the server', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    api.calls = [];
    await core.stat(t, 'a.txt');
    expect(api.calls).toEqual(['stat:a.txt']);
    events.live = true;
    api.calls = [];
    await core.stat(t, 'a.txt');
    expect(api.calls).toEqual([]);
  });

  it('read-only: a viewer team, a template path, a file over 16 MiB', async () => {
    make(false);
    api.files.set('a.txt', { bytes: bytes('x'), etag: '"1"' });
    expect((await core.stat(t, 'a.txt')).readonly).toBe(true);
    make(true);
    api.stat = async (_t, p) => stat(p, '"1"', { readonly: 'template' });
    expect((await core.stat(t, '.claude/x.md')).readonly).toBe(true);
    api.stat = async (_t, p) => stat(p, '"1"', { size: 17 * 1024 * 1024 });
    expect((await core.stat(t, 'big.bin')).readonly).toBe(true);
    api.stat = async (_t, p) => stat(p, '"1"');
    expect((await core.stat(t, 'ok.txt')).readonly).toBe(false);
  });

  it('drops names that cannot be shown safely', async () => {
    for (const bad of [
      '',
      '.',
      '..',
      'a/b',
      'a\\b',
      'x\u001b[31m',
      `evil${String.fromCharCode(0x202e)}txt.exe`,
      `z${String.fromCharCode(0x200b)}`,
    ]) {
      expect(isSafeName(bad)).toBe(false);
    }
    expect(isSafeName('app.py')).toBe(true);
    expect(isSafeName('ünïcode ok.md')).toBe(true);
  });
});

describe('reads', () => {
  it('a cached file reopens with zero requests while live; otherwise a conditional 304', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('abc');
    api.calls = [];
    events.live = true;
    await core.readFile(t, 'a.txt');
    expect(api.calls).toEqual([]);
    events.live = false;
    await core.readFile(t, 'a.txt');
    expect(api.calls).toEqual(['read:a.txt:"1"']);
  });

  it('masked on FIRST open: the cached stat turns read-only and `changed` fires for the uri', async () => {
    api.files.set('.env', { bytes: bytes('A=[REDACTED]'), etag: '"m"', masked: true });
    expect((await core.stat(t, '.env')).readonly).toBe(false);
    await core.readFile(t, '.env');
    expect(masked).toEqual(['.env']);
    expect(changes).toContainEqual({ team: t, path: '.env', type: 'changed' });
    events.live = true;
    expect((await core.stat(t, '.env')).readonly).toBe(true);
    await expect(
      core.writeFile(t, '.env', bytes('A=x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ kind: 'no-permissions', message: COPY.fsMasked });
  });

  it('a team that is off: cached listings and contents stay readable; uncached says off; nothing retries', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    await core.readFile(t, 'a.txt');
    api.off = true;
    skew = 31_000; // the listing is older than its TTL: it cannot rule b.txt out
    expect(await core.readDirectory(t, '')).toEqual([['a.txt', 'file']]);
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('abc');
    await expect(core.readFile(t, 'b.txt')).rejects.toMatchObject({
      kind: 'unavailable',
      message: COPY.fsOffOpen('Backend team'),
    });
    // Only the open that FAILED says the team is off; the cached open is quiet (train 42).
    expect(off).toEqual(['open']);
    await expect(
      core.writeFile(t, 'a.txt', bytes('x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ message: COPY.fsOffSave('Backend team') });
  });
});

describe('writes', () => {
  it('save sends If-Match the known etag; create is create-only; the cache follows', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    await core.writeFile(t, 'a.txt', bytes('new'), { create: false, overwrite: true });
    await core.writeFile(t, 'b.txt', bytes('b'), { create: true, overwrite: false });
    expect(api.calls.filter((c) => c.startsWith('write'))).toEqual(['write:a.txt', 'write:b.txt']);
    events.live = true;
    api.calls = [];
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('new');
    expect(api.calls).toEqual([]);
  });

  it('a stale save: the cached stat takes the current one, `changed` fires, and the error says save again', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    api.staleOnWrite = true;
    await expect(
      core.writeFile(t, 'a.txt', bytes('mine'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ kind: 'unavailable', message: COPY.fsChangedOnMachine });
    expect(changes).toContainEqual({ team: t, path: 'a.txt', type: 'changed' });
    events.live = true;
    expect(core.listings.stat(WS, 'a.txt')?.etag).toBe('"1"-new');
  });

  it('exists and not-found follow VS Code create/overwrite; a viewer cannot write', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await expect(
      core.writeFile(t, 'a.txt', bytes('x'), { create: true, overwrite: false }),
    ).rejects.toMatchObject({ kind: 'exists' });
    await expect(
      core.writeFile(t, 'nope.txt', bytes('x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ kind: 'not-found' });
    make(false);
    await expect(
      core.writeFile(t, 'a.txt', bytes('x'), { create: true, overwrite: true }),
    ).rejects.toBeInstanceOf(FsCoreError);
    expect(api.calls).toEqual([]);
  });

  it('delete and rename fire deleted/created and forget the cache', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    await core.rename(t, 'a.txt', 'b.txt', false);
    await core.delete(t, 'b.txt', false);
    expect(changes.map((c) => `${c.type}:${c.path}`)).toEqual([
      'deleted:a.txt',
      'created:b.txt',
      'deleted:b.txt',
    ]);
  });
});

describe('events', () => {
  it('a teammate write fires Changed for the file; its listed folder is re-listed from the server', async () => {
    api.files.set('src/x.ts', { bytes: bytes('1'), etag: '"1"' });
    await core.readDirectory(t, 'src');
    api.files.set('src/x.ts', { bytes: bytes('2'), etag: '"2"' });
    api.calls = [];
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'src/x.ts' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toEqual([{ team: t, path: 'src/x.ts', type: 'changed' }]);
    expect(api.calls).toEqual(['list:src']);
    expect(core.listings.folder(WS, 'src', true)?.map((e) => e.etag)).toEqual(['"2"']);
  });

  it('Explorer: a file created or deleted on the machine fires Created / Deleted for that child (kind-less events)', async () => {
    api.files.set('src/x.ts', { bytes: bytes('1'), etag: '"1"' });
    await core.readDirectory(t, 'src');
    api.files.set('src/new.ts', { bytes: bytes('n'), etag: '"n"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'src/new.ts' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toEqual([{ team: t, path: 'src/new.ts', type: 'created' }]);
    changes = [];
    api.files.delete('src/x.ts');
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 2, changes: [{ path: 'src/x.ts' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toEqual([{ team: t, path: 'src/x.ts', type: 'deleted' }]);
    expect(await core.readDirectory(t, 'src')).toEqual([['new.ts', 'file']]);
  });

  it('a change under a folder VS Code never listed re-lists nothing', async () => {
    api.calls = [];
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'deep/x.ts' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(api.calls).toEqual([]);
    expect(changes).toEqual([{ team: t, path: 'deep/x.ts', type: 'changed' }]);
  });

  it('our own save coming back is dropped (no "changed on disk"); a later foreign write is not', async () => {
    await core.writeFile(t, 'a.txt', bytes('mine'), { create: true, overwrite: false });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'a.txt' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toEqual([]);
    api.files.set('a.txt', { bytes: bytes('theirs'), etag: '"theirs"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 2, changes: [{ path: 'a.txt' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes.map((c) => c.path)).toEqual(['a.txt']);
  });

  it('unsafe paths on the stream are ignored; resync re-reads every cached folder and file', async () => {
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: '../etc' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toEqual([]);
    api.files.set('src/x.ts', { bytes: bytes('1'), etag: '"1"' });
    await core.readDirectory(t, 'src');
    await core.readFile(t, 'src/x.ts');
    api.files.set('src/y.ts', { bytes: bytes('y'), etag: '"y"' });
    api.calls = [];
    events.emit({ type: 'resync', workspaceId: WS });
    await new Promise((r) => setTimeout(r, 5));
    expect(api.calls).toEqual(['list:src']);
    expect(changes).toEqual([
      { team: t, path: 'src/x.ts', type: 'changed' },
      { team: t, path: 'src/y.ts', type: 'created' },
    ]);
  });

  it('watch subscribes the team (refcounted by the hub)', () => {
    const w = core.watch(t);
    expect(events.subscribed).toBe(1);
    w.dispose();
    expect(events.subscribed).toBe(0);
  });
});

describe('the version a save replaces', () => {
  it('after an event forgot the stat, a save matches the bytes the editor loaded, never a fresh stat', async () => {
    api.files.set('a.txt', { bytes: bytes('v1'), etag: '"1"' });
    await core.readDirectory(t, '');
    await core.readFile(t, 'a.txt');
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'a.txt' }] });
    await new Promise((r) => setTimeout(r, 5));
    // Someone else's version lands; the editor still shows v1.
    api.files.set('a.txt', { bytes: bytes('theirs'), etag: '"2"' });
    await expect(
      core.writeFile(t, 'a.txt', bytes('mine'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ message: COPY.fsChangedOnMachine });
    expect(new TextDecoder().decode(api.files.get('a.txt')!.bytes)).toBe('theirs');
  });
});

describe('the 60 s root refresh while the change stream is down (FEATURE §7a)', () => {
  afterEach(() => {
    core.dispose();
    vi.useRealTimers();
  });

  it('re-lists the root ITSELF every 60 s while not live (refused, paused, down) and fires per child', async () => {
    vi.useFakeTimers();
    make();
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    const sub = core.watch(t);
    api.calls = [];
    changes = [];
    api.files.set('b.txt', { bytes: bytes('b'), etag: '"b"' });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(api.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    // No reliance on VS Code re-reading after an event: the request is ours.
    expect(api.calls).toEqual(['list:']);
    expect(changes).toEqual([{ team: t, path: 'b.txt', type: 'created' }]);
    sub.dispose();
  });

  it('never while the stream is live, and stops once the last watch is disposed', async () => {
    vi.useFakeTimers();
    make();
    await core.readDirectory(t, '');
    api.calls = [];
    events.live = true;
    const a = core.watch(t);
    const b = core.watch(t);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(changes).toEqual([]);
    expect(api.calls).toEqual([]);
    events.live = false;
    a.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls).toEqual(['list:']);
    b.dispose();
    api.calls = [];
    await vi.advanceTimersByTimeAsync(180_000);
    expect(api.calls).toEqual([]);
  });
});

describe('a machine that cannot serve files: needs an update, or is updating (nonprod 2026-09-30)', () => {
  const needsUpdate = () =>
    new FsApiError(409, 'REMOTE_UNSUPPORTED_RUNNER', 'needs an update', { missing: ['fs'] });
  const updating = (etaSeconds: number | null) =>
    new FsApiError(409, 'WORKSPACE_UPDATING', 'updating', {
      workspaceId: WS,
      stage: 'creating',
      etaSeconds,
    });

  it('needs an update: the root still mounts (no bare "!"), reads say why, and the UI hears it ONCE', async () => {
    api.err = needsUpdate();
    expect(await core.stat(t, '')).toMatchObject({ type: 'dir' });
    expect(await core.readDirectory(t, '')).toEqual([]);
    await expect(core.readFile(t, 'src/a.ts')).rejects.toMatchObject({
      kind: 'unavailable',
      message: COPY.updateNeededLong('Backend team'),
    });
    await expect(core.stat(t, 'src')).rejects.toMatchObject({
      message: COPY.updateNeededLong('Backend team'),
    });
    await core.readDirectory(t, '');
    expect(issues).toEqual([{ kind: 'needs-update' }]);
    // Never mistaken for "off": no Wake Team offer.
    expect(off).toEqual([]);
  });

  it('updating: the sentence carries the ETA, once per team; a new ETA is not a new notice', async () => {
    api.err = updating(120);
    await expect(core.readFile(t, 'a.txt')).rejects.toMatchObject({
      message: COPY.fsUpdating('Backend team', 120),
    });
    expect(COPY.fsUpdating('Backend team', 120)).toContain('about 2 minutes');
    expect(COPY.fsUpdating('Backend team', null)).toContain('in a few minutes');
    api.err = updating(40);
    expect(await core.readDirectory(t, '')).toEqual([]);
    expect(issues).toEqual([{ kind: 'updating', etaSeconds: 120 }]);
  });

  it('the notice comes back only when the state changes; being off in between changes nothing', async () => {
    api.err = needsUpdate();
    await core.readDirectory(t, '');
    api.err = null;
    api.off = true;
    await core.stat(t, '');
    api.off = false;
    api.err = needsUpdate();
    await core.readDirectory(t, '');
    expect(issues).toEqual([{ kind: 'needs-update' }]);
    api.err = updating(null);
    await core.readDirectory(t, '');
    api.err = null;
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    api.err = needsUpdate();
    // The listing is cached now (a success), so ask the server through a stat.
    await core.stat(t, '');
    expect(issues).toEqual([
      { kind: 'needs-update' },
      { kind: 'updating', etaSeconds: null },
      null,
      { kind: 'needs-update' },
    ]);
  });
});

describe('a cold open under load (nonprod 2026-09-30: 103 x 429 in 2 s, an empty root)', () => {
  const throttled = () =>
    new FsApiError(429, 'THROTTLED', 'Too many requests', { retryAfterSeconds: 1 });

  it('at most 6 requests per team are in flight; the rest wait their turn', async () => {
    let inFlight = 0;
    let peak = 0;
    api.stat = async (_t, p) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return stat(p, '"1"');
    };
    await Promise.all(Array.from({ length: 20 }, (_, i) => core.stat(t, `f${i}.txt`)));
    expect(peak).toBe(6);
  });

  it('a throttled READ waits Retry-After and tries again; a write is never replayed', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    let refusals = 2;
    const realStat = api.stat.bind(api);
    api.stat = async (team, p) => {
      if (refusals-- > 0) throw throttled();
      return realStat(team, p);
    };
    expect(await core.stat(t, 'a.txt')).toMatchObject({ type: 'file' });
    expect(sleeps).toEqual([1000, 1000]);
    api.write = async () => {
      api.calls.push('write');
      throw throttled();
    };
    api.calls = [];
    await expect(
      core.writeFile(t, 'a.txt', bytes('x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(api.calls).toEqual(['write']);
  });

  it('never an empty root on a 429: the last listing stands, or it is an error (never [])', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    api.listAll = async () => {
      throw throttled();
    };
    await expect(core.readDirectory(t, '')).rejects.toMatchObject({ kind: 'unavailable' });
    make();
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    skew = 31_000; // past the listing TTL: the next read asks the server
    api.listAll = async () => {
      throw throttled();
    };
    expect(await core.readDirectory(t, '')).toEqual([['a.txt', 'file']]);
  });

  it("VS Code's probes of paths the listing says are absent cost no request", async () => {
    api.files.set('src/a.ts', { bytes: bytes('a'), etag: '"1"' });
    api.files.set('README.md', { bytes: bytes('r'), etag: '"r"' });
    await core.readDirectory(t, '');
    api.calls = [];
    for (const probe of [
      '.vscode',
      '.vscode/settings.json',
      '.github/workflows',
      '.claude/settings.json',
      'README.md/x',
    ]) {
      await expect(core.stat(t, probe)).rejects.toMatchObject({ kind: 'not-found' });
    }
    await expect(core.readFile(t, '.vscode/tasks.json')).rejects.toMatchObject({
      kind: 'not-found',
    });
    expect(api.calls).toEqual([]);
    // A path the listing cannot rule out still asks.
    await core.stat(t, 'src/a.ts');
    expect(api.calls).toEqual(['stat:src/a.ts']);
  });

  it('a probe that arrives while the parent listing is in flight waits for it instead of asking', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    const listed = core.readDirectory(t, '');
    const probe = core.stat(t, '.vscode/settings.json');
    await listed;
    await expect(probe).rejects.toMatchObject({ kind: 'not-found' });
    expect(api.calls).toEqual(['list:']);
  });

  it('a 404 is remembered briefly; a change on the stream for that path forgets it', async () => {
    api.calls = [];
    await expect(core.stat(t, 'src/missing.ts')).rejects.toMatchObject({ kind: 'not-found' });
    await expect(core.stat(t, 'src/missing.ts')).rejects.toMatchObject({ kind: 'not-found' });
    expect(api.calls).toEqual(['stat:src/missing.ts']);
    api.files.set('src/missing.ts', { bytes: bytes('m'), etag: '"m"' });
    events.emit({
      type: 'fs-changed',
      workspaceId: WS,
      seq: 1,
      changes: [{ path: 'src/missing.ts' }],
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(await core.stat(t, 'src/missing.ts')).toMatchObject({ type: 'file' });
  });
});

describe('U23: a file opened before, reopened while the team is off', () => {
  it('is served from the cache READ-ONLY with the off notice, even with no cached stat', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    await core.readFile(t, 'a.txt');
    core.listings.invalidate(WS, 'a.txt');
    api.off = true;
    expect(await core.stat(t, 'a.txt')).toMatchObject({ type: 'file', readonly: true, size: 3 });
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('abc');
    expect(off).toEqual([]); // opened fine: no "off" notice (train 42 re-test)
  });

  it('a cached stat while off is read-only too (a save could not land)', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    api.off = true;
    expect(await core.stat(t, 'a.txt')).toMatchObject({ readonly: true });
  });
});

describe('U23 (item 9): a change on the machine keeps the last bytes for when the team is off', () => {
  it('a file changed while the editor had it cached still opens (read-only, off notice) once the team is off', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readFile(t, 'a.txt');
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'a.txt' }] });
    await new Promise((r) => setTimeout(r, 5));
    api.off = true;
    expect(await core.stat(t, 'a.txt')).toMatchObject({ readonly: true });
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('abc');
    expect(off).toEqual([]);
  });

  it('while the team is up, the kept bytes are never served as current (a conditional read decides)', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readFile(t, 'a.txt');
    api.files.set('a.txt', { bytes: bytes('new'), etag: '"2"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'a.txt' }] });
    await new Promise((r) => setTimeout(r, 5));
    events.live = true;
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('new');
  });
});

describe('VS-18 (item 13): hostile file names are shown cleaned, never dropped, never run', () => {
  const ESC = String.fromCharCode(0x1b);
  // A zero-width space: hostile (cleaned) but not a control character, so HQ can open it.
  const ZW = String.fromCharCode(0x200b);
  const RLO = String.fromCharCode(0x202e);
  const evil = `evil${ESC}[31m.txt`;
  const bidi = `invoice${RLO}fdp.exe`;
  const nl = 'two\nlines.md';

  it('lists a cleaned name for each; `..`-style entries are still dropped', async () => {
    for (const n of [evil, bidi, nl, 'ok.txt']) api.files.set(n, { bytes: bytes(n), etag: '"1"' });
    const names = (await core.readDirectory(t, '')).map(([n]) => n).sort();
    expect(names).toEqual(
      ['evil\uFFFD[31m.txt', 'invoice\uFFFDfdp.exe', 'ok.txt', 'two\uFFFDlines.md'].sort(),
    );
    for (const n of names) expect(isSafeName(n)).toBe(true);
  });

  it('operations on the cleaned name reach the REAL path', async () => {
    api.files.set(bidi, { bytes: bytes('pdf'), etag: '"1"' });
    await core.readDirectory(t, '');
    api.calls = [];
    const shown = 'invoice\uFFFDfdp.exe';
    expect(await core.stat(t, shown)).toMatchObject({ type: 'file' });
    expect(new TextDecoder().decode(await core.readFile(t, shown))).toBe('pdf');
    expect(api.calls).toEqual([`stat:${bidi}`, `read:${bidi}`]);
  });

  it('a change on the stream for a hostile path reaches VS Code under the cleaned name', async () => {
    api.files.set('ok.txt', { bytes: bytes('o'), etag: '"1"' });
    await core.readDirectory(t, '');
    api.files.set(evil, { bytes: bytes('e'), etag: '"e"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: evil }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toEqual([{ team: t, path: 'evil\uFFFD[31m.txt', type: 'created' }]);
  });

  it('a hostile name that cleans to a plain one is shown with a stable suffix; the plain one keeps its name', async () => {
    api.files.set('a\uFFFDb', { bytes: bytes('1'), etag: '"1"' });
    api.files.set(`a${ZW}b`, { bytes: bytes('2'), etag: '"2"' });
    const names = (await core.readDirectory(t, '')).map(([n]) => n);
    expect(names).toHaveLength(2);
    expect(names).toContain('a\uFFFDb');
    const twin = names.find((n) => n !== 'a\uFFFDb')!;
    expect(twin).toMatch(/^a\uFFFDb ~[0-9a-f]{6}$/);
    expect(new TextDecoder().decode(await core.readFile(t, twin))).toBe('2');
    expect(new TextDecoder().decode(await core.readFile(t, 'a\uFFFDb'))).toBe('1');
  });

  it('a hostile name inside a subfolder is cleaned and reaches its real path', async () => {
    api.files.set(`src/evil${ZW}.txt`, { bytes: bytes('e'), etag: '"e"' });
    expect((await core.readDirectory(t, 'src')).map(([n]) => n)).toEqual(['evil\uFFFD.txt']);
    api.calls = [];
    expect(new TextDecoder().decode(await core.readFile(t, 'src/evil\uFFFD.txt'))).toBe('e');
    expect(api.calls).toEqual([`read:src/evil${ZW}.txt`]);
  });

  it('a hostile FOLDER name is cleaned, and paths below it reach the real folder', async () => {
    api.files.set(`bad${RLO}dir/x.txt`, { bytes: bytes('x'), etag: '"x"' });
    expect(await core.readDirectory(t, '')).toEqual([['bad\uFFFDdir', 'dir']]);
    expect(await core.readDirectory(t, 'bad\uFFFDdir')).toEqual([['x.txt', 'file']]);
    api.calls = [];
    expect(new TextDecoder().decode(await core.readFile(t, 'bad\uFFFDdir/x.txt'))).toBe('x');
    expect(api.calls).toEqual([`read:bad${RLO}dir/x.txt`]);
  });

  it('delete and rename on a cleaned name reach the real path', async () => {
    const zw = `zw${String.fromCharCode(0x200b)}.txt`;
    api.files.set(zw, { bytes: bytes('z'), etag: '"z"' });
    api.files.set(bidi, { bytes: bytes('b'), etag: '"b"' });
    await core.readDirectory(t, '');
    api.calls = [];
    await core.delete(t, 'zw\uFFFD.txt', false);
    await core.rename(t, 'invoice\uFFFDfdp.exe', 'invoice.pdf', false);
    expect(api.calls).toEqual([`delete:${zw}`, `rename:${bidi}:invoice.pdf`]);
  });
});

describe('security review of 509bdcb4', () => {
  const RLO = String.fromCharCode(0x202e);
  const FFFD = String.fromCharCode(0xfffd);
  const hostile = `deploy${RLO}.sh`;
  const plain = `deploy${FFFD}.sh`;

  it('M1: a plain name that wins a collision resolves to ITSELF, never to the hostile twin', async () => {
    api.files.set(hostile, { bytes: bytes('evil'), etag: '"h"' });
    expect((await core.readDirectory(t, '')).map(([n]) => n)).toEqual([plain]);
    api.files.set(plain, { bytes: bytes('good'), etag: '"p"' });
    skew = 31_000; // the listing is stale: the next read re-lists
    const names = (await core.readDirectory(t, '')).map(([n]) => n);
    expect(names).toContain(plain);
    expect(names).toHaveLength(2); // the hostile twin gets its own suffixed name (W2)
    api.calls = [];
    expect(new TextDecoder().decode(await core.readFile(t, plain))).toBe('good');
    await core.stat(t, plain);
    expect(api.calls).toEqual([`read:${plain}`, `stat:${plain}`]);
  });

  it('M1: after the hostile file is deleted, a new file with the cleaned name is created as exactly that name', async () => {
    api.files.set(hostile, { bytes: bytes('evil'), etag: '"h"' });
    await core.readDirectory(t, '');
    await core.delete(t, plain, false); // VS Code deletes what it shows: the hostile file
    expect(api.files.has(hostile)).toBe(false);
    api.calls = [];
    await core.writeFile(t, plain, bytes('new'), { create: true, overwrite: false });
    expect(api.calls.filter((c) => c.startsWith('write:'))).toEqual([`write:${plain}`]);
    expect(api.files.has(plain)).toBe(true);
  });

  it('M1: a hostile file gone from the machine (stream event) leaves no mapping behind', async () => {
    api.files.set(hostile, { bytes: bytes('evil'), etag: '"h"' });
    await core.readDirectory(t, '');
    api.files.delete(hostile);
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: hostile }] });
    await new Promise((r) => setTimeout(r, 5));
    api.calls = [];
    await core.writeFile(t, plain, bytes('new'), { create: true, overwrite: false });
    expect(api.calls.filter((c) => c.startsWith('write:'))).toEqual([`write:${plain}`]);
  });

  it('M1: a hostile file that appears on the stream is reachable under its cleaned name at once', async () => {
    await core.readDirectory(t, '');
    api.files.set(hostile, { bytes: bytes('evil'), etag: '"h"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: hostile }] });
    await new Promise((r) => setTimeout(r, 5));
    api.calls = [];
    await core.stat(t, plain);
    expect(api.calls).toEqual([`stat:${hostile}`]);
  });

  it('L2c: a 401 during a background re-list or an echo check reaches the sign-in service', async () => {
    api.files.set('src/a.ts', { bytes: bytes('a'), etag: '"1"' });
    await core.readDirectory(t, 'src');
    api.err = new FsApiError(401, 'REMOTE_TOKEN_INVALID', 'Unauthorized', undefined);
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'src/a.ts' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(apiErrors).toHaveLength(1);
    expect(apiErrors[0]).toMatchObject({ status: 401 });
    api.err = null;
    await core.writeFile(t, 'b.txt', bytes('b'), { create: true, overwrite: false });
    api.err = new FsApiError(401, 'REMOTE_TOKEN_INVALID', 'Unauthorized', undefined);
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 2, changes: [{ path: 'b.txt' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(apiErrors.length).toBeGreaterThanOrEqual(2);
  });

  it('L3: a read in flight across a sign-out does not repopulate the cache', async () => {
    api.files.set('a.txt', { bytes: bytes('secret'), etag: '"1"' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realRead = api.read.bind(api);
    api.read = async (team, p, inm) => {
      await gate;
      return realRead(team, p, inm);
    };
    const reading = core.readFile(t, 'a.txt');
    core.clear();
    release();
    await expect(reading).rejects.toMatchObject({ kind: 'unavailable' });
    expect(core.contents.keys()).toEqual([]);
  });

  it('L3: a listing in flight across a sign-out is not cached either', async () => {
    api.files.set('a.txt', { bytes: bytes('x'), etag: '"1"' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realList = api.listAll.bind(api);
    api.listAll = async (team, p) => {
      await gate;
      return realList(team, p);
    };
    const listing = core.readDirectory(t, '');
    core.clear();
    release();
    await expect(listing).rejects.toMatchObject({ kind: 'unavailable' });
    expect(core.listings.staleFolder(WS, '')).toBeUndefined();
  });
});

describe('code review of 509bdcb4', () => {
  const ESC = String.fromCharCode(0x1b);
  // A zero-width space: hostile (cleaned) but not a control character, so HQ can open it.
  const ZW = String.fromCharCode(0x200b);
  const RLO = String.fromCharCode(0x202e);
  const FFFD = String.fromCharCode(0xfffd);
  const twinA = `a${ZW}b.txt`;
  const twinB = `a${RLO}b.txt`;

  it('W2: two hostile twins get stable, unique names; flipping the listing order changes nothing', async () => {
    api.files.set(twinA, { bytes: bytes('A'), etag: '"a"' });
    api.files.set(twinB, { bytes: bytes('B'), etag: '"b"' });
    const first = (await core.readDirectory(t, '')).map(([n]) => n).sort();
    expect(first).toHaveLength(2);
    for (const n of first) expect(n).toMatch(new RegExp(`^a${FFFD}b ~[0-9a-f]{6}\\.txt$`));
    // Which shown name is A's? Ask through the file system.
    const read = await Promise.all(
      first.map(async (n) => [n, new TextDecoder().decode(await core.readFile(t, n))] as const),
    );
    const aShown = read.find(([, v]) => v === 'A')![0];
    // Flip the server order and re-list.
    const entries = [...api.files.entries()].reverse();
    api.files.clear();
    for (const [k, v] of entries) api.files.set(k, v);
    skew = 31_000;
    expect((await core.readDirectory(t, '')).map(([n]) => n).sort()).toEqual(first);
    api.calls = [];
    await core.writeFile(t, aShown, bytes('A2'), { create: false, overwrite: true });
    expect(api.calls.filter((c) => c.startsWith('write:'))).toEqual([`write:${twinA}`]);
  });

  it("W2: an event for a hostile twin never fires under the plain winner's path", async () => {
    api.files.set(`a${FFFD}b.txt`, { bytes: bytes('P'), etag: '"p"' });
    await core.readDirectory(t, '');
    api.files.set(twinA, { bytes: bytes('A'), etag: '"a"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: twinA }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.path).not.toBe(`a${FFFD}b.txt`);
    expect(changes[0]!.path).toMatch(new RegExp(`^a${FFFD}b ~[0-9a-f]{6}\\.txt$`));
  });

  it('W3: a cleaned path whose folder was not listed this session (restored tab, after clear) lists it once', async () => {
    api.files.set(`src/evil${ZW}.txt`, { bytes: bytes('e'), etag: '"e"' });
    core.clear();
    api.calls = [];
    expect(new TextDecoder().decode(await core.readFile(t, `src/evil${FFFD}.txt`))).toBe('e');
    expect(api.calls).toEqual(['list:src', `read:src/evil${ZW}.txt`]);
  });

  it('W4: search results open the SAME uri the Explorer shows (the cleaned path)', async () => {
    api.files.set(`src/evil${ESC}.txt`, { bytes: bytes('e'), etag: '"e"' });
    expect(await core.shownPath(t, `src/evil${ESC}.txt`)).toBe(`src/evil${FFFD}.txt`);
    expect(await core.shownPath(t, 'src/plain.ts')).toBe('src/plain.ts');
  });

  it('W5: the extra invisible code points are unsafe in names too', () => {
    for (const cp of [
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2028, 0x2029, 0x00ad, 0x180e, 0x034f,
    ]) {
      expect(isSafeName(`a${String.fromCharCode(cp)}b`)).toBe(false);
    }
  });

  it('S1: a DELETED file keeps no bytes; a changed one does', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    api.files.set('b.txt', { bytes: bytes('def'), etag: '"2"' });
    await core.readFile(t, 'a.txt');
    await core.readFile(t, 'b.txt');
    events.emit({
      type: 'fs-changed',
      workspaceId: WS,
      seq: 1,
      changes: [
        { path: 'a.txt', kind: 'deleted' },
        { path: 'b.txt', kind: 'changed' },
      ],
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(core.contents.last(`${WS}:a.txt`)).toBeUndefined();
    expect(core.contents.last(`${WS}:b.txt`)).toBeDefined();
  });

  it('S2: a deleted file leaves no etag behind (a recreated one is never read conditionally)', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readFile(t, 'a.txt');
    await core.delete(t, 'a.txt', false);
    api.files.set('a.txt', { bytes: bytes('new'), etag: '"1"' }); // same etag string, new file
    api.calls = [];
    expect(new TextDecoder().decode(await core.readFile(t, 'a.txt'))).toBe('new');
    expect(api.calls).toEqual(['read:a.txt']);
  });
});

describe('security re-review Lows (after 20174685)', () => {
  // A zero-width space: hostile (cleaned) but not a control character, so HQ can open it.
  const ZW = String.fromCharCode(0x200b);
  const RLO = String.fromCharCode(0x202e);
  const FFFD = String.fromCharCode(0xfffd);
  const td = (b: Uint8Array) => new TextDecoder().decode(b);

  it('LOW 1b: a suffix that collides with a real name gets a LONGER hash (never hidden), in any listing order', async () => {
    const hostile = `x${ZW}.txt`;
    const collider = suffixedName(`x${FFFD}.txt`, hostile); // a real file named like the 6-hex form
    api.files.set(`x${FFFD}.txt`, { bytes: bytes('plain'), etag: '"p"' });
    api.files.set(collider, { bytes: bytes('collider'), etag: '"c"' });
    api.files.set(hostile, { bytes: bytes('hostile'), etag: '"h"' });
    const names = (await core.readDirectory(t, '')).map(([n]) => n).sort();
    expect(names).toHaveLength(3);
    const long = names.find((n) => /~[0-9a-f]{12}\.txt$/.test(n))!;
    expect(long).toBeTruthy();
    expect(td(await core.readFile(t, long))).toBe('hostile');
    expect(td(await core.readFile(t, collider))).toBe('collider');
    // LOW 1a: flip the order; every name maps to the same file.
    const entries = [...api.files.entries()].reverse();
    api.files.clear();
    for (const [k, v] of entries) api.files.set(k, v);
    skew = 31_000;
    expect((await core.readDirectory(t, '')).map(([n]) => n).sort()).toEqual(names);
    expect(td(await core.readFile(t, long))).toBe('hostile');
  });

  it('LOW 1a: two hostile twins whose suffixes collide resolve the same way whatever the order', async () => {
    const a = `q${ZW}.md`;
    const b = `q${RLO}.md`;
    api.files.set(a, { bytes: bytes('A'), etag: '"a"' });
    api.files.set(b, { bytes: bytes('B'), etag: '"b"' });
    const first = new Map(
      await Promise.all(
        (await core.readDirectory(t, '')).map(
          async ([n]) => [n, td(await core.readFile(t, n))] as const,
        ),
      ),
    );
    const entries = [...api.files.entries()].reverse();
    api.files.clear();
    for (const [k, v] of entries) api.files.set(k, v);
    skew = 31_000;
    for (const [n, v] of first) expect(td(await core.readFile(t, n))).toBe(v);
  });

  it('LOW 1c (scenario B): a later plain file takes the cleaned name; saving the old tab REFUSES, the new file is untouched', async () => {
    const hostile = `deploy${RLO}.sh`;
    const cleaned = `deploy${FFFD}.sh`;
    api.files.set(hostile, { bytes: bytes('evil'), etag: '"h"' });
    await core.readDirectory(t, '');
    expect(td(await core.readFile(t, cleaned))).toBe('evil'); // the tab holds the hostile file
    api.files.set(cleaned, { bytes: bytes('new plain'), etag: '"p"' });
    skew = 31_000;
    await core.readDirectory(t, ''); // the plain file now owns the cleaned name
    await expect(
      core.writeFile(t, cleaned, bytes('edited'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ message: COPY.fsChangedOnMachine });
    expect(td(api.files.get(cleaned)!.bytes)).toBe('new plain');
    expect(td(api.files.get(hostile)!.bytes)).toBe('evil');
  });

  it('LOW 2: a 50-segment hostile path costs at most ONE listing, and then answers not-found', async () => {
    const deep = Array.from({ length: 50 }, () => `d${FFFD}`).join('/');
    core.clear();
    api.calls = [];
    await expect(core.stat(t, deep)).rejects.toMatchObject({ kind: 'not-found' });
    expect(api.calls.filter((c) => c.startsWith('list:')).length).toBeLessThanOrEqual(1);
    const before = api.calls.length;
    await expect(core.stat(t, deep)).rejects.toMatchObject({ kind: 'not-found' });
    expect(api.calls.slice(before)).toEqual([]); // remembered
  });

  it('LOW 3: a search hit in an unlisted folder opens the HOSTILE file, never its plain twin', async () => {
    const hostile = `src/a${RLO}b.txt`;
    api.files.set(`src/a${FFFD}b.txt`, { bytes: bytes('plain twin'), etag: '"p"' });
    api.files.set(hostile, { bytes: bytes('the match'), etag: '"h"' });
    const shown = await core.shownPath(t, hostile);
    expect(shown).not.toBe(`src/a${FFFD}b.txt`);
    expect(td(await core.readFile(t, shown))).toBe('the match');
  });
});

describe("presence: background traffic carries the marker, a person's action never does", () => {
  afterEach(() => {
    core.dispose();
    vi.useRealTimers();
  });

  it('expanding a folder, a stat and opening a file are user actions (no marker)', async () => {
    api.files.set('a.txt', { bytes: bytes('abc'), etag: '"1"' });
    await core.readDirectory(t, '');
    await core.stat(t, 'a.txt');
    await core.readFile(t, 'a.txt');
    await core.writeFile(t, 'a.txt', bytes('x'), { create: false, overwrite: true });
    expect(api.bg).toEqual([]);
  });

  it('the re-list after a stream change and the own-echo check are background', async () => {
    api.files.set('src/x.ts', { bytes: bytes('1'), etag: '"1"' });
    await core.readDirectory(t, 'src');
    await core.writeFile(t, 'src/x.ts', bytes('mine'), { create: false, overwrite: true });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 1, changes: [{ path: 'src/x.ts' }] });
    api.files.set('src/y.ts', { bytes: bytes('y'), etag: '"y"' });
    events.emit({ type: 'fs-changed', workspaceId: WS, seq: 2, changes: [{ path: 'src/y.ts' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(api.bg).toContain('stat:src/x.ts');
    expect(api.bg).toContain('list:src');
  });

  it('the 60 s root refresh and a resync are background', async () => {
    vi.useFakeTimers();
    make();
    await core.readDirectory(t, '');
    const sub = core.watch(t);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.bg).toEqual(['list:']);
    api.bg = [];
    await core.resync(t);
    expect(api.bg).toEqual(['list:']);
    sub.dispose();
  });
});

describe('train 42 re-test: names with control characters', () => {
  const ESC = String.fromCharCode(0x1b);
  const RLO = String.fromCharCode(0x202e);
  const ctrl = `evil${ESC}[31m.txt`;
  const shownCtrl = 'evil\uFFFD[31m.txt';

  it('are listed, marked not openable, and every open, save or rename says why WITHOUT a request', async () => {
    api.files.set(ctrl, { bytes: bytes('x'), etag: '"x"' });
    api.files.set(`nl\nname.md`, { bytes: bytes('y'), etag: '"y"' });
    api.files.set(`bidi${RLO}.txt`, { bytes: bytes('b'), etag: '"b"' });
    const names = (await core.readDirectory(t, '')).map(([n]) => n).sort();
    expect(names).toContain(shownCtrl);
    expect(core.isUnopenable(t, shownCtrl)).toBe(true);
    expect(core.isUnopenable(t, 'nl\uFFFDname.md')).toBe(true);
    expect(core.isUnopenable(t, 'bidi\uFFFD.txt')).toBe(false);
    expect(core.isUnopenable(t, 'plain.txt')).toBe(false);
    api.calls = [];
    const refused = { kind: 'no-permissions', message: COPY.fsControlName };
    await expect(core.readFile(t, shownCtrl)).rejects.toMatchObject(refused);
    await expect(
      core.writeFile(t, shownCtrl, bytes('z'), { create: false, overwrite: true }),
    ).rejects.toMatchObject(refused);
    await expect(core.rename(t, shownCtrl, 'ok.txt', false)).rejects.toMatchObject(refused);
    await expect(core.delete(t, shownCtrl, false)).rejects.toMatchObject(refused);
    // stat answers from the listing (the Explorer can show it), read-only.
    expect(await core.stat(t, shownCtrl)).toMatchObject({ type: 'file', readonly: true });
    expect(api.calls).toEqual([]);
    // Bidi and zero-width names stay openable.
    expect(new TextDecoder().decode(await core.readFile(t, 'bidi\uFFFD.txt'))).toBe('b');
  });

  it('the rename message says what to do, in plain words', () => {
    expect(COPY.fsControlName).toBe(
      "This file's name has control characters HQ can't open. Rename it on the machine.",
    );
  });
});
