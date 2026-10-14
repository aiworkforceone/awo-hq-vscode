/**
 * Every sentence the extension shows a person, in one file (FEATURE.md §Wireframes, "States and
 * copy"). A snapshot test pins them and a sweep refuses two things in any of them: an em dash, and
 * the word "asleep" (a machine that is not running is "off" in user copy, the web's CI-gated rule).
 *
 * Team and org names are server strings: callers pass them through `cleanLabel` first.
 */

import { copy } from '@kpa/shared/active-dev-brand';
import { wakeRangeText, type RemoteWakeEstimate } from '@kpa/shared/remote.types';

export const COPY = {
  // ── sign-in ──────────────────────────────────────────────────────────────────────────────────
  signedOutWelcome: 'Sign in to see your teams.',
  deviceCode: (code: string) => `Enter ${code} in the browser (copied). Waiting for approval.`,
  signInDenied: 'The sign-in was denied in the browser.',
  /** The client host rule: the approving account belongs to another address. */
  signInWrongHost: (host: string) =>
    `This account signs in at ${host}. Set the host setting to ${host} and sign in again.`,
  signInExpired: 'This sign-in code expired. Sign in again.',
  // Review MUST 5: the approval may have reached HQ while this editor could not hear the answer.
  signInExpiredAfterNetwork: copy`This sign-in code expired while HQ could not be reached, so the approval may have gone through without reaching this editor. If this computer shows in HQ, under Account, Devices, remove it there, then sign in again.`,
  signInUnavailable: copy`HQ for VS Code is not available on this HQ yet.`,
  signInFailed: (detail: string) => `Could not sign in: ${detail}`,
  signedIn: (email: string) => copy`Signed in to AI Workforce One HQ as ${email}.`,
  signedOut: copy`Signed out of AI Workforce One HQ. This computer can no longer reach your teams.`,
  // One account of several (live test 2026-10-02: the sentence above said "your teams" while the
  // other accounts' teams were still right there).
  signedOutAccount: (email: string) => `Signed out of ${email}. Other accounts stay signed in.`,
  signOutOffline: copy`Signed out on this computer. HQ could not be reached to end this computer’s access; remove it in HQ, under Account, Devices.`,
  hostNotAllowed: (host: string) =>
    copy`"${host}" is not an HQ address this editor may use. Set hq.host to https://hq.aiworkforceone.com or add it to hq.allowedHosts.`,
  hostChanged: copy`The HQ address changed. Sign in again to use it.`,
  hostUnset: copy`Set hq.host to the address you sign in to, for example https://hq.aiworkforceone.com.`,
  keyringMissing: copy`Your HQ sign-in is stored without the system keychain on this computer.`,
  renewSignIn: copy`Your HQ sign-in needs renewing.`,
  // hq-vscode-multi-account: an `add` sign-in becomes active only in the window that started it.
  signInOtherWindow: copy`Signing in to AI Workforce One HQ from another VS Code window. Wait for it to finish, or sign in here instead.`,
  signInHereAction: 'Sign in here instead',
  signInMovedToOtherWindow: 'Sign-in moved to another VS Code window. Finish it there.',
  signInInProgress: copy`Already signing in to AI Workforce One HQ in this window. Waiting for the code.`,
  signInAction: 'Sign in',
  tooOld: copy`This version of AI Workforce One HQ is no longer supported. Update it from the Extensions view.`,
  unreachable: copy`HQ could not be reached. Check your connection and try again.`,
  signInThrottled: copy`Too many HQ sign-ins were started from this network. Wait a minute and try again.`,

  // ── accounts (hq-vscode-multi-account) ───────────────────────────────────────────────────────
  pickAccount: 'Choose an account',
  pickAccountForCommand: 'Choose an account for this window',
  accountActiveNote: 'Active in this window',
  addAnotherAccount: 'Add another account...',
  addedAccount: (email: string) =>
    copy`Signed in to AI Workforce One HQ as ${email}. This window now uses it.`,
  accountAlreadySignedIn: (email: string) =>
    copy`The browser approved this sign-in as ${email}, who is already signed in here, so it was not kept. To add another account, sign in to HQ in your browser as that account first.`,
  // Jean 2026-10-01: the first sentence verbatim; the grant approved as someone else is revoked.
  renewMismatch: (expected: string, got: string) =>
    copy`You approved as ${got}, but this account is ${expected}. Sign in to HQ in your browser as ${expected}, then try again.`,
  renewMismatchUnknown: (got: string) =>
    copy`You approved as ${got}, but this sign-in was for another account. Sign in to HQ in your browser as that account, then try again.`,
  signInUnstorableUser: copy`HQ answered with an account this editor cannot store. It was not kept.`,
  revokeNewFailed: copy`HQ could not be reached to undo that sign-in. Remove the newest computer in HQ, under Account, Devices.`,
  slotInUse:
    'This sign-in could not be stored: another VS Code profile on this computer holds one for the same account. It was not kept.',
  fsAccountGone: (email: string) =>
    `This folder belongs to ${email}, who is not signed in on this computer.`,
  fsAccountUnknown: copy`This folder belongs to an HQ account that is not signed in on this computer. Open it again from the Teams view.`,
  signInAsAction: (email: string) => `Sign in as ${email}`,
  revokedAccount: (email: string) =>
    copy`Your access to HQ as ${email} ended on this computer. Sign in again, or switch to another account.`,
  renewSignInAccount: (email: string) => copy`Your HQ sign-in as ${email} needs renewing.`,
  needsSignInDescription: 'Sign in again',
  keychainBusy: (email: string) =>
    copy`Could not read your HQ sign-in for ${email} from the keychain. Unlock it and try again.`,
  confirmSignOut: (email: string) =>
    copy`Sign out of ${email}? Its HQ terminals and port forwards close in every window.`,
  statusOtherAccount: 'other account',
  accountsExistNoneActive: copy`You have other HQ accounts signed in on this computer.`,
  manageDevicesBrowserNote: (email: string) =>
    copy`Opens HQ in your browser. If your browser is signed in as someone other than ${email}, sign in there first.`,

  // ── teams tree ───────────────────────────────────────────────────────────────────────────────
  noOrgs: copy`No org has developer access on yet. An org owner turns it on in HQ, under Settings, Security.`,
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
    copy`${team}'s Cloud Computer needs an update for this. An owner or admin can update it in HQ, under Team, Settings, Update Cloud Computer.`,

  // ── session lifecycle (cli-session-lifecycle) ────────────────────────────────────────────────
  // Refusals are the shared client's sentences (`describeSessionRefusal`), the same the CLI prints.
  sessionStarting: (name: string) => `Starting session "${name}"...`,
  sessionStopping: (name: string) => `Stopping session "${name}"...`,
  sessionRestartingProgress: (name: string) => `Restarting session "${name}"...`,
  sessionStarted: (name: string) => `Session "${name}" is starting.`,
  sessionStopped: (name: string) => `Session "${name}" stopped.`,
  sessionRestarted: (name: string) => `Session "${name}" is restarting.`,
  // train 98 e2e: HQ answers ALREADY_RUNNING while a session is still starting too (the CLI's words).
  sessionAlreadyStarting: (name: string) => `Session "${name}" is already starting.`,
  sessionBusyConfirm: (agent: string, name: string, action: 'stop' | 'restart') =>
    `${agent} is answering in "${name}" right now. ${action === 'stop' ? 'Stop' : 'Restart'} it anyway?`,
  stopSessionAction: 'Stop Session',
  restartSessionAction: 'Restart Session',

  // ── wake ─────────────────────────────────────────────────────────────────────────────────────
  // Jean 2026-10-14: the team's own range from HQ's listing (30-45 seconds from 32 GB); an older HQ
  // sends none and the ordinary 15-30 holds.
  waking: (team: string, estimate?: RemoteWakeEstimate) =>
    `Waking ${team}... this usually takes ${wakeRangeText(estimate)}`,
  stillOnIt: 'Taking longer than usual, still working.',
  woke: (team: string) => `${team} is running.`,
  wakeTimeout: (team: string) =>
    copy`${team} did not start within 3 minutes. Check it in HQ and try again.`,
  // ALSO-3 (live re-test, round 3): HQ's wake only resumes a machine that went to sleep (it never
  // starts a stopped one, D23); a session start is what starts it, in HQ or here.
  wakeStopped: (team: string) =>
    `${team} is stopped. Wake only resumes a sleeping team: start a session to start its Cloud Computer.`,
  startSessionAction: 'Start a Session',
  openInAppAction: copy`Open in HQ`,
  wakeThrottled: 'Too many wake requests for this team. Wait a few minutes and try again.',
  wakeTeam: 'Wake Team',
  wakeUnavailable: copy`Waking a team from VS Code is not available on this HQ yet. Open one of its session terminals to wake it.`,

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
  imagePasteRemoteHost: copy`Pasting an image needs the HQ extension on this computer. Drag the image file onto the terminal instead.`,

  // ── terminal ─────────────────────────────────────────────────────────────────────────────────
  // Decision 21: the account's short label, only while 2 or more accounts are signed in.
  terminalName: (team: string, session: string, label?: string) =>
    label ? copy`HQ · ${label} · ${team} · ${session}` : copy`HQ · ${team} · ${session}`,
  terminalSuffixViewOnly: ' · view only',
  terminalSuffixWaking: ' · waking',
  terminalSuffixStopped: ' · stopped',
  attached: (session: string, owner: string, canType: boolean) =>
    `Attached to "${session}" (${owner})${canType ? '' : ' · view only'}`,
  teamOffTerminal: (team: string) => `${team} is off.`,
  pressKeyToWake: 'Press any key to wake it.',
  reconnecting: 'Connection lost, reconnecting...',
  connectionLost: copy`The connection to HQ was lost.`,
  // 0.2.2: an ended or lost terminal comes back in place on the next key.
  pressKeyToReconnect: 'Press any key to reconnect.',
  sessionStoppedTerminal: 'The session stopped.',
  sessionErrorTerminal: 'The session exited with an error.',
  sessionAccessEnded: 'Your access to this session ended.',
  detached: copy`Detached. The session keeps running in HQ.`,
  nowViewOnly: 'You can watch this session but not type in it.',
  terminalRefused: (status: number) =>
    status === 403
      ? 'You cannot open this session from this computer.'
      : status === 404
        ? copy`HQ for VS Code is not available on this HQ.`
        : status === 426
          ? copy`This version of AI Workforce One HQ is no longer supported. Update it from the Extensions view.`
          : status === 0
            ? copy`HQ could not be reached.`
            : `The session could not be opened (HTTP ${status}).`,
  localEchoUnavailable: copy`Local echo is not available on this HQ yet.`,
  localEchoOrgOff: (org: string) =>
    copy`Instant local echo is off for ${org}. An owner or admin can turn it on in HQ, under Settings, Security, Instant local echo.`,
  localEchoTypeaheadConflict: copy`HQ local echo is off in this terminal because VS Code's own local echo is on (terminal.integrated.localEchoEnabled).`,
  pickSession: 'Choose a session to open',
  pickTeam: 'Choose a team',
  newSessionFailed: (detail: string) => `Could not start a session: ${detail}`,
  sessionLimit: copy`This team is at its session limit. Stop a session in HQ, then try again.`,
  planReadOnly: copy`Your plan is read-only. Reactivate billing in HQ to save files or start sessions.`,
  viewOnlyTeam: 'You can view this team but not start sessions on it.',

  // ── ports ────────────────────────────────────────────────────────────────────────────────────
  forwardPrompt: 'AI Team Cloud Computer port to forward (1024-65535)',
  forwardLocalPrompt: 'Port on this computer (leave empty to use the same)',
  forwardBadPort: 'Enter a port number from 1024 to 65535.',
  forwardBadLocal: 'Enter a port number from 1 to 65535.',
  forwarding: (local: number, team: string, remote: number) =>
    `Forwarding localhost:${local} to ${team} :${remote}`,
  forwardDetected: (port: number) => `${port}  detected · Forward?`,
  forwardPaused: 'paused · click to resume',
  forwardRefusedPort: (port: number) =>
    `Port ${port} cannot be forwarded: the AI Team Cloud Computer uses it itself.`,
  // kr-api's `restart_required`: Developer access is on now (the org gate passed), but this boot
  // started without it, so its relay does not serve `forward` until the next start.
  forwardRestart: (team: string) =>
    copy`${team} started before Developer access was turned on. Restart it once (Restart Cloud Computer in HQ team settings) and ports will forward.`,
  forwardNotAllowed: (team: string) => `You cannot forward ports from ${team}.`,
  forwardTeamOff: (team: string) => `${team} is off. Wake it, then forward the port again.`,
  forwardTeamStopped: (team: string) =>
    copy`${team} is stopped. Start it from the team page in HQ, then forward the port again.`,
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
  fsPlanReadOnly: copy`Your plan is read-only. Reactivate billing in HQ to save files or start sessions.`,
  fsMasked: copy`This file contains masked secret values. Edit it from an HQ terminal.`,
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
  fsProtected: copy`This file came from an AI Workforce One HQ template, so it is read-only.`,
  fsTooLarge: copy`This file is too large to open here. Open it in HQ or from a terminal.`,
  fsChangedOnMachine: 'This file changed on the AI Team Cloud Computer. Save again to compare.',
  fsControlName: copy`This file's name has control characters HQ can't open. Rename it on the Cloud Computer.`,
  // The web's WORKSPACE_UPDATING sentence (client/src/lib/team-updating.ts), for files. Jean
  // 2026-10-10: one static estimate (CLOUD_COMPUTER_CHANGE_ESTIMATE), never the server's ETA, which
  // counted down past what a real change took.
  fsUpdating: (team: string) =>
    `${team}'s Cloud Computer is updating. Its files are back once it is done. This usually takes about 5 to 6 minutes.`,
  openTeamSettings: 'Open Team Settings',
  fsEventsRefused: (org: string) =>
    copy`Live file updates for ${org} are paused: HQ is holding too many connections for this sign-in (other VS Code windows). Files still refresh every minute. Close other HQ windows to restore live updates.`,

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
  searchHint: copy`For a fast search on the AI Team Cloud Computer, use HQ: Search in Team Files.`,

  // ── account ──────────────────────────────────────────────────────────────────────────────────
  accountHost: (host: string) => copy`HQ: ${host}`,
  manageDevices: copy`Manage devices in HQ`,
  signOut: 'Sign out',

  // ── status bar ───────────────────────────────────────────────────────────────────────────────
  statusSignedOut: copy`HQ: signed out`,
  statusSignedIn: (email: string) => copy`HQ: ${email}`,
  statusTeam: (email: string, team: string, state: string) => copy`HQ: ${email} · ${team} ${state}`,
  statusTooltip: copy`AI Workforce One HQ`,
} as const;
