/**
 * Wake Team (F10, D12): the one explicit, person-initiated action besides opening a terminal or a
 * forward that may start a team machine. `POST …/workspaces/:ws/wake` (device-signed, open to
 * viewers) then `GET …/workspaces/:ws` until the team reads `running`, at the browser's cadence
 * (2 s, then 4 s), with "Still on it..." past 20 s and the other doors' 170 s budget.
 *
 * Nothing in the background ever calls this: the tree, the status bar and every refresh read only.
 */
import type { RemoteWakeResponse, RemoteWorkspace } from '@kpa/shared/remote.types';
import { HqApiError, type HqClient } from '@hq/client/api.js';
import { WAKE_TIMEOUT_MS } from '@hq/client/connect.js';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';

export const WAKE_POLL_FIRST_MS = 2_000;
export const WAKE_POLL_MS = 4_000;
export const WAKE_STILL_MS = 20_000;

export type WakeOutcome =
  | { kind: 'running' }
  | { kind: 'timeout' }
  | { kind: 'no-machine' }
  | { kind: 'throttled' }
  | { kind: 'unavailable' }
  | { kind: 'refused'; error: HqApiError };

export interface WakeDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** A line of progress for the person (the notification's message). */
  report: (message: string) => void;
}

export function teamPath(team: Team): string {
  return `/api/remote/orgs/${encodeURIComponent(team.org.slug)}/workspaces/${team.workspace.id}`;
}

export async function wakeTeam(client: HqClient, team: Team, deps: WakeDeps): Promise<WakeOutcome> {
  const base = teamPath(team);
  let answer: RemoteWakeResponse;
  try {
    answer = (
      await client.request<RemoteWakeResponse>('POST', `${base}/wake`, {
        org: team.org.slug,
        signed: true,
      })
    ).body;
  } catch (err) {
    if (!(err instanceof HqApiError)) throw err;
    if (err.status === 404) return { kind: 'unavailable' };
    if (err.status === 429) return { kind: 'throttled' };
    if (err.code === 'RUNNER_UNAVAILABLE') return { kind: 'no-machine' };
    return { kind: 'refused', error: err };
  }
  if (answer.state === 'running') return { kind: 'running' };
  const name = team.workspace.name;
  deps.report(COPY.waking(name));
  const started = deps.now();
  let saidStill = false;
  let first = true;
  while (deps.now() - started < WAKE_TIMEOUT_MS) {
    await deps.sleep(first ? WAKE_POLL_FIRST_MS : WAKE_POLL_MS);
    first = false;
    if (!saidStill && deps.now() - started >= WAKE_STILL_MS) {
      saidStill = true;
      deps.report(COPY.stillOnIt);
    }
    let ws: RemoteWorkspace;
    try {
      ws = (await client.request<RemoteWorkspace>('GET', base, { org: team.org.slug })).body;
    } catch (err) {
      if (err instanceof HqApiError) return { kind: 'refused', error: err };
      continue; // a blip on the way: the next poll decides
    }
    if (ws.state === 'running') return { kind: 'running' };
  }
  return { kind: 'timeout' };
}
