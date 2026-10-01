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
 * ⛔ "BACK" IS ONE SIGNAL ONLY: an `attached` whose answer carried NO wake code and NO asleep notice
 *    (review 2026-09-28). Bytes are not it: a SUSPENDING machine still has its relay socket, so it
 *    answers the wake code AND a readable screen, and ending the wake on those bytes re-sent `open`
 *    at network speed for the whole suspend. An answer that says "asleep, nobody waking it" (the
 *    wake was refused or failed) ends the wake QUIETLY: no `open` (that would wake the machine with
 *    no key pressed, DEF-110, and loop forever against a paused team); the next KEY sends it.
 */
import type { RemoteSessionSummary } from '@kpa/shared/remote.types';
import { createTerminalQueryFilter } from '@kpa/shared/terminal-queries';
import WebSocket from 'ws';
import type { HqClient } from './api.js';
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
}

export const CLI_ATTACH_COPY: AttachCopy = {
  prefix: 'hq: ',
  stillOnIt: 'hq: Still on it...',
  wakeTimeout: wakeTimeoutMessage,
  reconnecting: 'hq: connection lost, reconnecting...',
  accessEnded: 'hq: your access to this session ended.',
  detached: 'hq: detached.',
  nowViewOnly: 'hq: you can watch this session but not type in it.',
};

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
  errorRetryMs?: number;
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
  | { type: 'reset'; sessionId: string }
  | { type: 'status'; sessionId: string; status?: string }
  | { type: 'error'; sessionId: string | null; message: string; code: string }
  | { type: 'notice'; sessionId: string; text: string; code?: string }
  | { type: 'runner-metrics'; sessionId: string; listenPorts?: unknown }
  | { type: string; sessionId?: string };

/** How one socket ended. `dropped` is a transport loss worth a reconnect. */
type SocketEnd =
  | { kind: 'dropped' }
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

  const setCanType = (next: boolean) => {
    if (next === canType) return;
    canType = next;
    opts.onCanTypeChanged?.(next);
  };

  async function run(): Promise<AttachEnd> {
    let announced = false;
    let intent: 'open' | 'reconnect' = opts.initialIntent ?? 'open';
    let reconnects = 0;
    for (;;) {
      if (detachRequested) return { kind: 'ended', exitCode: 0, message: `\r\n${copy.detached}` };
      // A FRESH signed upgrade every time: a nonce is single-use and the token may have rotated.
      const headers = await client.upgradeHeaders(REMOTE_TERMINAL_WS_PATH, team.org.slug);
      const ws = make(wsUrl(client.host, REMOTE_TERMINAL_WS_PATH), headers);
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
      const end = await runSocket(
        ws,
        () => {
          // Review N5: the budget is MAX_RECONNECTS drops IN A ROW. An admitted attach ends the
          // row, so a day of hourly LB cuts never adds up to a give-up.
          reconnects = 0;
        },
        intent,
        headers,
      );
      if (end.kind === 'dropped' && reconnects < MAX_RECONNECTS) {
        sink.say(`\r\n${copy.reconnecting}`);
        await sleep(Math.min(RECONNECT_MAX_MS, reconnectBase * 2 ** reconnects));
        reconnects += 1;
        intent = 'reconnect';
        continue;
      }
      if (end.kind === 'dropped') return { kind: 'lost' };
      return end;
    }
  }

  /** One socket's life: attach, pipe, heartbeat, until it closes. */
  function runSocket(
    ws: WebSocket,
    onAdmitted: () => void,
    intent: 'open' | 'reconnect',
    headers: Record<string, string>,
  ): Promise<SocketEnd> {
    // A reconnect / re-attach is a lifecycle reset (Decision 19): nothing predicted survives it.
    echo?.lifecycleReset();
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
    const attachFrame = (i: 'open' | 'reconnect') => {
      answerWaking = false;
      answerAsleep = false;
      attachOutstanding = true;
      send({ type: 'attach', sessionId: session.id, ...size(), intent: i });
    };
    attachFrame(intent);
    const filter = (opts.createFilter ?? createTerminalQueryFilter)();

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

      const onResize = () => {
        echo?.resize(size().cols, size().rows);
        send({ type: 'resize', sessionId: session.id, ...size() });
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
          echo?.key(data); // judged in order with the output; the bytes go out right now regardless
          send({ type: 'input', sessionId: session.id, data });
        }
        if (i >= 0) detachNow();
      };
      detachHooks.add(detachNow);
      const offResize = sink.onResize(onResize);
      const offInput = sink.onInput(onData);

      ws.on('message', (data: Buffer) => {
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
          if (echo) echo.repaint('\x1b[H\x1b[2J\x1b[3J');
          else sink.write('\x1b[H\x1b[2J\x1b[3J');
        } else if (frame.type === 'attached') {
          attachOutstanding = false;
          onAdmitted();
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
      ws.on('error', () => undefined);
      ws.on('close', (code) => {
        detachHooks.delete(detachNow);
        for (const tm of rttTimers) clearTimeout(tm);
        if (livenessTimer) clearInterval(livenessTimer);
        clearInterval(tokenTimer);
        clearInterval(presenceTimer);
        clearWakeTimers();
        if (errorRetryTimer) clearTimeout(errorRetryTimer);
        offInput();
        offResize();
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
  };
}
