/**
 * remote-dev-access — the WIRE CONTRACT shared by the server (`src/remote/*`, `src/api/remote.ts`),
 * the HQ client (Settings, `/device`, Account → Devices) and the `hq` CLI (`cli/`).
 *
 * One file so the three can never disagree about a header name, a token prefix or a response shape.
 * Mirrors `designs/remote-dev-access/contracts/openapi.yaml` and `contracts/events.json`.
 *
 * ⛔ PURE. No `node:crypto`, no DOM, no Node built-ins: the client bundle imports this module too.
 *    Anything that signs or hashes lives in `src/remote/` (server) or `cli/src/` (laptop).
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Credentials and headers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Access token prefix (15 min). The prefix is what lets secret scanners match a leaked one. */
export const REMOTE_ACCESS_TOKEN_PREFIX = 'hqa_';
/** Refresh token prefix (rotates on every use; reuse revokes the family). */
export const REMOTE_REFRESH_TOKEN_PREFIX = 'hqr_';
/** Shim token prefix (the in-container `claude` shim, read from `<remoteHome>/.hq/current.json`). */
export const REMOTE_SHIM_TOKEN_PREFIX = 'hqs_';
/** Every token body is 32 random bytes as base64url: 43 characters. */
export const REMOTE_TOKEN_BODY_CHARS = 43;

export const REMOTE_ACCESS_TTL_SEC = 15 * 60;
export const REMOTE_REFRESH_IDLE_TTL_SEC = 30 * 24 * 60 * 60;
export const REMOTE_REFRESH_ABSOLUTE_TTL_SEC = 90 * 24 * 60 * 60;
/** Device code / user code lifetime (RFC 8628 `expires_in`). */
export const REMOTE_DEVICE_CODE_TTL_SEC = 600;
/** RFC 8628 default polling interval, and the `slow_down` increment. */
export const REMOTE_POLL_INTERVAL_SEC = 5;
/** Device-signature nonce lifetime. Single use. */
export const REMOTE_NONCE_TTL_SEC = 60;
/** One-time connect code lifetime (S4: header only). */
export const REMOTE_CONNECT_CODE_TTL_SEC = 60;

/** RFC 8628 §6.1: a base-20 consonant alphabet, no vowels (no accidental words), no lookalikes. */
export const REMOTE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
/** `XXXX-XXXX`. */
export const REMOTE_USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export const HQ_HEADER_ORG = 'x-hq-org';
export const HQ_HEADER_NONCE = 'x-hq-nonce';
export const HQ_HEADER_DEVICE_SIG = 'x-hq-device-sig';
export const HQ_HEADER_CONNECT_CODE = 'x-hq-connect-code';
export const HQ_HEADER_CLI_VERSION = 'x-hq-cli-version';
/**
 * hq-vscode (decision 22): `<kind>/<semver>` on every request and upgrade, e.g. `vscode/0.1.0` or
 * `hq/0.2.0`. The server holds each kind to its own floor; ABSENT means the `hq` CLI and today's
 * `X-HQ-CLI-Version` rule.
 */
export const HQ_HEADER_CLIENT = 'x-hq-client';
/**
 * hq-vscode decision 24: a client that sends `X-HQ-Client` asks for the next signature's nonce with
 * this header; requests without `X-HQ-Client` (CLIs before this change) keep getting one always.
 */
export const HQ_HEADER_WANT_NONCE = 'x-hq-want-nonce';
/** The `X-HQ-Client` kinds the server knows. Any other kind is below every floor that exists. */
export type HqClientKind = 'hq' | 'vscode';
export const HQ_CLIENT_KINDS: readonly HqClientKind[] = ['hq', 'vscode'];

/**
 * Parse `X-HQ-Client`. `null` when the header is absent; kind `unknown` for anything that is not
 * `<known kind>/<version>`. The version is returned as sent (the server's own parser decides whether
 * it is a version).
 */
