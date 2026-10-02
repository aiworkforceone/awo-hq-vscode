/**
 * Server strings are DATA (security §Extension): a team, org, session or owner name reaches tree
 * labels, terminal names and notifications. Control characters, bidi overrides and zero-width
 * characters are removed (they could reorder or hide what a label says), and the length is capped.
 */

/** C0, DEL and C1: a control becomes a space (a newline in a name must not glue two words). */
export const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
];
/**
 * THE one list of invisible code points (labels here, file names in `fs-core.ts`): soft hyphen,
 * the combining grapheme joiner, ALM, the Mongolian vowel separator, the zero-width and directional
 * marks, the line and paragraph separators, the bidi embeddings, the word joiner and invisible
 * operators (U+2060-2065) with the isolates (U+2066-2069), and BOM.
 */
export const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

const esc = (n: number): string => `\\u${n.toString(16).padStart(4, '0')}`;

/** The inside of a character class for `ranges` (escaped code points, never the characters). */
export const rangesSource = (ranges: ReadonlyArray<readonly [number, number]>): string =>
  ranges.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('');

const charClass = (ranges: ReadonlyArray<readonly [number, number]>): RegExp =>
  new RegExp(`[${rangesSource(ranges)}]`, 'g');

/** Built from code points, so the source never carries the invisible characters themselves. */
export const CONTROL_TEXT = charClass(CONTROL_RANGES);
export const UNSAFE_TEXT = charClass(UNSAFE_RANGES);

export function cleanLabel(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_TEXT, ' ')
    .replace(UNSAFE_TEXT, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * A string about to be shown in a VS Code NOTIFICATION (security L1). Notification text is not
 * Markdown, but VS Code turns `[label](command:…|https://…|file:…)` into a live link
 * (`parseLinkedText`, which honours no escapes: a backslash before a bracket still links). So the
 * square brackets of anything interpolated become their fullwidth forms: nothing can form a link,
 * and the text reads the same.
 */
export function notificationText(value: string): string {
  return value.replace(/\[/g, '\uFF3B').replace(/\]/g, '\uFF3D');
}
