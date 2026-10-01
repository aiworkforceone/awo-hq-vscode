/**
 * The one-time "no system keychain" warning (FEATURE Notifications, notes/security.md §SecretStorage).
 *
 * The sign-in lives in the editor's SecretStorage. On macOS and Windows that is the OS keychain. On
 * Linux it is the Secret Service when one answers, and otherwise the editor falls back to a weak
 * store (`--password-store=basic`). The API does not say which, so this reads the two signs an
 * extension can see: no D-Bus session bus (no Secret Service can answer), or the editor's
 * `argv.json` naming the basic store. Nothing here ever writes a secret itself.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COPY } from '../copy.js';

/** `globalState` key: the warning was shown on this install. */
export const KEYRING_WARNED_KEY = 'hq:keyringWarned';

export function keyringLikelyMissing(input: {
  platform: string;
  env: NodeJS.ProcessEnv;
  argvJson: string | null;
}): boolean {
  if (input.platform !== 'linux') return false;
  if (!input.env.DBUS_SESSION_BUS_ADDRESS?.trim()) return true;
  return input.argvJson !== null && /"password-store"\s*:\s*"basic"/.test(input.argvJson);
}

/** The folder under the home directory holding this editor's `argv.json`, or null if unknown. */
export function argvJsonDir(appName: string): string | null {
  if (/cursor/i.test(appName)) return '.cursor';
  if (/vscodium/i.test(appName)) return '.vscode-oss';
  if (/windsurf/i.test(appName)) return '.windsurf';
  if (/visual studio code/i.test(appName)) return '.vscode';
  return null;
}

/** `keyringLikelyMissing` for this process and editor. */
export function keyringMissingHere(appName: string): boolean {
  const dir = argvJsonDir(appName);
  let argvJson: string | null = null;
  if (dir !== null && process.platform === 'linux') {
    try {
      argvJson = readFileSync(path.join(os.homedir(), dir, 'argv.json'), 'utf8');
    } catch {
      argvJson = null;
    }
  }
  return keyringLikelyMissing({ platform: process.platform, env: process.env, argvJson });
}

export async function warnIfKeyringMissing(deps: {
  missing: () => boolean;
  memento: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
  };
  warn: (message: string) => void;
}): Promise<void> {
  if (deps.memento.get<boolean>(KEYRING_WARNED_KEY) === true) return;
  if (!deps.missing()) return;
  await deps.memento.update(KEYRING_WARNED_KEY, true);
  deps.warn(COPY.keyringMissing);
}
