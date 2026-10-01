/**
 * Server-provided text is DATA, never syntax (remote-dev-access review C4).
 *
 * A team or org name reaches two places where a control character is an instruction: a comment line
 * in `~/.ssh/hq_config` (a newline there starts a real ssh directive, and `Match exec` runs a
 * command on every later ssh) and the laptop's terminal (an ESC starts an escape sequence that can
 * retitle the window, rewrite the screen or, in some terminals, write the clipboard). HQ refuses to
 * store such names, but the CLI must not trust that: it cleans every server string it writes or
 * prints, and it refuses identifiers that do not have the server's exact shape.
 */

// eslint-disable-next-line no-control-regex -- matching control characters IS the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
// eslint-disable-next-line no-control-regex -- as above, minus \t \n \r
const CONTROLS_KEEP_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** A label on ONE line: every control character (tab, CR, LF included) becomes a space. */
export function oneLine(value: string): string {
  return value.replace(CONTROLS, ' ');
}

/**
 * A line for the terminal: every control character except tab, CR and LF becomes a space, so no
 * escape sequence can start. What the CLI itself writes around it (`\r\n` in attach) is kept.
 */
export function terminalSafe(value: string): string {
  return value.replace(CONTROLS_KEEP_LINES, ' ');
}

/** `hq-<8..12 lowercase hex>` — the only alias shape the CLI writes into ssh config. */
export const ALIAS_RE = /^hq-[0-9a-f]{8,12}$/;
/** A team id: a UUID. It is passed to ProxyCommand, which ssh runs through /bin/sh. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An org slug: the provisioner's DNS-label shape (`src/provisioner/naming.ts` SLUG_PATTERN). */
export const ORG_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
