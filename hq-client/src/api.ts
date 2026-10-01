/**
 * The HQ API as an HQ client sees it (the `hq` CLI and the VS Code extension, hq-vscode decision 4):
 * bearer auth, the server nonce, device signatures, transparent token refresh, and the house error
 * envelope mapped to plain sentences.
 *
 *  - Every request carries `Authorization: Bearer hqa_…` and the client's own headers
 *    (`X-HQ-Client: <kind>/<version>`, and for the CLI also `X-HQ-CLI-Version`).
 *  - Every STATE-CHANGING request (and every WebSocket upgrade) is signed with the device key over
 *    `nonce\nMETHOD\n/path\nsha256(body)`; the nonce is single-use, taken from the last response's
 *    `X-HQ-Nonce` or fetched with `GET /api/remote/nonce`.
 *  - The access token lives 15 minutes. `ensureFresh` rotates it (device-signed) when less than two
 *    minutes remain. A reused refresh token is fatal on the server side (the grant is revoked), and
 *    several processes (an editor's `hq ssh-proxy` fan-out, two VS Code windows) refresh at once, so
 *    rotation is serialized ACROSS PROCESSES by a lock file (review C3): the process that waited
 *    re-reads the store and adopts the pair the winner stored instead of presenting the used
 *    refresh token. The holder heartbeats the lock and a live holder is never broken (review W5).
 *
 * Where tokens live is the CLIENT's business (`TokenStore`): the CLI's OS keychain, the extension's
 * SecretStorage. The store may be async.
 *
 * ⛔ No token, nonce, code or signature is ever printed. Errors print the server's `error` sentence.
 */
import { createHash, type KeyObject } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  HQ_HEADER_DEVICE_SIG,
  HQ_HEADER_NONCE,
  HQ_HEADER_ORG,
  type TokenPair,
} from '@kpa/shared/remote.types';
import { signRequest } from './device-key.js';
import { acquireFileLock, FileLockBusyError } from './file-lock.js';

export interface StoredTokens {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  /**
   * FEATURE §7c step 2b/4 (review M-a): this refresh token's fate is unknown (a presentation went
   * unanswered, or HQ said it was already used) and it must NEVER be presented again: one more
   * presentation after the grace window is reuse, which revokes the whole grant. The person signs
   * in again instead. Persisted beside the pair so the next process obeys it too.
   */
  needsRenewing?: true;
}

export class HqApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'HqApiError';
  }
}

