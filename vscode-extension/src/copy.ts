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
  signInDenied: 'The sign-in was denied in the browser.',
  signInExpired: 'This sign-in code expired. Sign in again.',
  // Review MUST 5: the approval may have reached HQ while this editor could not hear the answer.
  signInExpiredAfterNetwork:
    'This sign-in code expired while HQ could not be reached, so the approval may have gone through without reaching this editor. If this computer shows in HQ, under Account, Devices, remove it there, then sign in again.',
  signInUnavailable: 'HQ for VS Code is not available on this HQ yet.',
  signInFailed: (detail: string) => `Could not sign in: ${detail}`,
  signedIn: (email: string) => `Signed in to AI Workforce One HQ as ${email}.`,
  signedOut: 'Signed out of AI Workforce One HQ. This computer can no longer reach your teams.',
  // One account of several (live test 2026-10-02: the sentence above said "your teams" while the
  // other accounts' teams were still right there).
  signedOutAccount: (email: string) => `Signed out of ${email}. Other accounts stay signed in.`,
  signOutOffline:
    'Signed out on this computer. HQ could not be reached to end this computer’s access; remove it in HQ, under Account, Devices.',
  hostNotAllowed: (host: string) =>
    `"${host}" is not an HQ address this editor may use. Set hq.host to https://hq.aiworkforceone.com or add it to hq.allowedHosts.`,
  hostChanged: 'The HQ address changed. Sign in again to use it.',
  keyringMissing: 'Your HQ sign-in is stored without the system keychain on this computer.',
  renewSignIn: 'Your HQ sign-in needs renewing.',
  // hq-vscode-multi-account: an `add` sign-in becomes active only in the window that started it.
  signInOtherWindow:
    'Signing in to AI Workforce One HQ from another VS Code window. Wait for it to finish, or sign in here instead.',
  signInHereAction: 'Sign in here instead',
  signInMovedToOtherWindow: 'Sign-in moved to another VS Code window. Finish it there.',
  signInInProgress:
    'Already signing in to AI Workforce One HQ in this window. Waiting for the code.',
  signInAction: 'Sign in',
  tooOld:
    'This version of AI Workforce One HQ is no longer supported. Update it from the Extensions view.',
  unreachable: 'HQ could not be reached. Check your connection and try again.',
  signInThrottled:
    'Too many HQ sign-ins were started from this network. Wait a minute and try again.',

  // ── accounts (hq-vscode-multi-account) ───────────────────────────────────────────────────────
  pickAccount: 'Choose an account',
  pickAccountForCommand: 'Choose an account for this window',
  accountActiveNote: 'Active in this window',
  addAnotherAccount: 'Add another account...',
  addedAccount: (email: string) =>
    `Signed in to AI Workforce One HQ as ${email}. This window now uses it.`,
  accountAlreadySignedIn: (email: string) =>
    `The browser approved this sign-in as ${email}, who is already signed in here, so it was not kept. To add another account, sign in to HQ in your browser as that account first.`,
  // Jean 2026-10-01: the first sentence verbatim; the grant approved as someone else is revoked.
  renewMismatch: (expected: string, got: string) =>
    `You approved as ${got}, but this account is ${expected}. Sign in to HQ in your browser as ${expected}, then try again.`,
  renewMismatchUnknown: (got: string) =>
    `You approved as ${got}, but this sign-in was for another account. Sign in to HQ in your browser as that account, then try again.`,
  signInUnstorableUser: 'HQ answered with an account this editor cannot store. It was not kept.',
  revokeNewFailed:
    'HQ could not be reached to undo that sign-in. Remove the newest computer in HQ, under Account, Devices.',
  slotInUse:
    'This sign-in could not be stored: another VS Code profile on this computer holds one for the same account. It was not kept.',
  fsAccountGone: (email: string) =>
    `This folder belongs to ${email}, who is not signed in on this computer.`,
  fsAccountUnknown:
    'This folder belongs to an HQ account that is not signed in on this computer. Open it again from the Teams view.',
  signInAsAction: (email: string) => `Sign in as ${email}`,
  revokedAccount: (email: string) =>
    `Your access to HQ as ${email} ended on this computer. Sign in again, or switch to another account.`,
  renewSignInAccount: (email: string) => `Your HQ sign-in as ${email} needs renewing.`,
  needsSignInDescription: 'Sign in again',
  keychainBusy: (email: string) =>
    `Could not read your HQ sign-in for ${email} from the keychain. Unlock it and try again.`,
  confirmSignOut: (email: string) =>
    `Sign out of ${email}? Its HQ terminals and port forwards close in every window.`,
  statusOtherAccount: 'other account',
  accountsExistNoneActive: 'You have other HQ accounts signed in on this computer.',
  manageDevicesBrowserNote: (email: string) =>
    `Opens HQ in your browser. If your browser is signed in as someone other than ${email}, sign in there first.`,

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
  // ALSO-3 (live re-test, round 3): HQ's wake only resumes a machine that went to sleep (it never
  // starts a stopped one, D23); a session start is what starts it, in HQ or here.
  wakeStopped: (team: string) =>
    `${team} is stopped. Wake only resumes a sleeping team: start a session to start its machine.`,
  startSessionAction: 'Start a Session',
  openInHqAction: 'Open in HQ',
  wakeThrottled: 'Too many wake requests for this team. Wait a few minutes and try again.',
  wakeTeam: 'Wake Team',
  wakeUnavailable:
    'Waking a team from VS Code is not available on this HQ yet. Open one of its session terminals to wake it.',

  // ── image paste and drop (hq-vscode-image-paste; the web terminal's sentences) ────────────────
  imageUploading: 'Uploading image...',
  imageAdded: 'Image added. Describe it, then press Enter.',
  imageWrongType: 'Only PNG, JPEG, GIF, or WebP images can be pasted.',
  imageTooLarge: 'That image is too large. Pasted images must be 10 MB or smaller.',
  imageUploadFailed: (detail: string) => `The image was not added: ${detail}`,
  imageUploadTimeout: 'The image upload did not finish.',
  imageUploadConfirm: (files: string, team: string) => `Upload ${files} to ${team}?`,
  imageUploadAction: 'Upload',
  imageTypePathAction: 'Type the path',
  imageDropOtherTeam: (team: string) =>
    `That file is in another team. Drop files from ${team}'s folder, or from your computer.`,
  imagePasteRemoteHost:
    'Pasting an image needs the HQ extension on this computer. Drag the image file onto the terminal instead.',

  // ── terminal ─────────────────────────────────────────────────────────────────────────────────
  // Decision 21: the account's short label, only while 2 or more accounts are signed in.
  terminalName: (team: string, session: string, label?: string) =>
    label ? `HQ · ${label} · ${team} · ${session}` : `HQ · ${team} · ${session}`,
  terminalSuffixViewOnly: ' · view only',
  terminalSuffixWaking: ' · waking',
  terminalSuffixStopped: ' · stopped',
  attached: (session: string, owner: string, canType: boolean) =>
    `Attached to "${session}" (${owner})${canType ? '' : ' · view only'}`,
  teamOffTerminal: (team: string) => `${team} is off.`,
  pressKeyToWake: 'Press any key to wake it.',
  reconnecting: 'Connection lost, reconnecting...',
  connectionLost: 'The connection to HQ was lost.',
  // 0.2.2: an ended or lost terminal comes back in place on the next key.
  pressKeyToReconnect: 'Press any key to reconnect.',
  sessionStoppedTerminal: 'The session stopped.',
  sessionErrorTerminal: 'The session exited with an error.',
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
  // kr-api's `restart_required`: Developer access is on now (the org gate passed), but this boot
  // started without it, so its relay does not serve `forward` until the next start.
  forwardRestart: (team: string) =>
    `${team} started before Developer access was turned on. Restart it once (Restart machine in HQ team settings) and ports will forward.`,
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
  teamFolderName: (team: string, org: string, label?: string) =>
    label ? `${team} (${org}) · ${label}` : `${team} (${org})`,
  fsTeamGone: 'This team is not available on this sign-in. Sign in, or refresh the Teams view.',
  fsOffOpen: (team: string) => `${team} is off. Wake it to open this file.`,
  fsOffSave: (team: string) => `${team} is off. Wake it to save this file.`,
  fsViewOnly: 'You can view this team but not change its files.',
  fsPlanReadOnly:
    'Your plan is read-only. Reactivate billing in HQ to save files or start sessions.',
  fsMasked: 'This file contains masked secret values. Edit it from an HQ terminal.',
  // 0.2.2 review: unsaved edits in a file that just became masked cannot be saved through HQ.
  fsMaskedWhileEditing: (file: string) =>
    `${file} now holds the value of a secret, so it is shown masked and can't be saved here. Copy your changes out (for example into a new file) before you close it.`,
  // 0.2.2: the one-time notice for a masked file, naming the secret(s) when HQ said which.
  fsMaskedFile: (file: string, given: readonly string[]) => {
    const names = Array.isArray(given) ? given : [];
    if (names.length === 0) {
      return `${file} contains the value of a secret, so it's shown masked and read-only. Edit it in the terminal, or read the secret from its environment variable instead of keeping its value in the file.`;
    }
    if (names.length === 1) {
      return `${file} contains the value of a secret (${names[0]}), so it's shown masked and read-only. Edit it in the terminal, or read the secret from $${names[0]} instead of keeping its value in the file.`;
    }
    const vars = names.map((n) => `$${n}`);
    const said = `${vars.slice(0, -1).join(', ')} and ${vars[vars.length - 1]}`;
    return `${file} contains the values of secrets (${names.join(', ')}), so it's shown masked and read-only. Edit it in the terminal, or read the secrets from ${said} instead of keeping their values in the file.`;
  },
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
