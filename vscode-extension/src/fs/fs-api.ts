/**
 * The workspace file routes as the extension calls them (FEATURE API F1-F8), over the shared
 * `HqClient.send`: bearer + `X-HQ-Client` on every call, and every write and search device-signed
 * over the path WITH its query and the exact body (S5). No `vscode` import: the unit tier and the
 * real-server test drive it directly.
 *
 * Paths are team-relative and '/'-separated; they travel percent-encoded in `?path=` (the signature
 * covers the exact string sent).
 */
import type { HqClient } from '@hq/client/api.js';
import type { Team } from '@hq/client/teams.js';
import {
  HQ_ACTIVITY_BACKGROUND,
  HQ_HEADER_ACTIVITY,
  HQ_HEADER_MASKED,
  type FsDirPage,
  type FsSearchTextRequest,
  type FsSearchTextResponse,
  type FsStat,
} from '@kpa/shared/remote-fs.types';
import { teamPath } from '../hq/wake.js';

export class FsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'FsApiError';
  }
}

/**
 * A call the extension makes ON ITS OWN (a periodic or stream-driven relist, its own-echo check, a
 * resync): sent with `X-HQ-Activity: background` so HQ does not count it as a person working, and an
 * idle window never keeps the team's machine awake. An older server ignores the header.
 */
export interface FsCallOpts {
  background?: boolean;
}

function activityHeaders(opts: FsCallOpts | undefined): Record<string, string> | undefined {
  return opts?.background === true ? { [HQ_HEADER_ACTIVITY]: HQ_ACTIVITY_BACKGROUND } : undefined;
}

export type FsRead =
  | { kind: 'bytes'; bytes: Uint8Array; etag: string; masked: boolean }
  | { kind: 'not-modified'; etag: string };

async function toError(res: Response): Promise<FsApiError> {
  let body: { error?: unknown; message?: unknown; code?: unknown; details?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not JSON */
  }
  const message =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : `HQ answered ${res.status}`;
  return new FsApiError(
    res.status,
    typeof body.code === 'string' ? body.code : undefined,
    message,
    typeof body.details === 'object' && body.details !== null
      ? (body.details as Record<string, unknown>)
      : undefined,
  );
}

export class HqFsApi {
  constructor(private readonly client: () => Promise<HqClient>) {}

  private base(team: Team): string {
    return `${teamPath(team)}/fs`;
  }

  private q(path: string): string {
    return encodeURIComponent(path);
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  async tree(team: Team, path: string, cursor?: string, opts?: FsCallOpts): Promise<FsDirPage> {
    const c = await this.client();
    const headers = activityHeaders(opts);
    const res = await c.send(
      'GET',
      `${this.base(team)}/tree?path=${this.q(path)}${cursor ? `&cursor=${this.q(cursor)}` : ''}`,
      { org: team.org.slug, ...(headers ? { headers } : {}) },
    );
    return this.json<FsDirPage>(res);
  }

  /** Every page of one folder (one request per 1,000 entries). */
  async listAll(team: Team, path: string, opts?: FsCallOpts): Promise<FsStat[]> {
    const out: FsStat[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 1000; pages++) {
      const page = await this.tree(team, path, cursor, opts);
      out.push(...page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  async stat(team: Team, path: string, opts?: FsCallOpts): Promise<FsStat> {
    const c = await this.client();
    const headers = activityHeaders(opts);
    return this.json<FsStat>(
      await c.send('GET', `${this.base(team)}/stat?path=${this.q(path)}`, {
        org: team.org.slug,
        ...(headers ? { headers } : {}),
      }),
    );
  }

  async read(team: Team, path: string, ifNoneMatch?: string): Promise<FsRead> {
    const c = await this.client();
    const res = await c.send('GET', `${this.base(team)}/file?path=${this.q(path)}`, {
      org: team.org.slug,
      ...(ifNoneMatch ? { headers: { 'if-none-match': ifNoneMatch } } : {}),
    });
    if (res.status === 304) return { kind: 'not-modified', etag: res.headers.get('etag') ?? '' };
    if (!res.ok) throw await toError(res);
    return {
      kind: 'bytes',
      bytes: new Uint8Array(await res.arrayBuffer()),
      etag: res.headers.get('etag') ?? '',
      masked: res.headers.get(HQ_HEADER_MASKED) === '1',
    };
  }

  async write(
    team: Team,
    path: string,
    bytes: Uint8Array,
    pre: { ifMatch: string } | { createOnly: true },
  ): Promise<FsStat> {
    const c = await this.client();
    const res = await c.send('PUT', `${this.base(team)}/file?path=${this.q(path)}`, {
      org: team.org.slug,
      raw: bytes,
      signed: true,
      headers: 'ifMatch' in pre ? { 'if-match': pre.ifMatch } : { 'if-none-match': '*' },
    });
    return this.json<FsStat>(res);
  }

  async mkdir(team: Team, path: string): Promise<FsStat> {
    const c = await this.client();
    return this.json<FsStat>(
      await c.send('POST', `${this.base(team)}/dir`, {
        org: team.org.slug,
        json: { path },
        signed: true,
      }),
    );
  }

  async remove(team: Team, path: string, recursive: boolean): Promise<void> {
    const c = await this.client();
    const res = await c.send(
      'DELETE',
      `${this.base(team)}/entry?path=${this.q(path)}${recursive ? '&recursive=1' : ''}`,
      { org: team.org.slug, signed: true },
    );
    if (!res.ok) throw await toError(res);
  }

  async rename(team: Team, from: string, to: string, overwrite: boolean): Promise<FsStat> {
    const c = await this.client();
    return this.json<FsStat>(
      await c.send('POST', `${this.base(team)}/rename`, {
        org: team.org.slug,
        json: { from, to, overwrite },
        signed: true,
      }),
    );
  }

  async search(team: Team, req: FsSearchTextRequest): Promise<FsSearchTextResponse> {
    const c = await this.client();
    return this.json<FsSearchTextResponse>(
      await c.send('POST', `${this.base(team)}/search/text`, {
        org: team.org.slug,
        json: req,
        signed: true,
      }),
    );
  }
}
