/**
 * What an image paste or drop in an HQ terminal does (hq-vscode-image-paste, 0.2.1), with every
 * effect injected so it is decided here and only wired in `extension.ts`.
 *
 *   paste   TEXT FIRST: any text on the clipboard is the key's own paste, at once, with no image
 *           reader started (an Office, Finder or Keynote copy carries a picture too). With no text,
 *           an image is uploaded to `.uploads` and its path typed (no Enter), with the web terminal's
 *           sentences; anything else is the key's own paste, exactly as before.
 *   drop    a chunk of dropped image paths is rewritten (image-paste.ts `rewriteDrop`) after the
 *           person agrees; a refusal, a failed upload or one that does not finish in 30 s says why
 *           and sends nothing, and the input behind it moves on.
 */
import { COPY } from '../copy.js';
import {
  parseDroppedPaths,
  rewriteDrop,
  type ClipboardImage,
  type DropContext,
  type PastedImage,
} from './image-paste.js';

export interface PasteFlowDeps {
  /** VS Code's clipboard text (`vscode.env.clipboard.readText`). */
  readText(): Promise<string>;
  readImage(): Promise<ClipboardImage>;
  /** What the key did before: VS Code's terminal paste, or `^V` (Linux Ctrl+V). */
  fallback(): Promise<void>;
  /** The terminal's account may change this team's files and type in the session. */
  canWrite: boolean;
  /** The extension runs in a remote extension host: the OS clipboard is not this computer's. */
  remoteHost: boolean;
  upload(image: PastedImage): Promise<string>;
  /** Type into the terminal (no Enter). */
  type(text: string): void;
  info(message: string): void;
  error(message: string): void;
  progress<T>(title: string, task: () => Promise<T>): Promise<T>;
  status(message: string): void;
}

const reason = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : COPY.unreachable;

export async function pasteIntoTerminal(d: PasteFlowDeps): Promise<void> {
  const text = await d.readText().catch(() => '');
  if (text.length > 0) return d.fallback();
  if (d.remoteHost) {
    d.info(COPY.imagePasteRemoteHost);
    return d.fallback();
  }
  let clip: ClipboardImage;
  try {
    clip = await d.readImage();
  } catch {
    clip = { kind: 'none' };
  }
  if (clip.kind === 'none') return d.fallback();
  if (clip.kind === 'too-large') return d.error(COPY.imageTooLarge);
  if (clip.kind === 'wrong-type') return d.error(COPY.imageWrongType);
  if (!d.canWrite) return d.info(COPY.fsViewOnly);
  const { bytes, mime, ext } = clip;
  let path: string;
  try {
    path = await d.progress(COPY.imageUploading, () => d.upload({ bytes, mime, ext }));
  } catch (err) {
    return d.error(COPY.imageUploadFailed(reason(err)));
  }
  d.type(path);
  d.status(COPY.imageAdded);
}

export interface DropFlowDeps {
  ctx(): DropContext;
  canWrite(): boolean;
  /** Our own paste (`hq.terminalPaste`'s fallback) is running: its text is never rewritten. */
  suppressed(): boolean;
  /** The terminal's team, for the refusal sentence. */
  teamName(): string;
  info(message: string): void;
  error(message: string): void;
  /** A progress notice with Cancel (`onCancel` runs when the person presses it). */
  progress<T>(title: string, task: () => Promise<T>, onCancel: () => void): Promise<T>;
  /** How long a rewrite may take, not counting the consent question. Default 30 s. */
  timeoutMs?: number;
}

/** A dropped image's upload gets this long (review MUST 2: the input behind it must not hang). */
export const DROP_TIMEOUT_MS = 30_000;

/**
 * The rewrite an `OrderedInput` runs on each input chunk: null (synchronously) for anything that is
 * not a chunk of absolute paths (every key typed), else a promise of what to send instead. The
 * promise always settles: by the rewrite, the time limit (paused while the person is asked), or the
 * progress notice's Cancel; a result that comes later is dropped.
 */
export function dropRewriter(d: DropFlowDeps): (chunk: string) => Promise<string | null> | null {
  const limit = d.timeoutMs ?? DROP_TIMEOUT_MS;
  return (chunk) => {
    if (d.suppressed() || !parseDroppedPaths(chunk) || !d.canWrite()) return null;
    return new Promise<string | null>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (v: string | null): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve(v);
      };
      const arm = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          if (done) return;
          d.error(COPY.imageUploadTimeout);
          settle(null);
        }, limit);
      };
      const pause = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };
      const ctx = d.ctx();
      let uploading = false;
      const guarded: DropContext = {
        ...ctx,
        confirm: async (names) => {
          if (done) return false; // settled (time limit, Cancel): no stale question
          pause(); // the person's time to answer does not count
          try {
            return await ctx.confirm(names);
          } finally {
            if (!done) arm();
          }
        },
        upload: (img) => {
          // Settled: nothing more goes up. One already under way may still land in .uploads.
          if (done) return Promise.reject(new Error(COPY.imageUploadTimeout));
          if (uploading) return ctx.upload(img);
          uploading = true;
          return d.progress(
            COPY.imageUploading,
            () => ctx.upload(img),
            () => settle(null),
          );
        },
      };
      arm();
      void (async () => {
        try {
          const r = await rewriteDrop(chunk, guarded);
          if (done) return; // too late: dropped
          if (r.kind === 'pass') return settle(chunk);
          if (r.kind === 'replace') return settle(r.text);
          d.error(
            r.reason === 'other-team' ? COPY.imageDropOtherTeam(d.teamName()) : COPY.imageTooLarge,
          );
          settle(null);
        } catch (err) {
          if (done) return;
          d.error(COPY.imageUploadFailed(reason(err)));
          settle(null);
        }
      })();
    });
  };
}

/**
 * A local path as the consent question shows it: in full, with the home folder as `~` (review: a
 * base name alone does not say WHICH file leaves the computer). Windows paths compare case-blind.
 */
export function displayPath(path: string, home: string): string {
  if (!home) return path;
  const win = /^[A-Za-z]:\\/.test(home) || home.startsWith('\\\\');
  const sep = win ? '\\' : '/';
  const same = win ? path.toLowerCase().startsWith(home.toLowerCase()) : path.startsWith(home);
  if (!same) return path;
  const rest = path.slice(home.length);
  if (rest === '') return '~';
  return rest.startsWith(sep) ? `~${rest}` : path;
}
