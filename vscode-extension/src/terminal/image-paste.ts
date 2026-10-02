/**
 * Image paste and drop for HQ terminals (hq-vscode-image-paste, 0.2.1): the part with no `vscode`
 * import. The web terminal is the reference (client/src/lib/paste-image.ts): an image becomes a file
 * under `.uploads` in the team's folder and its relative path is typed at the prompt, no Enter.
 *
 *   - Types by MAGIC BYTES (PNG, JPEG, GIF, WebP), never by a file name. 10 MiB at most (the web's).
 *   - The OS clipboard is read with `execFile`, a fixed argv, no shell, a timeout and a bounded
 *     output: macOS `osascript`, Windows `powershell -STA`, Linux `wl-paste` or `xclip`. Nothing is
 *     written to disk.
 *   - A dropped chunk is rewritten only when it is EXACTLY path tokens (as VS Code types a drop) that
 *     are all existing local image files, or a path in the terminal's own team folder. Anything else
 *     passes through untouched.
 */

/** The web's cap for a pasted image (`MAX_PASTE_IMAGE_BYTES`). */
export const MAX_PASTE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Where pasted images land, relative to the team's folder (the session's working dir). */
export const PASTE_IMAGE_DIR = '.uploads';
/** One clipboard tool call at most this long. */
export const CLIPBOARD_TIMEOUT_MS = 3_000;

export interface ImageKind {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  ext: 'png' | 'jpg' | 'gif' | 'webp';
}

export type PastedImage = ImageKind & { bytes: Uint8Array };

const ALLOWED_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  return sig.every((v, i) => b[at + i] === v);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** What image the bytes are, by their signature only; null for anything else. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: 'image/png', ext: 'png' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')))
    return { mime: 'image/gif', ext: 'gif' };
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8))
    return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** `pasted-YYYYMMDD-HHMMSS-xxxx.<ext>`, the web's `synthesizePasteImageName` format. */
export function pastedImageName(
  ext: string,
  now: Date = new Date(),
  random: () => number = Math.random,
): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = random().toString(16).slice(2, 6).padEnd(4, '0');
  return `pasted-${stamp}-${rand}.${ext}`;
}

// ── the OS clipboard ──────────────────────────────────────────────────────────────────────────────

export type ExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; encoding: 'buffer' | 'utf8'; windowsHide: true },
) => Promise<{ stdout: Buffer | string }>;

export type ClipboardImage =
  | ({ kind: 'image' } & PastedImage)
  | { kind: 'none' }
  | { kind: 'too-large' }
  | { kind: 'wrong-type' };

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exec: ExecFile;
}

/** Room for the image as hex (macOS) or base64 (Windows), and a little more. */
const TEXT_BOUND = 2 * MAX_PASTE_IMAGE_BYTES + 64 * 1024;
const BINARY_BOUND = MAX_PASTE_IMAGE_BYTES + 64 * 1024;

class TooLarge extends Error {}

