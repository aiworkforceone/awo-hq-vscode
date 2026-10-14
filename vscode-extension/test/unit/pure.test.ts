/**
 * The extension's pure pieces: the copy rules (U29), the host allow-list (decision 26, U25), the
 * tree labels (D3/U4), the status lines a terminal prints, and the manifest's posture (D15).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RemoteOrg, RemoteSessionSummary } from '@kpa/shared/remote.types';
import { withTeamAliases } from '@hq/client/teams.js';
import { COPY } from '../../src/copy.js';
import { isOnHost, normalizeHqHost, resolveHqHost } from '../../src/hq/hosts.js';
import {
  sessionContextValue,
  sessionDescription,
  teamContextValue,
  teamDescription,
  webUrl,
} from '../../src/tree/labels.js';
import { statusLine, terminalName } from '../../src/terminal/hq-pty.js';
import { cleanLabel } from '../../src/util/text.js';
import { deviceLabelFor } from '../../src/auth/device-flow.js';
import { argvJsonDir, keyringLikelyMissing, warnIfKeyringMissing } from '../../src/auth/keyring.js';

/** Every sentence COPY can produce, functions called with sample arguments. */
function allCopy(): string[] {
  const out: string[] = [];
  for (const v of Object.values(COPY)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') {
      const fn = v as (...a: unknown[]) => unknown;
      const sample = Array.from({ length: fn.length }, (_, i) => (i === 0 ? 'Backend team' : 3000));
      const r = fn(...sample);
      if (typeof r === 'string') out.push(r);
    }
  }
  // Every refusal sentence of the terminal.
  for (const s of [0, 401, 403, 404, 426, 500]) out.push(COPY.terminalRefused(s));
  return out;
}

describe('copy (U29)', () => {
  it('never says "asleep" and never uses an em dash', () => {
    const all = allCopy();
    expect(all.length).toBeGreaterThan(50);
    for (const s of all) {
      expect(s, s).not.toMatch(/asleep/i);
      expect(s, s).not.toMatch(/—/);
    }
  });
});

describe('hosts (decision 26)', () => {
  it('accepts the two built-in HQ addresses and nothing else by default', () => {
    expect(resolveHqHost(undefined, [])).toEqual({
      ok: true,
      host: 'https://hq.aiworkforceone.com',
    });
    expect(resolveHqHost('https://hq-test.aiworkforceone.com/', [])).toEqual({
      ok: true,
      host: 'https://hq-test.aiworkforceone.com',
    });
    expect(resolveHqHost('https://evil.example', [])).toMatchObject({ ok: false });
    expect(resolveHqHost('http://hq.aiworkforceone.com', [])).toMatchObject({ ok: false });
    expect(resolveHqHost('https://hq.aiworkforceone.com/api', [])).toMatchObject({ ok: false });
  });

  it('an extra address counts only when the person listed it; loopback only then', () => {
    expect(resolveHqHost('https://staging.example', ['https://staging.example'])).toMatchObject({
      ok: true,
    });
    expect(resolveHqHost('http://localhost:3000', [])).toMatchObject({ ok: false });
    expect(resolveHqHost('http://localhost:3000', ['http://localhost:3000'])).toMatchObject({
      ok: true,
    });
    expect(normalizeHqHost('HTTPS://HQ.AIWORKFORCEONE.COM/')).toBe('https://hq.aiworkforceone.com');
  });

  it('opens a URL only on the signed-in address', () => {
    expect(isOnHost('https://hq.aiworkforceone.com/device', 'https://hq.aiworkforceone.com')).toBe(
      true,
    );
    expect(isOnHost('https://evil.example/device', 'https://hq.aiworkforceone.com')).toBe(false);
    expect(isOnHost('javascript:alert(1)', 'https://hq.aiworkforceone.com')).toBe(false);
  });
});

const ORGS: RemoteOrg[] = [
  {
    id: 'o1',
    slug: 'awo',
    name: 'AI Workforce One',
    role: 'member',
    remoteAccess: { allowed: true },
    workspaces: [
      {
        id: '3f9a1c2e-1111-4222-8333-444455556666',
        alias: 'hq-3f9a1c2e',
        name: 'Backend team',
        state: 'running',
        rights: { forward: true, attach: true },
        supported: true,
      },
      {
        id: '4a9a1c2e-1111-4222-8333-444455556666',
        alias: 'hq-4a9a1c2e',
        name: 'Marketing team',
        state: 'asleep',
        rights: { forward: false, attach: true },
        supported: false,
      },
    ],
  },
];