export function parseHqClientHeader(
  value: string | undefined,
): { kind: HqClientKind; version: string } | { kind: 'unknown'; version: null } | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const m = /^([a-z][a-z0-9-]{0,31})\/(\S{1,64})$/.exec(value.trim());
  if (!m) return { kind: 'unknown', version: null };
  const kind = m[1] as string;
  if (!(HQ_CLIENT_KINDS as readonly string[]).includes(kind))
    return { kind: 'unknown', version: null };
  return { kind: kind as HqClientKind, version: m[2] as string };
}

/**
 * The bytes a device signature covers, as one string: `nonce\nMETHOD\n/path?query\nsha256hex(body)`.
 *
 * Newline-separated rather than concatenated, so no field can bleed into the next (`nonce || method`
 * with a method of `POST` and a path starting with `T` is otherwise ambiguous). The PATH is the
 * request target INCLUDING its query string, exactly as sent (`signedRequestTarget`; security
 * review S5: a query is covered, so none can be added or changed); the body hash is the lowercase
 * hex SHA-256 of the exact request body bytes (empty body → the hash of the empty string). Both ends
 * build the payload with THIS function, so the order cannot drift.
 */
export function deviceSignaturePayload(
  nonce: string,
  method: string,
  path: string,
  bodySha256Hex: string,
): string {
  return `${nonce}\n${method.toUpperCase()}\n${path}\n${bodySha256Hex.toLowerCase()}`;
}

/**
 * The request target a device signature covers: the path WITH its query string, exactly as sent
 * (security review S5). Before it the server stripped the query; every signed call a released
 * client makes carries none, and for those the target is byte-identical, so old clients still
 * verify. A client signs the same string it requests (`HqClient.request(method, path)`).
 */
export function signedRequestTarget(url: string | undefined): string {
  return url ?? '';
}

/** SHA-256 of the empty string, lowercase hex — the body hash of a GET or an upgrade. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Device authorization (hq login)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which HQ client asked for a device grant: the `hq` CLI or the VS Code extension (hq-vscode
 * decision 2: its own grant and key, never the CLI's). Shown on `/device` and in Account → Devices.
 */
export type RemoteDeviceClientName = 'hq' | 'hq-vscode';
export const REMOTE_DEVICE_CLIENT_NAMES: readonly RemoteDeviceClientName[] = ['hq', 'hq-vscode'];

/** The name `/device` and Account → Devices show for a client (an absent name is the CLI). */
export function remoteClientDisplayName(name: RemoteDeviceClientName | undefined): string {
  return name === 'hq-vscode' ? 'HQ for VS Code' : 'hq';
}

/**
 * hq-vscode §Security: the one-time notice a member gets while Developer access is on. Plain words,
 * no em dash.
 */
export function remoteForwardNoticeSentence(teamName: string): string {
  return `Developer access is on for ${teamName}. Members who can edit it can forward its ports to their own computer, which reaches programs you run on this machine, such as dev servers.`;
}

export interface DeviceStartRequest {
  clientName: RemoteDeviceClientName;
  clientVersion: string;
  platform: string;
  deviceLabel?: string;
  /** One `ssh-ed25519 <base64>` line; the per-device key made at `hq login` (decision 6). */
  devicePubkey: string;
}

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResponse =
  | { status: 'authorization_pending' | 'slow_down'; interval: number }
  | {
      status: 'approved';
      /** This device's grant id — what `hq logout` revokes (`DELETE /api/remote/grants/:id`). */
      grantId: string;
      accessToken: string;
      accessExpiresAt: string;
      refreshToken: string;
      user: { id: string; email: string; name: string };
      orgs: RemoteOrg[];
    };

export interface DeviceLookupOrg {
  id: string;
  slug: string;
  name: string;
  requires2fa: boolean;
  /** How many teams in this org the approver can edit, so reach from a laptop (the "N teams" sentence, S3). */
  teams: number;
}

export interface DeviceLookupResponse {
  /** Which HQ client is asking (hq-vscode). ABSENT from an older HQ: read as `hq`. */
  clientName?: RemoteDeviceClientName;
  deviceLabel: string;
  clientVersion: string;
  platform: string;
  requestedAt: string;
  requesterIp: string;
  requesterCountry: string | null;
  orgs: DeviceLookupOrg[];
  /** S3: the request came from a different IP / country than the approving browser. */
  mismatch: { ip: boolean; country: boolean };
  /** True when the approver must type a TOTP (enrolled, or any org mandates 2FA). */
  totpRequired: boolean;
}

