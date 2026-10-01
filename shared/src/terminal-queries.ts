/**
 * The terminal QUERIES the browser terminal never answers, removed from what `hq attach` writes to
 * the laptop's terminal (review 2026-09-27, D7 "exactly as in the browser").
 *
 * The browser swallows them in xterm's parser (client/src/components/AgentView.tsx, DEF-139 and
 * DEF-145): a DEVICE ATTRIBUTES query (`CSI c`, `CSI > c`, `CSI = c`) and an OSC 10/11 colour QUERY
 * (`OSC 10 ; ?`, `OSC 11 ; ?`). A laptop terminal would otherwise ANSWER each one, and `hq attach`
 * forwards stdin as the owner's `input`, so the answer would be typed into the running agent as
 * keystrokes (`^[[?1;2c` above its banner, or a palette flip), including for a query REPLAYED in the
 * `history` frame of an attach. The runner answers the colour queries itself (DEF-139); nothing
 * answers the device-attributes one (DEF-145), which is the proven-safe state.
 *
 * Stateful across chunks: a query split over two frames is held (at most a few bytes) until the
 * next chunk decides it. Everything else passes through byte for byte.
 *
 * In `shared` so the in-container `claude` shim (runner half), which attaches the same way and
 * writes to a real terminal too, applies the identical set.
 */

/** A complete query anywhere in the text. */
// eslint-disable-next-line no-control-regex -- ESC/BEL are exactly what this matches.
const QUERY_RE = /\x1b\[[>=]?[0-9;]*c|\x1b\](?:10|11);\?(?:\x07|\x1b\\)/g;

/** A trailing PREFIX of a query, which the next chunk may complete. */
// eslint-disable-next-line no-control-regex -- ESC is exactly what this matches.
const PARTIAL_TAIL_RE = /\x1b(?:\[[>=]?[0-9;]*|\](?:1(?:[01](?:;(?:\?(?:\x1b)?)?)?)?)?)?$/;

/** Longest prefix ever held back (a DA query with parameters is well under this). */
const MAX_HELD = 24;

export function createTerminalQueryFilter(): { push(chunk: string): string; flush(): string } {
  let held = '';
  return {
    push(chunk: string): string {
      const text = held + chunk;
      held = '';
      const stripped = text.replace(QUERY_RE, '');
      const tail = PARTIAL_TAIL_RE.exec(stripped);
      if (tail && tail[0].length <= MAX_HELD) {
        held = tail[0];
        return stripped.slice(0, stripped.length - held.length);
      }
      return stripped;
    },
    /** Whatever is still held (a prefix that never completed): written as is. */
    flush(): string {
      const out = held;
      held = '';
      return out;
    },
  };
}

/** One-shot form, for a whole buffer. */
export function stripTerminalQueries(text: string): string {
  const f = createTerminalQueryFilter();
  return f.push(text) + f.flush();
}
