/**
 * The Accounts-menu entry (decision 3): registered for the UX only (each account shows in VS Code's
 * Accounts menu, with its own Sign Out there). The session's `accessToken` is the SENTINEL
 * `'hq-session'`, never an `hqa_` token: any other extension may call `authentication.getSession`
 * for any provider, and there is nothing to gain by handing one a bearer.
 *
 * One session per account (hq-vscode-multi-account decision 15): `id` = the account TAG (stable
 * across a renew, so a renew reads as `changed`, never remove + add), `account.id` = the HQ user id,
 * label = the FULL email (VS Code signs out every session whose label matches the clicked one, P0
 * check 4, so a short label could sign out the wrong account).
 */
import * as vscode from 'vscode';
import { accountTag } from '../hq/account-ref.js';
import type { AccountBundle, HqAccounts, SignInIntent } from '../hq/accounts.js';
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';
import { KEY_NS } from '../brand-keys.js';

/** The build's brand (`aiworkforceone-hq` / `AI Workforce One HQ` for AWO). */
export const AUTH_PROVIDER_ID = ACTIVE_DEV_BRAND.vscode.authProviderId;
export const AUTH_PROVIDER_LABEL = ACTIVE_DEV_BRAND.displayName;
/** What `AuthenticationSession.accessToken` carries. Never a credential. */
export const SESSION_SENTINEL = `${KEY_NS}-session`;

const sessionOf = (b: AccountBundle): vscode.AuthenticationSession => ({
  id: b.tag,
  accessToken: SESSION_SENTINEL,
  account: { id: b.account.user.id, label: b.account.user.email },
  scopes: [],
});

type AccountOption = { account?: { id: string; label: string } | undefined } | undefined;

export class HqAuthenticationProvider implements vscode.AuthenticationProvider {
  private readonly changed =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changed.event;
  private last: Map<string, { session: vscode.AuthenticationSession; grantId: string }>;
  private readonly subscription: { dispose(): unknown };

  constructor(
    private readonly accounts: Pick<
      HqAccounts,
      'list' | 'host' | 'signIn' | 'signOut' | 'byTag' | 'onDidChange'
    >,
  ) {
    this.last = this.current();
    this.subscription = accounts.onDidChange(() => {
      const next = this.current();
      const before = this.last;
      this.last = next;
      const added = [...next.values()].filter((s) => !before.has(s.session.id));
      const removed = [...before.values()].filter((s) => !next.has(s.session.id));
      // A renew keeps the session id (the tag) but is a new grant: `changed`, never remove + add.
      const changed = [...next.values()].filter((s) => {
        const was = before.get(s.session.id);
        return (
          was !== undefined &&
          (was.session.account.label !== s.session.account.label || was.grantId !== s.grantId)
        );
      });
      if (added.length + removed.length + changed.length === 0) return;
      this.changed.fire({
        added: added.map((s) => s.session),
        removed: removed.map((s) => s.session),
        changed: changed.map((s) => s.session),
      });
    });
  }

  private current(): Map<string, { session: vscode.AuthenticationSession; grantId: string }> {
    return new Map(
      this.accounts
        .list()
        .map((b) => [b.tag, { session: sessionOf(b), grantId: b.account.grantId }]),
    );
  }

  async getSessions(
    _scopes?: readonly string[],
    options?: AccountOption,
  ): Promise<vscode.AuthenticationSession[]> {
    const want = options?.account;
    const all = this.accounts.list();
    return (want ? all.filter((b) => b.account.user.id === want.id) : all).map(sessionOf);
  }

  async createSession(
    _scopes: readonly string[],
    options?: AccountOption,
  ): Promise<vscode.AuthenticationSession> {
    const want = options?.account;
    const held = want ? this.accounts.list().find((b) => b.account.user.id === want.id) : undefined;
    if (held) return sessionOf(held); // already here: no flow
    const host = this.accounts.host();
    const intent: SignInIntent =
      want && host
        ? { kind: 'as', tag: accountTag(host, want.id), expectedUserId: want.id }
        : this.accounts.list().length === 0
          ? { kind: 'first' }
          : { kind: 'add' };
    const result = await this.accounts.signIn(intent);
    const b = result.ref && host ? this.accounts.byTag(accountTag(host, result.ref.userId)) : null;
    if (!b) throw new Error('Sign-in did not finish.');
    return sessionOf(b);
  }

  /** Sign out of ONLY that account. VS Code's Accounts menu has already asked (P0 check 4). */
  async removeSession(sessionId: string): Promise<void> {
    const all = this.accounts.list();
    // The tag; else a session id an older build gave VS Code: 0.1.1 used the grant id, and the
    // account id is the last fallback (B-5). Never "the active account".
    const b =
      all.find((x) => x.tag === sessionId) ??
      all.find((x) => x.account.grantId === sessionId) ??
      all.find((x) => x.account.user.id === sessionId);
    if (b) await this.accounts.signOut(b.ref, { confirm: false });
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
