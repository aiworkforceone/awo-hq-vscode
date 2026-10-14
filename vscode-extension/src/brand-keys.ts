/**
 * The names this extension keeps on the computer and in VS Code (globalState keys, the auth session
 * sentinel, the lock directory, the device key's comment, the team folder names it parses), in the
 * build's brand. For AWO they are byte for byte what they always were (`hq:…`, `hq.terminals`,
 * `~/.hq/vscode`, `hq-<8hex>`), so nothing an existing install stored moves.
 */
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';

/** The prefix of every globalState key (`hq` for AWO). */
export const KEY_NS: string = ACTIVE_DEV_BRAND.vscode.idPrefix;
/** The state directory under the home directory (`.hq` for AWO), shared with the brand's CLI. */
export const HOME_DIR_NAME: string = ACTIVE_DEV_BRAND.cli.homeDirName;
/** The team alias prefix (`hq` for AWO: `hq-3f9a1c2e`). */
export const TEAM_ALIAS_PREFIX: string = ACTIVE_DEV_BRAND.teamAliasPrefix;
/** `hq-3f9a1c2e` (this build's prefix, 8 hex): the team folder of a team-files URI. */
export const TEAM_ALIAS_SOURCE = `${TEAM_ALIAS_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}`;
