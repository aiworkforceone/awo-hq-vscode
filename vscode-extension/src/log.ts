/**
 * The extension's own log, shown in the Output panel as "AI Workforce One HQ" (a `LogOutputChannel`
 * since 0.2.0). It records the account and sign-in lifecycle: accounts appearing, going, renewed,
 * the window's active account, slot health, sign-in intents and outcomes, revocations, sign-outs.
 *
 * ⛔ NEVER a token, a refresh token, a key, a device code, a nonce, a signature or file contents.
 *    Accounts are named by their TAG (a selector, not a credential), never their email beside
 *    anything token-shaped (hq-vscode §4.9, multi-account §8). Every line also passes `redact`, so
 *    a server sentence that happened to carry a token-shaped string is masked before it is written.
 *
 * No `vscode` import: the extension hands in the channel; the unit tier hands in an array.
 */
import os from 'node:os';

export interface HqLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLog: HqLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const TOKEN = /\bhq[arsc]_[A-Za-z0-9_-]+/g;
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const KEY_BODY = /b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*/g; // base64 of "openssh-key-v1"
const BEARER = /\b(Bearer)\s+\S+/gi;
const USER_CODE = /\b[A-Z]{4}-[A-Z]{4}\b/g;
const NONCE = /\bn_[A-Za-z0-9_-]{20,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Any long opaque run: a raw device code, a signature, a key or token of a shape not known above. */
const OPAQUE = /[A-Za-z0-9_+/=-]{32,}/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mask anything token-, key-, code-, nonce- or email-shaped in one line; the home folder is `~`. */
export function redact(line: string): string {
  const home = os.homedir();
  const homed = home.length > 1 ? line.replace(new RegExp(escapeRe(home), 'g'), '~') : line;
  return homed
    .replace(KEY_BLOCK, '[key]')
    .replace(KEY_BODY, '[key]')
    .replace(TOKEN, '[token]')
    .replace(BEARER, '$1 [token]')
    .replace(USER_CODE, '[code]')
    .replace(NONCE, '[nonce]')
    .replace(EMAIL, '[email]')
    .replace(OPAQUE, '[redacted]');
}

/** A channel whose every line is redacted first. */
export function redactingLog(sink: HqLog): HqLog {
  return {
    info: (m) => sink.info(redact(m)),
    warn: (m) => sink.warn(redact(m)),
    error: (m) => sink.error(redact(m)),
  };
}

/** An error as one short, safe line: its kind and sentence (never a stack, never a cause). */
export function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
