/**
 * The local-echo PREDICTION ENGINE (feature `local-echo`, Decisions 2, 3, 11 and 12): a pure,
 * framework-free state machine shared verbatim by the browser terminal (`useLocalEcho`, rendered
 * with xterm decorations) and `hq attach` (rendered with raw ANSI into the person's own terminal).
 * It owns WHAT is predicted and when a prediction confirms, fails or times out; the two renderers
 * own only how a prediction is drawn. No xterm, DOM or Node import, and nothing here logs: a
 * prediction is a typed character.
 *
 * THE ONE PROPERTY THAT IS A SECURITY CLAIM: a character typed into a prompt that does not echo (a
 * password, `read -s`, a secret the server-side masker holds back) is never drawn. It rests on the
 * EPOCH rule (Decision 3), not on knowing what a password prompt looks like:
 *
 *   - `epochVisible` starts false, and after every Enter, control byte, escape sequence, paste,
 *     lifecycle reset, mismatch or timeout it is false again. While false a keystroke is tracked as
 *     a SHADOW prediction, never drawn.
 *   - It turns true only when a shadow prediction CONFIRMS: its cell changed from what it held when
 *     the key was typed to exactly the predicted NON-BLANK character, and the cursor has moved past
 *     it. A blank never confirms an epoch, and neither does output that merely already shows the
 *     glyph (the cell must have CHANGED).
 *   - A mismatch or a timeout does not just hide the epoch: it SUSPENDS the engine for the rest of
 *     the line. Every keystroke passes through untracked (not even a shadow) until a line-ending
 *     control byte. A line that already produced one wrong or late guess gets no more guesses.
 *   - While the OLDEST pending prediction is overdue (past ~1.25x the measured echo latency), a new
 *     keystroke is tracked hidden. That bounds how many characters can be drawn before a prompt that
 *     stopped echoing is noticed to roughly one echo-latency's worth.
 *
 * THREE OUTCOMES PER PREDICTION, not two (Decision 2): CONFIRMED (above), PENDING (the cell is
 * unchanged or blank; left alone, no flicker) and CONTRADICTED (the cell now holds a DIFFERENT
 * non-blank character). Only a contradiction or the timeout withdraws predictions. Confirmation is
 * in order: confirming character N confirms every earlier one.
 *
 * ⛔ "THE CURSOR MOVED PAST AN UNWRITTEN CELL" IS NOT A CONTRADICTION HERE (a deliberate narrowing
 *    of Decision 2's wording). Claude repaints by moving the cursor to its footer and back
 *    (`CSI 4 B … CSI 4 A`, captured on 2.1.283), so a frame split across two writes parks the
 *    cursor below the prompt with the echo not yet drawn. Reading that as a contradiction would
 *    suspend the line on an ordinary split frame. Such a prediction stays PENDING and the timeout
 *    resolves it, which is the conservative direction: a cell that never fills is exactly the
 *    no-echo case the timeout exists for.
 *
 * PLACEMENT is append-only: a prediction goes at the caret (or right after the last pending one),
 * only where the rest of the row is blank, and never within `EDGE_MARGIN` cells of the right edge.
 * Mid-line insertion, a completion ghost after the caret, or a right-hand prompt are skipped, not
 * drawn over (Decision 10, and the CLI's hard rule, Decision 14).
 */
import { promptGateOpen } from './local-echo-prompt-gate.js';
import { cellChars, cursorRow, isBlankChars, type EchoTerminal } from './local-echo-terminal.js';

export type { EchoTerminal } from './local-echo-terminal.js';

/** The per-user preference (web) or per-invocation flag (CLI). */
export type LocalEchoMode = 'auto' | 'always' | 'off';

/** Auto mode draws only when the measured latency is ABOVE this (Risk 4, default 60 ms). */
export const AUTO_LATENCY_THRESHOLD_MS = 60;

/** Never predict within this many cells of the right edge: no wrap is ever guessed. */
export const EDGE_MARGIN = 2;

/** Timeout floor and cap (Decision 3): `max(1000, 3 × echo p90)`, capped at 2.5 s. */
export const TIMEOUT_FLOOR_MS = 1_000;
export const TIMEOUT_CAP_MS = 2_500;
/** The overdue mark, as a multiple of the expected echo latency… */
export const OVERDUE_FACTOR = 1.25;
/** …never below this: a measured near-zero echo (loopback) must not make every key overdue at birth. */
export const OVERDUE_FLOOR_MS = 50;
/** Echo latency assumed before anything was measured (no RTT, no confirmation yet). */
export const DEFAULT_ECHO_MS = 250;
/** Confirmation latencies kept for the estimate. */
const ECHO_SAMPLE_WINDOW = 20;
/** Samples needed before the engine trusts its own echo latency over the socket RTT. */
const MIN_ECHO_SAMPLES = 3;