export class NotLoggedInError extends Error {
  constructor(message = 'hq: you are not logged in on this computer. Run hq login.') {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

/**
 * Another process on this computer is renewing the login and did not finish inside the wait. The
 * used refresh token is NEVER presented beside a live holder (review W5); the caller tries again.
 */
export class RefreshBusyError extends Error {
  constructor() {
    super('Another window or process on this computer is renewing this login. Try again.');
    this.name = 'RefreshBusyError';
  }
}

/**
 * The login needs renewing (FEATURE §7c step 2b/4): the stored refresh token may already have been
 * used, so it is never presented again. Sign in again.
 */
export class RefreshNeedsRenewingError extends Error {
  constructor(message = 'hq: your HQ login on this computer needs renewing. Run hq login.') {
    super(message);
    this.name = 'RefreshNeedsRenewingError';
  }
}

/** The refresh POST was sent but no answer came back (timeout, dropped connection). Internal. */
class RefreshUnansweredError extends Error {
  constructor(cause: unknown) {
    super('the refresh request went unanswered', { cause });
    this.name = 'RefreshUnansweredError';
  }
}

export type FetchLike = typeof globalThis.fetch;

/**
 * Where a client keeps its token pair, per HQ host. May be async (SecretStorage is): a promise
 * `save` returns is awaited before the pair is used.
 */
export interface TokenStore {
  /**
   * `fresh`: bypass any in-memory copy and read the backing store now (review M-b: the re-read
   * after taking the refresh lock must see what another window stored a moment ago).
   */
  load(
    host: string,
    opts?: { fresh?: boolean },
  ): StoredTokens | null | Promise<StoredTokens | null>;
  save(host: string, tokens: StoredTokens): unknown;
}

export interface HqClientOptions {
  host: string;
  key: KeyObject;
  store: TokenStore;
  /** Where the cross-process refresh lock lives (the CLI: `~/.hq`; the extension: `~/.hq/vscode`). */
  lockDir: string;
  /** The lock file's name. Default `refresh-<sha12(host)>.lock` (one login per host). */
  lockName?: string;
  /** Sent on EVERY request, nonce fetch and upgrade (`X-HQ-Client`, and the CLI's version header). */
  clientHeaders?: Record<string, string>;
  fetch?: FetchLike;
  now?: () => number;
  /** A refresh call that has not answered after this long is abandoned. Default: none. */
  refreshTimeoutMs?: number;
  /**
   * After a `409 REFRESH_RACE`, how many times the store is re-read for the racer's new pair, and
   * how long apart. Default once, at once (the CLI's rule).
   */
  raceRereads?: number;
  raceRereadMs?: number;
  /** Test seams for the lock timings. */
  lockStaleMs?: number;
  lockWaitMs?: number;
}

/** Refresh when fewer than this many ms remain on the access token. */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;
/** A refresh lock whose heartbeat is older than this belongs to a process that died holding it. */
export const REFRESH_LOCK_STALE_MS = 30_000;
/** The longest a process waits for another one's refresh before giving up (never breaking it). */
export const REFRESH_LOCK_WAIT_MS = 20_000;
/** The holder refreshes the lock's mtime this often while it works. */
export const REFRESH_LOCK_HEARTBEAT_MS = 5_000;
/**
 * A cached nonce (the last response's `X-HQ-Nonce`) older than this is dropped and a fresh one
 * fetched (security review B1). The server keeps a nonce 60 s (`REMOTE_NONCE_TTL_SEC`); an editor
 * that sat idle would otherwise sign with a dead one and read the 401 as a revocation.
 */
export const NONCE_MAX_AGE_MS = 45_000;
/**
 * FEATURE §7c step 2b: an unanswered refresh is re-presented once, and only this soon after the
 * first presentation (the server's `REFRESH_REUSE_GRACE_MS` is 30 s; later is reuse).
 */
export const REFRESH_REPRESENT_WINDOW_MS = 30_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HqClient {
  readonly host: string;
  private readonly key: KeyObject;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly store: TokenStore;
  private readonly clientHeaders: Record<string, string>;
  private nonce: { value: string; at: number } | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private readonly lockDir: string;
  private readonly lockName: string | undefined;
  private readonly opts: HqClientOptions;

  constructor(opts: HqClientOptions) {
    this.opts = opts;
    this.host = opts.host.replace(/\/+$/, '');
    this.key = opts.key;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    this.clientHeaders = { ...(opts.clientHeaders ?? {}) };
    this.lockDir = opts.lockDir;
    this.lockName = opts.lockName;
  }

  /** The lock file's name for THIS host (one login per host, so one lock per host). */
  refreshLockName(): string {
    return (
      this.lockName ??
      `refresh-${createHash('sha256').update(this.host).digest('hex').slice(0, 12)}.lock`
    );
  }

  /** The headers this client sends on every call (a copy). */
  headers(): Record<string, string> {
    return { ...this.clientHeaders };
  }

  private isFresh(t: StoredTokens): boolean {
    return Date.parse(t.accessExpiresAt) - this.now() > REFRESH_MARGIN_MS;
  }

  private async tokens(fresh = false): Promise<StoredTokens> {
    const t = await (fresh
      ? this.store.load(this.host, { fresh: true })
      : this.store.load(this.host));
    if (!t) throw new NotLoggedInError();
    return t;
  }

  /** A live access token, rotated first when it is about to expire. */
  async accessToken(): Promise<string> {
    return (await this.ensureFresh()).accessToken;
  }

  async ensureFresh(): Promise<StoredTokens> {
    const t = await this.tokens();
    if (this.isFresh(t)) return t;
    if (t.needsRenewing) throw new RefreshNeedsRenewingError();
    // In-process: one refresh at a time. Across processes: the lock file (below).
    this.refreshing ??= this.refreshAcrossProcesses().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Rotate under the cross-process lock. After taking it, re-read the store FRESH (review M-b): when
   * another process rotated while we waited, its pair is fresh and we adopt it without touching the
   * server. If the server still answers `REFRESH_RACE` (a process that raced us WITHOUT the lock,
   * e.g. an older client), the pair it stored is adopted the same way, and otherwise the token is
   * marked `needsRenewing` and never presented again (§7c step 4). A refresh that went UNANSWERED
   * is re-presented once, still under the lock, within `REFRESH_REPRESENT_WINDOW_MS` of the first
   * presentation (§7c step 2b, review M-a); past that it is marked too. A waiter whose deadline
   * passed while the holder was alive re-reads the store once and otherwise gives up: it never
   * presents the token.
   */
  private async refreshAcrossProcesses(): Promise<StoredTokens> {
    mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    let release: () => void;
    try {
      release = await acquireFileLock(path.join(this.lockDir, this.refreshLockName()), {
        staleMs: this.opts.lockStaleMs ?? REFRESH_LOCK_STALE_MS,
        waitMs: this.opts.lockWaitMs ?? REFRESH_LOCK_WAIT_MS,
        heartbeatMs: REFRESH_LOCK_HEARTBEAT_MS,
      });
    } catch (err) {
      if (!(err instanceof FileLockBusyError)) throw err;
      const after = await this.tokens(true);
      if (this.isFresh(after)) return after;
      throw new RefreshBusyError();
    }
    try {
      const current = await this.tokens(true);
      if (this.isFresh(current)) return current;
      if (current.needsRenewing) throw new RefreshNeedsRenewingError();
      const firstAt = this.now();
      try {
        return await this.refresh(current);
      } catch (err) {
        if (err instanceof RefreshUnansweredError)
          return await this.representOnce(current, firstAt);
        return await this.afterRace(current, err);
      }
    } finally {
      release();
    }
  }

  /** §7c step 2b: the first presentation went unanswered. Still under the lock. */
  private async representOnce(current: StoredTokens, firstAt: number): Promise<StoredTokens> {
    // Only a guard: nobody else can store a pair while we hold the lock.
    const again = await this.tokens(true);
    if (again.refreshToken !== current.refreshToken) return again;
    if (this.now() - firstAt > REFRESH_REPRESENT_WINDOW_MS) {
      await this.markNeedsRenewing(current);
      throw new RefreshNeedsRenewingError();
    }
    try {
      return await this.refresh(current);
    } catch (err) {
      if (err instanceof RefreshUnansweredError) {
        await this.markNeedsRenewing(current);
        throw new RefreshNeedsRenewingError();
      }
      return await this.afterRace(current, err);
    }
  }

  /**
   * §7c step 4: after `409 REFRESH_RACE`, re-read the store (fresh) for the racer's pair; if none
   * appears the token is marked and never presented again. Any other error is rethrown as it is.
   */
  private async afterRace(current: StoredTokens, err: unknown): Promise<StoredTokens> {
    if (err instanceof HqApiError && err.code === 'REFRESH_RACE') {
      const rereads = Math.max(1, this.opts.raceRereads ?? 1);
      for (let i = 0; i < rereads; i++) {
        if (i > 0) await realSleep(this.opts.raceRereadMs ?? 500);
        const after = await this.tokens(true);
        if (after.refreshToken !== current.refreshToken) return after;
      }
      await this.markNeedsRenewing(current);
    }
    throw err;
  }

  private async markNeedsRenewing(current: StoredTokens): Promise<void> {
    await this.store.save(this.host, { ...current, needsRenewing: true });
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ms = this.opts.refreshTimeoutMs;
    if (ms === undefined) return this.fetchFn(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Rotate the pair. Device-signed; the nonce is fetched with the REFRESH token as the bearer. */
  private async refresh(t: StoredTokens): Promise<StoredTokens> {
    const nonceRes = await this.fetchWithTimeout(`${this.host}/api/remote/nonce`, {
      headers: { Authorization: `Bearer ${t.refreshToken}`, ...this.clientHeaders },
    });
    if (!nonceRes.ok) throw await this.toError(nonceRes);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const path = '/api/remote/token/refresh';
    const body = JSON.stringify({ refreshToken: t.refreshToken });
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.host}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.clientHeaders,
          [HQ_HEADER_NONCE]: nonce,
          [HQ_HEADER_DEVICE_SIG]: signRequest(this.key, nonce, 'POST', path, body),
        },
        body,
      });
    } catch (err) {
      // Sent (or maybe sent), never answered: the server may already have rotated (§7c step 2b).
      throw new RefreshUnansweredError(err);
    }
    if (!res.ok) throw await this.toError(res);
    const pair = (await res.json()) as TokenPair;
    const next: StoredTokens = {
      accessToken: pair.accessToken,
      accessExpiresAt: pair.accessExpiresAt,
      refreshToken: pair.refreshToken,
    };
    await this.store.save(this.host, next);
    return next;
  }

