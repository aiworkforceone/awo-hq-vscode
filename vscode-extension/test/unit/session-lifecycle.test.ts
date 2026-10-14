/**
 * cli-session-lifecycle: Start, Stop and Restart on a session row of the Teams tree.
 *
 *   - each calls the shared client's method for THAT team and session, inside a progress notice;
 *   - Stop and Restart of a session that is answering ask first (a modal), and only the confirming
 *     button goes ahead;
 *   - a refusal is a notification with the same sentence the CLI prints (the operator one is the
 *     web's); a sign-in problem is left to the account service, which already said it;
 *   - the tree is refreshed afterwards, whatever happened.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RemoteSessionSummary } from '@kpa/shared/remote.types';
import { HqApiError, type HqClient } from '@hq/client/api.js';
import {
  deviceSignatureMissingMessage,
  SESSION_NOT_OPERATOR_MESSAGE,
} from '@hq/client/session-actions.js';
import type { Team } from '@hq/client/teams.js';
import { stub } from './vscode-stub.js';
import { COPY } from '../../src/copy.js';
import { runSessionLifecycle } from '../../src/hq/session-lifecycle.js';

const WS = '3f9a1c2e-1111-4222-8333-444455556666';
const SID = '7c21e0b4-5555-4666-8777-888899990000';
const team = {
  alias: 'hq-3f9a1c2e',
  org: { slug: 'awo', name: 'AWO' },
  workspace: { id: WS, name: 'Backend team', state: 'running' },
} as unknown as Team;

function session(over: Partial<RemoteSessionSummary> = {}): RemoteSessionSummary {
  return {
    id: SID,
    name: 'fix login bug',
    ownerName: 'Olive',
    status: 'running',
    canType: true,
    canOperate: true,
    midTurn: false,
    engine: 'claude',
    ...over,
  };
}

let calls: Array<{ method: string; team: unknown; id: string }>;
let refreshed: number;
let fail: unknown;

const client = {
  startSession: async (t: unknown, id: string) => {
    calls.push({ method: 'start', team: t, id });
    if (fail) throw fail;
    return { id, status: 'starting' };
  },
  stopSession: async (t: unknown, id: string) => {
    calls.push({ method: 'stop', team: t, id });
    if (fail) throw fail;
    return { id, status: 'stopped' };
  },
  restartSession: async (t: unknown, id: string) => {
    calls.push({ method: 'restart', team: t, id });
    if (fail) throw fail;
    return { id, status: 'starting' };
  },
} as unknown as HqClient;

const deps = {
  call: <T>(fn: (c: HqClient) => Promise<T>) => fn(client),
  refresh: () => {
    refreshed += 1;
  },
};

beforeEach(() => {
  stub.reset();
  calls = [];
  refreshed = 0;
  fail = undefined;
});

describe('runSessionLifecycle', () => {
  it('Start calls startSession for the row, under a progress notice, then refreshes', async () => {
    const outcome = await runSessionLifecycle(
      deps,
      { team, session: session({ status: 'stopped' }) },
      'start',
    );
    expect(outcome).toBe('done');
    expect(calls).toEqual([{ method: 'start', team, id: SID }]);
    expect(stub.progress.map((p) => p.title)).toEqual([COPY.sessionStarting('fix login bug')]);
    expect(stub.statusMessages).toEqual([COPY.sessionStarted('fix login bug')]);
    expect(refreshed).toBe(1);
  });

  it('Stop of an idle session goes straight ahead (no question)', async () => {
    expect(await runSessionLifecycle(deps, { team, session: session() }, 'stop')).toBe('done');
    expect(calls.map((c) => c.method)).toEqual(['stop']);
    expect(stub.messages).toEqual([]);
    expect(stub.statusMessages).toEqual([COPY.sessionStopped('fix login bug')]);
  });

  it('Stop while it is answering asks first; only "Stop Session" goes ahead', async () => {
    const busy = { team, session: session({ midTurn: true }) };
    expect(await runSessionLifecycle(deps, busy, 'stop')).toBe('cancelled');
    expect(stub.messages).toEqual([
      { level: 'warn', text: COPY.sessionBusyConfirm('Claude', 'fix login bug', 'stop') },
    ]);
    expect(calls).toEqual([]);
    expect(refreshed).toBe(0);

    stub.messages = [];
    stub.choice = COPY.stopSessionAction;
    expect(await runSessionLifecycle(deps, busy, 'stop')).toBe('done');
    expect(calls.map((c) => c.method)).toEqual(['stop']);
  });

  it('Restart while it is answering asks too, naming Codex for a Codex session', async () => {
    stub.choice = COPY.restartSessionAction;
    const busy = { team, session: session({ midTurn: true, engine: 'codex' }) };
    expect(await runSessionLifecycle(deps, busy, 'restart')).toBe('done');
    expect(stub.messages[0]).toEqual({
      level: 'warn',
      text: COPY.sessionBusyConfirm('Codex', 'fix login bug', 'restart'),
    });
    expect(calls.map((c) => c.method)).toEqual(['restart']);
  });

  it('Start never asks, even while the team is busy elsewhere', async () => {
    await runSessionLifecycle(
      deps,
      { team, session: session({ status: 'stopped', midTurn: true }) },
      'start',
    );
    expect(stub.messages).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('a row HQ says you may not operate is refused with the web sentence, nothing sent', async () => {
    const outcome = await runSessionLifecycle(
      deps,
      { team, session: session({ canOperate: false }) },
      'stop',
    );
    expect(outcome).toBe('refused');
    expect(stub.messages).toEqual([{ level: 'error', text: SESSION_NOT_OPERATOR_MESSAGE }]);
    expect(calls).toEqual([]);
  });

  it("HQ's refusal becomes a notification with the shared sentence, and the tree still refreshes", async () => {
    fail = new HqApiError(409, 'LIMIT_EXCEEDED', 'Session limit reached', {
      reason: '3/3 sessions running',
    });
    expect(
      await runSessionLifecycle(deps, { team, session: session({ status: 'stopped' }) }, 'start'),
    ).toBe('refused');
    expect(stub.messages).toEqual([
      {
        level: 'error',
        text: 'Team "Backend team" is running as many sessions as it can (3/3 sessions running). Stop one of its sessions first, or give the team more room in HQ.',
      },
    ]);
    expect(refreshed).toBe(1);
  });

  it('the server refusing a view-only member (403 FORBIDDEN) says the operator sentence', async () => {
    fail = new HqApiError(403, 'FORBIDDEN', 'View-only access', undefined);
    await runSessionLifecycle(deps, { team, session: session() }, 'restart');
    expect(stub.messages).toEqual([{ level: 'error', text: SESSION_NOT_OPERATOR_MESSAGE }]);
  });

  it('already stopped is information, not an error', async () => {
    fail = new HqApiError(409, 'NOT_RUNNING', 'Session not running', undefined);
    expect(await runSessionLifecycle(deps, { team, session: session() }, 'stop')).toBe('already');
    expect(stub.messages).toEqual([
      { level: 'info', text: 'Session "fix login bug" is already stopped.' },
    ]);
  });

  it('train 98 e2e: Start on a session HQ is still starting says "already starting", never running', async () => {
    fail = new HqApiError(409, 'ALREADY_RUNNING', 'Session already running', undefined);
    const starting = { team, session: session({ starting: true }) };
    expect(await runSessionLifecycle(deps, starting, 'start')).toBe('already');
    expect(stub.messages).toEqual([
      { level: 'info', text: 'Session "fix login bug" is already starting.' },
    ]);
    expect(refreshed).toBe(1);
  });

  it('train 98 e2e: Start on a row still listed stopped (a start from elsewhere landed) says "already starting"', async () => {
    fail = new HqApiError(409, 'ALREADY_RUNNING', 'Session already running', undefined);
    const stale = { team, session: session({ status: 'stopped' }) };
    expect(await runSessionLifecycle(deps, stale, 'start')).toBe('already');
    expect(stub.messages).toEqual([
      { level: 'info', text: 'Session "fix login bug" is already starting.' },
    ]);
  });

  it('train 98 e2e: a running row with no `starting` field (an older HQ) still says "already running"', async () => {
    fail = new HqApiError(409, 'ALREADY_RUNNING', 'Session already running', undefined);
    expect(await runSessionLifecycle(deps, { team, session: session() }, 'start')).toBe('already');
    expect(stub.messages).toEqual([
      { level: 'info', text: 'Session "fix login bug" is already running.' },
    ]);
  });

  it('a sign-in problem (401, or not an HQ answer) is left to the account service: no second message', async () => {
    fail = new HqApiError(401, 'REMOTE_TOKEN_INVALID', 'expired', undefined);
    expect(await runSessionLifecycle(deps, { team, session: session() }, 'stop')).toBe('failed');
    fail = new Error('the keychain could not be read');
    expect(await runSessionLifecycle(deps, { team, session: session() }, 'stop')).toBe('failed');
    expect(stub.messages).toEqual([]);
    expect(refreshed).toBe(2);
  });

  it('train 96 review W1: a 401 for a MISSING device signature shows the shared sentence, not silence', async () => {
    fail = new HqApiError(401, 'DEVICE_SIGNATURE_MISSING', 'not signed', undefined);
    expect(await runSessionLifecycle(deps, { team, session: session() }, 'stop')).toBe('refused');
    expect(stub.messages).toEqual([{ level: 'error', text: deviceSignatureMissingMessage() }]);
    expect(stub.messages[0]!.text).not.toMatch(/expired or was revoked|needs renewing/i);
    expect(refreshed).toBe(1);
  });

  it('every new sentence keeps the copy rules', () => {
    const all = [
      COPY.sessionStarting('x'),
      COPY.sessionStopping('x'),
      COPY.sessionRestartingProgress('x'),
      COPY.sessionStarted('x'),
      COPY.sessionStopped('x'),
      COPY.sessionRestarted('x'),
      COPY.sessionAlreadyStarting('x'),
      COPY.sessionBusyConfirm('Claude', 'x', 'stop'),
      COPY.sessionBusyConfirm('Claude', 'x', 'restart'),
      COPY.stopSessionAction,
      COPY.restartSessionAction,
    ];
    for (const s of all) {
      expect(s).not.toContain('—');
      expect(s).not.toContain(' - ');
      expect(s.toLowerCase()).not.toContain('asleep');
    }
  });
});