/** One tracked keystroke. `y` is the ABSOLUTE buffer row (`baseY + cursorY` when typed). */
export interface Prediction {
  readonly id: number;
  readonly ch: string;
  readonly x: number;
  readonly y: number;
  /** What the cell held when the key was typed (always blank: only blank cells are predicted into). */
  readonly original: string;
  readonly createdAt: number;
  /** Drawn. A shadow prediction (epoch hidden, overdue block, Auto below threshold) is not. */
  visible: boolean;
  /** Past the overdue mark and still pending: the renderer adds weight, it does not remove it. */
  late: boolean;
}

export type WithdrawReason = 'mismatch' | 'timeout' | 'reset' | 'backspace';

export type EchoEvent =
  | { type: 'show'; prediction: Prediction }
  | { type: 'late'; prediction: Prediction }
  | { type: 'confirm'; predictions: Prediction[] }
  | { type: 'withdraw'; predictions: Prediction[]; reason: WithdrawReason };

/**
 * Aggregate counters over RENDERED predictions only (Data Model, accepted blocking). A shadow
 * prediction is never counted in any field: a password typed at a no-echo prompt must not become a
 * length in a telemetry row. No characters, ever.
 */
export interface LocalEchoStats {
  predicted: number;
  confirmed: number;
  mismatched: number;
  timedOut: number;
  /** Rendered, then contradicted or timed out before confirming: visible flicker (Data Model). */
  withdrawn: number;
  /** Keypress-to-confirm latency of each rendered prediction that confirmed. */
  latenciesMs: number[];
}

export interface PredictionEngineOptions {
  now?: () => number;
  autoThresholdMs?: number;
}

/** A character a keystroke may be predicted for: printable ASCII, Latin-1, Latin Extended-A. */
export function isPredictableChar(data: string): boolean {
  if (data.length !== 1) return false;
  const c = data.charCodeAt(0);
  if (c >= 0x20 && c <= 0x7e) return true;
  // Latin-1 Supplement minus NBSP (0xa0) and the soft hyphen (0xad), then Latin Extended-A: the
  // allowlist that stands in for a cell-width call xterm 5.5 does not expose (pt-BR accents fit).
  return c >= 0xa1 && c <= 0x17f && c !== 0xad;
}

const BACKSPACE = new Set(['\x7f', '\b']);

