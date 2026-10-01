/**
 * AI Workforce One HQ for VS Code (feature `hq-vscode`, phase 1: sign-in, terminals, ports).
 *
 * The extension talks ONLY to HQ's own APIs (decision 1): no SSH, nothing installed on a team
 * machine. It runs on the local UI host only (`extensionKind: ["ui"]`, decision 25), so the device
 * key, the tokens and the port listeners always stay on the person's own computer, even in a remote
 * window. No telemetry, no webview, nothing downloaded at run time (decision 28, D15).
 *
 * `activate` only wires things up: nothing talks to HQ until a view is shown or a command runs,
 * except one team listing when an existing sign-in is found (reads never wake a machine).
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import {
  AUTH_PROVIDER_ID,
  AUTH_PROVIDER_LABEL,
  HqAuthenticationProvider,
} from './auth/auth-provider.js';
import { keyringMissingHere, warnIfKeyringMissing } from './auth/keyring.js';
import { COPY } from './copy.js';
import { resolveHqHost } from './hq/hosts.js';
import { HqService, type HqUi } from './hq/hq-service.js';
import { SessionStore } from './hq/session-store.js';
import { wakeTeam } from './hq/wake.js';
import { askForPorts, Ports, type PortEntry } from './ports/ports.js';
import { StatusBar } from './status-bar.js';
import { Terminals } from './terminal/terminals.js';
import { AccountTree } from './tree/account-tree.js';
import { teamState, webUrl } from './tree/labels.js';
import { TeamsTree, type TeamsNode } from './tree/teams-tree.js';
import { cleanLabel } from './util/text.js';
import { EXTENSION_VERSION } from './version.js';
import { NotLoggedInError } from '@hq/client/api.js';
import type { FsSearchTextRequest } from '@kpa/shared/remote-fs.types';
import { EventsHub } from './fs/events-client.js';
import { FsApiError, HqFsApi } from './fs/fs-api.js';
import { HqFsCore } from './fs/fs-core.js';
import {
  HQ_SCHEME,
  HqFileSystemProvider,
  relPathOf,
  teamFolderName,
  teamRootUri,
} from './fs/hq-fs-provider.js';
import { HqTeamIssues, UnopenableNames } from './fs/hq-fs-issues.js';
import {
  groupByFile,
  withShownPaths,
  openMatch,
  parseGlobs,
  SearchView,
  type SearchNode,
} from './search/search-view.js';

function vscodeUi(): HqUi {
  return {
    showDeviceCode: (code, onCancel) => {
      let done = false;
      void vscode.window
        .showInformationMessage(COPY.deviceCode(code), COPY.deviceCodeCancel)
        .then((choice) => {
          if (!done && choice === COPY.deviceCodeCancel) onCancel();
        });
      return {
        close: () => {
          done = true;
        },
      };
    },
    openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    copyToClipboard: async (text) => vscode.env.clipboard.writeText(text),
    info: (message) => void vscode.window.showInformationMessage(message),
    askToSignIn: async (message, modal) =>
      (await (modal
        ? vscode.window.showWarningMessage(message, { modal: true }, COPY.signInAction)
        : vscode.window.showWarningMessage(message, COPY.signInAction))) === COPY.signInAction,
    modal: (message) => void vscode.window.showErrorMessage(message, { modal: true }),
    offerSignInHere: async (message) =>
      (await vscode.window.showInformationMessage(message, COPY.signInHereAction)) ===
      COPY.signInHereAction,
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

/** The team a command was run on: a tree row, or a pick among the teams. */
async function pickTeam(
  service: HqService,
  node: TeamsNode | undefined,
  filter: (t: Team) => boolean = () => true,
): Promise<Team | undefined> {
  if (node && (node.kind === 'team' || node.kind === 'session' || node.kind === 'message')) {
    return node.team;
  }
  let teams = service.teams().filter(filter);
  if (teams.length === 0) {
    await service.refreshOrgs().catch(() => undefined);
    teams = service.teams().filter(filter);
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

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore(context.secrets, context.globalState);
  const service = new HqService({
    store,
    ui: vscodeUi(),
    host: hostSetting,
    extensionVersion: EXTENSION_VERSION,
    appName: vscode.env.appName,
  });
  const teamsTree = new TeamsTree(service);
  const accountTree = new AccountTree(service);
  const ports = new Ports(service, context.globalState);
  const terminals = new Terminals({ service, offerPorts: (team, p) => ports.offer(team, p) });
  const status = new StatusBar(service, terminals, ports);
  const auth = new HqAuthenticationProvider(service);

  // ── hq:// (phase 2): the team folders, their change stream, and search ─────────────────────────
  const fsApi = new HqFsApi(async () => {
    const c = await service.client();
    if (!c) throw new NotLoggedInError(COPY.signedOutWelcome);
    return c;
  });
  const events = new EventsHub({
    client: () => service.client(),
    onUnauthorized: () => service.refreshOrgs().catch(() => undefined),
    // Nonprod 2026-09-30: a refused socket used to retry silently forever; say it once.
    onRefused: (org) => {
      const name = service.teams().find((t) => t.org.slug === org)?.org.name ?? org;
      void vscode.window.showWarningMessage(COPY.fsEventsRefused(cleanLabel(name) || org));
    },
  });
  const teamIssues = new HqTeamIssues({ host: () => service.host() });
  const offSaid = new Map<string, number>();
  const maskedSaid = new Set<string>();
  const fsCore = new HqFsCore({
    teams: () => service.teams(),
    api: fsApi,
    events,
    onApiError: (err) => void service.handleError(err),
    ui: {
      teamOff: (team, action) => {
        const last = offSaid.get(team.workspace.id) ?? 0;
        if (Date.now() - last < 60_000) return;
        offSaid.set(team.workspace.id, Date.now());
        const name = cleanLabel(team.workspace.name) || team.alias;
        void vscode.window
          .showWarningMessage(
            action === 'open' ? COPY.fsOffOpen(name) : COPY.fsOffSave(name),
            COPY.wakeTeam,
          )
          .then((choice) => {
            if (choice === COPY.wakeTeam) {
              void vscode.commands.executeCommand('hq.wakeTeam', { kind: 'team', team });
            }
          });
      },
      masked: (team, path) => {
        const k = `${team.workspace.id}:${path}`;
        if (maskedSaid.has(k)) return;
        maskedSaid.add(k);
        void vscode.window.showInformationMessage(COPY.fsMasked);
      },
      teamIssue: (team, issue) => teamIssues.onIssue(team, issue),
    },
  });
  const fsProvider = new HqFileSystemProvider(fsCore);
  const searchView = new SearchView();
  service.onRevoked(() => {
    fsCore.clear();
    teamIssues.clear();
    events.closeAll();
    searchView.clear();
  });

  // Once per install: on Linux without a keyring the sign-in is stored with weaker protection.
  void warnIfKeyringMissing({
    missing: () => keyringMissingHere(vscode.env.appName),
    memento: context.globalState,
    warn: (message) => void vscode.window.showWarningMessage(message),
  });

  const setContext = () => {
    void vscode.commands.executeCommand('setContext', 'hq.signedIn', service.signedIn());
    void vscode.commands.executeCommand('setContext', 'hq.hasOrgs', service.teams().length > 0);
  };
  setContext();

  context.subscriptions.push(
    store,
    service,
    teamsTree,
    accountTree,
    ports,
    terminals,
    status,
    auth,
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID,
      AUTH_PROVIDER_LABEL,
      auth,
      {
        supportsMultipleAccounts: false,
      },
    ),
    vscode.window.registerTreeDataProvider('hq.teams', teamsTree),
    vscode.window.registerTreeDataProvider('hq.ports', ports),
    vscode.window.registerTreeDataProvider('hq.account', accountTree),
    vscode.window.registerTreeDataProvider('hq.search', searchView),
    vscode.workspace.registerFileSystemProvider(HQ_SCHEME, fsProvider, { isCaseSensitive: true }),
    fsProvider,
    teamIssues,
    vscode.window.registerFileDecorationProvider(teamIssues),
    vscode.window.registerFileDecorationProvider(new UnopenableNames(fsCore)),
    { dispose: () => events.closeAll() },
    fsCore,
    service.onDidChange(setContext),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hq.host') || e.affectsConfiguration('hq.allowedHosts')) {
        service.hostChanged();
        setContext();
        const verdict = hostSetting();
        if (!verdict.ok) void vscode.window.showErrorMessage(COPY.hostNotAllowed(verdict.host));
        else if (!service.signedIn()) void vscode.window.showInformationMessage(COPY.hostChanged);
      }
    }),

    vscode.commands.registerCommand('hq.signIn', () => service.signIn()),
    vscode.commands.registerCommand('hq.signOut', () => service.signOut()),
    vscode.commands.registerCommand('hq.refresh', async () => {
      teamsTree.refresh();
      await service.refreshOrgs().catch(() => undefined);
    }),
    vscode.commands.registerCommand('hq.manageDevices', () => {
      const host = service.host();
      if (host) void vscode.env.openExternal(vscode.Uri.parse(`${host}/account/devices`));
    }),
    vscode.commands.registerCommand('hq.openInHqWeb', (node?: TeamsNode) => {
      const host = service.host();
      if (!host || !node || node.kind === 'org') return;
      const url =
        node.kind === 'session'
          ? webUrl(host, { workspaceId: node.team.workspace.id, sessionId: node.session.id })
          : webUrl(host, { workspaceId: node.team.workspace.id });
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('hq.wakeTeam', async (node?: TeamsNode) => {
      const team = await pickTeam(service, node, (t) => teamState(t.workspace) !== 'running');
      if (!team) return;
      const name = cleanLabel(team.workspace.name) || team.alias;
      teamsTree.setWaking(team.workspace.id, true);
      try {
        const outcome = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: COPY.waking(name) },
          (progress) =>
            service.call((client) =>
              wakeTeam(client, team, {
                now: Date.now,
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                report: (message) =>
                  progress.report({ message: message === COPY.waking(name) ? '' : message }),
              }),
            ),
        );
        if (outcome.kind === 'running') void vscode.window.showInformationMessage(COPY.woke(name));
        else if (outcome.kind === 'timeout')
          void vscode.window.showWarningMessage(COPY.wakeTimeout(name));
        else if (outcome.kind === 'no-machine')
          void vscode.window.showWarningMessage(COPY.wakeNoMachine(name));
        else if (outcome.kind === 'throttled')
          void vscode.window.showWarningMessage(COPY.wakeThrottled);
        else if (outcome.kind === 'unavailable')
          void vscode.window.showWarningMessage(COPY.wakeUnavailable);
        else if (outcome.error.status === 403)
          void vscode.window.showErrorMessage(COPY.forwardNotAllowed(name));
        else void vscode.window.showErrorMessage(outcome.error.message);
      } catch {
        /* the service already said what the sign-in needs */
      } finally {
        teamsTree.setWaking(team.workspace.id, false);
        await service.refreshOrgs().catch(() => undefined);
      }
    }),
    vscode.commands.registerCommand('hq.attachSession', async (node?: TeamsNode) => {
      if (node?.kind === 'session') {
        terminals.attach({ team: node.team, session: node.session });
        return;
      }
      const team = await pickTeam(service, node, (t) => t.workspace.rights.attach);
      if (!team) return;
      teamsTree.refresh();
      const sessions = (await teamsTree.getChildren({ kind: 'team', team })) ?? [];
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
      if (picked) terminals.attach({ team: picked.node.team, session: picked.node.session });
    }),
    vscode.commands.registerCommand('hq.newSessionTerminal', async (node?: TeamsNode) => {
      const team = await pickTeam(service, node, (t) => t.workspace.rights.forward);
      if (!team) return;
      await terminals.newSession(team);
      teamsTree.refresh();
    }),
    vscode.commands.registerCommand('hq.forwardPort', async (node?: TeamsNode) => {
      const team = await pickTeam(service, node, (t) => t.workspace.rights.forward);
      if (!team) return;
      const chosen = await askForPorts();
      if (chosen) await ports.start(team, chosen.remote, chosen.local);
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
      if (entry.kind === 'detected') await ports.start(entry.team, entry.port, entry.port);
    }),
    vscode.commands.registerCommand('hq.ports.dismissDetected', (entry: PortEntry) =>
      ports.dismiss(entry),
    ),
    vscode.commands.registerCommand('hq.openTeamFiles', async (node?: TeamsNode) => {
      const team = await pickTeam(service, node, (t) => t.workspace.rights.files?.read === true);
      if (!team) return;
      const uri = teamRootUri(team);
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.some((f) => f.uri.toString() === uri.toString())) return;
      vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
        uri,
        name: teamFolderName(team),
      });
    }),
    vscode.commands.registerCommand('hq.searchTeamFiles', async (node?: TeamsNode) => {
      // The team of the active hq:// editor first, else the open team folders, else a pick.
      const active = vscode.window.activeTextEditor?.document.uri;
      let team =
        active?.scheme === HQ_SCHEME
          ? service
              .teams()
              .find((t) => t.org.slug === active.authority && t.alias === relPathOf(active).alias)
          : undefined;
      if (!team) {
        team = await pickTeam(service, node, (t) => t.workspace.rights.files?.read === true);
      }
      if (!team) return;
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
      try {
        const res = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: COPY.searchTitle },
          () => fsApi.search(team!, req),
        );
        searchView.show(
          await withShownPaths(groupByFile(team, res), (t, p) => fsCore.shownPath(t, p)),
        );
        void vscode.commands.executeCommand('setContext', 'hq.hasSearch', true);
        void vscode.commands.executeCommand('hq.search.focus');
      } catch (err) {
        const detail =
          err instanceof FsApiError || err instanceof Error ? err.message : COPY.unreachable;
        void vscode.window.showErrorMessage(COPY.searchFailed(detail));
      }
    }),
    vscode.commands.registerCommand('hq.search.open', (node: SearchNode) =>
      openMatch(node, (team, p) => fsCore.shownPath(team, p)),
    ),
  );

  // One listing for an existing sign-in, so the tree paints from fresh data (a read: never wakes).
  if (service.signedIn()) void service.refreshOrgs().catch(() => undefined);
}

export function deactivate(): void {
  /* everything is in context.subscriptions */
}
