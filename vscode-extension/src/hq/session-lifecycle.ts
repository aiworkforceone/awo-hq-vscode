/**
 * cli-session-lifecycle: Start, Stop and Restart on a session row of the Teams tree (inline icons and
 * the context menu, shown by the row's `contextValue`, `tree/labels.ts`).
 *
 * The calls are the shared client's (`HqClient.startSession` / `stopSession` / `restartSession`),
 * the bearer twins of the web's session lifecycle routes, run as the account that listed the row.
 *
 *   - Stop and Restart of a session that is answering (`midTurn`) ask first, in a modal; only the
 *     confirming button goes ahead. Start never asks.
 *   - A row HQ says this member may not operate (`canOperate === false`) is refused here with the
 *     web's sentence and nothing is sent (the menus hide the actions anyway; the route refuses too).
 *   - HQ's refusals are notifications with the shared sentence (`describeSessionRefusal`), the one
 *     the CLI prints. A sign-in problem is the account service's to explain (`HqService.call`
 *     already asked to sign in again or said the keychain is busy), so it adds nothing.
 *   - The tree is refreshed afterwards, whatever happened.
 */
import * as vscode from 'vscode';
import type { RemoteSessionAction, RemoteSessionSummary } from '@kpa/shared/remote.types';
import { HqApiError, type HqClient } from '@hq/client/api.js';
import {
  DEVICE_SIGNATURE_MISSING_CODE,
  describeSessionRefusal,
  SESSION_NOT_OPERATOR_MESSAGE,
} from '@hq/client/session-actions.js';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import { cleanLabel, notificationText } from '../util/text.js';

export interface SessionLifecycleDeps {
  /** Run one HQ call as the row's account (`HqService.call`). */
  call<T>(fn: (client: HqClient) => Promise<T>): Promise<T>;
  /** Re-read the tree (the sessions and the team states). */
  refresh(): unknown;
}

export interface SessionLifecycleTarget {
  team: Team;
  session: RemoteSessionSummary;
}

export type SessionLifecycleOutcome = 'done' | 'already' | 'cancelled' | 'refused' | 'failed';

function progressTitle(action: RemoteSessionAction, name: string): string {
  if (action === 'start') return COPY.sessionStarting(name);
  if (action === 'stop') return COPY.sessionStopping(name);
  return COPY.sessionRestartingProgress(name);
}

function doneMessage(action: RemoteSessionAction, name: string): string {
  if (action === 'start') return COPY.sessionStarted(name);
  if (action === 'stop') return COPY.sessionStopped(name);
  return COPY.sessionRestarted(name);
}

/** Ask before interrupting an answer. Resolves true when the person chose the action. */
async function confirmInterrupt(
  session: RemoteSessionSummary,
  name: string,
  action: 'stop' | 'restart',
): Promise<boolean> {
  const agent = session.engine === 'codex' ? 'Codex' : 'Claude';
  const button = action === 'stop' ? COPY.stopSessionAction : COPY.restartSessionAction;
  const chosen = await vscode.window.showWarningMessage(
    notificationText(COPY.sessionBusyConfirm(agent, name, action)),
    { modal: true },
    button,
  );
  return chosen === button;
}

export async function runSessionLifecycle(
  deps: SessionLifecycleDeps,
  target: SessionLifecycleTarget,
  action: RemoteSessionAction,
): Promise<SessionLifecycleOutcome> {
  const { team, session } = target;
  const name = cleanLabel(session.name) || session.id.slice(0, 8);
  if (session.canOperate === false) {
    void vscode.window.showErrorMessage(SESSION_NOT_OPERATOR_MESSAGE);
    return 'refused';
  }
  if (action !== 'start' && session.midTurn === true) {
    if (!(await confirmInterrupt(session, name, action))) return 'cancelled';
  }
  try {
    // The progress task SETTLES, never rejects: the refusal is read after the notice closes, so no
    // rejected promise is left behind on the progress notice's own chain.
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: notificationText(progressTitle(action, name)),
      },
      () =>
        deps
          .call((client) =>
            action === 'start'
              ? client.startSession(team, session.id)
              : action === 'stop'
                ? client.stopSession(team, session.id)
                : client.restartSession(team, session.id),
          )
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
    );
    if (!outcome.ok) throw outcome.error;
    vscode.window.setStatusBarMessage(notificationText(doneMessage(action, name)), 5_000);
    return 'done';
  } catch (err) {
    // Not an HQ answer (an account or keychain problem), a dead login or a too-old extension: the
    // account service already said what to do. A 401 for a MISSING device signature is not a dead
    // login (train 96 review W1): the account service says nothing about it, so it falls through
    // to the shared sentence.
    const missingSig = err instanceof HqApiError && err.code === DEVICE_SIGNATURE_MISSING_CODE;
    if (!(err instanceof HqApiError) || (err.status === 401 && !missingSig) || err.status === 426)
      return 'failed';
    const refusal = describeSessionRefusal(err, action, {
      session: name,
      team: cleanLabel(team.workspace.name) || team.alias,
    });
    if (refusal.kind === 'already') {
      // train 98 e2e (the CLI's rule): HQ answers ALREADY_RUNNING for a session still STARTING too,
      // and "running" then is a claim nobody checked (the start may still fail). Starting when the
      // row says so, or still listed it stopped (a start from elsewhere landed in between).
      const stillStarting =
        action !== 'stop' && (session.starting === true || session.status === 'stopped');
      const message = stillStarting ? COPY.sessionAlreadyStarting(name) : refusal.message;
      void vscode.window.showInformationMessage(notificationText(message));
      return 'already';
    }
    void vscode.window.showErrorMessage(notificationText(refusal.message));
    return 'refused';
  } finally {
    // Not after a cancelled question (nothing changed); after every call, whatever it answered.
    deps.refresh();
  }
}