/** Any C0 control byte or DEL anywhere in the chunk (Enter, ^C, ESC-led sequences, …). */
function hasControlByte(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function emptyStats(): LocalEchoStats {
  return { predicted: 0, confirmed: 0, mismatched: 0, timedOut: 0, withdrawn: 0, latenciesMs: [] };
}

/**
 * A character just removed by Backspace while its echo was still in flight. Its echo may still
 * land in that cell a moment later (then the Backspace echo erases it), so that one character in
 * that one cell is not a contradiction of whatever is predicted there next.
 */
interface Ghost {
  x: number;
  y: number;
  ch: string;
  until: number;
}

export class PredictionEngine {
  private readonly now: () => number;
  private readonly autoThresholdMs: number;
  private mode: LocalEchoMode = 'off';
  private enabled = false;
  private rttMs: number | null = null;
  private pending: Prediction[] = [];
  private epochVisible = false;
  private suspended = false;
  private nextId = 1;
  private echoSamples: number[] = [];
  private stats: LocalEchoStats = emptyStats();
  private ghosts: Ghost[] = [];
  /** Where the next prediction goes while a Backspaced character's echo may still be in flight. */
  private anchorHint: { x: number; y: number; until: number } | null = null;
  private lastBufferType: string | undefined;

  constructor(opts: PredictionEngineOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.autoThresholdMs = opts.autoThresholdMs ?? AUTO_LATENCY_THRESHOLD_MS;
  }

  // ── configuration ─────────────────────────────────────────────────────────────────────────────

  /** The surface's own gate (feature available, write-capable, connected, running). Off clears. */
  setEnabled(enabled: boolean): EchoEvent[] {
    this.enabled = enabled;
    return enabled ? [] : this.reset();
  }

  setMode(mode: LocalEchoMode): EchoEvent[] {
    this.mode = mode;
    return mode === 'off' ? this.reset() : [];
  }

  /** A smoothed WebSocket RTT sample, or null when none is known. */
  setRtt(ms: number | null): void {
    this.rttMs = ms !== null && Number.isFinite(ms) && ms >= 0 ? ms : null;
  }

  // ── read-only views ───────────────────────────────────────────────────────────────────────────

  /** Pending predictions in type order (visible and shadow). */
  get predictions(): readonly Prediction[] {
    return this.pending;
  }

  get isEpochVisible(): boolean {
    return this.epochVisible;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * The latency the Auto gate reads: the engine's own measured echo latency once it has a few
   * confirmations (it includes the agent's own redraw time), the socket RTT until then.
   */
  get measuredLatencyMs(): number | null {
    if (this.echoSamples.length >= MIN_ECHO_SAMPLES) return percentile(this.echoSamples, 50);
    return this.rttMs;
  }

  /** The echo latency the overdue mark and the timeout scale with (p90 of confirmations). */
  expectedEchoMs(): number {
    if (this.echoSamples.length >= MIN_ECHO_SAMPLES) {
      return percentile(this.echoSamples, 90) ?? DEFAULT_ECHO_MS;
    }
    return this.rttMs !== null ? this.rttMs + 40 : DEFAULT_ECHO_MS;
  }

  /** `max(1000, 3 × echo p90)`, capped at 2.5 s (Decision 3). */
  timeoutMs(): number {
    return Math.min(TIMEOUT_CAP_MS, Math.max(TIMEOUT_FLOOR_MS, 3 * this.expectedEchoMs()));
  }

  overdueMs(): number {
    const mark = Math.max(OVERDUE_FLOOR_MS, OVERDUE_FACTOR * this.expectedEchoMs());
    return Math.min(this.timeoutMs(), mark);
  }

  /** When `tick()` next has something to do, or null. The surface arms one timer for it. */
  nextDeadline(): number | null {
    const oldest = this.pending[0];
    if (!oldest) return null;
    let next = oldest.createdAt + this.timeoutMs();
    const overdue = this.overdueMs();
    for (const p of this.pending) {
      if (p.visible && !p.late) next = Math.min(next, p.createdAt + overdue);
    }
    return next;
  }

  /** Take (and reset) the rendered-only counters for one telemetry window. */
  takeStats(): LocalEchoStats {
    const out = this.stats;
    this.stats = emptyStats();
    return out;
  }

  // ── inputs ────────────────────────────────────────────────────────────────────────────────────

  /**
   * A chunk the person typed on THIS surface's keyboard path (xterm's `onData`, the CLI's stdin),
   * given BEFORE it is sent. Returns what changed on screen. The caller always sends the chunk.
   */
  input(data: string, term: EchoTerminal): EchoEvent[] {
    if (!this.active()) return this.pending.length > 0 ? this.reset() : [];
    const now = this.now();
    if (BACKSPACE.has(data)) return this.suspended ? [] : this.backspace(now, term);
    if (hasControlByte(data)) {
      // Enter, ^C, an arrow, any escape sequence: the line (and so the suspension) ends here.
      this.suspended = false;
      return this.reset();
    }
    if (this.suspended) return [];
    if (!isPredictableChar(data)) return this.reset(); // a paste, an emoji, a wide glyph
    return this.predict(data, term, now);
  }

  /**
   * An `input` / `login-code` frame that did NOT come through `input()` (Decision 9): the mobile key
   * bar, the automatic `/login`, a wheel report, a pasted image's path. Exactly like a control byte.
   */
  foreignInput(data: string): EchoEvent[] {
    if (hasControlByte(data)) this.suspended = false;
    return this.reset();
  }

  /**
   * The terminal has APPLIED a server write (xterm's `write(data, cb)` callback): confirm,
   * contradict or keep each pending prediction against what the buffer now shows.
   */
  serverWrite(term: EchoTerminal): EchoEvent[] {
    const now = this.now();
    const type = term.buffer.active.type;
    if (type !== this.lastBufferType) {
      // Entering or leaving the alternate screen is a lifecycle reset (Decision 3).
      const changed = this.lastBufferType !== undefined;
      this.lastBufferType = type;
      if (changed) return this.reset();
    }
    this.ghosts = this.ghosts.filter((g) => g.until > now);
    if (this.anchorHint) {
      const b = term.buffer.active;
      const settled = cursorRow(term) === this.anchorHint.y && b.cursorX === this.anchorHint.x;
      if (settled || this.anchorHint.until <= now) this.anchorHint = null;
    }
    if (this.pending.length === 0) return [];

    let lastConfirmed = -1;
    let firstContradicted = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const outcome = this.outcome(this.pending[i]!, term);
      if (outcome === 'confirmed') lastConfirmed = i;
      else if (outcome === 'contradicted' && firstContradicted < 0) firstContradicted = i;
    }
    if (firstContradicted >= 0) {
      // The screen disagrees with a guess: the in-order prefix BEFORE it still confirms, then the
      // line gets no more guesses. A confirmation after the contradiction confirms nothing.
      const events =
        lastConfirmed < firstContradicted ? this.confirmThrough(lastConfirmed, now) : [];
      return [...events, ...this.fail('mismatch')];
    }
    if (lastConfirmed < 0) return [];
    const events = this.confirmThrough(lastConfirmed, now);
    return [...events, ...this.promote(now)];
  }

  /** Timers: restyle overdue predictions, time out the oldest. */
  tick(): EchoEvent[] {
    const now = this.now();
    const oldest = this.pending[0];
    if (!oldest) return [];
    if (now - oldest.createdAt >= this.timeoutMs()) return this.fail('timeout');
    const events: EchoEvent[] = [];
    const overdue = this.overdueMs();
    for (const p of this.pending) {
      if (p.visible && !p.late && now - p.createdAt >= overdue) {
        p.late = true;
        events.push({ type: 'late', prediction: p });
      }
    }
    return events;
  }

  /**
   * A lifecycle reset (Decision 3's list: resize, focus change, reconnect / re-attach, a `history`
   * repaint, a `reset` frame, a stopped-to-running wipe, a runner wake). Hides the epoch and drops
   * every prediction. Does not end a suspension: the line has not ended.
   */
  reset(): EchoEvent[] {
    this.epochVisible = false;
    this.ghosts = [];
    this.anchorHint = null;
    return this.dropAll('reset');
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  private active(): boolean {
    return this.enabled && this.mode !== 'off';
  }

  /** May a new prediction be DRAWN (as opposed to tracked hidden) right now? */
  private mayRender(now: number): boolean {
    if (!this.epochVisible) return false;
    const oldest = this.pending[0];
    if (oldest && now - oldest.createdAt >= this.overdueMs()) return false;
    if (this.mode === 'always') return true;
    const latency = this.measuredLatencyMs;
    return latency !== null && latency > this.autoThresholdMs;
  }

  private predict(ch: string, term: EchoTerminal, now: number): EchoEvent[] {
    const b = term.buffer.active;
    if (b.type === 'alternate' || !promptGateOpen(term)) return this.reset();
    const row = cursorRow(term);
    const last = this.pending[this.pending.length - 1];
    let x: number;
    let y: number;
    if (last) {
      // The caret must still sit on the first unconfirmed cell; anything else means the screen
      // moved under the pending run (a repaint, a background print) and no anchor is trustworthy.
      // (Further right is fine while Backspaced characters' echoes are still landing: every cell
      // between the run and the caret must then be one of those ghosts.)
      const first = this.pending[0]!;
      const caretOk =
        b.cursorX === first.x ||
        (b.cursorX > first.x && this.ghostsCover(first.x, b.cursorX, first.y));
      if (row !== first.y || !caretOk) return this.reset();
      x = last.x + 1;
      y = last.y;
    } else if (this.anchorHint && this.anchorHint.until > now) {
      x = this.anchorHint.x;
      y = this.anchorHint.y;
    } else {
      x = b.cursorX;
      y = row;
    }
    if (x >= term.cols - EDGE_MARGIN) return this.reset();
    // Append-only: the rest of the row must be empty (a ghost's in-flight echo excepted).
    for (let cx = x; cx < term.cols; cx++) {
      const chars = cellChars(term, cx, y);
      if (!isBlankChars(chars) && !this.isGhost(cx, y, chars)) return this.reset();
    }
    const prediction: Prediction = {
      id: this.nextId++,
      ch,
      x,
      y,
      original: cellChars(term, x, y),
      createdAt: now,
      visible: this.mayRender(now),
      late: false,
    };
    this.pending.push(prediction);
    if (!prediction.visible) return [];
    this.stats.predicted += 1;
    return [{ type: 'show', prediction }];
  }

  private backspace(now: number, term: EchoTerminal): EchoEvent[] {
    const removed = this.pending.pop();
    const until = now + this.timeoutMs();
    if (!removed) {
      // Backspace over REAL, already-confirmed text. Nothing of ours to remove, and the epoch stays
      // (Decision 11), but the caret is about to move one cell LEFT and nobody has seen that yet: a
      // key typed before the echo would otherwise anchor one cell too far right and draw a doubled
      // glyph. So the next prediction anchors one cell back (further, for several Backspaces in
      // flight), and the character being deleted is a ghost there until its erase lands.
      const from = this.anchorHint && this.anchorHint.until > now ? this.anchorHint : null;
      const x = (from ? from.x : term.buffer.active.cursorX) - 1;
      const y = from ? from.y : cursorRow(term);
      const deleting = x >= 0 ? cellChars(term, x, y) : '';
      if (isBlankChars(deleting)) {
        // Nothing visible to delete (the prompt's own space, or a typed space): the caret's next
        // position is not knowable from the screen, so hide the epoch. The next key is a shadow.
        this.epochVisible = false;
        this.anchorHint = null;
        return [];
      }
      this.ghosts.push({ x, y, ch: deleting, until });
      this.anchorHint = { x, y, until };
      return [];
    }
    this.ghosts.push({ x: removed.x, y: removed.y, ch: removed.ch, until });
    if (this.pending.length === 0) this.anchorHint = { x: removed.x, y: removed.y, until };
    return removed.visible
      ? [{ type: 'withdraw', predictions: [removed], reason: 'backspace' }]
      : [];
  }

  /** Every cell in [from, to) on row `y` is a ghost (a Backspaced character still in flight). */
  private ghostsCover(from: number, to: number, y: number): boolean {
    for (let x = from; x < to; x++) {
      if (!this.ghosts.some((g) => g.x === x && g.y === y)) return false;
    }
    return true;
  }

  private isGhost(x: number, y: number, chars: string): boolean {
    return this.ghosts.some((g) => g.x === x && g.y === y && g.ch === chars);
  }

  private outcome(p: Prediction, term: EchoTerminal): 'confirmed' | 'pending' | 'contradicted' {
    const chars = cellChars(term, p.x, p.y);
    const b = term.buffer.active;
    const row = cursorRow(term);
    if (chars === p.ch) {
      if (isBlankChars(p.ch)) {
        // A space cannot show a content change: it confirms only by the caret moving past it on
        // its own row, and it can never be the confirmation that turns an epoch visible.
        return row === p.y && b.cursorX > p.x ? 'confirmed' : 'pending';
      }
      const past = row > p.y || (row === p.y && b.cursorX > p.x);
      return chars !== p.original && past ? 'confirmed' : 'pending';
    }
    if (isBlankChars(chars) || this.isGhost(p.x, p.y, chars)) return 'pending';
    return 'contradicted';
  }

  private confirmThrough(index: number, now: number): EchoEvent[] {
    if (index < 0) return [];
    const confirmed = this.pending.splice(0, index + 1);
    let flips = false;
    for (const p of confirmed) {
      const latency = now - p.createdAt;
      this.echoSamples.push(latency);
      if (this.echoSamples.length > ECHO_SAMPLE_WINDOW) this.echoSamples.shift();
      if (p.visible) {
        this.stats.confirmed += 1;
        this.stats.latenciesMs.push(latency);
      } else if (!isBlankChars(p.ch)) {
        flips = true;
      }
    }
    if (flips) this.epochVisible = true;
    const visible = confirmed.filter((p) => p.visible);
    return visible.length > 0 ? [{ type: 'confirm', predictions: visible }] : [];
  }

  /** Draw every hidden pending prediction once drawing is allowed again (epoch flip, overdue over). */
  private promote(now: number): EchoEvent[] {
    if (!this.mayRender(now)) return [];
    const events: EchoEvent[] = [];
    for (const p of this.pending) {
      if (p.visible) continue;
      p.visible = true;
      this.stats.predicted += 1;
      events.push({ type: 'show', prediction: p });
    }
    return events;
  }

  /** A mismatch or a timeout: drop everything, hide the epoch, suspend until the line ends. */
  private fail(reason: 'mismatch' | 'timeout'): EchoEvent[] {
    const visible = this.pending.filter((p) => p.visible).length;
    if (reason === 'mismatch') this.stats.mismatched += visible;
    else this.stats.timedOut += visible;
    this.stats.withdrawn += visible;
    this.epochVisible = false;
    this.suspended = true;
    this.ghosts = [];
    this.anchorHint = null;
    return this.dropAll(reason);
  }

  private dropAll(reason: WithdrawReason): EchoEvent[] {
    const dropped = this.pending;
    this.pending = [];
    const visible = dropped.filter((p) => p.visible);
    if (visible.length === 0) return [];
    return [{ type: 'withdraw', predictions: visible, reason }];
  }
}
