/**
 * The account switcher and what commands do about accounts (hq-vscode-multi-account §Wireframes,
 * decisions 7, 16, 21, 27, 28). Kept apart from `extension.ts` so the unit tier drives it.
 *
 *   switcher   active account first ("Active in this window"), then by email (never by recency),
 *              a sign-out button on each, "Add another account..." last. Picking switches at once:
 *              nothing closes, nothing asks.
 *   commands   a command that needs an account takes the one its tree node, URI or spec carries;
 *              with none, the window's active one; with no active account, the switcher opens and
 *              the command continues with the choice (decision 27). Escape does nothing.
 *   names      folder names carry the account's short label only while 2 or more accounts are
 *              signed in; when that flips, open `hq://` folders are renamed IN PLACE (same URI).
 */
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import { COPY } from './copy.js';
import { shortAccountLabel, type AccountRef } from './hq/account-ref.js';
import type { AccountBundle, HqAccounts } from './hq/accounts.js';
import { HQ_SCHEME, relPathOf, teamFolderName } from './fs/hq-fs-provider.js';
import { cleanLabel } from './util/text.js';

export type SwitcherItem = vscode.QuickPickItem & { ref?: AccountRef; add?: true };

type AccountsView = Pick<HqAccounts, 'list' | 'active'>;

