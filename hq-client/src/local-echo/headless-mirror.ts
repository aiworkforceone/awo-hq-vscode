/**
 * `hq attach` local echo: the SCREEN MODEL (feature `local-echo`, Decision 13). The CLI has no DOM
 * and cannot read a cell of the person's own terminal, so it keeps a `@xterm/headless` mirror fed
 * the exact bytes it writes to stdout (after the terminal-query filter), and the shared engine and
 * prompt gate read that mirror through the same structural interface they read in the browser.
 *
 * Loaded LAZILY (`import()`), only when local echo is actually on for this invocation, the reason
 * `src/runner/screen-model.ts` gives for its own lazy load: an attach that never asked for it never
 * pays the require. The bundle still carries the package (Decision 17, v1 single file).
 */
import type { EchoTerminal } from '@kpa/shared/local-echo-engine';

/** The headless surface this module uses (a subset of `@xterm/headless`'s `Terminal`). */
interface HeadlessTerminal extends EchoTerminal {
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  dispose(): void;
}
type HeadlessCtor = new (opts: Record<string, unknown>) => HeadlessTerminal;

/** Scrollback the mirror keeps: only the prompt region is ever read, so a small bound will do. */
const MIRROR_SCROLLBACK = 200;

export class HeadlessMirror {
  private constructor(private readonly term: HeadlessTerminal) {}

  /** Null when `@xterm/headless` cannot be loaded (local echo then simply stays off). */
  static async create(cols: number, rows: number): Promise<HeadlessMirror | null> {
    try {
      // CJS webpack bundle: under an ESM loader the ctor may only be on `default` (BUG-19b).
      const mod = (await import('@xterm/headless')) as unknown as {
        Terminal?: HeadlessCtor;
        default?: { Terminal?: HeadlessCtor };
      };
      const Ctor = mod.Terminal ?? mod.default?.Terminal;
      if (!Ctor) return null;
      const term = new Ctor({
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        scrollback: MIRROR_SCROLLBACK,
        allowProposedApi: true,
      });
      return new HeadlessMirror(term);
    } catch {
      return null;
    }
  }

  /** What the engine and the gate read. */
  get terminal(): EchoTerminal {
    return this.term;
  }

  /** Feed bytes; resolves once they are parsed (xterm parses asynchronously). */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    this.term.resize(Math.max(2, cols), Math.max(1, rows));
  }

  dispose(): void {
    this.term.dispose();
  }
}
