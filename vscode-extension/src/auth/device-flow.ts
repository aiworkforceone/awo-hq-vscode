/**
 * "HQ: Sign In" (D1): the same RFC 8628 device flow as `hq login`, asking for the extension's OWN
 * grant (`clientName: 'hq-vscode'`, decision 2) with its own ed25519 key.
 *
 * ⛔ THE CODE IS TYPED, NEVER PREFILLED (T2). The browser is sent to `/device` itself, never to
 *    `verificationUrlComplete`: the person reads the code in the editor and types it on the page.
 *    The page URL is opened only when it is on the signed-in HQ address.
 *
 * Pure over injected collaborators (no `vscode` import), so the unit tier walks every answer.
 */
import type { DevicePollResponse, DeviceStartResponse } from '@kpa/shared/remote.types';
import { postJson, type FetchLike } from '@hq/client/api.js';
import { COPY } from '../copy.js';
import { isOnHost } from '../hq/hosts.js';

export interface DeviceFlowDeps {
  fetch: FetchLike;
  host: string;
  clientHeaders: Record<string, string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The code is ready: show it, copy it, open `pageUrl`. */
  onCode: (userCode: string, pageUrl: string) => void | Promise<void>;
  /** The person cancelled (checked before every poll). */
  cancelled: () => boolean;
}

export interface DeviceFlowInput {
  clientVersion: string;
  platform: string;
  deviceLabel: string;
  devicePubkey: string;
}

/** `details.host` of a DEVICE_WRONG_HOST answer, when it is a plain https origin; else null. */
export function wrongHostOf(body: unknown): string | null {
  const host = (body as { details?: { host?: unknown } } | null)?.details?.host;
  if (typeof host !== 'string') return null;
  try {
    const u = new URL(host);
    return u.protocol === 'https:' && u.origin === host ? host : null;
  } catch {
    return null;
  }
}

export type DeviceFlowResult =
  | { kind: 'approved'; approved: Extract<DevicePollResponse, { status: 'approved' }> }
  | { kind: 'denied' }
  /** The client host rule: the approver's account signs in at `host`, not this one. */
  | { kind: 'wrong-host'; host: string }
  | { kind: 'expired' }
  /** The code expired right after a poll lost to the network: the approval may have happened. */
  | { kind: 'expired-after-network' }
  | { kind: 'unavailable' }
  | { kind: 'too-old' }
  /** Too many sign-ins pending from this network (HQ allows 5 per IP): wait a minute. */
  | { kind: 'throttled' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; detail: string };

/** A device label a person recognises on `/device`: `<editor> on <computer>`, at most 64 chars. */
export function deviceLabelFor(appName: string, hostname: string): string {
  const clean = (s: string) =>
    // eslint-disable-next-line no-control-regex -- the label is shown to an approver
    s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const label = `${clean(appName) || 'VS Code'} on ${clean(hostname) || 'this computer'}`;
  return label.slice(0, 64);
}

/** Polls in a row that may fail on the network before the sign-in ends (about 15 s at 5 s). */
export const POLL_NETWORK_RETRIES = 3;
const unreachable = COPY.unreachable;

export async function runDeviceFlow(
  deps: DeviceFlowDeps,
  input: DeviceFlowInput,
): Promise<DeviceFlowResult> {
  const start = await postJson<DeviceStartResponse & { error?: string; code?: string }>(
    deps.fetch,
    `${deps.host}/api/remote/device/start`,
    { clientName: 'hq-vscode', ...input },
    deps.clientHeaders,
  );
  if (start.status === 404) return { kind: 'unavailable' };
  if (start.status === 426) return { kind: 'too-old' };
  if (start.status === 429) return { kind: 'throttled' };
  if (start.status !== 200) {
    return { kind: 'failed', detail: start.body?.error ?? `HTTP ${start.status}` };
  }
  const s = start.body;
  const pageUrl = isOnHost(s.verificationUrl, deps.host)
    ? s.verificationUrl
    : `${deps.host}/device`;
  await deps.onCode(s.userCode, pageUrl);

  let interval = Math.max(5, s.interval);
  let networkFailures = 0;
  const deadline = deps.now() + s.expiresIn * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval * 1000);
    if (deps.cancelled()) return { kind: 'cancelled' };
    let poll: Awaited<
      ReturnType<typeof postJson<DevicePollResponse & { error?: string; code?: string }>>
    >;
    try {
      poll = await postJson<DevicePollResponse & { error?: string; code?: string }>(
        deps.fetch,
        `${deps.host}/api/remote/device/poll`,
        { deviceCode: s.deviceCode },
        deps.clientHeaders,
      );
      if (networkFailures > 0 && poll.status === 410) return { kind: 'expired-after-network' };
      networkFailures = 0;
    } catch {
      // A poll that never got an answer (a dropped kept-alive socket, a network blip) is asked
      // again at the next interval; only a run of them ends the sign-in, with the reason.
      networkFailures += 1;
      if (networkFailures >= POLL_NETWORK_RETRIES) return { kind: 'failed', detail: unreachable };
      continue;
    }
    if (poll.status === 200 && poll.body.status === 'approved') {
      return { kind: 'approved', approved: poll.body };
    }
    if (
      poll.status === 200 &&
      (poll.body.status === 'authorization_pending' || poll.body.status === 'slow_down')
    ) {
      interval = Math.max(interval, poll.body.interval);
      continue;
    }
    if (poll.status === 409 && poll.body?.code === 'DEVICE_WRONG_HOST') {
      const host = wrongHostOf(poll.body);
      if (host) return { kind: 'wrong-host', host };
    }
    if (poll.status === 403) return { kind: 'denied' };
    if (poll.status === 410) return { kind: 'expired' };
    if (poll.status === 426) return { kind: 'too-old' };
    if (poll.status === 429) {
      interval += 5;
      continue;
    }
    return { kind: 'failed', detail: poll.body?.error ?? `HTTP ${poll.status}` };
  }
  return { kind: 'expired' };
}