describe('tree labels (D3, U4)', () => {
  const [backend, marketing] = withTeamAliases(ORGS);
  it('running and write-capable; off, update needed and view only', () => {
    expect(teamDescription(backend!)).toBe('running');
    expect(teamContextValue(backend!)).toBe('team:running:write');
    expect(teamDescription(marketing!)).toBe('off · update needed · view only');
    expect(teamContextValue(marketing!)).toBe('team:off:read');
  });

  it('update needed when the machine cannot serve forward OR files; absent from an older HQ is fine', () => {
    const team = (ws: Partial<RemoteOrg['workspaces'][number]>) =>
      withTeamAliases([{ ...ORGS[0]!, workspaces: [{ ...ORGS[0]!.workspaces[0]!, ...ws }] }])[0]!;
    expect(teamDescription(team({ supported: true, filesSupported: true }))).toBe('running');
    expect(teamDescription(team({ supported: true }))).toBe('running');
    expect(teamDescription(team({ supported: true, filesSupported: false }))).toBe(
      'running · update needed',
    );
    expect(teamDescription(team({ supported: false, filesSupported: true }))).toBe(
      'running · update needed',
    );
  });

  it('sessions: "you" on your own, the owner and "view only" otherwise, the engine when Codex', () => {
    const mine: RemoteSessionSummary = {
      id: 's1',
      name: 'fix login bug',
      ownerName: 'Jean',
      status: 'running',
      canType: true,
      ownerIsMe: true,
      engine: 'claude',
    };
    const theirs: RemoteSessionSummary = {
      ...mine,
      id: 's2',
      ownerName: 'Maya\u202e',
      canType: false,
      ownerIsMe: false,
      engine: 'codex',
      canOperate: false,
    };
    expect(sessionDescription(mine)).toBe('you');
    expect(sessionContextValue(mine)).toBe('session:type:running:op');
    expect(sessionDescription(theirs)).toBe('Maya · view only · Codex');
    expect(sessionContextValue(theirs)).toBe('session:view:running:noop');
  });

  it('train 98 e2e: a session HQ is still starting reads "starting", never running; an older HQ reads as before', () => {
    const base: RemoteSessionSummary = {
      id: 's1',
      name: 'fix login bug',
      ownerName: 'Jean',
      status: 'running',
      canType: true,
      ownerIsMe: true,
      canOperate: true,
    };
    expect(sessionDescription({ ...base, starting: true })).toBe('you · starting');
    expect(sessionDescription({ ...base, canType: false, starting: true, engine: 'codex' })).toBe(
      'you · starting · view only · Codex',
    );
    // An older HQ never sends the field: the row is what it was.
    expect(sessionDescription(base)).toBe('you');
    // HQ keeps `status: 'running'` while starting, so Stop and Restart stay on the row (HQ decides).
    expect(sessionContextValue({ ...base, starting: true })).toBe('session:type:running:op');
  });

  it('cli-session-lifecycle: the session contextValue carries its state and whether you may operate it', () => {
    const base: RemoteSessionSummary = {
      id: 's1',
      name: 'n',
      ownerName: 'Jean',
      status: 'stopped',
      canType: true,
      canOperate: true,
    };
    expect(sessionContextValue(base)).toBe('session:type:stopped:op');
    expect(sessionContextValue({ ...base, status: 'idle' })).toBe('session:type:idle:op');
    // An older HQ does not say: offer the actions and let HQ answer.
    const { canOperate: _omitted, ...older } = base;
    expect(sessionContextValue(older)).toBe('session:type:stopped:op');
    expect(sessionContextValue({ ...base, canType: false, canOperate: false })).toBe(
      'session:view:stopped:noop',
    );
  });

  it('cli-session-lifecycle: package.json shows Start only on a stopped session, Stop and Restart only on a live one, and none without operate', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      contributes: {
        commands: Array<{ command: string; icon?: string }>;
        menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
      };
    };
    const ids = ['hq.startSession', 'hq.stopSession', 'hq.restartSession'];
    for (const id of ids) {
      expect(pkg.contributes.commands.find((c) => c.command === id)?.icon, id).toBeDefined();
      // Tree-only: each needs the row it acts on.
      expect(pkg.contributes.menus.commandPalette!.find((m) => m.command === id)?.when, id).toBe(
        'false',
      );
    }
    const whenOf = (id: string, inline: boolean) =>
      pkg.contributes.menus['view/item/context']!.filter(
        (m) => m.command === id && (m.group === 'inline') === inline,
      ).map((m) => m.when!);
    const shown = (id: string, ctx: string) =>
      [true, false].map((inline) =>
        whenOf(id, inline).some((w) => {
          const re = /viewItem =~ \/(.+)\/$/.exec(w)![1]!;
          return w.startsWith('view == hq.teams && ') && new RegExp(re).test(ctx);
        }),
      );
    // Inline AND in the context menu, both by the same rule.
    expect(shown('hq.startSession', 'session:type:stopped:op')).toEqual([true, true]);
    expect(shown('hq.startSession', 'session:type:running:op')).toEqual([false, false]);
    expect(shown('hq.startSession', 'session:view:stopped:noop')).toEqual([false, false]);
    for (const id of ['hq.stopSession', 'hq.restartSession']) {
      expect(shown(id, 'session:type:running:op'), id).toEqual([true, true]);
      expect(shown(id, 'session:view:idle:op'), id).toEqual([true, true]);
      expect(shown(id, 'session:type:stopped:op'), id).toEqual([false, false]);
      expect(shown(id, 'session:view:running:noop'), id).toEqual([false, false]);
    }
  });

  it('web links go to the HQ page of the team or the session', () => {
    expect(webUrl('https://hq.aiworkforceone.com', { workspaceId: 'w1' })).toBe(
      'https://hq.aiworkforceone.com/workspaces/w1',
    );
    expect(webUrl('https://hq.aiworkforceone.com', { workspaceId: 'w1', sessionId: 's1' })).toBe(
      'https://hq.aiworkforceone.com/sessions/s1',
    );
  });

  it('server strings lose controls, bidi and zero-width characters (VS-18)', () => {
    expect(cleanLabel('Evil\x1b[31m team\u202e\u200b\nname')).toBe('Evil [31m team name');
    expect(cleanLabel(42)).toBe('');
    expect(cleanLabel('x'.repeat(500)).length).toBe(200);
  });
});

