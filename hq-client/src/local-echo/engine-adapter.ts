/**
 * `hq attach` local echo: binds the SHARED prediction engine (`@kpa/shared/local-echo-engine`, the
 * state machine the browser runs), the headless mirror and the ANSI renderer to one attach — the
 * CLI's `useLocalEcho` (feature `local-echo`, Decisions 12-19).
 *
 * ⛔ ONE ORDERED QUEUE, because the mirror parses ASYNCHRONOUSLY. A keystroke is always SENT at
 *    once (typing is never delayed); what is queued is only the engine's look at it. Server output
 *    is queued too, and each output step writes to stdout, feeds the mirror and waits for the parse
 *    before the next step runs. So when a keystroke is judged, the mirror shows exactly what the
 *    person's terminal shows — never a screen one chunk behind, which would anchor a prediction on
 *    the wrong cell. The wait is the mirror's parse (about a millisecond); ordering output before a
 *    key typed while it was in flight is also the causal order the server produced them in.
 *
 * Every output write is preceded by an undraw (the server's bytes must land at the TRUE cursor),
 * and still-pending predictions are redrawn after the mirror has caught up. A pending character can
 * therefore disappear for the gap between those two writes; both usually land in one terminal frame.
 *
 * ⛔ NOTHING HERE MAY THROW OUT, and nothing may be lost (review MUST 2). The public methods run
 *    inside `ws` and stdin listeners of an attach whose terminal is in RAW mode: an uncaught error
 *    there would take the process down with the person's terminal left raw. So every public method
 *    and every queue step is caught, and ANY error fails SAFE: local echo closes (whatever is drawn
 *    comes off, SGR is reset), every output byte still queued — including the step that failed, if
 *    it had not reached stdout yet — is written straight through, and every later output goes
 *    straight to stdout, exactly as an attach without `--local-echo`.
 *
 * Nothing here logs: a prediction is a typed character.
 */
import {
  PredictionEngine,
  type EchoEvent,
  type LocalEchoMode,
} from '@kpa/shared/local-echo-engine';
import { AnsiRenderer, SGR_RESET } from './ansi-renderer.js';
import { HeadlessMirror } from './headless-mirror.js';

/** How many RTT samples the smoothed value is the minimum of (as in the browser). */
const RTT_SAMPLES = 5;

type Step =
  | { kind: 'out'; data: string; reset: boolean; written?: boolean }
  | { kind: 'key'; data: string }
  | { kind: 'tick' }
  | { kind: 'reset' };

export interface LocalEchoSessionOptions {
  mode: LocalEchoMode;
  /** Where bytes go: the person's terminal (`io.stdout.write`). */
  write: (bytes: string) => void;
  cols: number;
  rows: number;
  /** Test seam. */
  now?: () => number;
}

export class LocalEchoSession {
  private readonly engine: PredictionEngine;
  private readonly renderer: AnsiRenderer;
  private readonly queue: Step[] = [];
  private running = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private rttSamples: number[] = [];
  private idleWaiters: (() => void)[] = [];

  private constructor(
    private readonly mirror: HeadlessMirror,
    private readonly opts: LocalEchoSessionOptions,
  ) {
    this.engine = new PredictionEngine(opts.now ? { now: opts.now } : {});
    this.engine.setEnabled(true);
    this.engine.setMode(opts.mode);
    this.renderer = new AnsiRenderer(opts.write);
  }

  /** Null when the headless mirror cannot be loaded: the attach then runs exactly as before. */
  static async create(opts: LocalEchoSessionOptions): Promise<LocalEchoSession | null> {
    const mirror = await HeadlessMirror.create(opts.cols, opts.rows);
    return mirror ? new LocalEchoSession(mirror, opts) : null;
  }

  // ── inputs (all synchronous for the caller; the work is queued in order) ──────────────────────

  /** A chunk the person typed, given right BEFORE it is sent (it is sent regardless). */
  key(data: string): void {
    this.safely(() => this.enqueue({ kind: 'key', data }));
  }

  /** Server output (after the terminal-query filter): replaces the direct stdout write. */
  output(clean: string): void {
    if (this.closed) {
      this.writeThrough(clean);
      return;
    }
    this.safely(() => this.enqueue({ kind: 'out', data: clean, reset: false }), clean);
  }

  /** A `history` repaint or a `reset` wipe: a lifecycle reset first, then the bytes. */
  repaint(bytes: string): void {
    if (this.closed) {
      this.writeThrough(bytes);
      return;
    }
    this.safely(() => this.enqueue({ kind: 'out', data: bytes, reset: true }), bytes);
  }

  /** A reconnect / re-attach (Decision 19): drop every prediction, hide the epoch. */
  lifecycleReset(): void {
    this.safely(() => this.enqueue({ kind: 'reset' }));
  }

  /**
   * The terminal was resized: the drawn run has been reflowed by the terminal itself and its cells
   * are no longer known, so it is forgotten (never erased in place) and SGR is reset (Decision 19).
   */
  resize(cols: number, rows: number): void {
    if (this.closed) return;
    this.safely(() => {
      this.mirror.resize(cols, rows);
      this.engine.reset();
      this.renderer.forget();
    });
  }

