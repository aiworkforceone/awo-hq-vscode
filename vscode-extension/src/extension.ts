/**
 * AI Workforce One HQ for VS Code (feature `hq-vscode`; more than one account since
 * `hq-vscode-multi-account`, 0.2.0).
 *
 * The extension talks ONLY to HQ's own APIs (decision 1): no SSH, nothing installed on a team
 * machine. It runs on the local UI host only (`extensionKind: ["ui"]`, decision 25), so the device
 * keys, the tokens and the port listeners always stay on the person's own computer, even in a remote
 * window. No telemetry, no webview, nothing downloaded at run time (decision 28, D15).
 *
 * Accounts: `HqAccounts` holds one bundle per signed-in account (service, file API, events, file
 * cache). Everything here reaches an account through the `AccountRef` its node, URI, terminal or
 * forward carries; a command with none uses the window's active account, and with no active account
 * opens the switcher (decision 27). Nothing outside `hq/accounts.ts` holds a "current" service.
 *
 * `activate` only wires things up: nothing talks to HQ until a view is shown or a command runs,
 * except one team listing for the window's active account (reads never wake a machine).
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import type { FsSearchTextRequest } from '@kpa/shared/remote-fs.types';
import {
  primaryAction,
  renameHqFolders,
  requireAccount,
  signOutAccount,
  switchAccount,
  openFolderOf,
  type AccountCommands,
} from './accounts-ui.js';
import {
  AUTH_PROVIDER_ID,
  AUTH_PROVIDER_LABEL,
  HqAuthenticationProvider,
} from './auth/auth-provider.js';
import { keyringMissingHere, warnIfKeyringMissing } from './auth/keyring.js';
import { AccountNotices } from './account-notices.js';
import { TeamOffNotices } from './team-off-notices.js';
import { COPY } from './copy.js';
import { redactingLog } from './log.js';
import { FsApiError } from './fs/fs-api.js';
import {
  HQ_SCHEME,
  HqFileSystemProvider,
  relPathOf,
  rootsFor,
  teamFolderName,
  teamRootUri,
  uriFor,
  type UnavailableAccount,
} from './fs/hq-fs-provider.js';
import { HqTeamIssues, UnopenableNames } from './fs/hq-fs-issues.js';
import { ReviveGate, reviveAccountViews } from './fs/hq-fs-revive.js';
import { accountTag, isTag, sameAccount, type AccountRef } from './hq/account-ref.js';
import { HqAccounts, type AccountBundle, type BundleFsHooks } from './hq/accounts.js';
import { resolveHqHost } from './hq/hosts.js';
import type { HqUi } from './hq/hq-service.js';
import { SessionStore } from './hq/session-store.js';
import { wakeNotice, wakeTeam, type WakeNotice } from './hq/wake.js';
import { askForPorts, Ports, type PortEntry } from './ports/ports.js';
import {
  groupByFile,
  openMatch,
  parseGlobs,
  SearchView,
  withShownPaths,
  type SearchNode,
} from './search/search-view.js';
import { StatusBar } from './status-bar.js';
import { Terminals } from './terminal/terminals.js';
import { registerTerminalPaste, rewriteInputFor } from './terminal/terminal-paste-wiring.js';
import { AccountTree, type AccountNode } from './tree/account-tree.js';
import { teamState, webUrl } from './tree/labels.js';
import { TeamsTree, type TeamsNode } from './tree/teams-tree.js';
import { cleanLabel, notificationText } from './util/text.js';
import { EXTENSION_VERSION } from './version.js';

function vscodeUi(): HqUi {
  return {
    // A cancellable progress notification, not an information message: it can be CLOSED when the
    // sign-in ends (an information message stays in the notification center for good).
    showDeviceCode: (code, onCancel) => {
      let close: () => void = () => undefined;
      const ended = new Promise<void>((r) => (close = r));
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: notificationText(COPY.deviceCode(code)),
          cancellable: true,
        },
        (_progress, token) => {
          token.onCancellationRequested(() => onCancel());
          return ended;
        },
      );
      return { close };
    },
    openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    copyToClipboard: async (text) => vscode.env.clipboard.writeText(text),
    info: (message) => void vscode.window.showInformationMessage(message),
    askToSignIn: async (_ref, message, modal) =>
      (await (modal
        ? vscode.window.showWarningMessage(message, { modal: true }, COPY.signInAction)
        : vscode.window.showWarningMessage(message, COPY.signInAction))) === COPY.signInAction,
    modal: (message) => void vscode.window.showErrorMessage(message, { modal: true }),
    offerSignInHere: async (message) =>
      (await vscode.window.showInformationMessage(message, COPY.signInHereAction)) ===
      COPY.signInHereAction,
    confirm: async (message, action) =>
      (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  };
}

function hostSetting(): ReturnType<typeof resolveHqHost> {
  const config = vscode.workspace.getConfiguration('hq');
  // `inspect` and globalValue only: an application-scoped setting has no workspace value, and even
  // if a workspace file named one it is never read (decision 26, U25).
  const host = config.inspect<string>('host');
  const allowed = config.inspect<string[]>('allowedHosts');
  return resolveHqHost(host?.globalValue ?? host?.defaultValue, allowed?.globalValue ?? []);
}

/** A node's own account, if it carries one (tree rows, the teamOff notice). */
function nodeAccount(node: TeamsNode | undefined): AccountRef | undefined {
  return node && 'account' in node ? node.account : undefined;
}