/** The switcher's rows (MA-U2). */
export function switcherItems(accounts: AccountsView): SwitcherItem[] {
  const active = accounts.active();
  const rest = accounts.list().filter((b) => b !== active);
  const rows = (active ? [active, ...rest] : rest).map(
    (b): SwitcherItem => ({
      label: `$(account) ${cleanLabel(b.email)}`,
      ...(b === active ? { description: COPY.accountActiveNote } : {}),
      ref: b.ref,
      buttons: [{ iconPath: new vscode.ThemeIcon('sign-out'), tooltip: COPY.signOut }],
    }),
  );
  return [
    ...rows,
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(add) ${COPY.addAnotherAccount}`, add: true },
  ];
}

/** Show the switcher. Resolves the chosen account, `'add'`, or undefined (Escape). */
export function showSwitcher(
  accounts: AccountsView,
  opts: { title: string; onSignOut: (ref: AccountRef) => void },
): Promise<AccountRef | 'add' | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<SwitcherItem>();
    qp.items = switcherItems(accounts);
    qp.placeholder = opts.title;
    qp.title = opts.title;
    let settled = false;
    const done = (v: AccountRef | 'add' | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(v);
      qp.dispose();
    };
    qp.onDidTriggerItemButton((e) => {
      if (!e.item.ref) return;
      done(undefined);
      opts.onSignOut(e.item.ref);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      done(item?.add ? 'add' : item?.ref);
    });
    qp.onDidHide(() => done(undefined));
    qp.show();
  });
}

export interface AccountCommands {
  accounts: Pick<HqAccounts, 'list' | 'active' | 'get' | 'setActive' | 'signIn' | 'signOut'>;
  /** A node's account is not signed in here: "Sign in as <email>" (never another account). */
  onAccountMissing?: (account: AccountRef) => void;
}

/**
 * Decision 27: the account a command runs as. The node's own account first; else the window's
 * active one; else the switcher ("Choose an account for this window"), whose choice becomes active.
 */
export async function requireAccount(
  c: AccountCommands,
  fromNode?: AccountRef,
): Promise<AccountBundle | null> {
  if (fromNode) {
    const b = c.accounts.get(fromNode);
    if (!b) c.onAccountMissing?.(fromNode);
    return b;
  }
  const active = c.accounts.active();
  if (active) return active;
  const choice = await showSwitcher(c.accounts, {
    title: COPY.pickAccountForCommand,
    onSignOut: (ref) => void c.accounts.signOut(ref, { confirm: true }),
  });
  if (choice === undefined) return null;
  if (choice === 'add') {
    const r = await c.accounts.signIn({ kind: 'add' });
    return r.ref ? c.accounts.get(r.ref) : null;
  }
  await c.accounts.setActive(choice);
  return c.accounts.get(choice);
}

/** "HQ: Switch Account": a ref switches at once (the Account view's row); none opens the switcher. */
export async function switchAccount(c: AccountCommands, ref?: AccountRef): Promise<void> {
  if (ref) {
    await c.accounts.setActive(ref);
    return;
  }
  const choice = await showSwitcher(c.accounts, {
    title: COPY.pickAccount,
    onSignOut: (r) => void c.accounts.signOut(r, { confirm: true }),
  });
  if (choice === 'add') await c.accounts.signIn({ kind: 'add' });
  else if (choice) await c.accounts.setActive(choice);
}

/** The status-bar click: the sidebar with one account (0.1.1), the switcher with more (MA-U1/U2). */
export async function primaryAction(c: AccountCommands): Promise<void> {
  if (c.accounts.list().length <= 1) {
    await vscode.commands.executeCommand('workbench.view.extension.hq');
    return;
  }
  await switchAccount(c);
}

/** "HQ: Sign Out of Account...": the given account, else a pick naming each email. */
export async function signOutAccount(c: AccountCommands, ref?: AccountRef): Promise<void> {
  let target = ref;
  if (!target) {
    const all = c.accounts.list();
    if (all.length === 1) target = all[0]!.ref;
    else {
      const picked = await vscode.window.showQuickPick(
        all.map((b) => ({ label: cleanLabel(b.email), ref: b.ref })),
        { placeHolder: COPY.pickAccount },
      );
      target = picked?.ref;
    }
  }
  if (target) await c.accounts.signOut(target, { confirm: true });
}

// ── decision 28: names follow the account count ─────────────────────────────────────────────────

export interface FolderNaming {
  accounts: Pick<HqAccounts, 'list' | 'resolveAuthority' | 'shortLabel'>;
}

/** What an open `hq://` folder should be called now, or null when it is not ours to name. */
export function wantedFolderName(n: FolderNaming, uri: vscode.Uri): string | null {
  if (uri.scheme !== HQ_SCHEME) return null;
  const r = n.accounts.resolveAuthority(uri.authority);
  if (r.kind !== 'ok') return null;
  let team: Team;
  try {
    team = r.bundle.core.team(r.orgSlug, relPathOf(uri).alias);
  } catch {
    return null;
  }
  if (relPathOf(uri).path !== '') return null;
  return teamFolderName(team, n.accounts.shortLabel(r.bundle.ref));
}

/** Every name this extension may have given that folder (so a person's own name is never touched). */
function namesWeGive(n: FolderNaming, uri: vscode.Uri): string[] {
  const r = n.accounts.resolveAuthority(uri.authority);
  if (r.kind !== 'ok') return [];
  try {
    const team = r.bundle.core.team(r.orgSlug, relPathOf(uri).alias);
    const email = r.bundle.email;
    const labels = new Set<string | undefined>([undefined, email, shortAccountLabel(email, [])]);
    return [...labels].map((l) => teamFolderName(team, l));
  } catch {
    return [];
  }
}

/**
 * Rename open `hq://` folders in place when their label should change (same URI, so editors stay
 * open and nothing reloads). One `updateWorkspaceFolders` call per folder, each after the previous
 * one landed. A single-folder window shows the folder by its URI: nothing to rename there.
 */
export async function renameHqFolders(n: FolderNaming): Promise<number> {
  if (vscode.workspace.workspaceFile === undefined) return 0;
  let renamed = 0;
  const folders = [...(vscode.workspace.workspaceFolders ?? [])];
  for (const f of folders) {
    const want = wantedFolderName(n, f.uri);
    if (want === null || want === f.name) continue;
    if (!namesWeGive(n, f.uri).includes(f.name)) continue;
    const landed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        sub.dispose();
        resolve();
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 2_000);
    });
    if (vscode.workspace.updateWorkspaceFolders(f.index, 1, { uri: f.uri, name: want })) {
      renamed += 1;
      await landed;
    }
  }
  return renamed;
}

/** Decision 24: the open folder of this team, in either form, so Open Team Files reveals it. */
export function openFolderOf(
  b: Pick<AccountBundle, 'tag'>,
  team: Team,
  isLegacyUser: boolean,
): vscode.WorkspaceFolder | undefined {
  return (vscode.workspace.workspaceFolders ?? []).find((f) => {
    if (f.uri.scheme !== HQ_SCHEME || relPathOf(f.uri).alias !== team.alias) return false;
    if (relPathOf(f.uri).path !== '') return false;
    return (
      f.uri.authority === `${b.tag}@${team.org.slug}` ||
      (isLegacyUser && f.uri.authority === team.org.slug)
    );
  });
}
