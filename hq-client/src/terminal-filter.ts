/**
 * The terminal safety filter for a session shown in an editor's terminal (hq-vscode D5, decision
 * 20). Everything a session prints is written into the person's own terminal emulator, which acts
 * on escape sequences: some would ANSWER back (the answer arrives as the person's keystrokes and is
 * typed into the agent), some reach outside the terminal (the clipboard, the editor's shell
 * integration, a link that opens a local command). A session's output is untrusted text, so:
 *
 *   DROPPED   device-attributes queries (`CSI c`, `CSI > c`, `CSI = c`) and OSC 4/10/11/12 colour
 *             QUERIES (B17, the browser's own set, `@kpa/shared/terminal-queries`);
 *             a CSI longer than `MAX_CSI`, whole, to its final byte (never passed raw: a query
 *             could otherwise ride past the filter behind padding);
 *             OSC 52 (clipboard), OSC 7 (cwd), OSC 133 and OSC 633 (shell integration marks);
 *             every OSC not on the allow-list below;
 *             DCS, SOS, PM and APC strings, whole;
 *             OSC 8 hyperlinks whose target is not http(s) (the link text still shows, unlinked).
 *   CLEANED   OSC 0/1/2 titles: C0/C1 controls, bidi overrides and zero-width characters removed,
 *             at most 256 characters.
 *   KEPT      everything else, byte for byte: text, SGR and every other CSI, the allow-listed OSCs.
 *
 * STATEFUL ACROSS CHUNKS: a sequence split over two frames is held until the next chunk completes
 * it. A string sequence (OSC, DCS, ...) is held at most `MAX_STRING` characters; past that its
 * content is discarded until its terminator. 8-bit C1 introducers (`\u009b`, `\u009d`, ...) are
 * read as their 7-bit forms, so they cannot slip a sequence past the filter.
 */

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

/** The longest OSC/DCS body kept in memory. Longer ones are discarded to their terminator. */
const MAX_STRING = 4096;
/** The longest CSI kept (parameters + intermediates). Longer is not a real sequence: dropped whole. */
const MAX_CSI = 64;
/** Titles (OSC 0/1/2) are cut to this many characters. */
const MAX_TITLE = 256;

/** OSC numbers that pass (after the per-number checks below). */
const OSC_ALLOWED = new Set([
  '0',
  '1',
  '2',
  '4',
  '8',
  '10',
  '11',
  '12',
  '104',
  '110',
  '111',
  '112',
]);

/** C1 introducers as their 7-bit equivalents. */
const C1: Record<string, string> = {
  '\u009b': `${ESC}[`,
  '\u009d': `${ESC}]`,
  '\u0090': `${ESC}P`,
  '\u0098': `${ESC}X`,
  '\u009e': `${ESC}^`,
  '\u009f': `${ESC}_`,
  '\u009c': ST,
};

const TITLE_UNSAFE =
  // eslint-disable-next-line no-control-regex -- stripping controls is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

type State =
  | { kind: 'text' }
  | { kind: 'esc'; buf: string }
  | { kind: 'escInter'; buf: string }
  | { kind: 'csi'; buf: string }
  | { kind: 'csiDrop' }
  | { kind: 'osc'; body: string; over: boolean; escPending: boolean }
  | { kind: 'string'; escPending: boolean };

export interface TerminalFilter {
  push(chunk: string): string;
  /** End of stream: whatever is held and safe to show (a partial CSI/ESC), else nothing. */
  flush(): string;
}

