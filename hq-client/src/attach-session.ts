/**
 * One HQ session attach over `WS /ws/remote/terminal`, shared by `hq attach` and the VS Code
 * extension's terminal (hq-vscode decision 4 and 19). A bearer client of the SAME terminal path the
 * browser uses (decision 5): owner-only typing, masking and geometry are the server's rules. Where
 * the bytes go and where the keys come from is the caller's `TerminalSink` (the CLI: stdout, stderr
 * and raw stdin; the extension: a `Pseudoterminal`).
 *
 * The browser's client rules, applied here too (review 2026-09-27, D7/D9/D13):
 *   - terminal QUERIES in `history`/`output` are never written to the laptop terminal (the filter,
 *     `@kpa/shared/terminal-queries` by default), so the laptop never answers one into the agent;
 *   - a `presence` frame every 60 s while attached (the extension: only while its window is focused
 *     or active, `presenceWhen`, so a forgotten background window never keeps a machine awake);
 *   - the wake codes are progress (print the server's sentence, re-attach with intent `reconnect`),
 *     with "Still on it..." past 20 s and a bounded wait (`WAKE_TIMEOUT_MS`, the other doors' budget);
 *   - a `history_unavailable` notice is not printed during a wake (DEF-140: a FROZEN screen was not
 *     lost), nor right after a repaint or a reset (a sibling attach's read, not a lost screen);
 *   - after "Press any key to continue." (`workspace_asleep`, DEF-110) the next key re-attaches with
 *     intent `open` first, the one gesture that wakes the machine, for a view-only watcher too;
 *   - a dropped socket (1006, or 1001 from a draining replica / the hourly LB cut) reconnects with
 *     backoff and a freshly signed upgrade, re-attaching with intent `reconnect`.
 *
 * 0.2.3, THE HOURLY LB CUT: the load balancer closes every WebSocket at 3600 s (the backend config's
 * `timeoutSec`). So, as the web app does, (1) a drop of a socket that was admitted and STAYED UP
 * reconnects quietly: "connection lost" is said only when the re-attach is not admitted within
 * `QUIET_RECONNECT_NOTICE_MS`, or on a second drop in a row; and (2) MAKE-BEFORE-BREAK: before the
 * cut (`HANDOVER_AFTER_MS`, minus jitter) a standby socket attaches `reconnect`. Once it is admitted
 * and the terminal has been quiet for `HANDOVER_SETTLE_MS` on both sockets, it takes over in one
 * step: the old one closes 1000, and keys typed meanwhile wait until it has closed, then go out on the
 * new one, in order. Output carries no sequence number, so a terminal with output in flight is never
 * spliced: the standby is closed and the handover tried again `HANDOVER_RETRY_MS` later (and if it
 * never finds a quiet moment, the cut lands and (1) takes it).
 *
 * FAIL 4 (nonprod 2026-09-28): ONCE A WAKE IS OVER, THE PERSON'S ATTACH IS SAID AGAIN, AS `open`.
 * A machine that idle-slept drops the api tier's relay socket, and every session it served is left
 * `reconnecting` there; only an attach by someone who may write re-attaches one (DEF-147's
 * `reattachNow`, under the attaching person's principal). Since DEF-212 kr-api lets a writer's
 * `reconnect` poll do that too, so the first poll after the resume already brings live output. The
 * `open` below stays as the backstop (a server without DEF-212, or a round that backed off): the
 * machine is awake by then, so it wakes nothing and names nobody in a wake row; it only restates
 * who is watching, and costs one repaint.
 *
 * INSTANT LOCAL ECHO (feature `local-echo`): when the caller passes a `LocalEchoSession`, keystrokes
 * are predicted by the SAME engine the browser runs and drawn with ANSI bytes (`./local-echo/`), and
 * output goes through that session's ordered queue instead of straight to the sink.
 *
 * SHARED GEOMETRY (terminal-shared-geometry, prod 2026-10-02): one session in the web tab AND here.
 * The pty follows whoever claimed it last, and a terminal at another size garbles under Claude
 * Code's relative redraws. The server announces the pty's size (`geometry`); a terminal at another
 * size is a NON-OWNER: it draws at the pty's size where the sink can (`matchGeometry`, VS Code's
 * dimension override) and repaints once from a snapshot at the size it really draws (a `reconnect`
 * attach). The CLI cannot size the person's terminal, so its snapshot is at its own size. A focus
 * claim (`claim`, the extension) and a key from a non-owner send this terminal's own size first;
 * a view-only attach never claims.
 *
 * ⛔ "BACK" IS ONE SIGNAL ONLY: an `attached` whose answer carried NO wake code and NO asleep notice
 *    (review 2026-09-28). Bytes are not it: a SUSPENDING machine still has its relay socket, so it
 *    answers the wake code AND a readable screen, and ending the wake on those bytes re-sent `open`
 *    at network speed for the whole suspend. An answer that says "asleep, nobody waking it" (the
 *    wake was refused or failed) ends the wake QUIETLY: no `open` (that would wake the machine with
 *    no key pressed, DEF-110, and loop forever against a paused team); the next KEY sends it.
 */
import type { RemoteSessionSummary } from '@kpa/shared/remote.types';
import { createTerminalQueryFilter } from '@kpa/shared/terminal-queries';
import { isPassiveTerminalInput, mayClaimSize } from '@kpa/shared/terminal-input';
import WebSocket from 'ws';
import { HqApiError, NotLoggedInError, RefreshNeedsRenewingError, type HqClient } from './api.js';
import { WAKE_TIMEOUT_MS, wakeTimeoutMessage } from './connect.js';
import type { LocalEchoSession } from './local-echo/engine-adapter.js';
import type { Team } from './teams.js';
import { REMOTE_TERMINAL_WS_PATH, wsUrl, type WsFactory } from './tunnel-client.js';

export const TOKEN_CHECK_MS = 60_000;
/** The browser's presence heartbeat (runner-idle-sleep D13): "still here", once a minute. */
export const PRESENCE_MS = 60_000;
/** The browser's wake re-attach cadence: 2 s, then 4 s. */
export const WAKE_RETRY_MS = 2_000;
export const WAKE_RETRY_MAX_MS = 4_000;
/** The browser's "Still on it..." under a wake that runs past this (WakingPill). Not for a cold restart. */
export const WAKE_STILL_ON_IT_MS = 20_000;
/**
 * How long after a repaint (or a `reset`) a `history_unavailable` notice is a sibling attach's
 * failed read, not a lost screen: the browser's 8 s (DEF-23, the after-repaint grace).
 */
const HISTORY_NOTICE_GRACE_MS = 8_000;
const HISTORY_UNAVAILABLE_NOTICE = 'history_unavailable';
const WORKSPACE_ASLEEP_NOTICE = 'workspace_asleep';
/** Reconnect backoff after a dropped socket: 1 s doubling to 10 s, at most 8 attempts in a row. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
export const MAX_RECONNECTS = 8;
/** 0.2.3: a stable socket's drop says "connection lost" only if not re-admitted within this. */
export const QUIET_RECONNECT_NOTICE_MS = 3_000;
/** 0.2.3 make-before-break: the socket age a handover starts at (the LB cuts at 3600 s)... */
export const HANDOVER_AFTER_MS = 55 * 60_000;
/** ...minus a random part of this, so a window's terminals do not all hand over at once... */
export const HANDOVER_JITTER_MS = 3 * 60_000;
/** ...again this long after a handover that found the terminal busy... */
export const HANDOVER_RETRY_MS = 60_000;
/** ...and none started past this age (the cut, and the quiet reconnect, are next). */
export const HANDOVER_LAST_START_MS = 59 * 60_000;
/** Output-free time on both sockets before the switch. */
export const HANDOVER_SETTLE_MS = 300;
/** A standby not admitted within this is given up. */
export const HANDOVER_ADMIT_MS = 15_000;
/** Keys typed during the switch wait for the old socket's close at most this long. */
export const HANDOVER_INPUT_HOLD_MS = 2_000;

