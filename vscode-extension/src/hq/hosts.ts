/**
 * Which HQ this editor talks to (decision 26). `hq.host` and `hq.allowedHosts` are APPLICATION-scoped
 * settings, so a `.vscode/settings.json` inside a team folder can never set them (VS Code ignores an
 * application setting at workspace scope), and the value is re-checked here at every use anyway: a
 * token is only ever sent to an address on the built-in list or one the person added themselves.
 *
 * Pure (no `vscode` import), so the unit tier covers it.
 */

export const DEFAULT_HOST = 'https://hq.aiworkforceone.com';
export const BUILT_IN_HOSTS: readonly string[] = [
  DEFAULT_HOST,
  'https://hq-test.aiworkforceone.com',
];

/** Loopback may use plain http, and only when listed explicitly (a local HQ during development). */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const HTTPS = /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/;

/** `https://host[:port]`, lowercased, no path and no trailing slash; null when it is not one. */
export function normalizeHqHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/\/+$/, '').toLowerCase();
  if (HTTPS.test(v) || LOOPBACK.test(v)) return v;
  return null;
}

export type HostVerdict = { ok: true; host: string } | { ok: false; host: string };

/** The configured host, if it is allowed. */
export function resolveHqHost(configured: unknown, allowedExtra: unknown): HostVerdict {
  const raw =
    typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_HOST;
  const host = normalizeHqHost(raw);
  if (host === null) return { ok: false, host: String(raw) };
  const extra = Array.isArray(allowedExtra)
    ? allowedExtra.map(normalizeHqHost).filter((h): h is string => h !== null)
    : [];
  const allowed = new Set([...BUILT_IN_HOSTS, ...extra]);
  if (LOOPBACK.test(host) && !extra.includes(host)) return { ok: false, host };
  return allowed.has(host) ? { ok: true, host } : { ok: false, host };
}

/** Is `url` a plain http(s) URL on exactly this HQ address (the only kind the extension opens)? */
export function isOnHost(url: string, host: string): boolean {
  let u: URL;
  let h: URL;
  try {
    u = new URL(url);
    h = new URL(host);
  } catch {
    return false;
  }
  return u.origin === h.origin && (u.protocol === 'https:' || u.protocol === 'http:');
}
