/**
 * hq-vscode-image-paste (0.2.1): the paste command's decisions, the drop rewriter's notices, and the
 * input order around an upload (nothing typed after a drop may overtake it).
 */
import { describe, expect, it, vi } from 'vitest';
import { COPY } from '../../src/copy.js';
import type { ClipboardImage, DropContext } from '../../src/terminal/image-paste.js';
import { MAX_PASTE_IMAGE_BYTES } from '../../src/terminal/image-paste.js';
import { OrderedInput } from '../../src/terminal/ordered-input.js';
import {
  displayPath,
  dropRewriter,
  pasteIntoTerminal,
  type DropFlowDeps,
  type PasteFlowDeps,
} from '../../src/terminal/terminal-paste.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const image: ClipboardImage = { kind: 'image', bytes: PNG, mime: 'image/png', ext: 'png' };

function deps(over: Partial<PasteFlowDeps> = {}) {
  const log: string[] = [];
  const d: PasteFlowDeps = {
    readText: async () => '',
    readImage: async () => image,
    fallback: async () => void log.push('fallback'),
    canWrite: true,
    remoteHost: false,
    upload: async () => '.uploads/pasted-20261002-010355-ab12.png',
    type: (t) => void log.push(`type ${t}`),
    info: (m) => void log.push(`info ${m}`),
    error: (m) => void log.push(`error ${m}`),
    progress: async (title, fn) => {
      log.push(`progress ${title}`);
      return fn();
    },
    status: (m) => void log.push(`status ${m}`),
    ...over,
  };
  return { d, log };
}

