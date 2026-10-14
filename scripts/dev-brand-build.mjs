// Build-time branding for the developer surfaces (shared/src/dev-brands.ts). One source, one build
// per brand; used by cli/build.mjs and vscode-extension/build.mjs.
//
//   loadDevBrand(root, id)        the brand's data, read from shared/src/dev-brands/<id>.ts through
//                                 esbuild (no second copy of it in a build script).
//   devBrandPlugin(root, id, ts)  an esbuild plugin that
//     1. resolves `shared/src/active-dev-brand.ts`'s ONE brand import (`./dev-brands/awo.js`) to
//        `./dev-brands/<id>.ts`, so a bundle carries only its own brand's data;
//     2. for any brand but `awo`, rewrites OUR copy in the source before esbuild sees it: the
//        literal parts of every `` copy`...` `` template, the string argument of every
//        `brandText('...')` call, and every string and template of a file marked
//        `@dev-brand-copy-file` (a table of copy) go through `rebrandCopy`, so the bundle text never
//        contains the AWO words it was written in (interpolated `${values}` are code and stay
//        untouched);
//     3. for any brand but `awo`, loads shared/src/dev-brand-copy.prebuilt.ts in place of
//        dev-brand-copy.ts: with the copy rewritten, the run-time copy functions pass text through,
//        and the bundle carries neither the AWO words nor the rules that rename them.
//        The AWO build is never rewritten: its bundle is byte for byte what it was.
//   neutralizeModulePaths(code, metafile)
//                                 names a bundle's modules by number (`"m3"`) where esbuild keyed
//                                 them by their source path, for a minified bundle that ships no
//                                 source.
//
// The rewrite walks the TypeScript AST, never a regex over source, so a backtick in a comment or a
// nested template cannot confuse it.
//
// ⛔ NO PACKAGE IMPORTS HERE. The caller passes its OWN `esbuild` and `typescript` (`{ esbuild, ts }`):
//    the extension's public mirror has no repo-root node_modules, so this file must resolve nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BRAND_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** Bundle one TypeScript module to ESM in memory and import it. */
async function importTs(esbuild, file) {
  const out = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const code = Buffer.from(out.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${code}`);
}

export function brandFileOf(root, id) {
  if (!BRAND_ID_RE.test(id)) throw new Error(`bad developer brand id "${id}"`);
  return path.join(root, 'shared', 'src', 'dev-brands', `${id}.ts`);
}

export async function loadDevBrand(root, id, { esbuild }) {
  const brand = (await importTs(esbuild, brandFileOf(root, id))).DEV_BRAND;
  if (!brand || brand.id !== id) throw new Error(`${brandFileOf(root, id)} is not brand "${id}"`);
  return brand;
}

/**
 * Rewrite our copy in one source file for `brand`. Returns the new text, or null when nothing in it
 * is copy. Exported for the build's own test (`dev-brand-build.test.ts`).
 */
/** One escape sequence in a string or template literal's source text. */
const ESCAPE = /(\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S]))/;

/** The marker of a source file whose every string and template is copy (a table of copy). */
export const COPY_FILE_MARKER = '@dev-brand-copy-file';

export function rebrandSource(ts, fileName, text, brand, rebrandCopy) {
  const wholeFile = text.includes(COPY_FILE_MARKER);
  if (!wholeFile && !text.includes('copy`') && !text.includes('brandText(')) return null;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** [start, end, replacement] over the ORIGINAL text, applied back to front. */
  const edits = [];
  const literal = (node, open, close) => {
    const start = node.getStart(sf) + open;
    const end = node.getEnd() - close;
    const raw = text.slice(start, end);
    // An escape (`\n`, `\u2026`, `` \` ``) is the character it stands for: copy on either side of it
    // is read on its own, so `\nhq:` is the word `hq` after a line break, never the letters `nhq`.
    const next = raw
      .split(ESCAPE)
      .map((part, i) => (i % 2 === 1 ? part : rebrandCopy(brand, part)))
      .join('');
    if (next !== raw) edits.push([start, end, next]);
  };
  const template = (t) => {
    if (ts.isNoSubstitutionTemplateLiteral(t)) literal(t, 1, 1);
    else {
      literal(t.head, 1, 2); // `...${
      for (const span of t.templateSpans) {
        // }...${  or  }...`
        literal(span.literal, 1, ts.isTemplateTail(span.literal) ? 1 : 2);
      }
    }
  };
  /** A module specifier (`import ... from '...'`, `export ... from '...'`, `import('...')`). */
  const isSpecifier = (node) =>
    (node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))) ||
    (node.parent &&
      ts.isCallExpression(node.parent) &&
      (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.parent.expression) && node.parent.expression.text === 'require')));
  const visitFile = (node) => {
    if (ts.isStringLiteral(node) && !isSpecifier(node)) literal(node, 1, 1);
    else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      template(node);
    }
    ts.forEachChild(node, visitFile);
  };
  const visit = (node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'copy'
    ) {
      template(node.template);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'brandText' &&
      node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      literal(node.arguments[0], 1, 1);
    }
    ts.forEachChild(node, visit);
  };
  (wholeFile ? visitFile : visit)(sf);
  if (edits.length === 0) return null;
  let out = text;
  for (const [start, end, next] of edits.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + next + out.slice(end);
  }
  return out;
}

/** `rebrandCopy` from shared/src/dev-brand-copy.ts, for build scripts (the manifest transform). */
export async function loadRebrandCopy(root, { esbuild }) {
  return (await importTs(esbuild, path.join(root, 'shared', 'src', 'dev-brand-copy.ts')))
    .rebrandCopy;
}

/**
 * A bundle with its modules keyed by number instead of by source path: esbuild names a lazily
 * initialized module (`__esm({ "../x/src/a.ts"() {...} })`) and a CommonJS one by its path, and that
 * name is only a label. Every input the metafile lists, as an exact quoted string, becomes `"m<n>"`.
 */
export function neutralizeModulePaths(code, metafile) {
  let out = code;
  Object.keys(metafile.inputs).forEach((input, i) => {
    out = out.split(JSON.stringify(input)).join(JSON.stringify(`m${i}`));
  });
  return out;
}

/** The esbuild plugin. `deps` = the caller's own `{ esbuild, ts }`. */
export async function devBrandPlugin(root, id, deps) {
  const { ts } = deps;
  const brandFile = brandFileOf(root, id);
  const copyFile = path.join(root, 'shared', 'src', 'dev-brand-copy.ts');
  const prebuiltCopyFile = path.join(root, 'shared', 'src', 'dev-brand-copy.prebuilt.ts');
  const brand = await loadDevBrand(root, id, deps);
  const rebrandCopy = await loadRebrandCopy(root, deps);
  return {
    name: 'dev-brand',
    setup(b) {
      b.onResolve({ filter: /^\.\/dev-brands\/awo\.js$/ }, (args) =>
        args.importer.endsWith(`${path.sep}active-dev-brand.ts`) ? { path: brandFile } : undefined,
      );
      if (id === 'awo') return;
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
        if (args.path === copyFile) {
          return {
            contents: readFileSync(prebuiltCopyFile, 'utf8'),
            loader: 'ts',
            resolveDir: path.dirname(copyFile),
          };
        }
        const text = readFileSync(args.path, 'utf8');
        const next = rebrandSource(ts, args.path, text, brand, rebrandCopy);
        return next === null ? undefined : { contents: next, loader: 'ts' };
      });
    },
  };
}