/** The team a command was run on: a tree row of that account, or a pick among its teams. */
async function pickTeam(
  b: AccountBundle,
  node: TeamsNode | undefined,
  filter: (t: Team) => boolean = () => true,
): Promise<Team | undefined> {
  if (node && (node.kind === 'team' || node.kind === 'session' || node.kind === 'message')) {
    return node.team;
  }
  // The pick shows each team's state: never from a listing more than 30 s old.
  await b.service.refreshOrgsIfOlder(30_000);
  let teams = b.service.teams().filter(filter);
  if (teams.length === 0) {
    await b.service.refreshOrgs().catch(() => undefined);
    teams = b.service.teams().filter(filter);
  }
  if (teams.length === 1) return teams[0];
  const picked = await vscode.window.showQuickPick(
    teams.map((t) => ({
      label: cleanLabel(t.workspace.name) || t.alias,
      description: `${cleanLabel(t.org.name)} · ${teamState(t.workspace) === 'running' ? COPY.stateRunning : teamState(t.workspace) === 'starting' ? COPY.stateStarting : COPY.stateOff}`,
      team: t,
    })),
    { placeHolder: COPY.pickTeam },
  );
  return picked?.team;
}

/** Wake Team's answer with its buttons (ALSO-3: a session start is what starts a stopped team). */
async function showWakeNotice(
  n: WakeNotice,
  node: Extract<TeamsNode, { kind: 'team' }>,
): Promise<void> {
  const labels = n.actions.map((a) =>
    a === 'newSession' ? COPY.startSessionAction : COPY.openInHqAction,
  );
  const choice =
    n.level === 'info'
      ? await vscode.window.showInformationMessage(n.message, ...labels)
      : n.level === 'warning'
        ? await vscode.window.showWarningMessage(n.message, ...labels)
        : await vscode.window.showErrorMessage(n.message, ...labels);
  if (choice === COPY.startSessionAction) {
    await vscode.commands.executeCommand('hq.newSessionTerminal', node);
  } else if (choice === COPY.openInHqAction) {
    await vscode.commands.executeCommand('hq.openInHqWeb', node);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Output, "AI Workforce One HQ": the account and sign-in lifecycle, redacted (src/log.ts).
  const channel = vscode.window.createOutputChannel('AI Workforce One HQ', { log: true });
  context.subscriptions.push(channel);
  const log = redactingLog(channel);
  log.info(`AI Workforce One HQ ${EXTENSION_VERSION} activated in ${vscode.env.appName}`);
  const store = new SessionStore(context.secrets, context.globalState);
  const ui = vscodeUi();
  const teamIssues = new HqTeamIssues({ host: () => accounts.host() });
  // "<team> is off. Wake it": one per team, closed when the team serves again (live re-test #2).
  const teamOffNotices = new TeamOffNotices();
  const maskedSaid = new Set<string>();

  /** Each account's file system talks to the editor through these (its own tag on everything). */
  const fsHooks = (b: AccountBundle): BundleFsHooks => ({
    onRefused: (org) => {
      const name = b.service.teams().find((t) => t.org.slug === org)?.org.name ?? org;
      void vscode.window.showWarningMessage(COPY.fsEventsRefused(cleanLabel(name) || org));
    },
    ui: {
      // Its Wake Team link runs as the folder's OWN account, whichever is active (MA-S19).
      teamOff: (team, action) =>
        teamOffNotices.say(
          b.tag,
          team.workspace.id,
          cleanLabel(team.workspace.name) || team.alias,
          action,
        ),
      masked: (team, path, names) => {
        const k = `${b.tag}:${team.workspace.id}:${path}`;
        if (maskedSaid.has(k)) return;
        maskedSaid.add(k);
        // 0.2.2: which file, which secret (by name, when HQ said), and what to do instead.
        const file = cleanLabel(path.split('/').pop() ?? path) || path;
        void vscode.window.showInformationMessage(notificationText(COPY.fsMaskedFile(file, names)));
      },
      teamIssue: (team, issue) =>
        teamIssues.onIssue(b.tag, (t) => rootsFor(b, t, accounts.isLegacyUser(b)), team, issue),
      // 0.2.2 review S2: only files open in an editor are re-read when the team's secrets change.
      openState: (team, path) => {
        const doc = vscode.workspace.textDocuments.find((d) => {
          if (d.uri.scheme !== HQ_SCHEME || d.uri.path !== `/${team.alias}/${path}`) return false;
          const r = accounts.resolveAuthority(d.uri.authority);
          return r.kind === 'ok' && r.bundle.tag === b.tag && r.orgSlug === team.org.slug;
        });
        if (!doc) return 'closed';
        return doc.isDirty ? 'dirty' : 'open';
      },
      maskedWhileDirty: (_team, path) => {
        const file = cleanLabel(path.split('/').pop() ?? path) || path;
        void vscode.window.showWarningMessage(notificationText(COPY.fsMaskedWhileEditing(file)));
      },
    },
  });

  const accounts = new HqAccounts({
    store,
    ui,
    host: hostSetting,
    extensionVersion: EXTENSION_VERSION,
    appName: vscode.env.appName,
    windowState: context.workspaceState,
    log,
    windowFocused: () => vscode.window.state.focused,
    firstFolderAuthority: () =>
      (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.scheme === HQ_SCHEME)?.uri
        .authority,
    fsHooks,
  });
  const c: AccountCommands = { accounts, onAccountMissing: (ref) => accountMissing(ref) };

  // ── "This folder belongs to <email>": once per account, with Sign in as; it closes when that
  // account is usable (live re-test #3), so it is a progress notification (src/account-notices.ts).
  const notices = new AccountNotices();
  const sayUnavailable = (info: UnavailableAccount): void => notices.say(info);
  const accountMissing = (ref: AccountRef): void => {
    const tag = accountTag(ref.host, ref.userId);
    const t = store.tombstone(ref.host, tag);
    sayUnavailable({ key: tag, email: t?.email ?? null, tag, userId: ref.userId });
  };

  const teamsTree = new TeamsTree(accounts);
  const teamsView = vscode.window.createTreeView('hq.teams', { treeDataProvider: teamsTree });
  const accountTree = new AccountTree(accounts);
  const ports = new Ports({
    accounts,
    memento: context.globalState,
    onAccountMissing: accountMissing,
  });
  const terminals = new Terminals({
    accounts,
    offerPorts: (account, team, p) => ports.offer(account, team, p),
    // A terminal of the team attached: if the team refused files, ask it again (it may still boot).
    onAttached: (account, team) => accounts.get(account)?.core.expectUp(team, { force: true }),
    onAccountMissing: accountMissing,
    // hq-vscode-image-paste: a dropped image file (or a file of the team's own folder) is typed as
    // its path on the team's machine.
    rewriteInput: rewriteInputFor(accounts),
    // 0.2.2 live FAIL 2: this window's HQ tabs, so a restarted extension host can replace them.
    memento: context.workspaceState,
  });
  // A restarted extension host finds the HQ tabs VS Code kept, with nothing behind them: they are
  // closed and their sessions attached again in fresh terminals.
  terminals.adoptOrphans(vscode.window.terminals);
  // Cmd/Ctrl+V in an HQ terminal: an image on the clipboard is uploaded and its path typed.
  context.subscriptions.push(
    registerTerminalPaste({
      accounts,
      terminals,
      // The extension runs on the local UI host (extensionKind "ui"); were it ever in a remote
      // extension host, the clipboard it can read would not be this computer's.
      remoteHost: () =>
        vscode.env.remoteName !== undefined &&
        context.extension.extensionKind === vscode.ExtensionKind.Workspace,
      log,
    }),
  );
  const status = new StatusBar(accounts, terminals, ports);
  const auth = new HqAuthenticationProvider(accounts);
  const fsProvider = new HqFileSystemProvider({ accounts, onUnavailable: sayUnavailable });
  const searchView = new SearchView();
  const reviveGate = new ReviveGate();
  /**
   * Bring an account's failed roots and never-loaded refused tabs back (U23), at most once per
   * account in 30 s, a request inside the window running once at its end (ReviveGate).
   */
  const reviveSoon = (b: AccountBundle): void => {
    const wait = reviveGate.schedule(b.tag);
    if (wait === null) return; // one is already planned for this account
    setTimeout(
      () => {
        void reviveAccountViews({
          belongs: (uri) => {
            if (uri.scheme !== HQ_SCHEME) return false;
            const r = accounts.resolveAuthority(uri.authority);
            return r.kind === 'ok' && r.bundle.tag === b.tag;
          },
          // Only what the provider refused and never served since: a loaded tab keeps its undo.
          refused: (uri) => fsProvider.isRefused(uri),
          reopened: (uri) => fsProvider.noteReopened(uri),
        }).then((r) => {
          if (r.explorer || r.reopened > 0) {
            log.info(
              `account ${b.tag} usable again: Explorer refreshed ${r.explorer}, editors reopened ${r.reopened}`,
            );
          }
        });
      },
      Math.max(250, wait),
    );
  };

  // Once per install: on Linux without a keyring the sign-in is stored with weaker protection.
  void warnIfKeyringMissing({
    missing: () => keyringMissingHere(vscode.env.appName),
    memento: context.globalState,
    warn: (message) => void vscode.window.showWarningMessage(message),
  });

  const setContext = () => {
    const active = accounts.active();
    teamsView.description = active ? cleanLabel(active.email) : '';
    void vscode.commands.executeCommand('setContext', 'hq.signedIn', active !== null);
    void vscode.commands.executeCommand(
      'setContext',
      'hq.hasOrgs',
      (active?.service.teams().length ?? 0) > 0,
    );
    void vscode.commands.executeCommand('setContext', 'hq.accountCount', accounts.count());
  };
  setContext();

  // Decision 28: when the short-label rule flips (1 ↔ 2 accounts, or a label clash), open folders
  // are renamed in place once the count has settled for a second.
  const labelMode = () =>
    accounts
      .list()
      .map((b) => accounts.shortLabel(b.ref) ?? '')
      .join('|');
  let lastLabels = labelMode();
  let renameTimer: ReturnType<typeof setTimeout> | null = null;
  const onLabelsMaybeChanged = () => {
    const now = labelMode();
    if (now === lastLabels) return;
    lastLabels = now;
    if (renameTimer) clearTimeout(renameTimer);
    renameTimer = setTimeout(() => {
      renameTimer = null;
      void renameHqFolders({ accounts });
    }, 1_000);
  };

  context.subscriptions.push(
    ports,
    terminals,
    status,
    auth,
    teamsTree,
    teamsView,
    accountTree,
    fsProvider,
    teamIssues,
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID,
      AUTH_PROVIDER_LABEL,
      auth,
      { supportsMultipleAccounts: true },
    ),
    vscode.window.registerTreeDataProvider('hq.ports', ports),
    vscode.window.registerTreeDataProvider('hq.account', accountTree),
    vscode.window.registerTreeDataProvider('hq.search', searchView),
    vscode.workspace.registerFileSystemProvider(HQ_SCHEME, fsProvider, { isCaseSensitive: true }),
    vscode.window.registerFileDecorationProvider(teamIssues),
    vscode.window.registerFileDecorationProvider(
      new UnopenableNames((authority) => {
        const r = accounts.resolveAuthority(authority);
        return r.kind === 'ok' ? { core: r.bundle.core, orgSlug: r.orgSlug } : null;
      }),
    ),
    accounts.onDidChange(() => {
      setContext();
      onLabelsMaybeChanged();
    }),
    { dispose: () => notices.dispose() },
    // U23: a "!" root and a failed editor of an account that just became usable come back by
    // themselves (VS Code does not re-resolve them on a Changed event); its notice closes.
    accounts.onAccountUsable((b) => {
      notices.closeFor(b.tag);
      fsProvider.resetReopens(b.tag); // a new episode: refused tabs get their 2 tries again
      reviveSoon(b);
    }),
    // Live re-test #2: a tab refused while its team was asleep is retried once the team answers.
    fsProvider.onRefusedReachable((tag) => {
      const b = accounts.byTag(tag);
      if (b) reviveSoon(b);
    }),
    fsProvider.onTeamUp(({ tag, workspaceId }) => teamOffNotices.closeFor(tag, workspaceId)),
    { dispose: () => teamOffNotices.dispose() },
    accounts.onAccountRemoved((ref) => {
      teamIssues.clear(accountTag(ref.host, ref.userId));
      teamOffNotices.forgetAccount(accountTag(ref.host, ref.userId));
      searchView.clearAccount((a) => sameAccount(a, ref));
      notices.forget(accountTag(ref.host, ref.userId));
    }),
    accounts.onAccountRenewed((ref) => accounts.get(ref)?.events.reconnectAll()),
    { dispose: () => renameTimer && clearTimeout(renameTimer) },
    // Decision 23: another window may have added, signed out or renewed an account.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) accounts.rederive('focus');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hq.host') || e.affectsConfiguration('hq.allowedHosts')) {
        accounts.rederive('host');
        setContext();
        const verdict = hostSetting();
        if (!verdict.ok) void vscode.window.showErrorMessage(COPY.hostNotAllowed(verdict.host));
        else if (accounts.count() === 0)
          void vscode.window.showInformationMessage(COPY.hostChanged);
      }
    }),
    store,
    { dispose: () => accounts.dispose() },

    // ── accounts ───────────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('hq.signIn', async () => {
      // With accounts here, a signed-out window picks one (or adds one), never a pointless grant.
      if (accounts.count() === 0) return (await accounts.signIn({ kind: 'first' })).outcome;
      await switchAccount(c);
      return 'busy';
    }),
    vscode.commands.registerCommand('hq.signOut', async () => {
      const active = accounts.active();
      if (active) await accounts.signOut(active.ref, { confirm: true });
      else await signOutAccount(c);
    }),
    vscode.commands.registerCommand('hq.addAccount', async () =>
      accounts.count() === 0
        ? (await accounts.signIn({ kind: 'first' })).outcome
        : (await accounts.signIn({ kind: 'add' })).outcome,
    ),
    vscode.commands.registerCommand('hq.switchAccount', (ref?: AccountRef) =>
      switchAccount(c, ref && 'userId' in ref ? ref : undefined),
    ),
    vscode.commands.registerCommand(
      'hq.signOutAccount',
      (arg?: AccountRef | Extract<AccountNode, { kind: 'account' }>) =>
        signOutAccount(c, arg && 'ref' in arg ? arg.ref : arg),
    ),
    // The notice's "Sign in as <email>" link (account-notices.ts). Renews a listed account.
    vscode.commands.registerCommand('hq.signInAs', async (tag?: unknown, userId?: unknown) => {
      if (typeof tag === 'string' && typeof userId === 'string') {
        await accounts.signInAs(tag, userId);
      }
    }),
    vscode.commands.registerCommand('hq.renewAccount', async (ref?: AccountRef) => {
      if (ref) await accounts.signIn({ kind: 'renew', ref });
    }),
    vscode.commands.registerCommand('hq.accounts.primaryAction', () => primaryAction(c)),

    // ── teams ──────────────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('hq.refresh', async () => {
      teamsTree.refresh();
      const b = await requireAccount(c);
      await b?.service.refreshOrgs().catch(() => undefined);
    }),
    vscode.commands.registerCommand('hq.manageDevices', () => {
      const host = accounts.host();
      if (host) void vscode.env.openExternal(vscode.Uri.parse(`${host}/account/devices`));
    }),
    vscode.commands.registerCommand('hq.openInHqWeb', (node?: TeamsNode) => {
      const host = accounts.host();
      if (!host || !node || node.kind === 'org') return;
      const url =
        node.kind === 'session'
          ? webUrl(host, { workspaceId: node.team.workspace.id, sessionId: node.session.id })
          : webUrl(host, { workspaceId: node.team.workspace.id });
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('hq.wakeTeam', async (node?: TeamsNode) => {
      const b = await requireAccount(c, nodeAccount(node));
      if (!b) return;
      const team = await pickTeam(b, node, (t) => teamState(t.workspace) !== 'running');
      if (!team) return;
      const name = cleanLabel(team.workspace.name) || team.alias;
      teamsTree.setWaking(team.workspace.id, true);
      // Files it refused are asked again until it serves (a wake answers before the machine does).
      b.core.expectUp(team, { force: true });
      try {
        const outcome = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: notificationText(COPY.waking(name)),
          },
          (progress) =>
            b.service.call((client) =>
              wakeTeam(client, team, {
                now: Date.now,
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                report: (message) =>
                  progress.report({
                    message: message === COPY.waking(name) ? '' : notificationText(message),
                  }),
              }),
            ),
        );
        if (outcome.kind === 'running') b.core.expectUp(team, { force: true });
        void showWakeNotice(wakeNotice(outcome, name, team), {
          kind: 'team',
          account: b.ref,
          team,
        });
      } catch {
        /* the service already said what the sign-in needs */
      } finally {
        teamsTree.setWaking(team.workspace.id, false);
        await b.service.refreshOrgs().catch(() => undefined);
      }
    }),
    // The off notice's "Wake Team" link (team-off-notices.ts): [tag, workspaceId], validated.
    vscode.commands.registerCommand(
      'hq.wakeTeamOf',
      async (tag?: unknown, workspaceId?: unknown) => {
        if (!isTag(tag) || typeof workspaceId !== 'string') return;
        const b = accounts.byTag(tag);
        const team = b?.service.teams().find((t) => t.workspace.id === workspaceId);
        if (b && team) {
          await vscode.commands.executeCommand('hq.wakeTeam', {
            kind: 'team',
            account: b.ref,
            team,
          } satisfies TeamsNode);
        }
      },
    ),
    vscode.commands.registerCommand('hq.attachSession', async (node?: TeamsNode) => {
      if (node?.kind === 'session') {
        terminals.attach({ account: node.account, team: node.team, session: node.session });
        return;
      }
      const b = await requireAccount(c, nodeAccount(node));
      if (!b) return;
      const team = await pickTeam(b, node, (t) => t.workspace.rights.attach);
      if (!team) return;
      teamsTree.refresh();
      const sessions = (await teamsTree.getChildren({ kind: 'team', account: b.ref, team })) ?? [];
      const picked = await vscode.window.showQuickPick(
        sessions
          .filter((n): n is Extract<TeamsNode, { kind: 'session' }> => n.kind === 'session')
          .map((n) => ({
            label: cleanLabel(n.session.name),
            description: cleanLabel(n.session.ownerName),
            node: n,
          })),
        { placeHolder: COPY.pickSession },
      );
      if (picked) {
        terminals.attach({
          account: picked.node.account,
          team: picked.node.team,
          session: picked.node.session,
        });
      }
    }),
    vscode.commands.registerCommand('hq.newSessionTerminal', async (node?: TeamsNode) => {
      const b = await requireAccount(c, nodeAccount(node));
      if (!b) return;
      const team = await pickTeam(b, node, (t) => t.workspace.rights.forward);
      if (!team) return;
      await terminals.newSession(b.ref, team);
      teamsTree.refresh();
    }),

    // ── ports ──────────────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('hq.forwardPort', async (node?: TeamsNode) => {
      const b = await requireAccount(c, nodeAccount(node));
      if (!b) return;
      const team = await pickTeam(b, node, (t) => t.workspace.rights.forward);
      if (!team) return;
      const chosen = await askForPorts();
      if (chosen) await ports.start(b.ref, team, chosen.remote, chosen.local);
    }),
    vscode.commands.registerCommand('hq.ports.open', (entry: PortEntry) => {
      const url = ports.localUrl(entry);
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('hq.ports.copy', async (entry: PortEntry) => {
      const url = ports.localUrl(entry);
      if (!url) return;
      await vscode.env.clipboard.writeText(url);
      void vscode.window.setStatusBarMessage(COPY.addressCopied(url), 3_000);
    }),
    vscode.commands.registerCommand('hq.ports.stop', (entry: PortEntry) => ports.stop(entry)),
    vscode.commands.registerCommand('hq.ports.resume', (entry: PortEntry) => ports.resume(entry)),
    vscode.commands.registerCommand('hq.ports.forwardDetected', async (entry: PortEntry) => {
      if (entry.kind === 'detected') {
        await ports.start(entry.account, entry.team, entry.port, entry.port);
      }
    }),
    vscode.commands.registerCommand('hq.ports.dismissDetected', (entry: PortEntry) =>
      ports.dismiss(entry),
    ),

    // ── team files ─────────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('hq.openTeamFiles', async (node?: TeamsNode) => {
      const b = await requireAccount(c, nodeAccount(node));
      if (!b) return;
      const team = await pickTeam(b, node, (t) => t.workspace.rights.files?.read === true);
      if (!team) return;
      // Decision 24: an open folder of this team (either form) is revealed, never duplicated.
      const open = openFolderOf(b, team, accounts.isLegacyUser(b));
      if (open) {
        void vscode.commands.executeCommand('revealInExplorer', open.uri);
        return;
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
        uri: teamRootUri(b.ref, team),
        name: teamFolderName(team, accounts.shortLabel(b.ref)),
      });
    }),
    vscode.commands.registerCommand('hq.searchTeamFiles', async (node?: TeamsNode) => {
      // The team of the active hq:// editor (as ITS account) first, else a pick of the account's.
      const active = vscode.window.activeTextEditor?.document.uri;
      let b: AccountBundle | null = null;
      let team: Team | undefined;
      if (!node && active?.scheme === HQ_SCHEME) {
        const r = accounts.resolveAuthority(active.authority);
        if (r.kind === 'ok') {
          b = r.bundle;
          const alias = relPathOf(active).alias;
          team = b.service.teams().find((t) => t.org.slug === r.orgSlug && t.alias === alias);
        }
      }
      if (!b || !team) {
        b = await requireAccount(c, nodeAccount(node));
        if (!b) return;
        team = await pickTeam(b, node, (t) => t.workspace.rights.files?.read === true);
      }
      if (!team) return;
      const bundle = b;
      const query = await vscode.window.showInputBox({ prompt: COPY.searchPrompt });
      if (!query) return;
      // Pattern search is for members who can edit the team (the server refuses it otherwise).
      const canRegex = team.workspace.rights.files?.write === true;
      const options = await vscode.window.showQuickPick(
        [...(canRegex ? [COPY.searchRegex] : []), COPY.searchCase, COPY.searchWord].map(
          (label) => ({ label }),
        ),
        { canPickMany: true, placeHolder: COPY.searchOptions },
      );
      if (options === undefined) return;
      const picked = new Set(options.map((o) => o.label));
      const include = parseGlobs(await vscode.window.showInputBox({ prompt: COPY.searchInclude }));
      const exclude = parseGlobs(await vscode.window.showInputBox({ prompt: COPY.searchExclude }));
      const req: FsSearchTextRequest = {
        query,
        isRegex: picked.has(COPY.searchRegex),
        caseSensitive: picked.has(COPY.searchCase),
        wholeWord: picked.has(COPY.searchWord),
        ...(include.length ? { include } : {}),
        ...(exclude.length ? { exclude } : {}),
      };
      const searchTeam = team;
      try {
        const res = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: COPY.searchTitle },
          () => bundle.fsApi.search(searchTeam, req),
        );
        searchView.show(
          await withShownPaths(groupByFile(bundle.ref, searchTeam, res), (t, p) =>
            bundle.core.shownPath(t, p),
          ),
        );
        void vscode.commands.executeCommand('setContext', 'hq.hasSearch', true);
        void vscode.commands.executeCommand('hq.search.focus');
      } catch (err) {
        void bundle.service.handleError(err);
        const detail =
          err instanceof FsApiError || err instanceof Error ? err.message : COPY.unreachable;
        void vscode.window.showErrorMessage(COPY.searchFailed(detail));
      }
    }),
    vscode.commands.registerCommand('hq.search.open', (node: SearchNode) => {
      const b = node.kind === 'summary' ? null : accounts.get(node.account);
      if (node.kind !== 'summary' && !b) accountMissing(node.account);
      return openMatch(
        node,
        b
          ? {
              shownPath: (team, p) => b.core.shownPath(team, p),
              uriOf: (team, p) => uriFor(b, team, p, accounts.isLegacyUser(b)),
            }
          : null,
      );
    }),
  );

  // One listing for this window's account, so the tree paints from fresh data (a read: never wakes).
  void accounts
    .active()
    ?.service.refreshOrgs()
    .catch(() => undefined);
}

export function deactivate(): void {
  /* everything is in context.subscriptions */
}