/**
 * local-echo RTT (Decision 15): WebSocket PROTOCOL pings, answered by the `ws` library at the other
 * end, so no server change and no JSON frame. One at once, a short burst, then this cadence.
 */
export const RTT_PING_MS = 30_000;
const RTT_BURST_MS = [500, 1_000, 1_500];

/**
 * `error` codes that END the attach: re-asking cannot change the answer (the browser's
 * `TERMINAL_ERROR_CODES`, plus FORBIDDEN when view-only is not the caller's choice). Every other
 * code is retryable, as in the browser: said once, then the attach is asked again with backoff
 * (nonprod 2026-09-30: `RUNNER_UNAVAILABLE` right after a wake ended the terminal on "We could not
 * reach the machine. Retrying." while a fresh attach worked).
 */
const TERMINAL_ERROR_CODES = new Set(['NOT_FOUND', 'SESSION_STOPPED', 'FORBIDDEN']);
/** A retryable error's re-attach: 2 s doubling to 10 s, for as long as the attach lives. */
export const ERROR_RETRY_MS = 2_000;
export const ERROR_RETRY_MAX_MS = 10_000;

/**
 * Focus events arrive in bursts (window focus + active terminal), and a person flicking between
 * windows fires them repeatedly: one claim, after the burst, by the terminal still in front.
 */
export const CLAIM_DEBOUNCE_MS = 300;
/**
 * The smallest terminal that may claim the pty (the browser's rule, `client/src/lib/shared-geometry.ts`):
 * below it, it keeps drawing at the pty's size and its keys go in at that size, so a tiny terminal
 * cannot shrink the session to something unusable. DEF-192's 100 x 24 read-only floor stays as is.
 */
export { MIN_CLAIM_COLS, MIN_CLAIM_ROWS } from '@kpa/shared/terminal-input';
/** A burst of pty size changes costs one snapshot, at the newest size. */
export const REPAINT_DEBOUNCE_MS = 150;
/**
 * How long this terminal's OWN resize is trusted over a different size the server announces (a
 * size broadcast before ours landed). Past it, the last size heard decides.
 */
export const OWN_RESIZE_ECHO_MS = 1_500;

/** The RETRYABLE codes the server sends while a machine starts or wakes (never a failure). */
const WAKE_CODES = new Set([
  'SESSION_STARTING',
  'SESSION_RESUMING',
  'SESSION_RESUME_RETRYING',
  'SESSION_RESUME_COLD_RESTART',
]);

/** Where an attach writes and reads. Every method is called on the attach's own schedule. */
export interface TerminalSink {
  /** The session's terminal bytes, already filtered. */
  write(bytes: string): void;
  /** One line about the attach for the person (the CLI: stderr). May carry `\r\n`. */
  say(line: string): void;
  /** The terminal's geometry now. */
  size(): { cols: number; rows: number };
  /** Start delivering keystrokes to `fn`; the returned function stops it (and pauses the source). */
  onInput(fn: (chunk: Buffer) => void): () => void;
  /** Geometry changes; the returned function unsubscribes. */
  onResize(fn: () => void): () => void;
  /**
   * terminal-shared-geometry: draw at exactly `dims` (the pty's size) instead of the terminal's own,
   * or go back to its own with `null`. Returns the size it will really draw at (VS Code applies an
   * override only where it is smaller than the panel). Absent (the CLI): it cannot be sized.
   */
  matchGeometry?(dims: { cols: number; rows: number } | null): { cols: number; rows: number };
}

/** The sentences an attach says on its own. The CLI's are the defaults. */
export interface AttachCopy {
  /** Put in front of every server sentence and every notice (`hq: `). */
  prefix: string;
  stillOnIt: string;
  wakeTimeout: (team: Team) => string;
  reconnecting: string;
  accessEnded: string;
  detached: string;
  /** hq-vscode: a `FORBIDDEN` on a view-only attach (the extension keeps the terminal open). */
  nowViewOnly: string;
  /** 0.2.2: the session's `status` frame said it stopped / exited with an error. */
  sessionStopped: string;
  sessionError: string;
}

export const CLI_ATTACH_COPY: AttachCopy = {
  prefix: 'hq: ',
  stillOnIt: 'hq: Still on it...',
  wakeTimeout: wakeTimeoutMessage,
  reconnecting: 'hq: connection lost, reconnecting...',
  accessEnded: 'hq: your access to this session ended.',
  detached: 'hq: detached.',
  nowViewOnly: 'hq: you can watch this session but not type in it.',
  sessionStopped: 'hq: the session stopped.',
  sessionError: 'hq: the session exited with an error.',
};

/** The extension's account errors (by `name`), never transient. */
const ACCOUNT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NeedsSignInError',
  'AccountGoneError',
  'SlotRenewedError',
]);

/** An admitted attach that lived at least this long resets the reconnect budget (review nit). */
export const ADMIT_STABLE_MS = 5_000;

/**
 * 0.2.2 (c): may a failure to BUILD an upgrade (the access token, the nonce) be retried? A network
 * failure, a timeout, a busy or unanswered refresh, or HQ's 5xx/429/408 are transient; a 4xx answer,
 * no sign-in, or a sign-in that needs renewing are not (the caller decides, as before).
 */
export function isTransientUpgradeError(err: unknown): boolean {
  if (err instanceof NotLoggedInError || err instanceof RefreshNeedsRenewingError) return false;
  // Review MUST 2: the extension's ACCOUNT errors (its token store throws them) are the caller's to
  // settle (a renew prompt, an account that went), never retried. By name: hq-client cannot import
  // the extension's classes. Its SecretsBusyError (the keychain answered slowly) stays transient.
  if (err instanceof Error && ACCOUNT_ERROR_NAMES.has(err.name)) return false;
  if (err instanceof HqApiError) {
    return err.status >= 500 || err.status === 429 || err.status === 408;
  }
  return true;
}

