/**
 * cli-session-lifecycle: start, stop and restart a session from an HQ client (the `hq` CLI and the
 * VS Code extension). The routes are the bearer twins of the web's `POST /api/sessions/:id/(start|
 * stop|restart)`: the same session service and the same gates, reached with the device token and a
 * device signature instead of a cookie and a CSRF token.
 *
 *   GET  /api/remote/orgs/:org/workspaces/:ws/sessions                  the list (unsigned read)
 *   POST /api/remote/orgs/:org/workspaces/:ws/sessions/:id/start        202 { id, status: starting }
 *   POST /api/remote/orgs/:org/workspaces/:ws/sessions/:id/stop         200 { id, status: stopped }
 *   POST /api/remote/orgs/:org/workspaces/:ws/sessions/:id/restart      202 { id, status: starting }
 *
 * The calls themselves are methods on `HqClient` (`api.ts`); this file holds the paths and the plain
 * sentence for every refusal, so the two clients say the same thing. It imports nothing at runtime
 * from `api.ts` (which imports the paths from here).
 *
 * Copy rules: no em dashes, no spaced hyphen, and the operator refusal is the web's sentence word
 * for word (`client/src/lib/access-error.ts`, a test pins it).
 */
import type { RemoteSessionAction } from '@kpa/shared/remote.types';
import { copy } from '@kpa/shared/active-dev-brand';

/** The web's sentence for 403 `SESSION_NOT_OPERATOR` (and for a view-only member). */
export const SESSION_NOT_OPERATOR_MESSAGE = 'Only the session owner or a team owner can do this.';

/**
 * train 96 e2e: HQ's code for a device-signed route reached WITHOUT the nonce or the signature
 * (`requireDeviceSig`). The login is fine: a client sent an unsigned state change, which is a bug in
 * that client. Telling the person their login expired sends them through a sign-in that cannot help.
 */
export const DEVICE_SIGNATURE_MISSING_CODE = 'DEVICE_SIGNATURE_MISSING';

/**
 * The sentence for `DEVICE_SIGNATURE_MISSING`, shared by every refusal mapper (no `hq: ` prefix).
 * A `copy` literal, not a constant: the brand twins rewrite those at build time, so a plain string
 * naming HQ would ship unbranded in a twin's bundle (`cli-brand-twin.test.ts`).
 */
export function deviceSignatureMissingMessage(): string {
  return copy`HQ refused this request because it was not signed by this computer. That is a bug in this app, not an expired login, so signing in again will not help. Update the app and try again.`;
}

/**
 * train 96 e2e: a 429 says how long to wait, from HQ's `details.retryAfterSeconds` (a whole number
 * of seconds, at least 1). Without a usable number, the general sentence HQ itself sends.
 */