async function run(
  deps: ClipboardDeps,
  file: string,
  args: string[],
  encoding: 'buffer' | 'utf8',
): Promise<Buffer | string | null> {
  try {
    const { stdout } = await deps.exec(file, args, {
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: encoding === 'buffer' ? BINARY_BOUND : TEXT_BOUND,
      encoding,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new TooLarge();
    return null; // no image, the tool is missing, a timeout: the caller pastes text instead
  }
}

const POWERSHELL_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
  '$i = [System.Windows.Forms.Clipboard]::GetImage(); ' +
  'if ($i -ne $null) { $m = New-Object System.IO.MemoryStream; ' +
  '$i.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()) }';

async function readRaw(deps: ClipboardDeps): Promise<Uint8Array | null> {
  if (deps.platform === 'darwin') {
    // Security L2: the system's own binaries by absolute path, never a PATH lookup.
    const out = await run(
      deps,
      '/usr/bin/osascript',
      ['-e', 'the clipboard as «class PNGf»'],
      'utf8',
    );
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(String(out ?? ''))?.[1];
    return hex ? Uint8Array.from(Buffer.from(hex, 'hex')) : null;
  }
  if (deps.platform === 'win32') {
    const out = await run(
      deps,
      `${deps.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', POWERSHELL_SCRIPT],
      'utf8',
    );
    const b64 = String(out ?? '').trim();
    return /^[A-Za-z0-9+/]+=*$/.test(b64) ? Uint8Array.from(Buffer.from(b64, 'base64')) : null;
  }
  // Linux and the BSDs: Wayland first when its display is set, else X11.
  const wayland = Boolean(deps.env.WAYLAND_DISPLAY);
  const types = wayland
    ? await run(deps, 'wl-paste', ['--list-types'], 'utf8')
    : await run(deps, 'xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], 'utf8');
  if (types === null) return null;
  const listed = String(types)
    .split(/\r?\n/)
    .map((t) => t.trim());
  const pick = ALLOWED_MIMES.find((m) => listed.includes(m));
  if (!pick) return null;
  const out = wayland
    ? await run(deps, 'wl-paste', ['--no-newline', '--type', pick], 'buffer')
    : await run(deps, 'xclip', ['-selection', 'clipboard', '-t', pick, '-o'], 'buffer');
  return out === null ? null : Uint8Array.from(Buffer.isBuffer(out) ? out : Buffer.from(out));
}

/** The image on the OS clipboard, if any (`none` whenever it cannot be read). Never throws. */
export async function readClipboardImage(deps: ClipboardDeps): Promise<ClipboardImage> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readRaw(deps);
  } catch (err) {
    if (err instanceof TooLarge) return { kind: 'too-large' };
    return { kind: 'none' };
  }
  if (!bytes || bytes.length === 0) return { kind: 'none' };
  if (bytes.length > MAX_PASTE_IMAGE_BYTES) return { kind: 'too-large' };
  const kind = sniffImage(bytes);
  return kind ? { kind: 'image', bytes, ...kind } : { kind: 'wrong-type' };
}

// ── dropped paths ─────────────────────────────────────────────────────────────────────────────────

export interface DropToken {
  path: string;
  /** How VS Code quoted it (kept when the replacement is a path again). */
  quote: '' | "'" | '"';
  /** A bare token with `\ ` escapes (a replacement path is escaped the same way). */
  escaped: boolean;
}

const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

/** A control character (a key such as Enter or an arrow, never part of a dropped path). */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** An absolute path: POSIX, a Windows drive, a UNC share, or `\hq-…` (an hq:// URI's fsPath). */
function absolute(p: string): boolean {
  return (
    (p.startsWith('/') && p.length > 1) ||
    /^[A-Za-z]:\\/.test(p) ||
    /^\\\\[^\\]/.test(p) ||
    /^\\hq-[0-9a-f]{8}(\\|$)/.test(p)
  );
}

/**
 * The chunk as path tokens, the way VS Code types a dropped file: `'…'` on macOS and Linux (with `\`
 * doubled), `"…"` on Windows when there is a space, or bare; several are separated by one space. A
 * bare token may escape a space as `\ `. Null when the chunk is anything else.
 */
export function parseDroppedPaths(
  chunk: string,
): { open: string; close: string; tokens: DropToken[] } | null {
  let body = chunk;
  let open = '';
  let close = '';
  if (body.startsWith(PASTE_OPEN) && body.endsWith(PASTE_CLOSE)) {
    open = PASTE_OPEN;
    close = PASTE_CLOSE;
    body = body.slice(PASTE_OPEN.length, body.length - PASTE_CLOSE.length);
  }
  if (body.length < 2 || hasControl(body)) return null;
  const tokens: DropToken[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    let path: string;
    let quote: DropToken['quote'];
    let escaped = false;
    if (c === "'" || c === '"') {
      const end = body.indexOf(c, i + 1);
      if (end < 0) return null;
      const inner = body.slice(i + 1, end);
      path = c === "'" ? inner.replace(/\\\\/g, '\\') : inner;
      quote = c;
      escaped = false;
      i = end + 1;
    } else {
      let j = i;
      let raw = '';
      while (j < body.length && body[j] !== ' ') {
        if (body[j] === '\\' && body[j + 1] === ' ') {
          raw += ' ';
          escaped = true;
          j += 2;
          continue;
        }
        raw += body[j];
        j += 1;
      }
      path = raw;
      quote = '';
      i = j;
    }
    if (!absolute(path)) return null;
    tokens.push({ path, quote, escaped });
    if (i < body.length) {
      if (body[i] !== ' ' || i + 1 >= body.length) return null;
      i += 1;
    }
  }
  return tokens.length > 0 ? { open, close, tokens } : null;
}

/** A local file opened ONCE (security L1): its type and size come from the open handle. */
export interface LocalFile {
  isFile: boolean;
  size: number;
  /** The first `n` bytes (the type is sniffed from these before anything else is read). */
  head(n: number): Promise<Uint8Array>;
  /** The whole file, at most the cap plus one byte. */
  all(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface DropContext {
  /** The terminal's team folder alias (`hq-xxxxxxxx`). */
  teamAlias: string;
  /** Open a local path without blocking (a FIFO answers at once and is not a regular file). */
  open(path: string): Promise<LocalFile | null>;
  /** Security M1: may these local files (full paths) go to the team? False: type the path as it was. */
  confirm(names: string[]): Promise<boolean>;
  /** Upload one image; resolves to its team-relative path. */
  upload(image: PastedImage): Promise<string>;
}

export type DropResult =
  | { kind: 'pass' }
  | { kind: 'replace'; text: string }
  | { kind: 'refuse'; reason: 'other-team' | 'too-large' };

/** `/hq-xxxxxxxx/rest` or `\hq-xxxxxxxx\rest` → [alias, rest with `/`]. */
function teamPathOf(path: string): [string, string] | null {
  const m = /^[/\\](hq-[0-9a-f]{8})(?:[/\\](.*))?$/.exec(path);
  return m ? [m[1]!, (m[2] ?? '').replace(/\\/g, '/')] : null;
}

const SNIFF_BYTES = 16;

/**
 * What a dropped chunk becomes (see the header). Every local file read needs the person's yes
 * (`confirm`); a path of the terminal's own team needs none (nothing local is read). If one upload
 * of several fails, the images already uploaded stay in `.uploads` (nothing is typed).
 */
export async function rewriteDrop(chunk: string, ctx: DropContext): Promise<DropResult> {
  const parsed = parseDroppedPaths(chunk);
  if (!parsed) return { kind: 'pass' };
  // A drop from an hq:// folder: VS Code typed the URI's path. Decided before any local read.
  const inTeam = parsed.tokens.map((t) => teamPathOf(t.path));
  // Security L3: ANY team folder but this terminal's own (another team, another account's): refused.
  if (inTeam.some((x) => x !== null && x[0] !== ctx.teamAlias)) {
    return { kind: 'refuse', reason: 'other-team' };
  }
  if (inTeam.some((x) => x !== null)) {
    if (!inTeam.every((x) => x !== null && x[1].length > 0)) return { kind: 'pass' };
    const out = parsed.tokens.map((t, i) => {
      const rel = inTeam[i]![1];
      return `${t.quote}${t.escaped ? rel.replace(/ /g, '\\ ') : rel}${t.quote}`;
    });
    return { kind: 'replace', text: `${parsed.open}${out.join(' ')}${parsed.close}` };
  }
  // Local files: every token must be an existing regular file that is an allowed image.
  const opened: LocalFile[] = [];
  try {
    const kinds: ImageKind[] = [];
    for (const t of parsed.tokens) {
      const f = await ctx.open(t.path).catch(() => null);
      if (!f) return { kind: 'pass' };
      opened.push(f);
      if (!f.isFile) return { kind: 'pass' };
      if (f.size > MAX_PASTE_IMAGE_BYTES) return { kind: 'refuse', reason: 'too-large' };
      const kind = sniffImage(await f.head(SNIFF_BYTES));
      if (!kind) return { kind: 'pass' };
      kinds.push(kind);
    }
    if (!(await ctx.confirm(parsed.tokens.map((t) => t.path)))) return { kind: 'pass' };
    const images: PastedImage[] = [];
    for (const [i, f] of opened.entries()) {
      const bytes = await f.all();
      if (bytes.length > MAX_PASTE_IMAGE_BYTES) return { kind: 'refuse', reason: 'too-large' };
      if (sniffImage(bytes)?.mime !== kinds[i]!.mime) return { kind: 'pass' };
      images.push({ ...kinds[i]!, bytes });
    }
    const paths: string[] = [];
    for (const img of images) paths.push(await ctx.upload(img));
    return { kind: 'replace', text: `${parsed.open}${paths.join(' ')}${parsed.close}` };
  } finally {
    await Promise.all(opened.map((f) => f.close().catch(() => undefined)));
  }
}

// ── the upload ────────────────────────────────────────────────────────────────────────────────────

export interface ImageUploadFs {
  /** Make the folder; an `exists` error (it is there already) is fine. */
  mkdir(path: string): Promise<void>;
  /** Write a NEW file; an `exists` error means the name is taken. */
  writeNew(path: string, bytes: Uint8Array): Promise<void>;
}

const isExists = (err: unknown): boolean => (err as { kind?: unknown }).kind === 'exists';

/** Put the image in `.uploads` under a fresh name; resolves to the path to type. */
export async function uploadPastedImage(
  fs: ImageUploadFs,
  image: PastedImage,
  now: Date = new Date(),
): Promise<string> {
  await fs.mkdir(PASTE_IMAGE_DIR).catch((err: unknown) => {
    if (!isExists(err)) throw err;
  });
  for (let attempt = 0; ; attempt++) {
    const path = `${PASTE_IMAGE_DIR}/${pastedImageName(image.ext, now)}`;
    try {
      await fs.writeNew(path, image.bytes);
      return path;
    } catch (err) {
      if (!isExists(err) || attempt >= 1) throw err;
    }
  }
}