export interface AttachSessionOptions {
  wsFactory?: WsFactory;
  /** local-echo, when on for this attach (it outlives a reconnect). */
  echo?: LocalEchoSession | null;
  /** A key that detaches (the CLI: Ctrl-], 0x1d). None by default. */
  detachByte?: number | null;
  /** The output filter. Default: the shared terminal-query filter. */
  createFilter?: () => { push(chunk: string): string; flush(): string };
  /** Send the presence heartbeat only while this says yes. Default: always. */
  presenceWhen?: () => boolean;
  /** The first socket is open (the CLI prints "Attached to..." and puts stdin in raw mode). */
  onFirstOpen?: () => void;
  /**
   * What a `FORBIDDEN` error frame means: `end` the attach (the CLI), or `view-only`: stop sending
   * input and keep watching (the extension, decision 19).
   */
  onForbidden?: 'end' | 'view-only';
  /** Typing rights changed (the extension renames its terminal "· view only"). */
  onCanTypeChanged?: (canType: boolean) => void;
  /** The team machine reported its listening ports (the extension offers them in HQ Ports). */
  onListenPorts?: (ports: number[]) => void;
  /** A wake began (`true`) or ended (`false`): the extension renames its terminal "· waking". */
  onWaking?: (waking: boolean) => void;
  /**
   * The line said for a server `notice` (default: `prefix` + the server's text). The extension
   * words `workspace_asleep` its own way ("Backend team is off. Press any key to wake it.").
   */
  noticeText?: (code: string | undefined, text: string) => string;
  /** The line said for a wake code (default: `prefix` + the server's sentence). */
  wakeText?: (code: string, message: string) => string;
  /**
   * hq-vscode decision 19: a client ping this often, and the socket is treated as dropped when no
   * pong comes back within `livenessTimeoutMs`. Off by default (the CLI relies on TCP).
   */
  livenessPingMs?: number;
  livenessTimeoutMs?: number;
  copy?: Partial<AttachCopy>;
  /** Test seams (production uses the constants above). */
  presenceIntervalMs?: number;
  wakeRetryMs?: number;
  wakeStillMs?: number;
  wakeTimeoutMs?: number;
  reconnectBaseMs?: number;
  /** How long an admitted attach must stay up to reset the reconnect budget (`ADMIT_STABLE_MS`). */
  admitStableMs?: number;
  /** 0.2.3 (`QUIET_RECONNECT_NOTICE_MS`). */
  quietReconnectNoticeMs?: number;
  /** 0.2.3 make-before-break (`HANDOVER_AFTER_MS`); 0 turns it off. */
  handoverAfterMs?: number;
  handoverJitterMs?: number;
  handoverRetryMs?: number;
  handoverSettleMs?: number;
  errorRetryMs?: number;
  /**
   * 0.2.2: who may type in the session changed (`ownership-changed`, which carries no facts). The
   * web refetches the session; the caller does the same and applies it with `setCanType`.
   */
  onOwnershipChanged?: () => void;
  /**
   * terminal-shared-geometry: is this terminal in front right now? A focus `claim` that is still
   * waiting out its debounce is dropped when this says no (two windows fighting for focus settle on
   * the one that ends in front). Default: always.
   */
  inFront?: () => boolean;
  /**
   * The first attach's intent. `open` (default) is the person's gesture and wakes a sleeping
   * machine; the extension passes `reconnect` for a team it knows is off, so the server answers
   * "asleep" and only a KEY sends `open` (hq-vscode "Team off, terminal": "Press any key to wake it").
   */
  initialIntent?: 'open' | 'reconnect';
}

export interface AttachTarget {
  team: Team;
  session: RemoteSessionSummary;
}

/** How the whole attach ended. */
export type AttachEnd =
  /** The upgrade was refused (`status` 0: HQ could not be reached). */
  | { kind: 'refused'; status: number }
  /** The socket kept dropping and the reconnect budget ran out. */
  | { kind: 'lost' }
  | {
      kind: 'ended';
      exitCode: number;
      message: string | null;
      /** HQ closed it 4401: the login may be gone (the caller asks HQ once over HTTP). */
      unauthorized?: true;
    };

export interface AttachSession {
  /** Attach (and reconnect) until the attach ends. Resolves once. */
  run(): Promise<AttachEnd>;
  /** Detach on purpose (the terminal was closed): a `detach` frame, then a normal close. */
  detach(): void;
  /** Whether keystrokes are sent. */
  canType(): boolean;
  /** 0.2.2: apply typing rights the caller re-read (after `onOwnershipChanged`). */
  setCanType(can: boolean): void;
  /**
   * terminal-shared-geometry: this terminal came to the front (the extension: it became the active
   * terminal, or its window gained focus). Claims the pty's size after a short debounce if this
   * terminal is not the owner, may type, and is still in front then.
   */
  claim(): void;
}

/**
 * The wake, held across sockets: a drop mid-wake neither restarts its clock nor repeats its lines.
 * `since` is null while no wake is in flight.
 */
interface WakeState {
  since: number | null;
  /** The server's sentence last printed (printed again only when it changes). */
  said: string | null;
  cold: boolean;
  stillSaid: boolean;
  /** A `workspace_asleep` notice is showing: the next key re-attaches with intent `open`. */
  asleep: boolean;
}

type ServerFrame =
  | { type: 'output' | 'history'; sessionId: string; data: string }
  | { type: 'geometry'; sessionId: string; cols?: unknown; rows?: unknown; viewers?: unknown }
  | { type: 'reset'; sessionId: string; reattach?: boolean }
  | { type: 'status'; sessionId: string; status?: string }
  | { type: 'error'; sessionId: string | null; message: string; code: string }
  | { type: 'notice'; sessionId: string; text: string; code?: string }
  | { type: 'runner-metrics'; sessionId: string; listenPorts?: unknown }
  | { type: string; sessionId?: string };

/** A standby socket that took over (0.2.3): admitted, quiet, and the old one is closing. */
interface Handover {
  ws: WebSocket;
  headers: Record<string, string>;
  openedAt: number;
  filter: { push(chunk: string): string; flush(): string };
  /** The old socket has closed (or the hold ran out): held keys may go. */
  oldClosed: Promise<void>;
}

