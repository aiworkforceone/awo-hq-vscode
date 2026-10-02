/**
 * The VS Code side of image paste and drop in HQ terminals (hq-vscode-image-paste, 0.2.2):
 *
 *   - `hq.terminalPaste`, bound to Cmd+V (macOS), Ctrl+V (Windows, Linux) and Ctrl+Shift+V (Linux)
 *     while an HQ terminal is focused (`hq.activeTerminal`). Its `fallback` arg is what the key did
 *     before: VS Code's terminal paste, or `^V` for Linux Ctrl+V. Clipboard TEXT always wins.
 *   - the drop rewrite each HQ terminal's input runs (`Terminals.rewriteInput`). A local file is
 *     uploaded only after the person says yes (security M1), and never for text our own paste typed.
 *
 * The image goes to the terminal's OWN account and team, through that account's file system (the
 * signed `PUT …/fs/file` every save uses), so its errors read like a save's.
 */
import { execFile } from 'node:child_process';
import { constants as fsc, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Team } from '@hq/client/teams.js';
import { COPY } from '../copy.js';
import type { HqAccounts } from '../hq/accounts.js';
import { cleanLabel } from '../util/text.js';
import type { SessionTarget } from './hq-pty.js';
import {
  MAX_PASTE_IMAGE_BYTES,
  readClipboardImage,
  uploadPastedImage,
  type DropContext,
  type ExecFile,
  type LocalFile,
  type PastedImage,
} from './image-paste.js';
import { displayPath, dropRewriter, pasteIntoTerminal } from './terminal-paste.js';
import type { Terminals } from './terminals.js';

type Accounts = Pick<HqAccounts, 'get'>;

/** `execFile` with a fixed argv and no shell, as a promise. */
const execFileP: ExecFile = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, shell: false }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

/** May this terminal's account change the team's files and type in the session? */
function canWrite(target: SessionTarget): boolean {
  return target.session.canType && target.team.workspace.rights.files?.write === true;
}

const teamName = (target: SessionTarget): string =>
  cleanLabel(target.team.workspace.name) || target.team.alias;

function uploader(
  accounts: Accounts,
  target: SessionTarget,
): (img: PastedImage) => Promise<string> {
  return async (img) => {
    const core = accounts.get(target.account)?.core;
    if (!core) throw new Error(teamName(target));
    const team: Team = target.team;
    return uploadPastedImage(
      {
        mkdir: (p) => core.createDirectory(team, p),
        writeNew: (p, bytes) => core.writeFile(team, p, bytes, { create: true, overwrite: false }),
      },
      img,
    );
  };
}

/** A notification progress with Cancel. */
const progress = <T>(title: string, task: () => Promise<T>, onCancel?: () => void): Promise<T> =>
  Promise.resolve(
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: onCancel !== undefined,
      },
      (_p, token) => {
        if (onCancel) token.onCancellationRequested(onCancel);
        return task();
      },
    ),
  );

/**
 * Security L1: ONE non-blocking open, and the type and size from `fstat` of that handle (a path
 * swapped for a FIFO between two calls cannot stall the input queue: a FIFO opens at once
 * non-blocking and is not a regular file).
 */
async function openLocal(path: string): Promise<LocalFile | null> {
  const fh = await fsp.open(path, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0)).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    const read = async (n: number): Promise<Uint8Array> => {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return Uint8Array.from(buf.subarray(0, bytesRead));
    };
    return {
      isFile: st.isFile(),
      size: st.size,
      head: (n) => read(n),
      all: () => read(MAX_PASTE_IMAGE_BYTES + 1),
      close: () => fh.close(),
    };
  } catch {
    await fh.close().catch(() => undefined);
    return null;
  }
}

/** "Upload ~/Shots/a.png to Backend team?" with Upload / Type the path (modal, full paths). */
async function confirmUpload(paths: string[], team: string): Promise<boolean> {
  const home = homedir();
  const files = paths.map((p) => cleanLabel(displayPath(p, home), 400) || '?').join(', ');
  const choice = await vscode.window.showWarningMessage(
    COPY.imageUploadConfirm(files, team),
    { modal: true },
    COPY.imageUploadAction,
    COPY.imageTypePathAction,
  );
  return choice === COPY.imageUploadAction;
}

/**
 * Per terminal: our own paste is running there (and its text is arriving), so that terminal's
 * chunks are never rewritten until then.
 */
const ownPasteUntil = new WeakMap<SessionTarget, number>();
/** The paste's text reaches the terminal shortly after the command resolves. */
const OWN_PASTE_TAIL_MS = 1_000;

/** The drop rewrite for one terminal (handed to `Terminals`). */
export function rewriteInputFor(
  accounts: Accounts,
): (target: SessionTarget) => (chunk: string) => Promise<string | null> | null {
  return (target) =>
    dropRewriter({
      canWrite: () => canWrite(target),
      suppressed: () => Date.now() < (ownPasteUntil.get(target) ?? 0),
      teamName: () => teamName(target),
      info: (m) => void vscode.window.showInformationMessage(m),
      error: (m) => void vscode.window.showWarningMessage(m),
      progress,
      ctx: (): DropContext => ({
        teamAlias: target.team.alias,
        open: openLocal,
        confirm: (names) => confirmUpload(names, teamName(target)),
        upload: uploader(accounts, target),
      }),
    });
}

/** `hq.terminalPaste` and the `hq.activeTerminal` context key. */
export function registerTerminalPaste(deps: {
  accounts: Accounts;
  terminals: Pick<Terminals, 'activeTerminal' | 'onDidChange'>;
  remoteHost: () => boolean;
  log: { info(line: string): void };
}): vscode.Disposable {
  const setContext = (): void =>
    void vscode.commands.executeCommand(
      'setContext',
      'hq.activeTerminal',
      deps.terminals.activeTerminal() !== null,
    );
  setContext();
  const onChange = deps.terminals.onDidChange(setContext);
  const command = vscode.commands.registerCommand(
    'hq.terminalPaste',
    async (args?: { fallback?: unknown }) => {
      const ctrlV = args?.fallback === 'ctrlV';
      const active = deps.terminals.activeTerminal();
      const fallback = async (): Promise<void> => {
        if (ctrlV) {
          active?.terminal.sendText('\x16', false);
          return;
        }
        // Review MUST 3: a path in the clipboard text is typed as pasted, never uploaded.
        const target = active?.target;
        if (target) ownPasteUntil.set(target, Number.POSITIVE_INFINITY);
        try {
          await vscode.commands.executeCommand('workbench.action.terminal.paste');
        } finally {
          if (target) ownPasteUntil.set(target, Date.now() + OWN_PASTE_TAIL_MS);
        }
      };
      if (!active) return fallback();
      const { terminal, target } = active;
      await pasteIntoTerminal({
        readText: () => Promise.resolve(vscode.env.clipboard.readText()),
        readImage: () =>
          readClipboardImage({ platform: process.platform, env: process.env, exec: execFileP }),
        fallback,
        canWrite: canWrite(target),
        remoteHost: deps.remoteHost(),
        upload: uploader(deps.accounts, target),
        type: (text) => {
          terminal.sendText(text, false);
          deps.log.info('terminal: an image was pasted');
        },
        info: (m) => void vscode.window.showInformationMessage(m),
        error: (m) => void vscode.window.showWarningMessage(m),
        progress: (title, task) => progress(title, task),
        status: (m) => void vscode.window.setStatusBarMessage(m, 4_000),
      });
    },
  );
  return vscode.Disposable.from(command, onChange);
}