describe('terminal names and status lines (D4)', () => {
  const [backend] = withTeamAliases(ORGS);
  const target = {
    team: backend!,
    session: {
      id: 's1',
      name: 'fix login bug',
      ownerName: 'Jean',
      status: 'running' as const,
      canType: true,
    },
  };
  it('names the tab HQ · team · session, with the view-only / waking / stopped suffix', () => {
    expect(terminalName(target, { canType: true })).toBe('HQ · Backend team · fix login bug');
    expect(terminalName(target, { canType: false })).toBe(
      'HQ · Backend team · fix login bug · view only',
    );
    expect(terminalName(target, { canType: true, waking: true })).toBe(
      'HQ · Backend team · fix login bug · waking',
    );
    expect(terminalName(target, { canType: true, stopped: true })).toBe(
      'HQ · Backend team · fix login bug · stopped',
    );
  });

  it('a status line is dim, on its own lines, and cannot carry an escape sequence', () => {
    expect(statusLine('\r\nBackend team is off.\r\nPress any key to wake it.')).toBe(
      '\r\n\x1b[2mBackend team is off.\r\nPress any key to wake it.\x1b[0m\r\n',
    );
    expect(statusLine('evil \x1b]52;c;AAAA\x07 line')).toBe(
      '\r\n\x1b[2mevil ]52;c;AAAA line\x1b[0m\r\n',
    );
    expect(statusLine('\r\n')).toBe('');
  });
});

describe('device label (D1: "HQ for VS Code (Cursor)" on /device)', () => {
  it('names the editor and the computer, cleaned and capped at 64', () => {
    expect(deviceLabelFor('Cursor', 'jeans-mbp')).toBe('Cursor on jeans-mbp');
    expect(deviceLabelFor('', '')).toBe('VS Code on this computer');
    expect(deviceLabelFor('Visual Studio Code', 'x'.repeat(100)).length).toBe(64);
    expect(deviceLabelFor('Evil\x1b[2J', 'mbp')).toBe('Evil[2J on mbp');
  });
});

