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

export type DeviceFlowResult =
  | { kind: 'approved'; approved: Extract<DevicePollResponse, { status: 'approved' }> }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'unavailable' }
  | { kind: 'too-old' }
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
  if (start.status !== 200) {
    return { kind: 'failed', detail: start.body?.error ?? `HTTP ${start.status}` };
  }
  const s = start.body;
  const pageUrl = isOnHost(s.verificationUrl, deps.host)
    ? s.verificationUrl
    : `${deps.host}/device`;
  await deps.onCode(s.userCode, pageUrl);

  let interval = Math.max(5, s.interval);
  const deadline = deps.now() + s.expiresIn * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval * 1000);
    if (deps.cancelled()) return { kind: 'cancelled' };
    const poll = await postJson<DevicePollResponse & { error?: string; code?: string }>(
      deps.fetch,
      `${deps.host}/api/remote/device/poll`,
      { deviceCode: s.deviceCode },
      deps.clientHeaders,
    );
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
