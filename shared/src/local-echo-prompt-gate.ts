/**
 * The local-echo PROMPT GATE (feature `local-echo`, Decision 4): "is the cursor on a plain input
 * line right now, where a typed character is simply echoed at the caret?" A coarse, read-only,
 * purely visual heuristic over the RENDERED buffer, shared verbatim by the browser terminal and
 * `hq attach` (Decision 12). It never sees the raw byte stream and never logs a row.
 *
 * Two ways in, and nothing else:
 *
 *   1. CLAUDE'S PROMPT. A ready footer (`MAIN_PROMPT_FOOTER`) in the last `SCREEN_FOOTER_ROWS`
 *      non-blank rows of the viewport, AND the caret inside the input box: walking up from the
 *      cursor row, the first row under the box's top rule (`────`) starts with `❯`. The box check
 *      is what keeps a keystroke that lands MID-FRAME (claude moves the cursor to the footer and
 *      back on every repaint) from anchoring a prediction on a footer row.
 *   2. A SHELL PROMPT (Advanced Mode's raw shell, a plain shell under `hq attach`): no claude
 *      footer on screen, and `$ `, `# ` or `% ` before the cursor on its row. `❯ ` is NOT a shell
 *      marker here: it is claude's selector in every menu (repl-state.ts's MAIN_PROMPT_FOOTER note).
 *
 * Closed, whatever else matches: the alternate screen (vim, less, htop, claude's fullscreen
 * renderer), `esc to interrupt` anywhere on the viewport (claude is working, and a stray `?` opens
 * the help panel instead of echoing), and any known startup dialog.
 *
 * ⛔ CURSOR VISIBILITY IS NOT A SIGNAL HERE. Claude Code 2.1.283 hides the real cursor at startup
 *    (`CSI ? 25 l`) and never shows it again while typing; it draws an inverse-video space as its
 *    own caret and PARKS the hidden real cursor on that cell after every echo (captured through the
 *    canary harness, 2026-09-28). Gating on a visible cursor would switch the feature off on
 *    exactly the screen it exists for. The caret position is the parked cursor; the box check above
 *    is what makes that position trustworthy.
 */
import {
  ESC_TO_INTERRUPT,
  KNOWN_DIALOGS,
  MAIN_PROMPT_FOOTER,
  SCREEN_FOOTER_ROWS,
} from './repl-markers.js';
import { cursorRow, type EchoTerminal } from './local-echo-terminal.js';

/** How far above the cursor the input box's top rule may sit (a long wrapped prompt). */
const MAX_INPUT_BOX_ROWS = 12;

/** Claude's horizontal rule glyph, the input box's top and bottom border. */
const RULE_CHAR = '─';

/** A shell prompt's terminator, followed by the space the shell prints after it. */
const SHELL_PROMPT_RE = /[$#%] /;

function viewportRows(term: EchoTerminal): string[] {
  const b = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
  }
  return rows;
}

/** Walk up from the cursor row to the box's top rule; the row under it must be the `❯` row. */
function caretInClaudeInputBox(term: EchoTerminal): boolean {
  const b = term.buffer.active;
  const row = cursorRow(term);
  let topmost: string | null = null;
  for (let y = row; y >= Math.max(0, row - MAX_INPUT_BOX_ROWS); y--) {
    const text = (b.getLine(y)?.translateToString(true) ?? '').trimStart();
    if (text.startsWith(RULE_CHAR)) return topmost !== null && topmost.startsWith('❯');
    topmost = text;
  }
  return false;
}

export type PromptKind = 'claude' | 'shell';

/**
 * Which kind of input line the cursor is on, or `null` when a typed character may not simply echo
 * at the caret (the gate is closed).
 */
export function promptKind(term: EchoTerminal): PromptKind | null {
  const b = term.buffer.active;
  if (b.type === 'alternate') return null;
  const rows = viewportRows(term);
  const viewport = rows.join('\n');
  if (ESC_TO_INTERRUPT.test(viewport)) return null;
  if (KNOWN_DIALOGS.some((d) => d.pattern.test(viewport))) return null;
  const footer = rows
    .filter((r) => r.trim().length > 0)
    .slice(-SCREEN_FOOTER_ROWS)
    .join('\n');
  if (MAIN_PROMPT_FOOTER.test(footer)) {
    return caretInClaudeInputBox(term) ? 'claude' : null;
  }
  const line = b.getLine(cursorRow(term));
  const beforeCursor = line?.translateToString(false, 0, b.cursorX) ?? '';
  return SHELL_PROMPT_RE.test(beforeCursor) ? 'shell' : null;
}

/** The gate the engine consults before tracking a keystroke. */
export function promptGateOpen(term: EchoTerminal): boolean {
  return promptKind(term) !== null;
}
