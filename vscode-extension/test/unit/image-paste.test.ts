/**
 * hq-vscode-image-paste (0.2.1): the pure half. Types by magic bytes, the three OS clipboard readers
 * (fixed argv, bounded, timed out; a fake execFile per OS), the dropped-path chunk rules, and the
 * upload that types `.uploads/pasted-….png` like the web terminal does.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PASTE_IMAGE_BYTES,
  PASTE_IMAGE_DIR,
  parseDroppedPaths,
  pastedImageName,
  readClipboardImage,
  rewriteDrop,
  sniffImage,
  uploadPastedImage,
  type DropContext,
  type ExecFile,
} from '../../src/terminal/image-paste.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Uint8Array.from(Buffer.from('GIF89a....'));
const WEBP = Uint8Array.from(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '));
const TIFF = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 8, 0]);

describe('sniffImage: the type comes from the bytes, never a name', () => {
  it.each([
    [PNG, 'image/png', 'png'],
    [JPG, 'image/jpeg', 'jpg'],
    [GIF, 'image/gif', 'gif'],
    [WEBP, 'image/webp', 'webp'],
  ])('%#: %s', (bytes, mime, ext) => {
    expect(sniffImage(bytes)).toEqual({ mime, ext });
  });
  it('TIFF, text, a RIFF that is not WebP, and too few bytes are not images', () => {
    expect(sniffImage(TIFF)).toBeNull();
    expect(sniffImage(Uint8Array.from(Buffer.from('hello world')))).toBeNull();
    expect(sniffImage(Uint8Array.from(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ')))).toBeNull();
    expect(sniffImage(Uint8Array.from([0x89, 0x50]))).toBeNull();
  });
});

describe('pastedImageName: the web format', () => {
  it('pasted-YYYYMMDD-HHMMSS-xxxx.<ext>, path-safe', () => {
    const name = pastedImageName('png', new Date(2026, 9, 2, 1, 3, 55), () => 0.5);
    expect(name).toMatch(/^pasted-20261002-010355-[0-9a-f]{4}\.png$/);
  });
});

/** A fake execFile: answers by the program name; records every call. */
function fakeExec(
  answers: Record<
    string,
    (args: string[]) => { stdout?: Buffer | string; error?: Error & { code?: unknown } }
  >,
) {
  const calls: Array<{ file: string; args: string[]; opts: Parameters<ExecFile>[2] }> = [];
  const exec: ExecFile = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const a = answers[file];
    if (!a) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    const r = a(args);
    if (r.error) throw r.error;
    return { stdout: r.stdout ?? Buffer.alloc(0) };
  };
  return { exec, calls };
}

describe('readClipboardImage: macOS (osascript, «class PNGf» as hex)', () => {
  it('an image: the bytes, sniffed; fixed argv, a timeout and a bounded buffer', async () => {
    const hex = Buffer.from(PNG).toString('hex').toUpperCase();
    const { exec, calls } = fakeExec({
      '/usr/bin/osascript': () => ({ stdout: `«data PNGf${hex}»\n` }),
    });
    const r = await readClipboardImage({ platform: 'darwin', env: {}, exec });
    expect(r).toEqual({ kind: 'image', bytes: PNG, mime: 'image/png', ext: 'png' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['-e', 'the clipboard as «class PNGf»']);
    expect(calls[0]!.file).toBe('/usr/bin/osascript'); // security L2: never a PATH lookup
    expect(calls[0]!.opts.timeout).toBeGreaterThan(0);
    expect(calls[0]!.opts.maxBuffer).toBeGreaterThanOrEqual(2 * MAX_PASTE_IMAGE_BYTES);
    expect(calls[0]!.opts.maxBuffer).toBeLessThan(4 * MAX_PASTE_IMAGE_BYTES);
  });
  it('text on the clipboard (osascript fails): none', async () => {
    const { exec } = fakeExec({
      '/usr/bin/osascript': () => ({ error: new Error("Can't make … into type «class PNGf»") }),
    });
    expect(await readClipboardImage({ platform: 'darwin', env: {}, exec })).toEqual({
      kind: 'none',
    });
  });
  it('an image over 10 MiB: too-large (by size, or because the output passed the bound)', async () => {
    const big = Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_PASTE_IMAGE_BYTES)]);
    const { exec } = fakeExec({
      '/usr/bin/osascript': () => ({ stdout: `«data PNGf${big.toString('hex')}»` }),
    });
    // `.kind` only: a regression would otherwise print a 10 MiB array in the diff.
    expect((await readClipboardImage({ platform: 'darwin', env: {}, exec })).kind).toBe(
      'too-large',
    );
    const over = fakeExec({
      '/usr/bin/osascript': () => ({
        error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      }),
    });
    expect(await readClipboardImage({ platform: 'darwin', env: {}, exec: over.exec })).toEqual({
      kind: 'too-large',
    });
  });
});

