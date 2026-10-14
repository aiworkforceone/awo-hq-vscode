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

import type { RemoteSessionSummary } from '@kpa/shared/remote.types';
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';

// eslint-disable-next-line no-control-regex -- matching control characters IS the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
// eslint-disable-next-line no-control-regex -- as above, minus \t \n \r
const CONTROLS_KEEP_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/gu;

/**
 * train 98 e2e: the bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069) and the
 * three marks (U+200E LRM, U+200F RLM, U+061C ALM). None is a terminal escape, but each one changes
 * the ORDER a reader sees: a session name holding U+202E prints reversed in `hq sessions`. They are
 * removed, not turned into spaces, so the letters around them read as the name's own.
 */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A label on ONE line: every control character (tab, CR, LF included) becomes a space, and every
 * bidi control is removed.
 */
export function oneLine(value: string): string {
  return value.replace(CONTROLS, ' ').replace(BIDI_CONTROLS, '');
}

/**
 * A line for the terminal: every control character except tab, CR and LF becomes a space, so no
 * escape sequence can start. What the CLI itself writes around it (`\r\n` in attach) is kept.
 */
export function terminalSafe(value: string): string {
  return value.replace(CONTROLS_KEEP_LINES, ' ');
}

/**
 * cli-session-lifecycle security L1: a session as HQ listed it, with every server string on ONE
 * clean line (C0, DEL, C1 and so ESC, BEL and the 8-bit CSI become spaces: no OSC 52 clipboard
 * write, no OSC 8 hidden link, no screen rewrite). Applied where a listing ENTERS the client, so
 * every print path after it (plain text, `--json`, the ambiguous-match list) sees clean names.
 */
export function cleanSessionSummary(s: RemoteSessionSummary): RemoteSessionSummary {
  return {
    ...s,
    name: oneLine(String(s.name ?? '')),
    ownerName: oneLine(String(s.ownerName ?? '')),
  };
}

/** `<prefix>-<8..12 lowercase hex>`: a team alias of one brand (`hq-…` for AWO). */
export function aliasPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[^a-z]/g, '')}-[0-9a-f]{8,12}$`);
}

/** `hq-<8..12 lowercase hex>` (this build's prefix) — the only alias shape the CLI accepts. */
export const ALIAS_RE = aliasPattern(ACTIVE_DEV_BRAND.teamAliasPrefix);
/** A team id: a UUID. It is passed to ProxyCommand, which ssh runs through /bin/sh. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An org slug: the provisioner's DNS-label shape (`src/provisioner/naming.ts` SLUG_PATTERN). */
export const ORG_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
