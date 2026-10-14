/**
 * Which HQ this editor talks to (decision 26). `hq.host` and `hq.allowedHosts` are APPLICATION-scoped
 * settings, so a `.vscode/settings.json` inside a team folder can never set them (VS Code ignores an
 * application setting at workspace scope), and the value is re-checked here at every use anyway: a
 * token is only ever sent to an address on the built-in list or one the person added themselves.
 *
 * The built-in list is the build's brand (`shared/src/dev-brands/`). AWO: its two exact hosts,
 * `hq.aiworkforceone.com` by default. A brand may instead have NO default (every customer has their
 * own address) and trust one label under its own domains; a custom domain works once the person
 * adds it to `allowedHosts`.
 *
 * Pure (no `vscode` import), so the unit tier covers it.
 */
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';
import { isBuiltInHost, type DevBrand } from '@kpa/shared/dev-brand-core';

/** The brand's default address, or `''` when it has none. */
export const DEFAULT_HOST: string = ACTIVE_DEV_BRAND.defaultHost ?? '';
/** The exact built-in addresses (AWO's two; none for a brand whose hosts are a pattern). */
export const BUILT_IN_HOSTS: readonly string[] = ACTIVE_DEV_BRAND.builtInHosts;

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

/** `unset`: no address is configured and the brand has no default (before setup). */
export type HostVerdict = { ok: true; host: string } | { ok: false; host: string; unset?: true };

/** The configured host, if it is allowed. */
export function resolveHqHost(
  configured: unknown,
  allowedExtra: unknown,
  brand: DevBrand = ACTIVE_DEV_BRAND,
): HostVerdict {
  const raw =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured
      : (brand.defaultHost ?? '');
  if (raw === '') return { ok: false, host: '', unset: true };
  const host = normalizeHqHost(raw);
  if (host === null) return { ok: false, host: String(raw) };
  const extra = Array.isArray(allowedExtra)
    ? allowedExtra.map(normalizeHqHost).filter((h): h is string => h !== null)
    : [];
  if (LOOPBACK.test(host) && !extra.includes(host)) return { ok: false, host };
  return isBuiltInHost(brand, host) || extra.includes(host)
    ? { ok: true, host }
    : { ok: false, host };
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