const PS = 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('readClipboardImage: Windows (PowerShell -STA, PNG as base64)', () => {
  it("security L2: %SystemRoot%'s own PowerShell by absolute path (C:\\Windows when unset), never a PATH lookup", async () => {
    const a = fakeExec({});
    await readClipboardImage({ platform: 'win32', env: { SystemRoot: 'D:\\Win' }, exec: a.exec });
    expect(a.calls[0]!.file).toBe(PS);
    const b = fakeExec({});
    await readClipboardImage({ platform: 'win32', env: {}, exec: b.exec });
    expect(b.calls[0]!.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('an image: the bytes; no image: none; fixed argv (no interpolation)', async () => {
    const env = { SystemRoot: 'D:\\Win' };
    const { exec, calls } = fakeExec({
      [PS]: () => ({ stdout: `${Buffer.from(PNG).toString('base64')}\r\n` }),
    });
    expect(await readClipboardImage({ platform: 'win32', env, exec })).toMatchObject({
      kind: 'image',
      ext: 'png',
    });
    expect(calls[0]!.args.slice(0, 4)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
    ]);
    expect(calls[0]!.args[4]).toContain('System.Windows.Forms.Clipboard');
    const empty = fakeExec({ [PS]: () => ({ stdout: '\r\n' }) });
    expect(await readClipboardImage({ platform: 'win32', env, exec: empty.exec })).toEqual({
      kind: 'none',
    });
  });
});

describe('readClipboardImage: Linux (wl-paste on Wayland, xclip on X11)', () => {
  it('Wayland: the type list first, then the first allowed image type', async () => {
    const { exec, calls } = fakeExec({
      'wl-paste': (args) =>
        args.includes('--list-types')
          ? { stdout: 'text/plain\nimage/jpeg\nimage/png\n' }
          : { stdout: Buffer.from(PNG) },
    });
    const r = await readClipboardImage({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      exec,
    });
    expect(r).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(calls.map((c) => c.args)).toEqual([
      ['--list-types'],
      ['--no-newline', '--type', 'image/png'],
    ]);
  });
  it('X11: xclip TARGETS, then the image; text only: none, with no second call', async () => {
    const { exec, calls } = fakeExec({
      xclip: (args) =>
        args.includes('TARGETS')
          ? { stdout: 'TARGETS\nimage/webp\n' }
          : { stdout: Buffer.from(WEBP) },
    });
    expect(
      await readClipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, exec }),
    ).toMatchObject({
      kind: 'image',
      mime: 'image/webp',
    });
    expect(calls[1]!.args).toEqual(['-selection', 'clipboard', '-t', 'image/webp', '-o']);
    const text = fakeExec({ xclip: () => ({ stdout: 'TARGETS\nUTF8_STRING\n' }) });
    expect(
      await readClipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, exec: text.exec }),
    ).toEqual({ kind: 'none' });
    expect(text.calls).toHaveLength(1);
  });
  it('the tool is not installed: none (the caller falls back to the text paste)', async () => {
    const { exec } = fakeExec({});
    expect(await readClipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, exec })).toEqual({
      kind: 'none',
    });
  });
  it('bytes that claim an image type but are not one: wrong-type', async () => {
    const { exec } = fakeExec({
      xclip: (args) =>
        args.includes('TARGETS') ? { stdout: 'image/png\n' } : { stdout: Buffer.from(TIFF) },
    });
    expect(await readClipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, exec })).toEqual({
      kind: 'wrong-type',
    });
  });
});

