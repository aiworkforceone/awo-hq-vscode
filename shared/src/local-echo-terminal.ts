/**
 * The narrow, STRUCTURAL view of a terminal that the local-echo engine and prompt gate read
 * (feature `local-echo`, Decisions 4 and 12). Both `@xterm/xterm`'s `Terminal` (the browser) and
 * `@xterm/headless`'s `Terminal` (the `hq attach` mirror) satisfy it without an adapter, the same
 * narrow-interface pattern `src/runner/screen-model.ts` uses for its `HeadlessTerminal`.
 *
 * Read-only by construction: nothing here can write to a buffer. A prediction is an overlay, never
 * a buffer mutation (Decision 1).
 */

export interface EchoCell {
  /** The cell's text; `''` for an empty cell. */
  getChars(): string;
}

export interface EchoLine {
  getCell(x: number): EchoCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface EchoBuffer {
  /** `'alternate'` while a full-screen program owns the terminal. */
  readonly type?: string;
  readonly cursorX: number;
  readonly cursorY: number;
  /** Absolute row of the viewport's first line; `baseY + cursorY` is the cursor's absolute row. */
  readonly baseY: number;
  getLine(y: number): EchoLine | undefined;
}

export interface EchoTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: EchoBuffer };
}

/** Blank = no glyph. An inverse-video space (claude's fake cursor) is blank: attributes are not text. */
export function isBlankChars(chars: string): boolean {
  return chars === '' || chars === ' ';
}

/** The text of one cell (`''` when the row or cell is absent). */
export function cellChars(term: EchoTerminal, x: number, y: number): string {
  return term.buffer.active.getLine(y)?.getCell(x)?.getChars() ?? '';
}

/** The cursor's absolute buffer row. */
export function cursorRow(term: EchoTerminal): number {
  const b = term.buffer.active;
  return b.baseY + b.cursorY;
}
