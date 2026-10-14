/**
 * Our copy in a brand's words. Copy is authored once, in the words of the AWO build (so it prints
 * exactly what it always did and every test still reads it); `rebrandCopy` writes it in another
 * brand's words. The identity for AWO.
 *
 * A build for another brand rewrites the literal copy in the SOURCE before bundling
 * (scripts/dev-brand-build.mjs) and loads `dev-brand-copy.prebuilt.ts` in place of this file, so its
 * bundle carries neither these AWO words nor the rules that rename them.
 */
import type { DevBrand } from './dev-brand-core.js';

/** The AWO words our copy is WRITTEN with; `dev-brands.test.ts` pins them to `dev-brands/awo.ts`. */
export const COPY_SOURCE = Object.freeze({
  displayName: 'AI Workforce One HQ',
  hostExample: 'https://hq.aiworkforceone.com',
  homeDir: '~/.hq',
});

/**
 * Our own AWO-written copy, in `brand`'s words. Order matters: the long forms first, then env vars,
 * team names, setting ids, camel-case ids, and last the bare command and product words. Boundaries
 * exclude `-`, `_`, `.` and word characters, so `x-hq-org`, `HQs` and `headquarters` are never
 * touched.
 *
 * ⛔ Copy only. Never pass data through this (a team or session name, a server message, a path):
 *    use `brandCopyTag`, which rebrands the literal parts and leaves interpolated values alone.
 */
export function rebrandCopy(brand: DevBrand, text: string): string {
  if (brand.id === 'awo') return text;
  return (
    text
      .split(COPY_SOURCE.displayName)
      .join(brand.displayName)
      .split(COPY_SOURCE.hostExample)
      .join(brand.hostExample)
      .replace(/~\/\.hq(?![\w-])/g, `~/${brand.cli.homeDirName}`)
      .replace(/(?<![\w.-])HQ_(?=[A-Z])/g, `${brand.cli.envPrefix}_`)
      .replace(/(?<![\w.-])hq-(?=…|[0-9a-f]{8}|name>)/g, `${brand.teamAliasPrefix}-`)
      .replace(/(?<![\w./-])hq:\/\//g, `${brand.vscode.fsScheme}://`)
      .replace(/(?<![\w./-])hq\.(?=[a-z])/g, `${brand.vscode.idPrefix}.`)
      // A camel-case id part (`hq.openInHqWeb`): the product word, as an id part.
      .replace(/(?<=[a-z])Hq(?=[A-Z])/g, brand.productName.replace(/[^A-Za-z0-9]/g, ''))
      .replace(/(?<![\w./-])hq(?![\w-])/g, brand.cli.command)
      // "an HQ session": the article follows the sound of the new name.
      .replace(/(?<![\w-])([Aa])n HQ(?![\w-])/g, (_m, a: string) =>
        /^[aeiou]/i.test(brand.productName)
          ? `${a}n ${brand.productName}`
          : `${a} ${brand.productName}`,
      )
      .replace(/(?<![\w-])HQ(?![\w-])/g, brand.productName)
  );
}

/** A template tag that rebrands the literal parts of our copy and interpolates values untouched. */
export function brandCopyTag(
  brand: DevBrand,
): (strings: TemplateStringsArray, ...values: unknown[]) => string {
  return (strings, ...values) => {
    let out = rebrandCopy(brand, strings[0] ?? '');
    for (let i = 0; i < values.length; i++) {
      out += String(values[i]) + rebrandCopy(brand, strings[i + 1] ?? '');
    }
    return out;
  };
}