describe('parseDroppedPaths: exactly path tokens as VS Code types them, or nothing', () => {
  it.each([
    ["'/Users/me/Shots/a b.png'", ['/Users/me/Shots/a b.png']],
    ['/Users/me/a.png', ['/Users/me/a.png']],
    ["'/tmp/a.png' '/tmp/b c.jpg'", ['/tmp/a.png', '/tmp/b c.jpg']],
    ['/Users/me/a\\ b.png', ['/Users/me/a b.png']],
    ["'/tmp/back\\\\slash.png'", ['/tmp/back\\slash.png']],
    ['C:\\Users\\me\\a.png', ['C:\\Users\\me\\a.png']],
    ['"C:\\Users\\me\\a b.png"', ['C:\\Users\\me\\a b.png']],
    ['\\hq-3f9a1c2e\\src\\a.png', ['\\hq-3f9a1c2e\\src\\a.png']],
  ])('%s', (chunk, paths) => {
    expect(parseDroppedPaths(chunk)?.tokens.map((t) => t.path)).toEqual(paths);
  });
  it('inside bracketed paste: the markers are kept around the result', () => {
    const p = parseDroppedPaths("\x1b[200~'/tmp/a.png'\x1b[201~")!;
    expect(p).toMatchObject({ open: '\x1b[200~', close: '\x1b[201~' });
    expect(p.tokens.map((t) => t.path)).toEqual(['/tmp/a.png']);
  });
  it.each([
    ['a'],
    ['/'],
    ['ls /tmp/a.png'],
    ['look at /tmp/a.png'],
    ['relative/a.png'],
    ["'/tmp/a.png' and"],
    ['\r'],
    ['\x1b[A'],
    [''],
  ])('not only paths: null (%j)', (chunk) => {
    expect(parseDroppedPaths(chunk)).toBeNull();
  });
});

/** Local files as the drop rewrite sees them: one open handle each, fstat'd, head read first. */
function ctx(
  over: Partial<DropContext> = {},
  files: Record<string, Uint8Array | 'fifo'> = {
    '/Users/me/Shots/a b.png': PNG,
    '/tmp/b.jpg': JPG,
    '/tmp/notes.txt': Uint8Array.from(Buffer.from('hello')),
    '/tmp/pipe.png': 'fifo',
  },
) {
  const uploaded: string[] = [];
  const asked: string[][] = [];
  const reads = { head: 0, all: 0, opened: 0, closed: 0 };
  const c: DropContext = {
    teamAlias: 'hq-3f9a1c2e',
    open: async (p) => {
      const f = files[p];
      if (f === undefined) return null;
      reads.opened += 1;
      return {
        isFile: f !== 'fifo',
        size: f === 'fifo' ? 0 : f.length,
        head: async (n) => {
          reads.head += 1;
          return (f as Uint8Array).subarray(0, n);
        },
        all: async () => {
          reads.all += 1;
          return f as Uint8Array;
        },
        close: async () => void (reads.closed += 1),
      };
    },
    confirm: async (names) => {
      asked.push(names);
      return true;
    },
    upload: async (img) => {
      uploaded.push(img.mime);
      return `${PASTE_IMAGE_DIR}/pasted-x${uploaded.length}.${img.ext}`;
    },
    ...over,
  };
  return Object.assign(c, { uploaded, asked, reads });
}