export interface DeviceApproveRequest {
  userCode: string;
  orgIds: string[];
  totpCode?: string;
}

export interface TokenRefreshRequest {
  refreshToken: string;
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
}

export interface NonceResponse {
  nonce: string;
  expiresIn: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Orgs, teams, capabilities (bearer)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `asleep` = idle-slept (a connect or `hq up` wakes it); `stopped` = no machine (never started or stopped). */
export type RemoteWorkspaceState = 'running' | 'starting' | 'asleep' | 'stopped';

export interface RemoteWorkspace {
  id: string;
  /** `hq-<first 8 hex of the workspace id>`, extended to 12 on a prefix collision (the CLI does it). */
  alias: string;
  name: string;
  state: RemoteWorkspaceState;
  /**
   * SSH was removed on 2026-10-01: the `ssh` right and the `sshDoor` flag are gone from the wire. A
   * published CLI reads a missing `ssh` as false, exactly what the server sent since the removal.
   */
  rights: {
    forward: boolean;
    attach: boolean;
    /**
     * hq-vscode: the team's files from a laptop. `read` = the attach rule, `write` = the forward
     * rule (write-capable, plan writable). ABSENT from an older HQ.
     */
    files?: { read: boolean; write: boolean };
  };
  /**
   * False only when the machine's report PROVES its image cannot serve `hq forward` (the `forward`
   * tunnel scope: "machine needs an update", D12). A team whose machine never started, or has not
   * reported yet, is not judged (FAIL 6). Until train 42 this was judged on SSH.
   */
  supported: boolean;
  /**
   * The same judgement for the hq-vscode file routes (`runner_caps.fs`): false only on proof that
   * the image lacks the file frames. ABSENT from an older HQ.
   */
  filesSupported?: boolean;
  hostKeyFingerprint?: string;
  hostKey?: string;
}

export interface RemoteOrg {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  remoteAccess: { allowed: boolean; reason?: RemoteAccessDeniedReason };
  workspaces: RemoteWorkspace[];
}

/** Why an org's remote access is not available to this member. A closed vocabulary, never text. */
export type RemoteAccessDeniedReason =
  | 'org_disabled'
  | 'advanced_terminal_off'
  | 'plan_inactive'
  | 'feature_not_in_plan'
  | 'staged_rollout'
  | 'two_factor_required';

export type RemoteScope = 'ssh' | 'forward';
/**
 * `hq-vscode` is the HQ extension (its forwards); `vscode` stays Remote-SSH VS Code, so the audit
 * says which door carried a connection.
 */
export type RemoteClientKind =
  | 'vscode'
  | 'cursor'
  | 'jetbrains'
  | 'zed'
  | 'ssh'
  | 'sshfs'
  | 'hq'
  | 'hq-vscode'
  | 'unknown';
export const REMOTE_CLIENT_KINDS: readonly RemoteClientKind[] = [
  'vscode',
  'cursor',
  'jetbrains',
  'zed',
  'ssh',
  'sshfs',
  'hq',
  'hq-vscode',
  'unknown',
];

export interface ConnectionRequest {
  scope: RemoteScope;
  /** forward only; ≥ 1024. */
  port?: number;
  /** forward only; informational. */
  localPort?: number;
  client: RemoteClientKind;
  /** A HINT. The server classifies reconnects itself (decision 23). */
  intent: 'open' | 'reconnect';
  /** `--wake`: forces `open` and counts as a human signal. */
  wake?: boolean;
}

export interface ConnectionReady {
  id: string;
  state: 'ready';
  connectCode: string;
  hostKey: string | null;
  expiresAt: string;
}

export interface ConnectionWaking {
  id: string;
  state: 'waking';
  code: 'SESSION_RESUMING' | 'SESSION_RESUME_COLD_RESTART' | 'SESSION_RESUME_FAILED';
}

export interface RemoteSessionSummary {
  id: string;
  name: string;
  ownerName: string;
  status: 'running' | 'idle' | 'stopped';
  canType: boolean;
  /**
   * local-echo (Decision 18): the `KR_LOCAL_ECHO` env flag AND the org's `local_echo_enabled` both
   * allow Instant Local Echo. `hq attach --local-echo` predicts only when this is `true`; ABSENT (an
   * older HQ) reads as false, so the org kill switch holds whatever CLI version attaches.
   */
  localEchoAvailable?: boolean;
  /** hq-vscode: which agent runs in it. ABSENT from an older HQ. */
  engine?: RemoteSessionEngine;
  /** hq-vscode: this member owns the session (the tree's "you"). ABSENT from an older HQ. */
  ownerIsMe?: boolean;
}

/** The engine a session runs, as the extension names it. */
export type RemoteSessionEngine = 'claude' | 'codex';

/** `POST …/workspaces/:ws/wake` (hq-vscode F10). */
export interface RemoteWakeResponse {
  state: 'waking' | 'running';
}

/** `POST …/workspaces/:ws/sessions` (hq-vscode F12). */
export interface RemoteSessionCreateRequest {
  engine?: RemoteSessionEngine;
  cols: number;
  rows: number;
}

export interface ShimSessionCreateRequest {
  term: string;
  cols: number;
  rows: number;
  initialPrompt?: string;
}

export interface ShimSessionCreateResponse {
  sessionId: string;
  url: string;
  canType: boolean;
}

/**
 * The `claude` shim's answer on a team whose engines do not include Claude Code (a Codex-only team):
 * `409 SHIM_ENGINE_UNSUPPORTED`, printed verbatim by the shim (src/runner/hq-shim/logic.ts carries
 * the same sentence; a test pins the two together). Plain words, no em dash.
 */
export const REMOTE_SHIM_ENGINE_UNSUPPORTED_MESSAGE =
  'This team runs Codex; the claude command works on Claude teams.';

/**
 * SSH to team machines is gone (2026-10-01): a machine reachable by a shell exposes its secrets. The
 * one sentence for every place that says so: the `410 SSH_REMOVED` answer to an `ssh` connect (old
 * published CLIs print a 410's message word for word) and the `hq ssh` / `hq ssh-proxy` / `hq open`
 * stubs. Plain words, no em dash.
 */
export const SSH_REMOVED_MESSAGE =
  'SSH access to team machines was removed on 2026-10-01. Use a terminal session in HQ, `hq attach <session> --team <team>`, `hq forward <port> --team <team>`, or the AI Workforce One HQ extension for VS Code.';

/** `<remoteHome>/.hq/current.json` (events.json CurrentConnectionFile). Written by the door. */
export interface CurrentConnectionFile {
  v: 1;
  connId: string;
  shimToken: string;
  workspaceId: string;
  orgSlug: string;
  hqHost: string;
  at: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Cookie (HQ UI) surfaces
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** SSH removed (2026-10-01): the only connections left on a team are forwards. */
export type RemotePresenceClient = 'forward' | 'unknown';

export interface RemotePresenceEntry {
  connectionId: string;
  userId: string;
  displayName: string;
  client: RemotePresenceClient;
  scope: RemoteScope;
  since: string;
}

export interface RemotePresenceResponse {
  connections: RemotePresenceEntry[];
  unmanagedClaude: { ssh: number; shell: number; orphan: number; measuredAt: string | null };
}

export interface RemoteGrantRow {
  id: string;
  /** Which HQ client holds the grant (hq-vscode). ABSENT from an older HQ: read as `hq`. */
  clientName?: RemoteDeviceClientName;
  userId: string;
  displayName: string;
  deviceLabel: string;
  platform: string;
  approvedAt: string;
  lastUsedAt: string | null;
}

export interface RemoteConnectionRow {
  id: string;
  userId: string;
  displayName: string;
  client: string;
  workspaceId: string;
  workspaceName: string;
  scope: RemoteScope;
  since: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Owner copy (review W7 / Test Plan A6e): ONE source for the Settings description and the consent,
// served by `GET /api/org/remote/availability` and rendered by the Settings page. Decision 18: never
// names VS Code. No em dashes. (The SSH door's copy went with SSH on 2026-10-01.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * hq-vscode decision 13: "Developer access" (`remote_access_enabled`) is files, terminal attach and
 * ports from a member's own computer, and no shell (FEATURE.md §Wireframes, HQ web Settings →
 * Security). No em dashes; "off", never "asleep".
 */
export const REMOTE_DEVELOPER_ACCESS_DESCRIPTION =
  'Members who can edit a team can open its files, join its terminals and forward its ports from their own computer (HQ for VS Code, the hq CLI). Everyone on a team machine shares one system account, so a forwarded port can reach any program listening on that machine.';

export const REMOTE_DEVELOPER_ACCESS_CONSENT_PARAGRAPHS: readonly string[] = [
  'Members who can edit a team will be able to open its files, join its terminals and forward its ports from their own computer, using HQ for VS Code or the hq command line tool. None of this opens a shell on the team machine.',
  "Everyone on a team machine shares one system account, so a forwarded port can reach any program listening on that machine, including dev servers other members run there. Each team's members are told this once.",
  'Files and terminals keep the permissions they have in HQ: viewers can look but cannot type or save, secrets stay masked, and protected template files stay read-only.',
  'Every connection and every saved file is recorded in your audit log. You can turn this off at any time; open connections close within 30 seconds.',
];

/** `GET /api/org/remote/availability` — whether Settings may offer the switch, and what it says. */
export interface RemoteAvailabilityResponse {
  /** `KR_REMOTE_ACCESS` is on for this deploy. */
  flag: boolean;
  /** The org is on `KR_REMOTE_ACCESS_ORGS` (or no allow-list is set). */
  allowListed: boolean;
  /** The plan carries `remote_access`. */
  planIncludes: boolean;
  /**
   * Ticket (am): the org is on the api serving tier, which remote access needs (the gate refuses
   * any other with 403 `serving_tier`). Absent from an older server: the client does not judge.
   */
  servingTierReady?: boolean;
  /**
   * hq-vscode decision 13: the Developer access switch's description and consent (A6e). The SSH
   * door's `copy` went with SSH on 2026-10-01.
   */
  developerCopy?: { setting: string; consent: readonly string[] };
  /**
   * Teams whose RUNNING machine booted before remote access was turned on, so it must restart
   * before forwarded ports work (its relay still accepts its static bearer: DEF-201 condition d,
   * review W11).
   */
  restartNeeded: string[];
}

export interface RemoteMemberNotice {
  /**
   * `forward` (hq-vscode): Developer access's one-time port notice. `sign_in` was the SSH door's
   * DEF-201 notice; SSH was removed on 2026-10-01 and the server no longer lists it.
   */
  kind?: 'sign_in' | 'forward';
  workspaceId: string;
  workspaceName: string;
  otherMembers: number;
  createdAt: string;
}

/** The org settings keys this feature adds (both owner-editable through `PUT /api/org`). */
export type RemoteUnmanagedPolicy = 'label' | 'kill';

/** Thin `remote-presence-changed` frame (events.json RemotePresenceChangedFrame). */
export interface RemotePresenceChangedFrame {
  type: 'remote-presence-changed';
  workspaceId: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Close codes (tunnel.md rev 2 §5, events.json TunnelCloseCodes)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const REMOTE_CLOSE_UNAUTHORIZED = 4401;
export const REMOTE_CLOSE_SSH_KEY_REFUSED = 4420;
export const REMOTE_CLOSE_SSH_CONN_REVOKED = 4421;
export const REMOTE_CLOSE_SSH_IDLE_SLEEP = 4422;
export const REMOTE_CLOSE_SSH_LIFETIME = 4423;
export const REMOTE_CLOSE_RUNNER_UNAVAILABLE = 4503;

/**
 * The workspace alias the CLI writes into `~/.ssh/hq_config` (`Host hq-<8hex>`). `workspaces` has no
 * slug column, so the alias is derived from the id: stable across renames, unique enough, and the
 * CLI widens it to 12 hex when two of the user's teams collide on 8.
 */
export function workspaceAlias(workspaceId: string, hexChars = 8): string {
  return `hq-${workspaceId.replace(/-/g, '').slice(0, hexChars).toLowerCase()}`;
}
