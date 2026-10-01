/**
 * Every sentence the extension shows a person, in one file (FEATURE.md §Wireframes, "States and
 * copy"). A snapshot test pins them and a sweep refuses two things in any of them: an em dash, and
 * the word "asleep" (a machine that is not running is "off" in user copy, the web's CI-gated rule).
 *
 * Team and org names are server strings: callers pass them through `cleanLabel` first.
 */

export const COPY = {
  // ── sign-in ──────────────────────────────────────────────────────────────────────────────────
  signedOutWelcome: 'Sign in to see your teams.',
  deviceCode: (code: string) => `Enter ${code} in the browser (copied). Waiting for approval.`,
  deviceCodeCancel: 'Cancel',
  signInDenied: 'The sign-in was denied in the browser.',
  signInExpired: 'This sign-in code expired. Sign in again.',
  signInUnavailable: 'HQ for VS Code is not available on this HQ yet.',
  signInFailed: (detail: string) => `Could not sign in: ${detail}`,
  signedIn: (email: string) => `Signed in to AI Workforce One HQ as ${email}.`,
  signedOut: 'Signed out of AI Workforce One HQ. This computer can no longer reach your teams.',
  signOutOffline:
    'Signed out on this computer. HQ could not be reached to end this computer’s access; remove it in HQ, under Account, Devices.',
  hostNotAllowed: (host: string) =>
    `"${host}" is not an HQ address this editor may use. Set hq.host to https://hq.aiworkforceone.com or add it to hq.allowedHosts.`,
  hostChanged: 'The HQ address changed. Sign in again to use it.',
  keyringMissing: 'Your HQ sign-in is stored without the system keychain on this computer.',
  renewSignIn: 'Your HQ sign-in needs renewing.',
  signInOtherWindow:
    'Signing in to AI Workforce One HQ from another VS Code window. Finish there; this window picks it up.',
  revoked: 'Your access to HQ from this computer ended. Sign in again.',
  signInAction: 'Sign in',
  tooOld:
    'This version of AI Workforce One HQ is no longer supported. Update it from the Extensions view.',
  unreachable: 'HQ could not be reached. Check your connection and try again.',

  // ── teams tree ───────────────────────────────────────────────────────────────────────────────
  noOrgs:
    'No org has developer access on yet. An org owner turns it on in HQ, under Settings, Security.',
  stateRunning: 'running',
  stateStarting: 'starting',
  stateOff: 'off',
  updateNeeded: 'update needed',
  you: 'you',
  viewOnly: 'view only',
  codex: 'Codex',
  noSessions: 'No sessions yet',
  sessionsFailed: 'Could not load sessions',
  teamOffTooltip: (team: string) => `${team} is off. Wake it to join its sessions.`,
  updateNeededLong: (team: string) =>
    `${team}'s machine needs an update for this. An owner or admin can update it in HQ, under Team, Settings, Update machine.`,

  // ── wake ─────────────────────────────────────────────────────────────────────────────────────
  waking: (team: string) => `Waking ${team} (about 15 s)...`,
  stillOnIt: 'Still on it...',
  woke: (team: string) => `${team} is running.`,
  wakeTimeout: (team: string) =>
    `${team} did not start within 3 minutes. Check it in HQ and try again.`,
  wakeNoMachine: (team: string) =>
    `${team} has no machine yet. Open the team in HQ and start a session to start it.`,
  wakeThrottled: 'Too many wake requests for this team. Wait a few minutes and try again.',
  wakeTeam: 'Wake Team',
  wakeUnavailable:
    'Waking a team from VS Code is not available on this HQ yet. Open one of its session terminals to wake it.',

  // ── terminal ─────────────────────────────────────────────────────────────────────────────────
  terminalName: (team: string, session: string) => `HQ · ${team} · ${session}`,
  terminalSuffixViewOnly: ' · view only',
  terminalSuffixWaking: ' · waking',
  terminalSuffixStopped: ' · stopped',
  attached: (session: string, owner: string, canType: boolean) =>
    `Attached to "${session}" (${owner})${canType ? '' : ' · view only'}`,
  teamOffTerminal: (team: string) => `${team} is off.`,
  pressKeyToWake: 'Press any key to wake it.',
  reconnecting: 'Connection lost, reconnecting...',
  connectionLost: 'The connection to HQ was lost. Close this terminal and attach again.',
  sessionAccessEnded: 'Your access to this session ended.',
  detached: 'Detached. The session keeps running in HQ.',
  nowViewOnly: 'You can watch this session but not type in it.',
  terminalRefused: (status: number) =>
    status === 403
      ? 'You cannot open this session from this computer.'
      : status === 404
        ? 'HQ for VS Code is not available on this HQ.'
        : status === 426
          ? 'This version of AI Workforce One HQ is no longer supported. Update it from the Extensions view.'
          : status === 0
            ? 'HQ could not be reached.'
            : `The session could not be opened (HTTP ${status}).`,
  localEchoUnavailable: 'Local echo is not available on this HQ yet.',
  localEchoOrgOff: (org: string) =>
    `Instant local echo is off for ${org}. An owner or admin can turn it on in HQ, under Settings, Security, Instant local echo.`,
  localEchoTypeaheadConflict:
    "HQ local echo is off in this terminal because VS Code's own local echo is on (terminal.integrated.localEchoEnabled).",
  pickSession: 'Choose a session to open',
  pickTeam: 'Choose a team',
  newSessionFailed: (detail: string) => `Could not start a session: ${detail}`,
  sessionLimit: 'This team is at its session limit. Stop a session in HQ, then try again.',
  planReadOnly: 'Your plan is read-only. Reactivate billing in HQ to save files or start sessions.',
  viewOnlyTeam: 'You can view this team but not start sessions on it.',

  // ── ports ────────────────────────────────────────────────────────────────────────────────────
  forwardPrompt: 'Team machine port to forward (1024-65535)',
  forwardLocalPrompt: 'Port on this computer (leave empty to use the same)',
  forwardBadPort: 'Enter a port number from 1024 to 65535.',
  forwardBadLocal: 'Enter a port number from 1 to 65535.',
  forwarding: (local: number, team: string, remote: number) =>
    `Forwarding localhost:${local} to ${team} :${remote}`,
  forwardDetected: (port: number) => `${port}  detected · Forward?`,
  forwardPaused: 'paused · click to resume',
  forwardRefusedPort: (port: number) =>
    `Port ${port} cannot be forwarded: the team machine uses it itself.`,
  forwardRestart: (team: string) =>
    `${team} needs a restart before ports can be forwarded. Stop and start it in HQ.`,
  forwardNotAllowed: (team: string) => `You cannot forward ports from ${team}.`,
  forwardTeamOff: (team: string) => `${team} is off. Wake it, then forward the port again.`,
  forwardTeamStopped: (team: string) =>
    `${team} is stopped. Start it from the team page in HQ, then forward the port again.`,
  forwardEnded: (port: number) => `The forward of port ${port} ended.`,
  forwardInUse: (port: number) => `Port ${port} is already in use on this computer.`,
  forwardFailed: (detail: string) => `Could not forward the port: ${detail}`,
  addressCopied: (url: string) => `Copied ${url}`,

  // ── team files (hq://) ───────────────────────────────────────────────────────────────────────
  openTeamFiles: 'Open Team Files',
  teamFolderName: (team: string, org: string) => `${team} (${org})`,
  fsTeamGone: 'This team is not available on this sign-in. Sign in, or refresh the Teams view.',
  fsOffOpen: (team: string) => `${team} is off. Wake it to open this file.`,
  fsOffSave: (team: string) => `${team} is off. Wake it to save this file.`,
  fsViewOnly: 'You can view this team but not change its files.',
  fsPlanReadOnly:
    'Your plan is read-only. Reactivate billing in HQ to save files or start sessions.',
  fsMasked: 'This file contains masked secret values. Edit it from an HQ terminal.',
  // The web's `TEMPLATE_READ_ONLY_SENTENCE` (client/src/lib/template-protected-path.ts).
  fsProtected: 'This file came from an AI Workforce One HQ template, so it is read-only.',
  fsTooLarge: 'This file is too large to open here. Open it in HQ or from a terminal.',
  fsChangedOnMachine: 'This file changed on the team machine. Save again to compare.',
  fsControlName: "This file's name has control characters HQ can't open. Rename it on the machine.",
  // The web's WORKSPACE_UPDATING sentence (client/src/lib/team-updating.ts), for files.
  fsUpdating: (team: string, etaSeconds: number | null) => {
    if (etaSeconds === null) {
      return `${team}'s machine is updating. Its files are back in a few minutes.`;
    }
    const min = Math.max(1, Math.ceil(etaSeconds / 60));
    return `${team}'s machine is updating. Its files are back in about ${min} ${min === 1 ? 'minute' : 'minutes'}.`;
  },
  openTeamSettings: 'Open Team Settings',
  fsEventsRefused: (org: string) =>
    `Live file updates for ${org} are paused: HQ is holding too many connections for this sign-in (other VS Code windows). Files still refresh every minute. Close other HQ windows to restore live updates.`,

  // ── search ───────────────────────────────────────────────────────────────────────────────────
  searchTitle: 'Search in Team Files',
  searchPrompt: 'Search the team files (text)',
  searchOptions: 'Search options',
  searchRegex: 'Regular expression',
  searchCase: 'Match case',
  searchWord: 'Whole word',
  searchInclude: 'Files to include (comma-separated globs, optional)',
  searchExclude: 'Files to exclude (comma-separated globs, optional)',
  searchNone: 'No results.',
  searchResults: (n: number, truncated: boolean) =>
    `${n} ${n === 1 ? 'result' : 'results'}${truncated ? ' (more were found; narrow the search)' : ''}`,
  searchFailed: (detail: string) => `The search did not run: ${detail}`,
  searchHint: 'For a fast search on the team machine, use HQ: Search in Team Files.',

  // ── account ──────────────────────────────────────────────────────────────────────────────────
  accountHost: (host: string) => `HQ: ${host}`,
  manageDevices: 'Manage devices in HQ',
  signOut: 'Sign out',

  // ── status bar ───────────────────────────────────────────────────────────────────────────────
  statusSignedOut: 'HQ: signed out',
  statusSignedIn: (email: string) => `HQ: ${email}`,
  statusTeam: (email: string, team: string, state: string) => `HQ: ${email} · ${team} ${state}`,
  statusTooltip: 'AI Workforce One HQ',
} as const;