/** Decide one complete OSC: the bytes to emit (possibly rewritten), or '' to drop it. */
function oscOut(body: string): string {
  const semi = body.indexOf(';');
  const ps = semi === -1 ? body : body.slice(0, semi);
  const pt = semi === -1 ? '' : body.slice(semi + 1);
  if (!OSC_ALLOWED.has(ps)) return '';
  // A colour QUERY answers back as typed input (B17): OSC 4's palette form as well as 10/11/12.
  if ((ps === '4' || ps === '10' || ps === '11' || ps === '12') && pt.includes('?')) return '';
  if (ps === '0' || ps === '1' || ps === '2') {
    const clean = pt.replace(TITLE_UNSAFE, '').slice(0, MAX_TITLE);
    return `${ESC}]${ps};${clean}${BEL}`;
  }
  if (ps === '8') {
    // `8 ; params ; URI`. An empty URI closes a link and always passes.
    const second = pt.indexOf(';');
    const uri = second === -1 ? '' : pt.slice(second + 1);
    if (uri !== '' && !/^https?:\/\//i.test(uri)) return '';
    // eslint-disable-next-line no-control-regex -- a URI never carries a control
    if (/[\u0000-\u001f\u007f-\u009f\s]/.test(uri)) return '';
  }
  return `${ESC}]${body}${BEL}`;
}

export function createTerminalFilter(): TerminalFilter {
  let state: State = { kind: 'text' };

  function push(chunk: string): string {
    let out = '';
    let input = chunk;
    // C1 introducers become their 7-bit forms first (they are never legitimate text).
    if (/[\u0090\u0098\u009b-\u009f]/.test(input)) {
      input = input.replace(/[\u0090\u0098\u009b-\u009f]/g, (c) => C1[c] ?? '');
    }
    for (let i = 0; i < input.length; i++) {
      const c = input[i]!;
      switch (state.kind) {
        case 'text': {
          if (c === ESC) {
            state = { kind: 'esc', buf: c };
          } else {
            // Fast path: copy the run up to the next ESC in one slice.
            const next = input.indexOf(ESC, i);
            const end = next === -1 ? input.length : next;
            out += input.slice(i, end);
            i = end - 1;
          }
          break;
        }
        case 'esc': {
          if (c === '[') state = { kind: 'csi', buf: `${ESC}[` };
          else if (c === ']') state = { kind: 'osc', body: '', over: false, escPending: false };
          else if (c === 'P' || c === 'X' || c === '^' || c === '_') {
            state = { kind: 'string', escPending: false };
          } else if (c >= ' ' && c <= '/') {
            state = { kind: 'escInter', buf: state.buf + c };
          } else if (c === ESC) {
            out += state.buf; // a lone ESC, then a new one
            state = { kind: 'esc', buf: c };
          } else {
            out += state.buf + c;
            state = { kind: 'text' };
          }
          break;
        }
        case 'escInter': {
          if (c >= ' ' && c <= '/' && state.buf.length < 8) {
            state = { kind: 'escInter', buf: state.buf + c };
          } else {
            out += state.buf + c;
            state = { kind: 'text' };
          }
          break;
        }
        case 'csi': {
          const code = c.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            const seq = state.buf + c;
            // A device-attributes query (any of `c`, `>c`, `=c`, with parameters): never shown.
            // eslint-disable-next-line no-control-regex -- ESC is exactly what this matches
            if (!(c === 'c' && /^\x1b\[[>=?]?[0-9;]*c$/.test(seq))) out += seq;
            state = { kind: 'text' };
          } else if (code >= 0x20 && code <= 0x3f) {
            // Absurdly long: drop the whole sequence to its final byte (review SHOULD).
            state =
              state.buf.length < MAX_CSI
                ? { kind: 'csi', buf: state.buf + c }
                : { kind: 'csiDrop' };
          } else {
            // Not a CSI after all (a control inside it): pass what we held, then go on.
            out += state.buf;
            state = { kind: 'text' };
            i -= 1;
          }
          break;
        }
        case 'csiDrop': {
          const code = c.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) state = { kind: 'text' };
          else if (code < 0x20 || code > 0x3f) {
            state = { kind: 'text' };
            i -= 1;
          }
          break;
        }
        case 'osc': {
          if (state.escPending) {
            if (c === '\\') {
              if (!state.over) out += oscOut(state.body);
              state = { kind: 'text' };
              break;
            }
            // ESC inside an OSC that is not ST: the OSC is cancelled; re-read this ESC's follower.
            state = { kind: 'esc', buf: ESC };
            i -= 1;
            break;
          }
          if (c === BEL) {
            if (!state.over) out += oscOut(state.body);
            state = { kind: 'text' };
          } else if (c === ESC) {
            state = { ...state, escPending: true };
          } else if (c === '\x18' || c === '\x1a') {
            state = { kind: 'text' }; // CAN / SUB abort the sequence
          } else if (!state.over) {
            const body = state.body + c;
            state =
              body.length > MAX_STRING ? { ...state, body: '', over: true } : { ...state, body };
          }
          break;
        }
        case 'string': {
          // DCS / SOS / PM / APC: dropped whole, up to ST (a BEL ends them in practice too).
          if (state.escPending) {
            if (c === '\\') state = { kind: 'text' };
            else {
              state = { kind: 'esc', buf: ESC };
              i -= 1;
            }
          } else if (c === ESC) state = { kind: 'string', escPending: true };
          else if (c === BEL || c === '\x18' || c === '\x1a') state = { kind: 'text' };
          break;
        }
      }
    }
    return out;
  }

  function flush(): string {
    const s = state;
    state = { kind: 'text' };
    if (s.kind === 'esc' || s.kind === 'escInter' || s.kind === 'csi') return s.buf;
    return '';
  }

  return { push, flush };
}

/** One-shot form, for a whole buffer. */
export function filterTerminalText(text: string): string {
  const f = createTerminalFilter();
  return f.push(text) + f.flush();
}