  /** One protocol ping's round trip; the engine reads the minimum of the last few. */
  rttSample(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return;
    this.rttSamples = [...this.rttSamples, ms].slice(-RTT_SAMPLES);
    this.safely(() => this.engine.setRtt(Math.min(...this.rttSamples)));
  }

  /**
   * Detach, error or exit: write what is still queued, erase whatever is drawn and leave SGR reset,
   * synchronously, so the terminal is handed back clean. Later output is written straight through.
   */
  close(): void {
    this.shutDown(null);
  }

  /** Erase the drawn run now (before something else writes to the same terminal, e.g. stderr). */
  undrawNow(): void {
    this.safely(() => this.renderer.undraw());
  }

  /** Has local echo closed (detach, exit, or an internal error)? */
  get isClosed(): boolean {
    return this.closed;
  }

  // ── failing safe ──────────────────────────────────────────────────────────────────────────────

  /** Run `fn`; any error closes local echo SAFELY. `unsent` is output the failed call carried. */
  private safely(fn: () => void, unsent?: string): void {
    if (this.closed) return;
    try {
      fn();
    } catch {
      this.shutDown(unsent ?? null);
    }
  }

  /** Write to the terminal, never throwing (a broken stdout is the attach's to notice, not ours). */
  private writeThrough(bytes: string): void {
    try {
      this.opts.write(bytes);
    } catch {
      // Nothing more can be written; the attach sees the stream error on its own.
    }
  }

  /**
   * Close local echo, synchronously: take whatever is drawn off the screen, write every output byte
   * that has not reached stdout yet (`failed`, then the queue, in order), and leave SGR reset. After
   * this, output goes straight through. Idempotent.
   */
  private shutDown(failed: string | null): void {
    if (this.closed) {
      if (failed !== null) this.writeThrough(failed);
      return;
    }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let undraw = '';
    try {
      undraw = this.renderer.takeUndraw();
    } catch {
      undraw = '';
    }
    const pending = this.queue.flatMap((s) => (s.kind === 'out' ? [s.data] : []));
    this.queue.length = 0;
    this.writeThrough(undraw + (failed ?? '') + pending.join('') + SGR_RESET);
    try {
      this.mirror.dispose();
    } catch {
      // Already broken; nothing holds it.
    }
    this.settle();
  }

  /** TEST SEAM: resolves once every queued step has run. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ── the queue ─────────────────────────────────────────────────────────────────────────────────

  private enqueue(step: Step): void {
    if (this.closed) return;
    this.queue.push(step);
    if (!this.running) void this.pump();
  }

  private async pump(): Promise<void> {
    this.running = true;
    let step: Step | undefined;
    try {
      while (this.queue.length > 0 && !this.closed) {
        step = this.queue.shift()!;
        await this.run(step);
        step = undefined;
      }
    } catch {
      // A failed OUTPUT step that never reached stdout is written first, then the rest in order.
      const unsent = step?.kind === 'out' && !step.written ? step.data : null;
      this.shutDown(unsent);
    } finally {
      this.running = false;
      this.settle();
    }
  }

  private settle(): void {
    if (this.running || this.queue.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async run(step: Step): Promise<void> {
    const term = this.mirror.terminal;
    switch (step.kind) {
      case 'key':
        this.apply(this.engine.input(step.data, term));
        return;
      case 'tick':
        this.apply(this.engine.tick());
        return;
      case 'reset':
        this.renderer.undraw();
        this.apply(this.engine.reset());
        return;
      case 'out': {
        if (step.reset) this.apply(this.engine.reset());
        // The server's bytes must land at the TRUE cursor: take the run off the screen first, in
        // the same write, so the two can never be split by anything else writing to the terminal.
        const undraw = this.renderer.takeUndraw();
        step.written = true;
        this.opts.write(undraw + step.data);
        await this.mirror.write(step.data);
        if (this.closed) return;
        this.apply(this.engine.serverWrite(term));
        // Whatever is still pending and drawable goes back on screen, from the true cursor.
        this.drawPending();
        return;
      }
    }
  }

  private cursor(): { x: number; y: number } {
    const b = this.mirror.terminal.buffer.active;
    return { x: b.cursorX, y: b.baseY + b.cursorY };
  }

  private drawPending(): void {
    const visible = this.engine.predictions.filter((p) => p.visible);
    const drawn = new Set(this.renderer.onScreen.map((p) => p.id));
    const rest = visible.filter((p) => !drawn.has(p.id));
    if (rest.length > 0) this.renderer.draw(rest, this.cursor());
  }

  private apply(events: EchoEvent[]): void {
    for (const e of events) {
      if (e.type === 'show') this.renderer.draw([e.prediction], this.cursor());
      else if (e.type === 'withdraw') {
        if (e.reason === 'backspace') this.renderer.backspace(e.predictions[0]!.id);
        else this.renderer.undraw();
      }
      // `confirm`: the server's own bytes already rewrote those cells plainly. `late`: no restyle
      // in a real terminal (it would be one more cursor dance for no information).
    }
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = this.engine.nextDeadline();
    if (deadline === null || this.closed) return;
    const now = this.opts.now ? this.opts.now() : Date.now();
    this.timer = setTimeout(
      () => this.safely(() => this.enqueue({ kind: 'tick' })),
      Math.max(0, deadline - now),
    );
    this.timer.unref?.();
  }
}