export function throttledMessage(details: Record<string, unknown> | undefined): string {
  const raw = details?.retryAfterSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 'Too many requests. Wait a moment and try again.';
  }
  const seconds = Math.ceil(raw);
  return `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}

/** The two ids a team route needs (a `Team` from `teams.ts` fits). */
export interface TeamRef {
  org: { slug: string };
  workspace: { id: string };
}

export function teamApiPath(team: TeamRef): string {
  return `/api/remote/orgs/${encodeURIComponent(team.org.slug)}/workspaces/${team.workspace.id}`;
}

export function sessionActionPath(
  team: TeamRef,
  sessionId: string,
  action: RemoteSessionAction,
): string {
  return `${teamApiPath(team)}/sessions/${encodeURIComponent(sessionId)}/${action}`;
}

export type SessionRefusalKind =
  | 'not_operator'
  | 'not_found'
  | 'unsupported'
  | 'already'
  | 'limit'
  | 'paused'
  | 'updating'
  | 'plan_inactive'
  | 'no_access'
  | 'signed_out'
  | 'throttled'
  | 'client_bug'
  | 'other';

export interface SessionRefusal {
  kind: SessionRefusalKind;
  message: string;
}

/** The shape of an `HqApiError` (duck-typed: no runtime import of `api.ts`). */
interface ApiErrorLike {
  status: number;
  code: string | undefined;
  message: string;
  details: Record<string, unknown> | undefined;
}

function isApiError(err: unknown): err is ApiErrorLike {
  return (
    err instanceof Error &&
    typeof (err as Partial<ApiErrorLike>).status === 'number' &&
    'code' in err &&
    'details' in err
  );
}

/**
 * The plain sentence for a refused start, stop or restart. `names` are cleaned display names (the
 * caller strips control characters). Never echoes a token or an id the person did not type.
 */
export function describeSessionRefusal(
  err: unknown,
  action: RemoteSessionAction,
  names: { session: string; team: string },
): SessionRefusal {
  if (!isApiError(err)) {
    return { kind: 'other', message: err instanceof Error ? err.message : String(err) };
  }
  const { status, code } = err;
  if (status === 403 && (code === 'SESSION_NOT_OPERATOR' || code === 'FORBIDDEN')) {
    return { kind: 'not_operator', message: SESSION_NOT_OPERATOR_MESSAGE };
  }
  if (status === 403 && code === 'SESSION_NOT_OWNER') {
    return { kind: 'not_operator', message: SESSION_NOT_OPERATOR_MESSAGE };
  }
  if (status === 403 && code === 'PERMISSION_DENIED') {
    return {
      kind: 'no_access',
      message: copy`You do not have remote access to team "${names.team}".`,
    };
  }
  if (status === 401 && code === DEVICE_SIGNATURE_MISSING_CODE) {
    return { kind: 'client_bug', message: deviceSignatureMissingMessage() };
  }
  if (status === 429) {
    return { kind: 'throttled', message: throttledMessage(err.details) };
  }
  if (status === 401) {
    return {
      kind: 'signed_out',
      message: copy`Your HQ login on this computer expired or was revoked. Sign in again.`,
    };
  }
  if (status === 404) {
    // The session gate's own 404 says "Session not found"; any other 404 (an HQ without these
    // routes, or with remote access off) is about the route, not the session.
    if (/session not found/i.test(err.message)) {
      return {
        kind: 'not_found',
        message: `Session "${names.session}" was not found. It may have been deleted.`,
      };
    }
    return {
      kind: 'unsupported',
      message: copy`This HQ cannot start or stop sessions from here yet. Use HQ in your browser.`,
    };
  }
  if (status === 402) {
    return {
      kind: 'plan_inactive',
      message: copy`This organization's plan is not active, so its sessions cannot be started or stopped. An owner can fix billing in HQ.`,
    };
  }
  if (status === 409 && code === 'ALREADY_RUNNING' && action !== 'stop') {
    return { kind: 'already', message: `Session "${names.session}" is already running.` };
  }
  if (status === 409 && code === 'NOT_RUNNING' && action === 'stop') {
    return { kind: 'already', message: `Session "${names.session}" is already stopped.` };
  }
  if (status === 409 && code === 'LIMIT_EXCEEDED') {
    const reason = typeof err.details?.reason === 'string' ? ` (${err.details.reason})` : '';
    return {
      kind: 'limit',
      message: copy`Team "${names.team}" is running as many sessions as it can${reason}. Stop one of its sessions first, or give the team more room in HQ.`,
    };
  }
  if (status === 409 && code === 'WORKSPACE_PAUSED') {
    return {
      kind: 'paused',
      message: copy`Team "${names.team}" is paused. An owner can resume it in HQ.`,
    };
  }
  if (status === 409 && code === 'WORKSPACE_UPDATING') {
    return {
      kind: 'updating',
      message: `Team "${names.team}" is updating its AI Team Cloud Computer. Try again in a few minutes.`,
    };
  }
  return { kind: 'other', message: err.message };
}
