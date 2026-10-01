/**
 * The Accounts-menu entry (decision 3): registered for the UX only (the account shows in VS Code's
 * Accounts menu, with Sign Out there). The session's `accessToken` is the SENTINEL `'hq-session'`,
 * never an `hqa_` token: any other extension may call `authentication.getSession` for any provider,
 * and there is nothing to gain by handing one a bearer.
 */
import * as vscode from 'vscode';
import type { HqService } from '../hq/hq-service.js';

export const AUTH_PROVIDER_ID = 'aiworkforceone-hq';
export const AUTH_PROVIDER_LABEL = 'AI Workforce One HQ';
/** What `AuthenticationSession.accessToken` carries. Never a credential. */
export const SESSION_SENTINEL = 'hq-session';

export class HqAuthenticationProvider implements vscode.AuthenticationProvider {
  private readonly changed =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changed.event;
  private last: vscode.AuthenticationSession | null;

  constructor(private readonly service: HqService) {
    this.last = this.current();
    service.onDidChange(() => {
      const next = this.current();
      const before = this.last;
      this.last = next;
      if (before?.id === next?.id) return;
      this.changed.fire({
        added: next && !before ? [next] : [],
        removed: before && !next ? [before] : [],
        changed: before && next ? [next] : [],
      });
    });
  }

  private current(): vscode.AuthenticationSession | null {
    const account = this.service.account();
    if (!account) return null;
    return {
      id: account.grantId,
      accessToken: SESSION_SENTINEL,
      account: { id: account.user.id, label: account.user.email },
      scopes: [],
    };
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const s = this.current();
    return s ? [s] : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    await this.service.signIn();
    const s = this.current();
    if (!s) throw new Error('Sign-in did not finish.');
    return s;
  }

  async removeSession(): Promise<void> {
    await this.service.signOut();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
