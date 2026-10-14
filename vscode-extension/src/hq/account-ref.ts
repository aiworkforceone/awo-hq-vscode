/**
 * Which HQ account a thing belongs to (hq-vscode-multi-account, decisions 2, 5, 9, 21, 22). Pure, no
 * `vscode` import: the unit tier pins every rule here.
 *
 *   slot      where an account's secrets and caches live. `legacy` is the 0.1.x prefix
 *             `hq:<host>:`, byte-identical to 0.1.1 and never created or rewritten by 0.2.0;
 *             `user` is `hq:<host>:u:<profileKey>:<userId>:`, one per (VS Code profile, HQ user).
 *   tag       `a` + 12 hex of sha256(host|userId): the userinfo of an `hq://` authority. A selector
 *             among accounts already signed in here, never a credential.
 *   locks     one refresh lock per slot. The legacy name is 0.1.1's exactly (golden test MA-S6): a
 *             "harmless" rename would split one token family across two locks, and reuse detection
 *             then revokes the grant.
 */
import { createHash, randomBytes } from 'node:crypto';
// The real org-slug rule, imported, never copied (`hq-client/src/safe-text.ts`, used by teams.ts).
import { ORG_SLUG_RE } from '@hq/client/safe-text.js';
import { KEY_NS } from '../brand-keys.js';

export interface AccountRef {
  host: string;
  userId: string;
  slot: 'legacy' | 'user';
  /** Decision 22; set for every ref built in this window (the legacy slot ignores it). */
  profileKey: string;
}

export const PROFILE_KEY_RE = /^p[0-9a-f]{8}$/;

/** Decision 22: a NEW random profile key. Only the sign-in flow mints one, under the sign-in lock. */
export function newProfileKey(): string {
  return `p${randomBytes(4).toString('hex')}`;
}

export const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_RE = /^a[0-9a-f]{12}$/;
const SLUG_BODY = ORG_SLUG_RE.source.replace(/^\^|\$$/g, '');
const AUTHORITY_TAGGED = new RegExp(`^(a[0-9a-f]{12})@(${SLUG_BODY})$`);
const AUTHORITY_LEGACY = new RegExp(`^(${SLUG_BODY})$`);

export function accountTag(host: string, userId: string): string {
  return `a${createHash('sha256').update(`${host}|${userId}`).digest('hex').slice(0, 12)}`;
}

/** `hq:<host>:` for the 0.1.x slot (byte-identical to 0.1.1), `hq:<host>:u:<profileKey>:<userId>:` otherwise. */
export function slotPrefix(ref: AccountRef): string {
  if (ref.slot === 'legacy') return `${KEY_NS}:${ref.host}:`;
  if (!USER_ID_RE.test(ref.userId) || !PROFILE_KEY_RE.test(ref.profileKey)) {
    throw new Error('bad slot');
  }
  return `${KEY_NS}:${ref.host}:u:${ref.profileKey}:${ref.userId}:`;
}

/** The legacy sign-in lock and refresh lock names, exactly as 0.1.1 builds them. */
export function legacyLockName(
  purpose: 'refresh' | 'signin',
  appName: string,
  host: string,
): string {
  return `${purpose}-${createHash('sha256').update(`${appName}|${host}`).digest('hex').slice(0, 12)}.lock`;
}

/** One refresh lock per slot. The legacy one MUST equal 0.1.1's `lockName('refresh', host)`. */
export function refreshLockName(appName: string, ref: AccountRef): string {
  if (ref.slot === 'legacy') return legacyLockName('refresh', appName, ref.host);
  const seed = `${appName}|${ref.host}|${ref.profileKey}|${ref.userId}`;
  return `refresh-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}.lock`;
}

export type ParsedAuthority =
  | { kind: 'tagged'; tag: string; orgSlug: string }
  | { kind: 'legacy'; orgSlug: string }
  | { kind: 'invalid' };

/** Strict: uppercase, a port, a second `@`, escapes or a wrong-length tag are all `invalid` (fail closed). */
export function parseHqAuthority(authority: string): ParsedAuthority {
  const t = AUTHORITY_TAGGED.exec(authority);
  if (t) return { kind: 'tagged', tag: t[1]!, orgSlug: t[2]! };
  const l = AUTHORITY_LEGACY.exec(authority);
  if (l) return { kind: 'legacy', orgSlug: l[1]! };
  return { kind: 'invalid' };
}

export const isTag = (s: unknown): s is string => typeof s === 'string' && TAG_RE.test(s);

/** Two refs name the same account when host and user match (the slot can move: decision 3). */
export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.host === b.host && a.userId === b.userId;
}

/**
 * Decision 21: `owner@client.com` → `owner@client`, `a@agency.co.uk` → `a@agency`. Two signed-in
 * accounts that would read the same use their full emails instead.
 */
export function shortAccountLabel(email: string, allEmails: readonly string[]): string {
  const short = (e: string): string => {
    const at = e.lastIndexOf('@');
    if (at <= 0) return e;
    const domain = e.slice(at + 1).split('.')[0] ?? '';
    return domain ? `${e.slice(0, at)}@${domain}` : e;
  };
  const mine = short(email);
  const clash = allEmails.some((other) => other !== email && short(other) === mine);
  return clash ? email : mine;
}