/** How one socket ended. `dropped` is a transport loss worth a reconnect. */
type SocketEnd =
  | { kind: 'dropped' }
  | ({ kind: 'handover' } & Handover)
  | { kind: 'ended'; exitCode: number; message: string | null; unauthorized?: true };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A port list the extension may offer: integers 1-65535, at most 64 (the runner's own bound). */
function cleanPorts(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ports = value.filter(
    (p): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65_535,
  );
  return ports.slice(0, 64);
}

export function createAttachSession(
  client: HqClient,
  target: AttachTarget,
  sink: TerminalSink,
  opts: AttachSessionOptions = {},
): AttachSession {
  const { team, session } = target;
  const copy: AttachCopy = { ...CLI_ATTACH_COPY, ...(opts.copy ?? {}) };
  const make: WsFactory = opts.wsFactory ?? ((url, h) => new WebSocket(url, { headers: h }));
  const reconnectBase = opts.reconnectBaseMs ?? RECONNECT_BASE_MS;
  const echo = opts.echo ?? null;
  const wake: WakeState = { since: null, said: null, cold: false, stillSaid: false, asleep: false };
  let canType = session.canType;
  let current: WebSocket | null = null;
  let detachRequested = false;
  const detachHooks = new Set<() => void>();
  // terminal-shared-geometry, held across sockets: what the server last said the pty is, and the
  // size this terminal draws at while it is not the owner (null: it is the owner).
  const geometry: {
    pty: Dims | null;
    drawn: Dims | null;
    /** The pty size the current match was made for (a repeat of it is not news). */
    matchedTo: Dims | null;
    ownResize: { dims: Dims; at: number } | null;
  } = { pty: null, drawn: null, matchedTo: null, ownResize: null };
  /** The live socket's claim, or null between sockets. */
  let claimNow: (() => void) | null = null;
  let claimTimer: NodeJS.Timeout | null = null;

  const setCanType = (next: boolean) => {
    if (next === canType) return;
    canType = next;
    opts.onCanTypeChanged?.(next);
  };

  async function run(): Promise<AttachEnd> {
    let announced = false;
    let intent: 'open' | 'reconnect' = opts.initialIntent ?? 'open';
    let reconnects = 0;
    /** When the current socket's attach was admitted (null: not yet). */
    let admittedAt: number | null = null;
    /** 0.2.3: a quiet drop's "connection lost", said only if no re-attach is admitted in time. */
    let lostNotice: NodeJS.Timeout | null = null;
    const cancelLostNotice = () => {
      if (lostNotice) clearTimeout(lostNotice);
      lostNotice = null;
    };
    /** 0.2.3: a standby that took over: the next socket is already open and admitted. */
    let next: Handover | null = null;
    try {
      return await runLoop();
    } finally {
      cancelLostNotice();
    }

    async function runLoop(): Promise<AttachEnd> {
      for (;;) {
        if (detachRequested) return { kind: 'ended', exitCode: 0, message: `\r\n${copy.detached}` };
        const adopt = next;
        next = null;
        // A FRESH signed upgrade every time: a nonce is single-use and the token may have rotated.
        let headers: Record<string, string>;
        let ws: WebSocket;
        if (adopt) {
          headers = adopt.headers;
          ws = adopt.ws;
          current = ws;
        } else {
          try {
            headers = await client.upgradeHeaders(REMOTE_TERMINAL_WS_PATH, team.org.slug);
          } catch (err) {
            // 0.2.2 (c): a transient failure (a hung or refused nonce, a network blip) is a failed
            // dial, never the end: the same backoff as an upgrade HQ did not answer. The first dial
            // keeps S4 (said at once). Anything else is the caller's, as before.
            if (!isTransientUpgradeError(err)) throw err;
            if ((reconnects > 0 || announced) && reconnects < MAX_RECONNECTS) {
              await sleep(Math.min(RECONNECT_MAX_MS, reconnectBase * 2 ** reconnects));
              reconnects += 1;
              intent = 'reconnect';
              continue;
            }
            if (reconnects >= MAX_RECONNECTS) return { kind: 'lost' };
            return { kind: 'refused', status: 0 };
          }
          ws = make(wsUrl(client.host, REMOTE_TERMINAL_WS_PATH), headers);
          current = ws;
          const opened = await new Promise<number | null>((resolve) => {
            ws.once('open', () => resolve(null));
            ws.once('unexpected-response', (_req, res) => {
              const status = res.statusCode ?? 0;
              res.resume();
              ws.terminate();
              resolve(status);
            });
            ws.once('error', () => resolve(0));
          });
          if (opened !== null) {
            // A reconnect that meets a restarting HQ (or no network yet) keeps trying, bounded. Never
            // the FIRST dial (S4): an attach that starts `reconnect` (a team that is off) shows HQ's
            // refusal at once instead of retrying silently.
            if (
              (reconnects > 0 || announced) &&
              intent === 'reconnect' &&
              (opened === 0 || opened === 503) &&
              reconnects < MAX_RECONNECTS
            ) {
              await sleep(Math.min(RECONNECT_MAX_MS, reconnectBase * 2 ** reconnects));
              reconnects += 1;
              continue;
            }
            return { kind: 'refused', status: opened };
          }
          if (!announced) {
            announced = true;
            opts.onFirstOpen?.();
          }
        }
        const end = await runSocket(
          ws,
          () => {
            // Review N5: the budget is MAX_RECONNECTS drops IN A ROW. An admitted attach that LIVES
            // ends the row (checked at the drop below), so a day of hourly LB cuts never adds up to a
            // give-up, while an admit-then-drop loop still runs out.
            admittedAt = Date.now();
            cancelLostNotice(); // 0.2.3: back within the bound: nothing to say
          },
          intent,
          headers,
          adopt,
        );
        if (end.kind === 'handover') {
          next = end;
          continue;
        }
        // Review nit: only an attach that stayed up ADMIT_STABLE_MS ends the row of failures.
        const stable =
          admittedAt !== null && Date.now() - admittedAt >= (opts.admitStableMs ?? ADMIT_STABLE_MS);
        if (stable) reconnects = 0;
        admittedAt = null;
        if (end.kind === 'dropped' && reconnects < MAX_RECONNECTS) {
          if (stable) {
            // 0.2.3: a socket that stayed up and dropped is most likely the LB's hourly cut: reconnect
            // quietly, and say it only if the re-attach is not admitted in time.
            lostNotice = setTimeout(() => {
              lostNotice = null;
              sink.say(`\r\n${copy.reconnecting}`);
            }, opts.quietReconnectNoticeMs ?? QUIET_RECONNECT_NOTICE_MS);
          } else {
            // A second drop in a row, or one that never settled: a real outage, said at once.
            cancelLostNotice();
            sink.say(`\r\n${copy.reconnecting}`);
          }
          await sleep(Math.min(RECONNECT_MAX_MS, reconnectBase * 2 ** reconnects));
          reconnects += 1;
          intent = 'reconnect';
          continue;
        }
        if (end.kind === 'dropped') return { kind: 'lost' };
        return end;
      }
    }
  }

  /**
   * Was `dims` broadcast before this terminal's own resize landed? Then it is not news (yet): the
   * last size heard decides once the window closes (`recheck`).
   */
  const staleEcho = (dims: Dims, recheck: () => void): boolean => {
    const own = geometry.ownResize;
    if (own === null) return false;
    if (sameDims(own.dims, dims)) {
      geometry.ownResize = null;
      return false;
    }
    const left = own.at + OWN_RESIZE_ECHO_MS - Date.now();
    if (left <= 0) {
      geometry.ownResize = null;
      return false;
    }
    setTimeout(() => {
      if (geometry.ownResize !== own) return;
      geometry.ownResize = null;
      recheck();
    }, left).unref?.();
    return true;
  };

  /** One socket's life: attach, pipe, heartbeat, until it closes. */
  function runSocket(
    ws: WebSocket,
    onAdmitted: () => void,
    intent: 'open' | 'reconnect',
    headers: Record<string, string>,
    adopt: Handover | null,
  ): Promise<SocketEnd> {
    // A reconnect / re-attach is a lifecycle reset (Decision 19): nothing predicted survives it. A
    // socket that took over (0.2.3) changed nothing on screen: the predictions stand.
    if (!adopt) echo?.lifecycleReset();
    /** The terminal shares the person's screen: take any drawn prediction off it first. */
    const say = (line: string): void => {
      echo?.undrawNow();
      sink.say(line);
    };
    let lastToken = (headers.Authorization ?? '').slice('Bearer '.length);
    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const size = () => sink.size();
    /** The size this terminal draws at: its own, or the pty's (as far as the sink can) as a non-owner. */
    const drawn = () => geometry.drawn ?? size();
    // What the answer to the attach we sent said, read when its `attached` (always last) lands: a
    // wake code (still waking), the asleep notice (nobody waking it), or neither (the machine is back).
    //
    // ⛔ ONE ATTACH OUTSTANDING, so those flags always belong to the answer being read (review W1).
    //    The next wake poll is armed from the `attached`, never from the wake code that precedes it:
    //    a slow screen read held that `attached` past the 2 s poll, the poll reset the flags, and the
    //    OLD answer then read as "back", re-sending `open`, reprinting "Waking" and restarting the
    //    budget. The server folds an attach that arrives mid-run anyway, so a second one bought nothing.
    let answerWaking = false;
    let answerAsleep = false;
    let attachOutstanding = false;
    /** A non-owner's `open` was answered at the pty's size: repaint at what it draws once admitted. */
    let repaintAfterOpen = false;
    const attachFrame = (i: 'open' | 'reconnect') => {
      answerWaking = false;
      answerAsleep = false;
      attachOutstanding = true;
      // The OWNER's attaches are unmarked and carry its size, as before (its `open` sizes the pty).
      // A NON-OWNER's are marked `repaint`, so the server never takes their size for the keystroke
      // re-statement (final review W1). Its `open` (the end of a wake, the key after "asleep") is not
      // a person claiming the size and carries NO size at all (final review W2): the server serializes
      // at the pty's own last-known size and sizes nothing — not `drawn()` (in a VS Code panel
      // narrower than the pty that is min(pty, panel)), and not the size last heard either (the pty
      // may have changed while the machine slept). It then repaints at what it draws once admitted.
      if (geometry.drawn === null) {
        send({ type: 'attach', sessionId: session.id, ...size(), intent: i });
        return;
      }
      if (i === 'open') {
        repaintAfterOpen = true;
        send({ type: 'attach', sessionId: session.id, intent: i, repaint: true });
        return;
      }
      send({ type: 'attach', sessionId: session.id, ...drawn(), intent: i, repaint: true });
    };
    // A socket that took over is already admitted (0.2.3); its filter is the old socket's, mid-stream.
    if (!adopt) attachFrame(intent);
    let filter = adopt ? adopt.filter : (opts.createFilter ?? createTerminalQueryFilter)();
    /**
     * 0.2.3: keys typed while the socket this one replaced is still closing wait for its close, so
     * the server never sees a later key before an earlier one (null: send at once).
     */
    let heldKeys: string[] | null = adopt ? [] : null;
    /** A reset+reattach arrived while an attach was out: re-attach when that one answers. */
    let reattachPending = false;
    /** The pty was replaced: send this terminal's size when the re-attach is admitted. */
    let resizeOnAdmit = false;
    /** 0.2.2: the last `status` said (each change is said once). */
    let statusSaid: string | null = null;

    return new Promise<SocketEnd>((resolve) => {
      let exitCode = 0;
      let errorMessage: string | null = null;
      let userDetached = false;
      let wakeTimer: NodeJS.Timeout | null = null;
      let wakeAttempts = 0;
      let stillTimer: NodeJS.Timeout | null = null;
      let giveUpTimer: NodeJS.Timeout | null = null;
      let errorRetryTimer: NodeJS.Timeout | null = null;
      let errorRetries = 0;
      /** The retryable error last said, so a retry loop says it once (cleared when admitted). */
      let errorSaid: string | null = null;
      // When the screen was last repainted (a `history`) or wiped (a `reset`), for the notice grace.
      let repaintedAt = 0;
      /** 0.2.3: when this socket last wrote anything to the screen (a handover needs quiet). */
      let lastOutputAt = 0;
      if (adopt) {
        onAdmitted();
        void adopt.oldClosed.then(() => {
          const keys = heldKeys ?? [];
          heldKeys = null;
          for (const data of keys) send({ type: 'input', sessionId: session.id, data });
        });
      }

      // The wake cadence: 2 s, then 4 s (the browser's), one poll pending at most.
      const schedulePoll = () => {
        if (wakeTimer !== null) return;
        const base = opts.wakeRetryMs ?? WAKE_RETRY_MS;
        const delay =
          wakeAttempts === 0 ? base : Math.max(base, Math.min(WAKE_RETRY_MAX_MS, base * 2));
        wakeAttempts += 1;
        wakeTimer = setTimeout(() => {
          wakeTimer = null;
          attachFrame('reconnect');
        }, delay);
      };
      // A retryable error: ask again, 2 s doubling to 10 s, one attach outstanding at most.
      const scheduleErrorRetry = () => {
        if (errorRetryTimer !== null) return;
        const base = opts.errorRetryMs ?? ERROR_RETRY_MS;
        const delay = Math.min(ERROR_RETRY_MAX_MS, base * 2 ** Math.min(errorRetries, 8));
        errorRetries += 1;
        errorRetryTimer = setTimeout(() => {
          errorRetryTimer = null;
          if (!attachOutstanding) attachFrame('reconnect');
        }, delay);
      };
      const clearWakeTimers = () => {
        if (wakeTimer) clearTimeout(wakeTimer);
        if (stillTimer) clearTimeout(stillTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        wakeTimer = stillTimer = giveUpTimer = null;
      };
      // The wake's two clocks, measured from when it BEGAN (`wake.since`), so a socket that dropped
      // mid-wake resumes them rather than starting over.
      const armWakeClocks = (since: number) => {
        const now = Date.now();
        if (stillTimer === null && !wake.stillSaid) {
          stillTimer = setTimeout(
            () => {
              // A cold restart has already said the real answer; "Still on it..." would be vaguer.
              if (wake.since === null || wake.cold || wake.stillSaid) return;
              wake.stillSaid = true;
              say(`\r\n${copy.stillOnIt}`);
            },
            Math.max(0, since + (opts.wakeStillMs ?? WAKE_STILL_ON_IT_MS) - now),
          );
        }
        if (giveUpTimer === null) {
          giveUpTimer = setTimeout(
            () => {
              // Said NOW, then the socket is cut: a clean close could wait out the 30 s handshake
              // timeout on a replica that stopped answering (review N3).
              say(`\r\n${copy.wakeTimeout(team)}`);
              errorMessage = '';
              exitCode = 1;
              ws.terminate();
            },
            Math.max(0, since + (opts.wakeTimeoutMs ?? WAKE_TIMEOUT_MS) - now),
          );
        }
      };
      /** Forget the wake. `asleep` is left as it is: the caller decides whether a key is awaited. */
      const clearWake = () => {
        if (wake.since !== null) opts.onWaking?.(false);
        wake.since = null;
        wake.said = null;
        wake.cold = false;
        wake.stillSaid = false;
        wakeAttempts = 0;
        clearWakeTimers();
      };
      // The machine is back: the wake is over. Say the person's attach once more, as `open`, so a
      // session the wake left behind is re-attached (see the header, FAIL 4).
      const endWake = () => {
        if (wake.since === null) return;
        clearWake();
        wake.asleep = false;
        attachFrame('open');
      };
      // Review N4: a socket that replaced one dropped mid-wake keeps the wake's clocks from the
      // start, so a replica that never answers still meets the ORIGINAL bound.
      if (wake.since !== null) armWakeClocks(wake.since);

      const tokenTimer = setInterval(() => {
        void client
          .accessToken()
          .then((t) => {
            if (t !== lastToken) {
              lastToken = t;
              send({ type: 'remote-token', token: t });
            }
          })
          .catch(() => undefined);
      }, TOKEN_CHECK_MS);
      // D13: the browser's "still here" while its tab is visible. A terminal that is attached IS
      // visible to the person running `hq attach`; the extension says it only while its window is
      // focused or active (`presenceWhen`, decision 17).
      const presenceTimer = setInterval(() => {
        if (opts.presenceWhen && !opts.presenceWhen()) return;
        send({ type: 'presence', sessionId: session.id });
      }, opts.presenceIntervalMs ?? PRESENCE_MS);
      presenceTimer.unref?.();
      tokenTimer.unref?.();

      // local-echo RTT: protocol pings, stamped with the send time (Decision 15).
      const rttTimers: NodeJS.Timeout[] = [];
      if (echo) {
        const ping = (): void => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.ping(String(Date.now()));
          } catch {
            // A socket closing under us: no sample this round.
          }
        };
        ws.on('pong', (payload: Buffer) => {
          const sentAt = Number(payload.toString('utf8'));
          if (Number.isFinite(sentAt)) echo.rttSample(Date.now() - sentAt);
        });
        ping();
        for (const ms of RTT_BURST_MS) rttTimers.push(setTimeout(ping, ms));
        rttTimers.push(setInterval(ping, RTT_PING_MS));
        for (const tm of rttTimers) tm.unref?.();
      }

      // hq-vscode decision 19: a liveness check. Any pong counts (the RTT pings' too).
      let livenessTimer: NodeJS.Timeout | null = null;
      let lastPongAt = Date.now();
      if (opts.livenessPingMs !== undefined) {
        const timeout = opts.livenessTimeoutMs ?? 10_000;
        ws.on('pong', () => {
          lastPongAt = Date.now();
        });
        let pingSentAt = 0;
        livenessTimer = setInterval(
          () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (pingSentAt > lastPongAt && Date.now() - pingSentAt > timeout) {
              ws.terminate(); // a silent socket: closes 1006, which reconnects
              return;
            }
            if (pingSentAt <= lastPongAt) {
              pingSentAt = Date.now();
              try {
                ws.ping();
              } catch {
                /* closing under us */
              }
            }
          },
          Math.min(opts.livenessPingMs, timeout),
        );
        livenessTimer.unref?.();
      }

      // terminal-shared-geometry: a repaint at the size this terminal draws, debounced, never with
      // another attach outstanding, never into a wake (a frozen machine has no screen to read).
      let repaintTimer: NodeJS.Timeout | null = null;
      let repaintPending = false;
      const repaint = () => {
        if (repaintTimer) clearTimeout(repaintTimer);
        repaintTimer = setTimeout(() => {
          repaintTimer = null;
          if (wake.since !== null || wake.asleep) return;
          if (attachOutstanding) repaintPending = true;
          else attachFrame('reconnect');
        }, REPAINT_DEBOUNCE_MS);
      };
      const sendOwnSize = () => {
        const own = size();
        geometry.ownResize = { dims: own, at: Date.now() };
        send({ type: 'resize', sessionId: session.id, ...own });
      };
      /** Back to this terminal's own size: the override cleared, nothing repainted or sent. */
      const becomeOwner = () => {
        if (geometry.drawn === null) return; // the owner already
        geometry.drawn = null;
        geometry.matchedTo = null;
        sink.matchGeometry?.(null);
        if (repaintTimer) clearTimeout(repaintTimer);
        repaintTimer = null;
        repaintPending = false;
        const own = size();
        echo?.resize(own.cols, own.rows);
      };
      /**
       * Draw at the pty's size (a non-owner) or this terminal's own (the owner); repaint if what it
       * draws moved. `boxMoved`: the terminal's own box changed, so the match is made again.
       */
      const follow = (boxMoved = false) => {
        const pty = geometry.pty;
        if (pty === null) return;
        const own = size();
        if (sameDims(own, pty)) {
          becomeOwner();
          return;
        }
        const matched = geometry.matchedTo;
        if (!boxMoved && geometry.drawn !== null && matched !== null && sameDims(matched, pty)) {
          return; // the same size again (every attach is told it): nothing moved
        }
        const next = sink.matchGeometry ? sink.matchGeometry(pty) : own;
        geometry.matchedTo = pty;
        if (geometry.drawn !== null && sameDims(geometry.drawn, next)) return;
        geometry.drawn = next;
        echo?.resize(next.cols, next.rows);
        repaint();
      };
      // A claim: this terminal's own size goes to the pty. Only a non-owner that may type claims.
      claimNow = () => {
        if (!canType || geometry.drawn === null) return;
        const own = size();
        if (!mayClaimSize(own)) return; // too small to own it (`MIN_CLAIM_COLS` x `MIN_CLAIM_ROWS`)
        geometry.drawn = null;
        geometry.matchedTo = null;
        sink.matchGeometry?.(null);
        if (repaintTimer) clearTimeout(repaintTimer);
        repaintTimer = null;
        repaintPending = false;
        echo?.resize(own.cols, own.rows);
        // The pty is already at this size: nothing to send (no redraw for nothing).
        if (geometry.pty !== null && sameDims(geometry.pty, own)) return;
        sendOwnSize();
      };
      const onResize = () => {
        if (geometry.drawn !== null) {
          // Not the owner: this terminal's box moved, the pty did not. Re-fit the match (VS Code
          // draws at min(pty, panel)) and repaint if what it draws changed; nothing is claimed.
          follow(true);
          return;
        }
        // Review C1: a box change claims the pty only for a terminal in FRONT. A window in the
        // background whose panel moved (or a host echoing an override back) must not take the size
        // from the window the person is in; it becomes a non-owner and matches instead. With no
        // size heard yet (an older server), it states its size as it always did.
        if (geometry.pty !== null && opts.inFront && !opts.inFront()) {
          follow(true);
          return;
        }
        echo?.resize(size().cols, size().rows);
        sendOwnSize();
      };
      const detachNow = () => {
        // local-echo: nothing dim or underlined is left on screen once the socket is gone (C11).
        echo?.close();
        userDetached = true;
        send({ type: 'detach', sessionId: session.id });
        ws.close(1000);
      };
      const onData = (chunk: Buffer) => {
        const i =
          opts.detachByte === null || opts.detachByte === undefined
            ? -1
            : chunk.indexOf(opts.detachByte);
        const before = i >= 0 ? chunk.subarray(0, i) : chunk;
        // DEF-110: a key on a machine the server said is asleep is the person asking for it. The
        // browser re-attaches `open` first; so do we, typing rights or not (a viewer's key wakes too).
        if (before.length > 0 && wake.asleep) {
          wake.asleep = false;
          attachFrame('open');
        }
        if (canType && before.length > 0) {
          const data = before.toString('utf8');
          // A key from a non-owner: its size goes to the pty first (before the held keys of a
          // handover, too). Not a focus or wheel report: nobody typed those (review W5).
          if (!isPassiveTerminalInput(data)) claimNow?.();
          echo?.key(data); // judged in order with the output; the bytes go out right now regardless
          if (heldKeys) heldKeys.push(data);
          else send({ type: 'input', sessionId: session.id, data });
        }
        if (i >= 0) detachNow();
      };
      detachHooks.add(detachNow);
      const offResize = sink.onResize(onResize);
      const offInput = sink.onInput(onData);

      ws.on('message', (data: Buffer) => {
        // 0.2.3: once a standby took over, this socket's frames are the new one's, already written.
        if (handedOver) return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(data.toString('utf8')) as ServerFrame;
        } catch {
          return;
        }
        if (
          frame.sessionId !== undefined &&
          frame.sessionId !== null &&
          frame.sessionId !== session.id
        )
          return;
        if (frame.type === 'output' || frame.type === 'history' || frame.type === 'reset') {
          lastOutputAt = Date.now();
        }
        if ((frame.type === 'output' || frame.type === 'history') && 'data' in frame) {
          if (frame.type === 'history') repaintedAt = Date.now();
          wake.asleep = false;
          const clean = filter.push(frame.data);
          if (clean.length > 0) {
            if (!echo) sink.write(clean);
            else if (frame.type === 'history') echo.repaint(clean);
            else echo.output(clean);
          }
          // NOT the end of a wake: a suspending machine repaints its screen with the wake code.
        } else if (frame.type === 'reset') {
          repaintedAt = Date.now();
          if ('reattach' in frame && frame.reattach === true) {
            // 0.2.2 (b): the RUNNER replaced the pty (the web's "solid restart"): this socket's
            // subscription is bound to the dead one. Everything about the old screen goes (the echo's
            // predictions, the filter's held bytes, every terminal mode via a hard reset), then a
            // `reconnect` re-attach (DEF-110: the runner did this, not the person) binds the new pty.
            echo?.lifecycleReset();
            filter = (opts.createFilter ?? createTerminalQueryFilter)();
            // 0.2.2 live: ESC c, then an explicit home + clear screen + clear scrollback, so nothing
            // of the old process stays visible whatever the terminal makes of RIS.
            const wipe = '\x1bc\x1b[H\x1b[2J\x1b[3J';
            if (echo) echo.repaint(wipe);
            else sink.write(wipe);
            // The new pty has never been sized, and a `reconnect` attach does not size it (the server
            // sizes only `open`, so tabs never fight over it): this terminal's size goes once the
            // re-attach is admitted (live: the new session wrapped at the wrong width until a key).
            resizeOnAdmit = true;
            // Never two attaches out at once. One already out may bind the OLD pty (it was sent
            // before the reset), so the re-attach waits for its answer (re-review).
            if (attachOutstanding) reattachPending = true;
            else attachFrame('reconnect');
            return;
          }
          if (echo) echo.repaint('\x1b[H\x1b[2J\x1b[3J');
          else sink.write('\x1b[H\x1b[2J\x1b[3J');
        } else if (frame.type === 'status' && 'status' in frame) {
          // 0.2.2 (b), the web's rule (DEF-133): while the machine is asleep or waking, an "error"
          // is about the SOCKET, not the session, and is not said. Each change is said once.
          const st = typeof frame.status === 'string' ? frame.status : '';
          if (st === 'error' && (wake.since !== null || wake.asleep)) return;
          if (st === statusSaid) return;
          statusSaid = st;
          if (st === 'stopped') say(`\r\n${copy.sessionStopped}`);
          else if (st === 'error') say(`\r\n${copy.sessionError}`);
        } else if (frame.type === 'geometry') {
          const pty = wireDims(
            'cols' in frame ? frame.cols : undefined,
            'rows' in frame ? frame.rows : undefined,
          );
          if (pty === null) return;
          geometry.pty = pty;
          // W6: told it is the only viewer, this terminal is the owner whatever the size says.
          if ('viewers' in frame && frame.viewers === 1) {
            geometry.ownResize = null;
            becomeOwner();
            // Final review (CRITICAL): alone at a size that is not the pty's (the owner left and this
            // terminal came back by itself), nobody else will ever size it: this terminal does, or it
            // draws at its own size against another pty — the original garble.
            if (!sameDims(size(), pty)) sendOwnSize();
            return;
          }
          if (staleEcho(pty, () => follow())) return;
          follow();
        } else if (frame.type === 'ownership-changed') {
          // 0.2.2 (b): the frame carries no facts on purpose; the caller re-reads the rights.
          opts.onOwnershipChanged?.();
        } else if (frame.type === 'attached') {
          attachOutstanding = false;
          onAdmitted();
          if (reattachPending) {
            // A reset+reattach came while this attach was out: bind the NEW pty now (once).
            reattachPending = false;
            attachFrame('reconnect');
            return;
          }
          if (resizeOnAdmit) {
            resizeOnAdmit = false;
            // W2: only the OWNER sizes the new pty. A non-owner already re-attached at the size it
            // draws (a `reconnect`, which never sizes), so it matches and has its fresh screen.
            if (geometry.drawn === null) send({ type: 'resize', sessionId: session.id, ...size() });
          }
          if (repaintAfterOpen) {
            repaintAfterOpen = false;
            repaintPending = true;
          }
          if (repaintPending) {
            repaintPending = false;
            if (wake.since === null && !wake.asleep) {
              attachFrame('reconnect');
              return;
            }
          }
          if (!answerWaking && !answerAsleep) {
            errorRetries = 0;
            errorSaid = null;
          }
          if (answerWaking) {
            schedulePoll(); // still waking: ask again, now that nothing is outstanding
            return;
          }
          if (answerAsleep) {
            // Asleep and nobody waking it (a refused or failed wake): stop waiting, send nothing.
            // "Press any key to continue." is on screen, and the key is what sends `open`.
            if (wake.since !== null) clearWake();
            return;
          }
          endWake(); // admitted with no wake code and no asleep notice: the machine is back
        } else if (frame.type === 'runner-metrics' && 'listenPorts' in frame) {
          const ports = cleanPorts(frame.listenPorts);
          if (ports !== null) opts.onListenPorts?.(ports);
        } else if (frame.type === 'error' && 'message' in frame) {
          const code = 'code' in frame ? frame.code : '';
          if (WAKE_CODES.has(code)) {
            // Progress, not failure: say the server's sentence once per change, re-attach shortly.
            answerWaking = true;
            wake.asleep = false;
            wake.cold = code === 'SESSION_RESUME_COLD_RESTART';
            if (wake.since === null) {
              wake.since = Date.now();
              opts.onWaking?.(true);
            }
            armWakeClocks(wake.since);
            if (wake.said !== frame.message) {
              wake.said = frame.message;
              say(
                `\r\n${opts.wakeText ? opts.wakeText(code, frame.message) : `${copy.prefix}${frame.message}`}`,
              );
            }
            // A keystroke's wake code arrives with no attach outstanding: nothing else will arm the
            // cadence, so it starts here. An attach's own code waits for its `attached` (above).
            if (!attachOutstanding) schedulePoll();
            return;
          }
          if (code === 'FORBIDDEN' && opts.onForbidden === 'view-only') {
            // Decision 19: the server dropped a keystroke (the role changed, or ownership moved).
            // Watching goes on; typing stops, and the terminal says so once.
            if (canType) {
              setCanType(false);
              say(`\r\n${copy.nowViewOnly}`);
            }
            return;
          }
          if (!TERMINAL_ERROR_CODES.has(code)) {
            // Retryable (the browser's rule): say it once, then ask again. While a wake is in
            // flight or the machine is asleep, "could not reach" is what that IS: not said.
            attachOutstanding = false;
            const quiet = code === 'RUNNER_UNAVAILABLE' && (wake.since !== null || wake.asleep);
            if (!quiet && errorSaid !== frame.message) {
              errorSaid = frame.message;
              say(`\r\n${copy.prefix}${frame.message}`);
            }
            scheduleErrorRetry();
            return;
          }
          errorMessage = `\r\n${copy.prefix}${frame.message}`;
          exitCode = 1;
          ws.close(1000);
        } else if (frame.type === 'notice' && 'text' in frame) {
          const code = 'code' in frame ? frame.code : undefined;
          // DEF-140: a screen that is FROZEN (a wake, or a machine asleep) was not lost; and one
          // just repainted or wiped was read by a sibling attach. Neither is news.
          if (
            code === HISTORY_UNAVAILABLE_NOTICE &&
            (wake.since !== null ||
              wake.asleep ||
              Date.now() - repaintedAt < HISTORY_NOTICE_GRACE_MS)
          )
            return;
          if (code === WORKSPACE_ASLEEP_NOTICE) {
            wake.asleep = true;
            answerAsleep = true;
          }
          say(
            `\r\n${opts.noticeText ? opts.noticeText(code, frame.text) : `${copy.prefix}${frame.text}`}`,
          );
        }
      });
      /** Everything this socket runs, stopped (its close, or a standby taking over). */
      const teardown = () => {
        detachHooks.delete(detachNow);
        for (const tm of rttTimers) clearTimeout(tm);
        if (livenessTimer) clearInterval(livenessTimer);
        clearInterval(tokenTimer);
        clearInterval(presenceTimer);
        clearWakeTimers();
        if (errorRetryTimer) clearTimeout(errorRetryTimer);
        if (handoverTimer) clearTimeout(handoverTimer);
        handoverTimer = null;
        // terminal-shared-geometry: this socket's claim and repaint go with it. In teardown, never in
        // the close handler: after a handover the old socket closes AFTER the new one took over, and
        // its close must not null the NEW socket's claim.
        if (repaintTimer) clearTimeout(repaintTimer);
        repaintTimer = null;
        repaintPending = false;
        claimNow = null;
        offInput();
        offResize();
      };

      // ── 0.2.3: make-before-break (see the header) ──────────────────────────────────────────
      const openedAt = adopt?.openedAt ?? Date.now();
      const handoverAfter = opts.handoverAfterMs ?? HANDOVER_AFTER_MS;
      const retryMs = opts.handoverRetryMs ?? HANDOVER_RETRY_MS;
      let handoverTimer: NodeJS.Timeout | null = null;
      let handedOver = false;
      let markOldClosed: () => void = () => undefined;
      interface Standby {
        ws: WebSocket;
        headers: Record<string, string>;
        openedAt: number;
        /** When its attach was sent: output on the old socket since then means "busy". */
        sentAt: number;
        sawOutput: boolean;
        timer: NodeJS.Timeout | null;
      }
      let standby: Standby | null = null;
      const scheduleHandover = (delay: number) => {
        if (handoverAfter <= 0 || handoverTimer !== null || handedOver || standby) return;
        const lastStart = Math.max(HANDOVER_LAST_START_MS, handoverAfter);
        if (Date.now() + delay - openedAt > lastStart) return; // the cut is near: the quiet reconnect
        handoverTimer = setTimeout(
          () => {
            handoverTimer = null;
            void beginHandover();
          },
          Math.max(0, delay),
        );
      };
      /** Nothing in flight on this socket that a takeover would cut across. */
      const steady = () =>
        ws.readyState === WebSocket.OPEN &&
        !userDetached &&
        !detachRequested &&
        !attachOutstanding &&
        !reattachPending &&
        !resizeOnAdmit &&
        errorRetryTimer === null &&
        wake.since === null &&
        !wake.asleep &&
        heldKeys === null && // keys still waiting on the socket this one replaced
        // terminal-shared-geometry: a repaint is on its way; a switch would drop it on the floor.
        repaintTimer === null &&
        !repaintPending &&
        !repaintAfterOpen;
      const giveUpStandby = (retry: boolean) => {
        const sb = standby;
        standby = null;
        if (sb) {
          if (sb.timer) clearTimeout(sb.timer);
          if (sb.ws.readyState === WebSocket.OPEN) sb.ws.close(1000);
          else sb.ws.terminate();
        }
        if (retry) scheduleHandover(retryMs);
      };
      const takeOver = (sb: Standby) => {
        standby = null;
        handedOver = true;
        if (sb.timer) clearTimeout(sb.timer);
        teardown();
        sb.ws.removeAllListeners('message');
        sb.ws.removeAllListeners('close');
        sb.ws.removeAllListeners('unexpected-response');
        const oldClosed = new Promise<void>((done) => {
          const hold = setTimeout(done, HANDOVER_INPUT_HOLD_MS);
          markOldClosed = () => {
            clearTimeout(hold);
            done();
          };
        });
        current = sb.ws;
        resolve({
          kind: 'handover',
          ws: sb.ws,
          headers: sb.headers,
          openedAt: sb.openedAt,
          filter,
          oldClosed,
        });
        ws.close(1000);
      };
      const settle = (sb: Standby) => {
        if (sb.timer) clearTimeout(sb.timer);
        sb.timer = setTimeout(() => {
          sb.timer = null;
          if (standby !== sb) return;
          // Output on either socket since the standby asked means bytes in flight that two streams
          // with no sequence number cannot be spliced across: not now.
          const quiet = lastOutputAt < sb.sentAt && !sb.sawOutput;
          if (!quiet || !steady() || sb.ws.readyState !== WebSocket.OPEN) giveUpStandby(true);
          else takeOver(sb);
        }, opts.handoverSettleMs ?? HANDOVER_SETTLE_MS);
      };
      const beginHandover = async () => {
        if (standby || handedOver || ws.readyState !== WebSocket.OPEN) return;
        if (!steady()) {
          scheduleHandover(retryMs);
          return;
        }
        let h: Record<string, string>;
        try {
          h = await client.upgradeHeaders(REMOTE_TERMINAL_WS_PATH, team.org.slug);
        } catch {
          scheduleHandover(retryMs);
          return;
        }
        if (standby || handedOver || !steady()) return;
        const next = make(wsUrl(client.host, REMOTE_TERMINAL_WS_PATH), h);
        const sb: Standby = {
          ws: next,
          headers: h,
          openedAt: 0,
          sentAt: Date.now(),
          sawOutput: false,
          timer: null,
        };
        standby = sb;
        next.on('error', () => undefined);
        next.once('unexpected-response', (_req, res) => {
          res.resume();
          if (standby === sb) giveUpStandby(true);
        });
        next.once('close', () => {
          if (standby === sb) giveUpStandby(true);
        });
        sb.timer = setTimeout(() => {
          if (standby === sb) giveUpStandby(true);
        }, HANDOVER_ADMIT_MS);
        next.once('open', () => {
          if (standby !== sb) return;
          sb.openedAt = Date.now();
          sb.sentAt = Date.now();
          // `reconnect`: the client's own, so it neither sizes the pty nor counts as a person. At the
          // size this terminal DRAWS (a non-owner draws the pty's), like every other `reconnect`.
          next.send(
            JSON.stringify({
              type: 'attach',
              sessionId: session.id,
              ...drawn(),
              intent: 'reconnect',
              // A non-owner's standby is its own attach, marked like every other (final review W1).
              ...(geometry.drawn !== null ? { repaint: true } : {}),
            }),
          );
        });
        next.on('message', (raw: Buffer) => {
          if (standby !== sb) return;
          let f: ServerFrame;
          try {
            f = JSON.parse(raw.toString('utf8')) as ServerFrame;
          } catch {
            return;
          }
          if (f.sessionId !== undefined && f.sessionId !== null && f.sessionId !== session.id) {
            return;
          }
          // Its repaint is the screen already showing; its output is the old socket's, written.
          if (f.type === 'history') return;
          if (f.type === 'output') {
            sb.sawOutput = true;
            return;
          }
          if (f.type === 'attached') {
            settle(sb);
            return;
          }
          // A wake code, an error, a reset, or a notice (other than the sibling-read one): the
          // session is in some state a quiet switch would hide. The old socket carries on.
          const benignNotice =
            f.type === 'notice' && 'code' in f && f.code === HISTORY_UNAVAILABLE_NOTICE;
          if (f.type === 'error' || f.type === 'reset' || (f.type === 'notice' && !benignNotice)) {
            giveUpStandby(true);
          }
        });
      };
      if (handoverAfter > 0) {
        const jitter = Math.random() * (opts.handoverJitterMs ?? HANDOVER_JITTER_MS);
        scheduleHandover(handoverAfter - jitter - (Date.now() - openedAt));
      }

      ws.on('error', () => undefined);
      ws.on('close', (code) => {
        if (handedOver) {
          markOldClosed(); // the held keys may go out on the new socket now
          return;
        }
        teardown();
        giveUpStandby(false);
        const held = filter.flush();
        if (held.length > 0 && !userDetached) {
          if (echo) echo.output(held);
          else sink.write(held);
        }
        // local-echo: whatever is still queued reaches the terminal before anything is said about
        // the socket, and nothing predicted is left drawn across a reconnect.
        echo?.undrawNow();
        if (!userDetached && exitCode === 0 && (code === 1006 || code === 1001)) {
          resolve({ kind: 'dropped' });
          return;
        }
        if (code === 4401) {
          resolve({
            kind: 'ended',
            exitCode: 1,
            message: `\r\n${copy.accessEnded}`,
            unauthorized: true,
          });
          return;
        }
        if (errorMessage !== null) {
          if (errorMessage.length > 0) say(errorMessage);
          resolve({ kind: 'ended', exitCode, message: null });
          return;
        }
        resolve({ kind: 'ended', exitCode, message: `\r\n${copy.detached}` });
      });
    });
  }

  return {
    run,
    detach: () => {
      detachRequested = true;
      for (const hook of [...detachHooks]) hook();
      if (detachHooks.size === 0 && current && current.readyState === WebSocket.CONNECTING) {
        current.terminate();
      }
    },
    canType: () => canType,
    setCanType: (can: boolean) => setCanType(can),
    claim: () => {
      if (claimTimer) clearTimeout(claimTimer);
      claimTimer = setTimeout(() => {
        claimTimer = null;
        if (opts.inFront && !opts.inFront()) return;
        claimNow?.();
      }, CLAIM_DEBOUNCE_MS);
      claimTimer.unref?.();
    },
  };
}

interface Dims {
  cols: number;
  rows: number;
}

const sameDims = (a: Dims, b: Dims): boolean => a.cols === b.cols && a.rows === b.rows;

/** The server's own wire caps for a size (500 x 300): anything else is not a size. */
function wireDims(cols: unknown, rows: unknown): Dims | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  return cols >= 1 && cols <= 500 && rows >= 1 && rows <= 300 ? { cols, rows } : null;
}