describe('manifest posture (D15)', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as {
    extensionKind: string[];
    browser?: string;
    main: string;
    engines: { vscode: string };
    activationEvents: string[];
    contributes: {
      configuration: { properties: Record<string, { scope?: string }> };
      authentication: Array<{ id: string }>;
      [k: string]: unknown;
    };
  };

  it('runs on the local UI host only, never in a browser host, with a Node 20 floor', () => {
    expect(pkg.extensionKind).toEqual(['ui']);
    expect(pkg.browser).toBeUndefined();
    expect(pkg.main).toBe('./dist/extension.cjs');
    expect(pkg.engines.vscode).toBe('^1.90.0');
  });

  it('host settings are application-scoped: a workspace file can never redirect tokens', () => {
    const props = pkg.contributes.configuration.properties;
    expect(props['hq.host']?.scope).toBe('application');
    expect(props['hq.allowedHosts']?.scope).toBe('application');
    expect(props['hq.localEcho']?.scope).toBe('application');
  });

  it('no webview, no task/debug/terminal-link provider, no `*` activation', () => {
    const contributes = JSON.stringify(pkg.contributes);
    expect(contributes).not.toMatch(/webview|taskDefinitions|debuggers|terminal\.link/i);
    expect(pkg.activationEvents).not.toContain('*');
    expect(pkg.activationEvents).not.toContain('onStartupFinished');
    expect(pkg.contributes.authentication).toEqual([
      { id: 'aiworkforceone-hq', label: 'AI Workforce One HQ' },
    ]);
  });
});

describe('keyring warning on Linux (security notes, branch review SHOULD)', () => {
  const linuxWithBus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };

  it('says the keychain is missing only on Linux, with no session bus or a basic password store', () => {
    expect(keyringLikelyMissing({ platform: 'darwin', env: {}, argvJson: null })).toBe(false);
    expect(keyringLikelyMissing({ platform: 'win32', env: {}, argvJson: null })).toBe(false);
    expect(keyringLikelyMissing({ platform: 'linux', env: linuxWithBus, argvJson: null })).toBe(
      false,
    );
    // No D-Bus session: no Secret Service can answer.
    expect(keyringLikelyMissing({ platform: 'linux', env: {}, argvJson: null })).toBe(true);
    // The editor was told to use its basic (weak) store (argv.json is JSON with comments).
    expect(
      keyringLikelyMissing({
        platform: 'linux',
        env: linuxWithBus,
        argvJson: '{\n  // keyring off\n  "password-store": "basic"\n}',
      }),
    ).toBe(true);
    expect(
      keyringLikelyMissing({
        platform: 'linux',
        env: linuxWithBus,
        argvJson: '{ "password-store": "gnome-libsecret" }',
      }),
    ).toBe(false);
  });

  it('warns ONCE per install, in the copy the design names', async () => {
    const shown: string[] = [];
    const state = new Map<string, unknown>();
    const deps = {
      missing: () => true,
      memento: {
        get: <T>(k: string) => state.get(k) as T | undefined,
        update: async (k: string, v: unknown) => void state.set(k, v),
      },
      warn: (m: string) => void shown.push(m),
    };
    await warnIfKeyringMissing(deps);
    await warnIfKeyringMissing(deps);
    expect(shown).toEqual([COPY.keyringMissing]);
    await warnIfKeyringMissing({
      ...deps,
      missing: () => false,
      memento: { ...deps.memento, get: () => undefined },
    });
    expect(shown).toHaveLength(1);
  });

  it('argv.json is looked up per editor', () => {
    expect(argvJsonDir('Visual Studio Code')).toBe('.vscode');
    expect(argvJsonDir('Cursor')).toBe('.cursor');
    expect(argvJsonDir('VSCodium')).toBe('.vscode-oss');
    expect(argvJsonDir('Windsurf')).toBe('.windsurf');
    expect(argvJsonDir('Something Else')).toBeNull();
  });
});

describe('0.2.2: the masked-file notice says why, and what to do', () => {
  it('one secret named: its name, and $NAME as the way to read it', () => {
    expect(COPY.fsMaskedFile('.env', ['STRIPE_KEY'])).toBe(
      ".env contains the value of a secret (STRIPE_KEY), so it's shown masked and read-only. Edit it in the terminal, or read the secret from $STRIPE_KEY instead of keeping its value in the file.",
    );
  });
  it('several: all of their names', () => {
    expect(COPY.fsMaskedFile('a.yml', ['A_KEY', 'B_KEY'])).toBe(
      "a.yml contains the values of secrets (A_KEY, B_KEY), so it's shown masked and read-only. Edit it in the terminal, or read the secrets from $A_KEY and $B_KEY instead of keeping their values in the file.",
    );
  });
  it('no names from HQ: "a secret"', () => {
    expect(COPY.fsMaskedFile('cfg.txt', [])).toBe(
      "cfg.txt contains the value of a secret, so it's shown masked and read-only. Edit it in the terminal, or read the secret from its environment variable instead of keeping its value in the file.",
    );
  });
});
