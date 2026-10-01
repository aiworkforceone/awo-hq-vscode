/**
 * Team resolution: `hq-<8hex>` aliases (widened to 12 hex when two of YOUR teams collide on 8), a
 * full team id, or a team name — optionally narrowed by `--org`.
 */
import { workspaceAlias, type RemoteOrg, type RemoteWorkspace } from '@kpa/shared/remote.types';
import { ALIAS_RE, ORG_SLUG_RE, UUID_RE, oneLine } from './safe-text.js';

export interface Team {
  org: RemoteOrg;
  workspace: RemoteWorkspace;
  alias: string;
}

/** Is this team safe to write into ssh config and to put in a URL path (review C4)? */
export function isWellFormedTeam(t: Team): boolean {
  return ORG_SLUG_RE.test(t.org.slug) && UUID_RE.test(t.workspace.id) && ALIAS_RE.test(t.alias);
}

/**
 * Every team this login can see, split into the well-formed ones and the ones the CLI refuses to
 * use. Names are cleaned to one printable line (a server string is data, never syntax). A real HQ
 * never produces a skipped team: seeing one means the answer did not come from HQ as we know it.
 */
export function partitionTeams(orgs: RemoteOrg[]): { teams: Team[]; skipped: Team[] } {
  const all = orgs.flatMap((raw) => {
    const org: RemoteOrg = { ...raw, name: oneLine(String(raw.name ?? '')) };
    return (raw.workspaces ?? []).map((w) => ({
      org,
      workspace: { ...w, name: oneLine(String(w.name ?? '')) },
    }));
  });
  const counts = new Map<string, number>();
  for (const t of all) {
    const a = workspaceAlias(t.workspace.id);
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const aliased = all.map((t) => {
    const short = workspaceAlias(t.workspace.id);
    return {
      ...t,
      alias: (counts.get(short) ?? 0) > 1 ? workspaceAlias(t.workspace.id, 12) : short,
    };
  });
  return {
    teams: aliased.filter(isWellFormedTeam),
    skipped: aliased.filter((t) => !isWellFormedTeam(t)),
  };
}

/** The well-formed teams, aliased (`hq-<8hex>`, widened to 12 on a collision). */
export function withTeamAliases(orgs: RemoteOrg[]): Team[] {
  return partitionTeams(orgs).teams;
}

export class TeamNotFoundError extends Error {}

export function resolveTeam(orgs: RemoteOrg[], ref: string, org?: string): Team {
  const teams = withTeamAliases(orgs).filter((t) => !org || t.org.slug === org);
  const needle = ref.trim().toLowerCase();
  const exact = teams.filter(
    (t) =>
      t.alias === needle ||
      t.workspace.id.toLowerCase() === needle ||
      t.workspace.name.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;
  const prefix = teams.filter((t) =>
    t.workspace.id.toLowerCase().startsWith(needle.replace(/^hq-/, '')),
  );
  if (exact.length === 0 && prefix.length === 1) return prefix[0]!;
  if (exact.length > 1 || prefix.length > 1) {
    throw new TeamNotFoundError(
      `hq: "${ref}" matches more than one team. Use the hq-… name from hq status.`,
    );
  }
  throw new TeamNotFoundError(
    `hq: no team "${ref}" on this login. Run hq status to see your teams.`,
  );
}
