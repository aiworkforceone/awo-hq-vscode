/**
 * The connect handshake every door shares (FEATURE.md §9, §13): `POST …/connections` (device
 * signed), the wake poll, and the `409`/`403` answers mapped to the plain sentences in §13.
 *
 * Messages go through `say` (stderr for the CLI). Nothing here prints a code, a token or a host key.
 */
import {
  wakeRangeText,
  type ConnectionReady,
  type ConnectionRequest,
  type ConnectionWaking,
} from '@kpa/shared/remote.types';
import { HqApiError, type HqClient } from './api.js';
import type { Team } from './teams.js';
import { copy } from '@kpa/shared/active-dev-brand';
import { DEVICE_SIGNATURE_MISSING_CODE, deviceSignatureMissingMessage } from './session-actions.js';

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
  return copy`hq: team "${team.workspace.name}" did not wake within 3 minutes. Check it in HQ and try again.`;
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
      return copy`hq: team "${name}" is asleep and this looks like an editor reconnect, so it was not woken. Run \`hq up ${team.alias}\` or open HQ to wake it.`;
    }
    if (err.code === 'RUNNER_UNAVAILABLE') {
      return copy`hq: team "${name}" has no running Cloud Computer. Open the team in HQ and start a session to start it.`;
    }
    if (err.code === 'REMOTE_UNSUPPORTED_RUNNER' && err.details?.reason === 'restart_required') {
      // Only a port forward meets this (SSH was removed on 2026-10-01; attach does not need it).
      return copy`hq: team "${name}" cannot forward ports yet: its AI Team Cloud Computer started before Developer access was turned on. Restart the AI Team Cloud Computer, then try again. An owner or admin presses Restart Cloud Computer in the team's Settings in HQ.`;
    }
    if (err.code === 'REMOTE_UNSUPPORTED_RUNNER') {
      return copy`hq: team "${name}" runs an older Cloud Computer image without remote access. An owner or admin can update it: HQ → ${name} → Settings → Update Cloud Computer.`;
    }
    if (err.code === 'THROTTLED') {
      return copy`hq: too many open connections to team "${name}". Close one and try again.`;
    }
    if (err.code === 'UPGRADE_REQUIRED') return copy`hq: ${err.message}`;
    if (err.code === DEVICE_SIGNATURE_MISSING_CODE)
      return copy`hq: ${deviceSignatureMissingMessage()}`;
    if (err.code === 'REMOTE_TOKEN_INVALID')
      return copy`hq: your HQ login on this computer expired or was revoked. Run hq login.`;
    if (err.code === 'FEATURE_NOT_AVAILABLE')
      return copy`hq: remote access is not available for ${team.org.name} yet.`;
    if (err.status === 403) return copy`hq: you do not have remote access to team "${name}".`;
    if (err.status === 404)
      return copy`hq: team "${name}" was not found. Run hq status to refresh your teams.`;
    return copy`hq: ${err.message}`;
  }
  return copy`hq: ${(err as Error).message}`;
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
/**
 * "hq: waking team "X", this usually takes 15-30 seconds..." with the range HQ gives for THIS team's
 * machine (`wakeEstimate`, Jean 2026-10-14: 30-45 seconds from 32 GB). An older HQ sends none and
 * the ordinary 15-30 holds. Shared by `hq up` and every connecting door.
 */
export function wakingTeamLine(team: Team): string {
  return copy`hq: waking team "${team.workspace.name}", this usually takes ${wakeRangeText(team.workspace.wakeEstimate)}...`;
}

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
      ? copy`hq: starting team "${team.workspace.name}" fresh (about 60 s)...`
      : wakingTeamLine(team),
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
