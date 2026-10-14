/**
 * The developer brand of THIS build, and the `copy` tag that writes our copy in it.
 *
 * ⛔ THE ONE IMPORT BELOW IS REDIRECTED BY THE BUNDLERS. `cli/build.mjs --brand <id>` and
 *    `vscode-extension/build.mjs --brand <id>` resolve `./dev-brands/awo.js` FROM THIS FILE to
 *    `./dev-brands/<id>.ts` (scripts/dev-brand-build.mjs), so a bundle carries one brand's data:
 *    its own. Source runs and tests are AWO.
 */
import { DEV_BRAND } from './dev-brands/awo.js';
import type { DevBrand } from './dev-brand-core.js';
import { brandCopyTag, rebrandCopy } from './dev-brand-copy.js';

export const ACTIVE_DEV_BRAND: DevBrand = DEV_BRAND;

/**
 * Our copy, written in AWO words, in this build's brand: `` copy`hq: could not reach HQ.` ``. Only
 * the literal parts are rebranded; `${values}` (team names, server text) pass through untouched.
 */
export const copy = brandCopyTag(ACTIVE_DEV_BRAND);

/**
 * One of OUR constant strings (a table of copy, a manifest line) in this build's brand. ⛔ Never a
 * value that came from a server or a person: use `copy` with the value interpolated.
 */
export function brandText(text: string): string {
  return rebrandCopy(ACTIVE_DEV_BRAND, text);
}
