/**
 * `hq attach` local echo: the RENDERER (feature `local-echo`, Decision 14). There is no decoration
 * layer in somebody's own terminal, so a prediction is real bytes, drawn and un-drawn with the
 * smallest, most portable sequences there are, and APPEND-ONLY: a run is only ever drawn at the true
 * cursor, where the rest of the row is known to be empty (the engine refuses anything else).
 *
 *   draw      `ESC[2;4m <chars> ESC[0m`   dim + underline, then reset: typed at the cursor, which
 *                                          advances past the run exactly as typing would.
 *   undraw    `ESC[<n>D ESC[<n>X`         back over the whole run, then ERASE CHARACTER (ECH) over
 *                                          exactly those n cells. Used before EVERY server write (the
 *                                          server's own bytes then land at the true cursor and redraw
 *                                          a confirmed character plainly), and on a mismatch or a
 *                                          timeout. ECH, not erase-to-end-of-line: it can only ever
 *                                          touch the cells this renderer drew, whatever sits right of
 *                                          them (review MUST 4).
 *   backspace `ESC[D ESC[1X`              the last drawn character only.
 *   forget    `ESC[<n>D ESC[0m`           resize (Decision 19): the terminal reflowed the drawn cells
 *                                          on its own, so nothing is erased in place, but the cursor
 *                                          goes back over the run so the server's next bytes land
 *                                          where it believes the cursor is (review MUST 3). A
 *                                          reflow that moved the run to another row leaves the dim
 *                                          glyphs as residue until the next repaint.
 *
 * Every operation is ONE `write()` and leaves SGR reset, so an interrupted run can never leave the
 * person's terminal dim or underlined.
 *
 * ⚠️ STATED LIMIT — SGR IS RESET, NOT RESTORED. `ESC[0m` after a draw returns the terminal to the
 *    DEFAULT pen, not to whatever pen the server's last bytes left active. xterm's public API does
 *    not expose the parser's current attributes, so the mirror cannot say what to restore. It only
 *    matters if the server writes unstyled text after leaving a style ON at the caret; claude does
 *    not (every styled span it paints is closed, captured on 2.1.283: `ESC[7m ESC[27m`), and the
 *    prompt gate only opens on claude's input box or a shell prompt. On a program that did, a
 *    later character could come out in the default style until that program's next SGR.
 */
import type { Prediction } from '@kpa/shared/local-echo-engine';

export const SGR_PREDICTED = '\x1b[2;4m';
export const SGR_RESET = '\x1b[0m';

export class AnsiRenderer {
  private drawn: Prediction[] = [];

  constructor(private readonly write: (bytes: string) => void) {}

  /** The predictions currently on screen, in order (the real cursor sits right after them). */
  get onScreen(): readonly Prediction[] {
    return this.drawn;
  }

  /**
   * Draw `ps` if they continue the run: the first one must sit exactly at the true cursor (`at`)
   * when nothing is drawn, or right after the last drawn cell. Returns what was drawn.
   */
  draw(ps: readonly Prediction[], at: { x: number; y: number }): Prediction[] {
    const out: Prediction[] = [];
    let next = this.drawn[this.drawn.length - 1];
    for (const p of ps) {
      const expected = next ? { x: next.x + 1, y: next.y } : at;
      if (p.x !== expected.x || p.y !== expected.y) break;
      out.push(p);
      next = p;
    }
    if (out.length === 0) return out;
    this.write(`${SGR_PREDICTED}${out.map((p) => p.ch).join('')}${SGR_RESET}`);
    this.drawn.push(...out);
    return out;
  }

  /** Back over the whole run and erase it; the cursor is at the true position again. */
  undraw(): void {
    const bytes = this.takeUndraw();
    if (bytes) this.write(bytes);
  }

  /** The undraw bytes (`''` when nothing is drawn), for a caller that sends them with its own. */
  takeUndraw(): string {
    const n = this.drawn.length;
    this.drawn = [];
    return n === 0 ? '' : `\x1b[${n}D\x1b[${n}X`;
  }

  /** Remove the LAST drawn character only (Backspace over a still-pending prediction). */
  backspace(id: number): void {
    const last = this.drawn[this.drawn.length - 1];
    if (!last || last.id !== id) return;
    this.write('\x1b[D\x1b[1X');
    this.drawn.pop();
  }

  /**
   * Forget the run WITHOUT erasing (a resize reflowed it): move the cursor back over it, so it is
   * where the server believes it is, and make sure no SGR state is left on.
   */
  forget(): void {
    const n = this.drawn.length;
    this.drawn = [];
    this.write(n === 0 ? SGR_RESET : `\x1b[${n}D${SGR_RESET}`);
  }
}