describe('rewriteDrop', () => {
  it('local images: ONE consent naming the files, then uploaded and replaced (bracketed paste kept)', async () => {
    const c = ctx();
    const r = await rewriteDrop("\x1b[200~'/Users/me/Shots/a b.png' '/tmp/b.jpg'\x1b[201~", c);
    expect(r).toEqual({
      kind: 'replace',
      text: '\x1b[200~.uploads/pasted-x1.png .uploads/pasted-x2.jpg\x1b[201~',
    });
    expect(c.asked).toEqual([['/Users/me/Shots/a b.png', '/tmp/b.jpg']]); // full paths (review)
    expect(c.uploaded).toEqual(['image/png', 'image/jpeg']);
    expect(c.reads.opened).toBe(c.reads.closed); // every handle closed
  });

  it('security M1: "Type the path" sends the original text unchanged; nothing is read past the head or uploaded', async () => {
    const c = ctx({ confirm: async () => false });
    expect(await rewriteDrop("'/tmp/b.jpg'", c)).toEqual({ kind: 'pass' });
    expect(c.uploaded).toEqual([]);
    expect(c.reads.all).toBe(0);
  });

  it('anything that is not ALL existing local images passes through untouched, unasked, with nothing read past the head', async () => {
    for (const chunk of [
      "'/tmp/notes.txt'",
      "'/tmp/missing.png'",
      "'/tmp/b.jpg' '/tmp/notes.txt'",
      'ls',
      'x',
    ]) {
      const c = ctx();
      expect(await rewriteDrop(chunk, c)).toEqual({ kind: 'pass' });
      expect(c.uploaded).toEqual([]);
      expect(c.asked).toEqual([]);
      expect(c.reads.all).toBe(0);
      expect(c.reads.opened).toBe(c.reads.closed);
    }
  });

  it('security L1: a FIFO (or anything not a regular file) by the fstat of the opened handle: passed through, never read', async () => {
    const c = ctx();
    expect(await rewriteDrop('/tmp/pipe.png', c)).toEqual({ kind: 'pass' });
    expect(c.reads.head + c.reads.all).toBe(0);
    expect(c.reads.closed).toBe(1);
  });

  it('should: the type is sniffed from the first 16 bytes before the rest is read', async () => {
    const c = ctx();
    await rewriteDrop('/tmp/notes.txt', c);
    expect(c.reads).toMatchObject({ head: 1, all: 0 });
  });

  it('a local image over 10 MiB: refused (too large), unasked, nothing uploaded', async () => {
    const big = Uint8Array.from(
      Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_PASTE_IMAGE_BYTES)]),
    );
    const c = ctx({}, { '/tmp/big.png': big });
    expect(await rewriteDrop('/tmp/big.png', c)).toEqual({ kind: 'refuse', reason: 'too-large' });
    expect(c.asked).toEqual([]);
    expect(c.uploaded).toEqual([]);
  });

  it("a file from this team's hq:// folder: its team-relative path, no consent and no upload (quoting kept; a \\ -escaped token re-escaped)", async () => {
    const c = ctx();
    expect(await rewriteDrop("'/hq-3f9a1c2e/docs/my shot.png'", c)).toEqual({
      kind: 'replace',
      text: "'docs/my shot.png'",
    });
    expect(await rewriteDrop('\\hq-3f9a1c2e\\src\\a.png', c)).toEqual({
      kind: 'replace',
      text: 'src/a.png',
    });
    expect(await rewriteDrop('/hq-3f9a1c2e/docs/my\\ shot.png', c)).toEqual({
      kind: 'replace',
      text: 'docs/my\\ shot.png',
    });
    expect(c.asked).toEqual([]);
    expect(c.uploaded).toEqual([]);
  });

  it("security L3: ANY other team folder (another team, or another account's) is refused, nothing typed", async () => {
    expect(await rewriteDrop('/hq-7c1e2a90/a.png', ctx())).toEqual({
      kind: 'refuse',
      reason: 'other-team',
    });
    expect(await rewriteDrop('/hq-00000000/a.png', ctx())).toEqual({
      kind: 'refuse',
      reason: 'other-team',
    });
    expect(await rewriteDrop("'/hq-3f9a1c2e/a.png' '/hq-11111111/b.png'", ctx())).toEqual({
      kind: 'refuse',
      reason: 'other-team',
    });
  });
});

describe('uploadPastedImage', () => {
  const img = { bytes: PNG, mime: 'image/png', ext: 'png' } as const;
  it('makes .uploads (already there is fine), writes the file as NEW, returns the relative path', async () => {
    const calls: string[] = [];
    const path = await uploadPastedImage(
      {
        mkdir: async (p) => {
          calls.push(`mkdir ${p}`);
          throw Object.assign(new Error('exists'), { kind: 'exists' });
        },
        writeNew: async (p, b) => void calls.push(`write ${p} ${b.length}`),
      },
      img,
      new Date(2026, 9, 2, 1, 3, 55),
    );
    expect(path).toMatch(/^\.uploads\/pasted-20261002-010355-[0-9a-f]{4}\.png$/);
    expect(calls).toEqual(['mkdir .uploads', `write ${path} ${PNG.length}`]);
  });
  it('a name already taken: one more try with a new name; any other failure is thrown', async () => {
    let n = 0;
    const path = await uploadPastedImage(
      {
        mkdir: async () => undefined,
        writeNew: async () => {
          n += 1;
          if (n === 1) throw Object.assign(new Error('exists'), { kind: 'exists' });
        },
      },
      img,
    );
    expect(n).toBe(2);
    expect(path.startsWith('.uploads/pasted-')).toBe(true);
    await expect(
      uploadPastedImage(
        {
          mkdir: async () => undefined,
          writeNew: async () => Promise.reject(new Error('Backend team is off.')),
        },
        img,
      ),
    ).rejects.toThrow('Backend team is off.');
  });
});
