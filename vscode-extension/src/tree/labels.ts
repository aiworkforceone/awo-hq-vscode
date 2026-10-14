/**
 * What the Teams tree says about a team and a session (D3, §Wireframes). Pure, so the unit tier pins
 * every state: running / starting / off / update needed, owner / "you" / view only, and the
 * `contextValue` the menus key on.
 *
 *   team contextValue     `team:<running|starting|off>:<write|read>`
 *   session contextValue  `session:<type|view>:<running|idle|stopped>:<op|noop>`
 *                         (cli-session-lifecycle: the state picks Start or Stop and Restart; `noop`
 *                         when HQ says this member may not operate it. An older HQ that does not
 *                         say reads `op`: the action is offered and HQ answers. A session HQ is
 *                         still starting keeps `running` here, as HQ's `status` does, so Stop and
 *                         Restart stay on it; its description says `starting`.)
 */
import type { RemoteSessionSummary, RemoteWorkspace } from '@kpa/shared/remote.types';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { cleanLabel } from '../util/text.js';

export type TeamState = 'running' | 'starting' | 'off';

/** `asleep` and `stopped` both read "off" in user copy (never "asleep"). */
export function teamState(ws: RemoteWorkspace): TeamState {
  if (ws.state === 'running') return 'running';
  if (ws.state === 'starting') return 'starting';
  return 'off';
}

export function canWriteTeam(team: Team): boolean {
  return team.workspace.rights.forward === true;
}

/** The machine's image cannot serve forward or the files (HQ says so only on proof, FAIL 6). */
export function needsUpdate(team: Team): boolean {
  return team.workspace.supported === false || team.workspace.filesSupported === false;
}

export function teamDescription(team: Team): string {
  const parts: string[] = [];
  const state = teamState(team.workspace);
  parts.push(
    state === 'running'
      ? COPY.stateRunning
      : state === 'starting'
        ? COPY.stateStarting
        : COPY.stateOff,
  );
  if (needsUpdate(team)) parts.push(COPY.updateNeeded);
  if (!canWriteTeam(team)) parts.push(COPY.viewOnly);
  return parts.join(' · ');
}

export function teamContextValue(team: Team): string {
  return `team:${teamState(team.workspace)}:${canWriteTeam(team) ? 'write' : 'read'}`;
}

export function sessionLabel(s: RemoteSessionSummary): string {
  return cleanLabel(s.name) || s.id.slice(0, 8);
}

export function sessionDescription(s: RemoteSessionSummary): string {
  const parts: string[] = [s.ownerIsMe === true ? COPY.you : cleanLabel(s.ownerName)];
  // train 98 e2e: HQ is still starting it (its machine may yet fail to come up), so never "running".
  if (s.starting === true) parts.push(COPY.stateStarting);
  if (!s.canType) parts.push(COPY.viewOnly);
  if (s.engine === 'codex') parts.push(COPY.codex);
  return parts.filter((p) => p.length > 0).join(' · ');
}

export function sessionContextValue(s: RemoteSessionSummary): string {
  return `session:${s.canType ? 'type' : 'view'}:${s.status}:${s.canOperate === false ? 'noop' : 'op'}`;
}

/** The HQ web page for a team or a session (Open in HQ Web). */
export function webUrl(host: string, target: { workspaceId: string; sessionId?: string }): string {
  return target.sessionId
    ? `${host}/sessions/${encodeURIComponent(target.sessionId)}`
    : `${host}/workspaces/${encodeURIComponent(target.workspaceId)}`;
}

/** The team's settings page in HQ web, where an owner or admin finds Update machine. */
export function teamSettingsUrl(host: string, workspaceId: string): string {
  return `${host}/workspaces/${encodeURIComponent(workspaceId)}/settings`;
}