  /**
   * A single-use nonce: the last response's while it is younger than `NONCE_MAX_AGE_MS`, or a new
   * one (security review B1).
   */
  async takeNonce(): Promise<string> {
    const cached = this.nonce;
    this.nonce = null;
    if (cached && this.now() - cached.at < NONCE_MAX_AGE_MS) return cached.value;
    return this.fetchNonce();
  }

  /** `GET /api/remote/nonce`, never the cache. */
  private async fetchNonce(): Promise<string> {
    const res = await this.fetchFn(`${this.host}/api/remote/nonce`, {
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...this.clientHeaders,
      },
    });
    if (!res.ok) throw await this.toError(res);
    return ((await res.json()) as { nonce: string }).nonce;
  }

  /** Headers for a signed WebSocket upgrade (`GET <path>`, empty body). */
  async upgradeHeaders(
    path: string,
    org: string,
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const token = await this.accessToken();
    const nonce = await this.takeNonce();
    return {
      Authorization: `Bearer ${token}`,
      [HQ_HEADER_ORG]: org,
      [HQ_HEADER_NONCE]: nonce,
      [HQ_HEADER_DEVICE_SIG]: signRequest(this.key, nonce, 'GET', path, ''),
      ...this.clientHeaders,
      ...extra,
    };
  }

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: unknown; org?: string; signed?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const res = await this.send(method, path, {
      ...(opts.body !== undefined ? { json: opts.body } : {}),
      ...(opts.org ? { org: opts.org } : {}),
      ...(opts.signed ? { signed: true } : {}),
    });
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return { status: 204, body: undefined as T };
    return { status: res.status, body: (await res.json()) as T };
  }

  /**
   * The raw exchange under `request` (hq-vscode phase 2: the file routes need the bytes, the status
   * and the headers). `json` is sent as JSON, `raw` as `application/octet-stream`; a signed call
   * signs the exact bytes sent and the path WITH its query (S5). Returns the Response whatever its
   * status (the caller reads 304/412/...); only the one fresh-nonce retry of a signed 401 happens
   * here (security review B1).
   */
  async send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: {
      json?: unknown;
      raw?: Uint8Array;
      org?: string;
      signed?: boolean;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const token = await this.accessToken();
    const body: string | Buffer =
      opts.raw !== undefined
        ? Buffer.from(opts.raw)
        : opts.json === undefined
          ? ''
          : JSON.stringify(opts.json);
    const hasBody = opts.raw !== undefined || opts.json !== undefined;
    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...this.clientHeaders,
    };
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    if (opts.raw !== undefined) headers['content-type'] = 'application/octet-stream';
    if (opts.org) headers[HQ_HEADER_ORG] = opts.org;
    const once = async (freshNonce: boolean): Promise<Response> => {
      if (opts.signed) {
        const nonce = freshNonce ? await this.fetchNonce() : await this.takeNonce();
        headers[HQ_HEADER_NONCE] = nonce;
        headers[HQ_HEADER_DEVICE_SIG] = signRequest(this.key, nonce, method, path, body);
      }
      const r = await this.fetchFn(`${this.host}${path}`, {
        method,
        headers,
        ...(hasBody ? { body: typeof body === 'string' ? body : new Uint8Array(body) } : {}),
      });
      const next = r.headers.get(HQ_HEADER_NONCE);
      if (next) this.nonce = { value: next, at: this.now() };
      return r;
    };
    let res = await once(false);
    // Security review B1: a signed call's 401 may be a nonce that died in flight (or on a clock the
    // client cannot see), not a dead login. Retry ONCE with a nonce fetched now; only a second 401
    // is reported. An unsigned 401 is never retried.
    if (res.status === 401 && opts.signed) {
      await res.arrayBuffer().catch(() => undefined);
      res = await once(true);
    }
    return res;
  }

  /**
   * Is this login really gone (security review B1)? Only an UNSIGNED `GET /api/remote/orgs` that
   * answers 401 (or a refresh HQ refuses with 401, or no stored login) says so: a signed call's 401
   * can be a nonce or a signature problem. Unreachable or any other answer: not confirmed.
   */
  async confirmRevoked(): Promise<boolean> {
    try {
      await this.request('GET', '/api/remote/orgs');
      return false;
    } catch (err) {
      return err instanceof NotLoggedInError || (err instanceof HqApiError && err.status === 401);
    }
  }

  async toError(res: Response): Promise<HqApiError> {
    let body: { error?: unknown; code?: unknown; details?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* not JSON */
    }
    const message = typeof body.error === 'string' ? body.error : `HQ answered ${res.status}`;
    return new HqApiError(
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
      message,
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : undefined,
    );
  }
}

/** Unauthenticated JSON POST (device start / poll), with the client's own headers. */
export async function postJson<T>(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
  clientHeaders: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...clientHeaders },
    body: JSON.stringify(body),
  });
  let parsed: unknown = undefined;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed as T };
}
