/**
 * The connect handshake every door shares (FEATURE.md §9, §13): `POST …/connections` (device
 * signed), the wake poll, and the `409`/`403` answers mapped to the plain sentences in §13.
 *
 * Messages go through `say` (stderr for the CLI). Nothing here prints a code, a token or a host key.
 */
import type {
  ConnectionReady,
  ConnectionRequest,
  ConnectionWaking,
} from '@kpa/shared/remote.types';
import { HqApiError, type HqClient } from './api.js';
import type { Team } from './teams.js';

export class ConnectRefusedError extends Error {
  /**
   * @param apiError the HQ answer behind the sentence, when there was one (the extension maps its
   *   `code`/`status` to its own copy; the CLI prints `message`).
   */
  constructor(
    message: string,
    readonly apiError?: HqApiError,
  ) {
    super(message);
    this.name = 'ConnectRefusedError';
  }
}

/** How long a wake may take before we give up (review S1): just under 3 minutes. */
export const WAKE_TIMEOUT_MS = 170_000;
export const WAKE_POLL_MS = 2_000;

/** What every door says when a wake runs past `WAKE_TIMEOUT_MS` (`hq up`, `hq attach`, `hq forward`). */
export function wakeTimeoutMessage(team: Team): string {
  return `hq: team "${team.workspace.name}" did not wake within 3 minutes. Check it in HQ and try again.`;
}

export function connectionsPath(team: Team, id?: string): string {
  const base = `/api/remote/orgs/${encodeURIComponent(team.org.slug)}/workspaces/${team.workspace.id}/connections`;
  return id ? `${base}/${id}` : base;
}

/** The §13 sentence for a refusal. Never names an editor; never echoes a server detail verbatim. */
export function refusalMessage(team: Team, err: unknown): string {
  const name = team.workspace.name;
  if (err instanceof HqApiError) {
    if (err.code === 'RUNNER_UNAVAILABLE' && err.details?.hint === 'reconnect') {
      return `hq: team "${name}" is asleep and this looks like an editor reconnect, so it was not woken. Run \`hq up ${team.alias}\` or open HQ to wake it.`;
    }
    if (err.code === 'RUNNER_UNAVAILABLE') {
      return `hq: team "${name}" has no running machine. Open the team in HQ and start a session to start it.`;
    }
    if (err.code === 'REMOTE_UNSUPPORTED_RUNNER' && err.details?.reason === 'restart_required') {
      return `hq: team "${name}" must restart its machine before remote access works (remote access was turned on while it was running). An owner or admin can stop and start it from the team page in HQ.`;
    }
    if (err.code === 'REMOTE_UNSUPPORTED_RUNNER') {
      return `hq: team "${name}" runs an older machine image without remote access. An owner or admin can update it: HQ → ${name} → Settings → Update machine.`;
    }
    if (err.code === 'THROTTLED') {
      return `hq: too many open connections to team "${name}". Close one and try again.`;
    }
    if (err.code === 'UPGRADE_REQUIRED') return `hq: ${err.message}`;
    if (err.code === 'REMOTE_TOKEN_INVALID')
      return 'hq: your HQ login on this computer expired or was revoked. Run hq login.';
    if (err.code === 'FEATURE_NOT_AVAILABLE')
      return `hq: remote access is not available for ${team.org.name} yet.`;
    if (err.status === 403) return `hq: you do not have remote access to team "${name}".`;
    if (err.status === 404)
      return `hq: team "${name}" was not found. Run hq status to refresh your teams.`;
    return `hq: ${err.message}`;
  }
  return `hq: ${(err as Error).message}`;
}

export interface ConnectDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  say: (line: string) => void;
}

/**
 * Open a connection row and wait until it is ready. Resolves with the one-time connect code and the
 * host key; throws `ConnectRefusedError` (with the §13 sentence) on every refusal.
 */
export async function openConnection(
  client: HqClient,
  team: Team,
  req: ConnectionRequest,
  deps: ConnectDeps,
): Promise<ConnectionReady> {
  let first: { status: number; body: ConnectionReady | ConnectionWaking };
  try {
    first = await client.request<ConnectionReady | ConnectionWaking>(
      'POST',
      connectionsPath(team),
      {
        body: req,
        org: team.org.slug,
        signed: true,
      },
    );
  } catch (err) {
    throw new ConnectRefusedError(
      refusalMessage(team, err),
      err instanceof HqApiError ? err : undefined,
    );
  }
  if (first.body.state === 'ready') return first.body;
  const id = first.body.id;
  deps.say(
    first.body.code === 'SESSION_RESUME_COLD_RESTART'
      ? `hq: starting team "${team.workspace.name}" fresh (about 60 s)...`
      : `hq: waking team "${team.workspace.name}" (about 15 s)...`,
  );
  const deadline = deps.now() + WAKE_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(WAKE_POLL_MS);
    let poll: { body: ConnectionReady | ConnectionWaking };
    try {
      poll = await client.request<ConnectionReady | ConnectionWaking>(
        'GET',
        connectionsPath(team, id),
        // Device-signed: the poll mints connect codes (review 2026-09-27).
        { org: team.org.slug, signed: true },
      );
    } catch (err) {
      throw new ConnectRefusedError(
        refusalMessage(team, err),
        err instanceof HqApiError ? err : undefined,
      );
    }
    if (poll.body.state === 'ready') return poll.body;
  }
  await closeConnection(client, team, id);
  throw new ConnectRefusedError(wakeTimeoutMessage(team));
}

/** Best effort: tell HQ this invocation is done. */
export async function closeConnection(client: HqClient, team: Team, id: string): Promise<void> {
  try {
    await client.request('DELETE', connectionsPath(team, id), { org: team.org.slug, signed: true });
  } catch {
    /* the stale sweep closes it within two minutes anyway */
  }
}
