/**
 * terminal-shared-geometry — what counts as a PERSON claiming a session's pty size, shared by the
 * server (the keystroke re-statement), the browser and `hq-client` (the CLI and VS Code), so the
 * three can never disagree.
 *
 * Only a person's viewer claims the size (Jean, 2026-10-02). Two kinds of `input` reach the pty
 * without anybody pressing a key, and must never claim:
 *   - FOCUS REPORTS (`CSI I` / `CSI O`): Claude Code turns on focus reporting (DECSET 1004), so a
 *     window merely LOSING focus types `ESC [ O` into the session — the window the person just left;
 *   - WHEEL REPORTS (SGR buttons 64-67): the browser synthesizes them for a scroll, and macOS sends
 *     the wheel to a window that is not even focused.
 */

/** The smallest terminal that may claim a session's size; smaller ones keep the pty's size. */
export const MIN_CLAIM_COLS = 40;
export const MIN_CLAIM_ROWS = 10;

// eslint-disable-next-line no-control-regex -- ESC is exactly what this matches.
const PASSIVE_INPUT_RE = /^(?:\x1b\[[IO]|\x1b\[<6[4-7];\d+;\d+[Mm])+$/;

/** True for input no person typed: focus reports and wheel reports, alone or in a run. */
export function isPassiveTerminalInput(data: string): boolean {
  return data.length > 0 && PASSIVE_INPUT_RE.test(data);
}

/** May a terminal of this size claim the session's pty (`MIN_CLAIM_COLS` x `MIN_CLAIM_ROWS`)? */
export function mayClaimSize(dims: { cols: number; rows: number }): boolean {
  return dims.cols >= MIN_CLAIM_COLS && dims.rows >= MIN_CLAIM_ROWS;
}