describe('pasteIntoTerminal', () => {
  it('review MUST 1: text on the clipboard (an Office or Finder copy carries an image too): the text paste at once, no image reader spawned', async () => {
    const readImage = vi.fn(async () => image);
    const upload = vi.fn();
    const { d, log } = deps({ readText: async () => 'A1\tB1', readImage, upload });
    await pasteIntoTerminal(d);
    expect(log).toEqual(['fallback']);
    expect(readImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('no text and an image: the upload (the screenshot case)', async () => {
    const upload = vi.fn(async () => '.uploads/p.png');
    const { d } = deps({ readText: async () => '', upload });
    await pasteIntoTerminal(d);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('reading the text fails: treated as no text (the image reader decides)', async () => {
    const upload = vi.fn(async () => '.uploads/p.png');
    const { d } = deps({ readText: async () => Promise.reject(new Error('x')), upload });
    await pasteIntoTerminal(d);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('an image: "Uploading image...", the upload, the relative path typed (no Enter), "Image added..."', async () => {
    const { d, log } = deps();
    await pasteIntoTerminal(d);
    expect(log).toEqual([
      `progress ${COPY.imageUploading}`,
      'type .uploads/pasted-20261002-010355-ab12.png',
      `status ${COPY.imageAdded}`,
    ]);
  });

  it.each([
    ['text or nothing on the clipboard', async () => ({ kind: 'none' }) as ClipboardImage],
    ['the clipboard tool failed', async () => Promise.reject(new Error('boom'))],
  ])('%s: the text paste exactly as before, nothing uploaded', async (_why, readImage) => {
    const upload = vi.fn();
    const { d, log } = deps({ readImage, upload });
    await pasteIntoTerminal(d);
    expect(log).toEqual(['fallback']);
    expect(upload).not.toHaveBeenCalled();
  });

  it('view-only: the view-only sentence; no upload and nothing typed', async () => {
    const upload = vi.fn();
    const { d, log } = deps({ canWrite: false, upload });
    await pasteIntoTerminal(d);
    expect(log).toEqual([`info ${COPY.fsViewOnly}`]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('too large, or not PNG/JPEG/GIF/WebP: the web sentences; nothing typed', async () => {
    const big = deps({ readImage: async () => ({ kind: 'too-large' }) });
    await pasteIntoTerminal(big.d);
    expect(big.log).toEqual([`error ${COPY.imageTooLarge}`]);
    expect(COPY.imageTooLarge).toContain(`${MAX_PASTE_IMAGE_BYTES / 1024 / 1024} MB`);
    const wrong = deps({ readImage: async () => ({ kind: 'wrong-type' }) });
    await pasteIntoTerminal(wrong.d);
    expect(wrong.log).toEqual([`error ${COPY.imageWrongType}`]);
  });

  it('the upload fails: a clear notice with the reason; nothing typed', async () => {
    const { d, log } = deps({
      upload: async () => Promise.reject(new Error('Backend team is off.')),
    });
    await pasteIntoTerminal(d);
    expect(log).toEqual([
      `progress ${COPY.imageUploading}`,
      `error ${COPY.imageUploadFailed('Backend team is off.')}`,
    ]);
  });

  it('a remote extension host (no local clipboard): text pastes as usual; with no text, says drag and drop works', async () => {
    const readImage = vi.fn();
    const withText = deps({ remoteHost: true, readImage, readText: async () => 'ls' });
    await pasteIntoTerminal(withText.d);
    expect(withText.log).toEqual(['fallback']);
    const noText = deps({ remoteHost: true, readImage });
    await pasteIntoTerminal(noText.d);
    expect(noText.log).toEqual([`info ${COPY.imagePasteRemoteHost}`, 'fallback']);
    expect(readImage).not.toHaveBeenCalled();
  });
});

const PNG_FILE = {
  isFile: true,
  size: PNG.length,
  head: async (n: number) => PNG.subarray(0, n),
  all: async () => PNG,
  close: async () => undefined,
};

function flow(over: Partial<DropFlowDeps> = {}, ctxOver: Partial<DropContext> = {}) {
  const shown: string[] = [];
  const cancels: Array<() => void> = [];
  const d: DropFlowDeps = {
    ctx: () => ({
      teamAlias: 'hq-3f9a1c2e',
      open: async () => PNG_FILE,
      confirm: async () => true,
      upload: async () => '.uploads/pasted-x.png',
      ...ctxOver,
    }),
    canWrite: () => true,
    suppressed: () => false,
    teamName: () => 'Backend team',
    info: (m) => void shown.push(m),
    error: (m) => void shown.push(m),
    progress: async (t, fn, onCancel) => {
      shown.push(t);
      cancels.push(onCancel);
      return fn();
    },
    ...over,
  };
  return { rw: dropRewriter(d), shown, cancels };
}

describe('dropRewriter', () => {
  it('a dropped local image: uploaded with progress, replaced by its path', async () => {
    const { rw, shown } = flow();
    const out = rw("'/tmp/a.png'");
    expect(out).not.toBeNull();
    expect(await out).toBe('.uploads/pasted-x.png');
    expect(shown).toEqual([COPY.imageUploading]);
  });

  it('typing is never touched: anything that is not a path chunk is passed on synchronously (null)', () => {
    const { rw } = flow();
    for (const k of ['a', 'ls -la', '\r', '\x1b[A', 'hello world']) expect(rw(k)).toBeNull();
  });

  it('review MUST 3: a chunk arriving while our own paste runs is never rewritten (null)', () => {
    const { rw } = flow({ suppressed: () => true });
    expect(rw("'/tmp/a.png'")).toBeNull();
  });

  it("another team's file: refused with a notice naming this team; the chunk is swallowed", async () => {
    const { rw, shown } = flow();
    expect(await rw('/hq-7c1e2a90/a.png')).toBeNull();
    expect(shown).toEqual([COPY.imageDropOtherTeam('Backend team')]);
  });

  it('a failed upload: the notice, the chunk swallowed (a local path means nothing on the machine)', async () => {
    const { rw, shown } = flow(
      {},
      { upload: async () => Promise.reject(new Error('Storage limit reached.')) },
    );
    expect(await rw('/tmp/a.png')).toBeNull();
    expect(shown).toEqual([COPY.imageUploading, COPY.imageUploadFailed('Storage limit reached.')]);
  });

  it('view-only: a dropped local file is passed on as typed (nothing opened or uploaded)', async () => {
    const open = vi.fn();
    const { rw } = flow({ canWrite: () => false }, { open });
    expect(rw('/tmp/a.png')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('review MUST 2: an upload that never finishes: after the time limit nothing is sent, "did not finish" is said, and a late result is dropped', async () => {
    let finish!: (p: string) => void;
    const { rw, shown } = flow(
      { timeoutMs: 50 },
      { upload: () => new Promise<string>((r) => (finish = r)) },
    );
    const out = rw('/tmp/a.png')!;
    expect(await out).toBeNull();
    expect(shown).toEqual([COPY.imageUploading, COPY.imageUploadTimeout]);
    finish('.uploads/late.png'); // nothing else happens
    await new Promise((r) => setTimeout(r, 10));
    expect(shown).toHaveLength(2);
  });

  it('the time limit does not run while the person answers the consent question', async () => {
    let answer!: (ok: boolean) => void;
    const { rw } = flow({ timeoutMs: 30 }, { confirm: () => new Promise((r) => (answer = r)) });
    const out = rw('/tmp/a.png')!;
    await new Promise((r) => setTimeout(r, 80)); // longer than the limit, still asking
    answer(true);
    expect(await out).toBe('.uploads/pasted-x.png');
  });

  it('review: settled by the time limit before the question: no stale modal is shown', async () => {
    const confirm = vi.fn(async () => true);
    const upload = vi.fn(async () => '.uploads/x.png');
    const { rw, shown } = flow(
      { timeoutMs: 20 },
      {
        // The local file is slow to open (the limit runs out first).
        open: () => new Promise((r) => setTimeout(() => r(PNG_FILE), 60)),
        confirm,
        upload,
      },
    );
    expect(await rw('/tmp/a.png')).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(confirm).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(shown).toEqual([COPY.imageUploadTimeout]);
  });

  it('review: Cancel during the first of two uploads: the second is never uploaded', async () => {
    const uploads: string[] = [];
    let first!: (p: string) => void;
    const { rw, cancels } = flow(
      {},
      {
        upload: (img) => {
          uploads.push(img.mime);
          return uploads.length === 1
            ? new Promise<string>((r) => (first = r))
            : Promise.resolve('.uploads/second.png');
        },
      },
    );
    const out = rw("'/tmp/a.png' '/tmp/b.png'")!;
    await new Promise((r) => setTimeout(r, 5));
    cancels[0]!();
    expect(await out).toBeNull();
    first('.uploads/first.png'); // the first one lands late (documented); the second never starts
    await new Promise((r) => setTimeout(r, 10));
    expect(uploads).toHaveLength(1);
  });

  it('displayPath: the full path, with the home folder as ~ (POSIX and Windows)', () => {
    expect(displayPath('/Users/me/Private/scan.png', '/Users/me')).toBe('~/Private/scan.png');
    expect(displayPath('/tmp/a.png', '/Users/me')).toBe('/tmp/a.png');
    expect(displayPath('/Users/meow/a.png', '/Users/me')).toBe('/Users/meow/a.png');
    expect(displayPath('C:\\Users\\me\\Desktop\\a.png', 'C:\\Users\\me')).toBe('~\\Desktop\\a.png');
    expect(displayPath('c:\\users\\ME\\a.png', 'C:\\Users\\me')).toBe('~\\a.png');
  });

  it("the progress notice's Cancel: nothing is sent, the queue moves on", async () => {
    const { rw, cancels } = flow({}, { upload: () => new Promise<string>(() => undefined) });
    const out = rw('/tmp/a.png')!;
    await new Promise((r) => setTimeout(r, 5));
    cancels[0]!();
    expect(await out).toBeNull();
  });
});

describe('review MUST 2: the input queue never hangs', () => {
  it('a never-finishing upload: keys typed after it go out, in order, once the time limit passes', async () => {
    const sent: string[] = [];
    const { rw } = flow({ timeoutMs: 40 }, { upload: () => new Promise<string>(() => undefined) });
    const q = new OrderedInput((s) => void sent.push(s), rw);
    q.push('/tmp/a.png');
    q.push('x');
    q.push('y');
    expect(sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual(['x', 'y']);
  });

  it('send() throwing does not stop later input', async () => {
    const sent: string[] = [];
    let fail = true;
    let release!: (v: string | null) => void;
    const q = new OrderedInput(
      (s) => {
        if (fail) {
          fail = false;
          throw new Error('socket gone');
        }
        sent.push(s);
      },
      (chunk) => (chunk.startsWith('/') ? new Promise<string | null>((r) => (release = r)) : null),
    );
    q.push('/tmp/a.png');
    q.push('k');
    release('.uploads/x.png'); // its send throws
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['k']);
    q.push('l');
    expect(sent).toEqual(['k', 'l']);
  });
});

describe('OrderedInput: nothing typed after a drop overtakes its upload', () => {
  it('a rewritten chunk goes out first; keys typed meanwhile follow in order; a swallowed chunk sends nothing', async () => {
    const sent: string[] = [];
    let release!: (v: string | null) => void;
    const q = new OrderedInput(
      (s) => void sent.push(s),
      (chunk) => (chunk.startsWith('/') ? new Promise<string | null>((r) => (release = r)) : null),
    );
    q.push('a'); // fast path: straight out
    q.push('/tmp/a.png');
    q.push('b');
    q.push('c');
    expect(sent).toEqual(['a']);
    release('.uploads/x.png');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['a', '.uploads/x.png', 'b', 'c']);
    q.push('/tmp/other.png');
    q.push('d');
    release(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['a', '.uploads/x.png', 'b', 'c', 'd']);
    q.push('e'); // drained: the fast path again
    expect(sent.at(-1)).toBe('e');
  });

  it('a rewrite that throws sends the chunk unchanged and keeps the order', async () => {
    const sent: string[] = [];
    const q = new OrderedInput(
      (s) => void sent.push(s),
      (chunk) => (chunk.startsWith('/') ? Promise.reject(new Error('x')) : null),
    );
    q.push('/tmp/a.png');
    q.push('z');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['/tmp/a.png', 'z']);
  });
});
