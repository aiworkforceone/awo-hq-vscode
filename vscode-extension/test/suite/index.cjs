// Runs INSIDE a real VS Code (test/run-integration.mjs). No test framework on purpose: each case is
// an async function, a failure throws, and `run` rejects so the harness exits non-zero.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'aiworkforceone.awo-hq';

const cases = {
  async 'activates when the HQ sidebar is opened, and registers every command'() {
    await vscode.commands.executeCommand('workbench.view.extension.hq');
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'the extension is installed');
    await ext.activate();
    assert.equal(ext.isActive, true);
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'hq.signIn',
      'hq.signOut',
      'hq.refresh',
      'hq.wakeTeam',
      'hq.newSessionTerminal',
      'hq.attachSession',
      'hq.openInHqWeb',
      'hq.forwardPort',
      'hq.ports.stop',
      'hq.openTeamFiles',
      'hq.searchTeamFiles',
      // hq-vscode-multi-account (0.2.0)
      'hq.addAccount',
      'hq.switchAccount',
      'hq.signOutAccount',
      'hq.renewAccount',
      'hq.signInAs',
      'hq.accounts.primaryAction',
      // hq-vscode-image-paste (0.2.2)
      'hq.terminalPaste',
    ]) {
      assert.ok(all.includes(id), `${id} is registered`);
    }
  },

  async "image paste: the keys are bound only in an HQ terminal, and anywhere else the paste is VS Code's own"() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const keys = ext.packageJSON.contributes.keybindings.filter(
      (k) => k.command === 'hq.terminalPaste',
    );
    assert.equal(keys.length, 2);
    for (const k of keys) assert.match(k.when, /terminalFocus && hq\.activeTerminal/);
    assert.deepEqual(
      keys.map((k) => [k.key, k.mac, k.linux, k.args.fallback]),
      [
        ['ctrl+v', 'cmd+v', 'ctrl+shift+v', 'paste'],
        ['ctrl+v', undefined, undefined, 'ctrlV'],
      ],
    );
    assert.match(keys[1].when, /^isLinux && /);
    // A terminal that is not an HQ one: the command is VS Code's terminal paste, bracketed paste and all.
    const typed = [];
    const write = new vscode.EventEmitter();
    const pty = {
      onDidWrite: write.event,
      open: () => write.fire('$ '),
      close: () => undefined,
      handleInput: (d) => typed.push(d),
    };
    const t = vscode.window.createTerminal({ name: 'not HQ', pty });
    t.show();
    await new Promise((r) => setTimeout(r, 500));
    await vscode.env.clipboard.writeText('plain text');
    await vscode.commands.executeCommand('hq.terminalPaste', { fallback: 'paste' });
    const end = Date.now() + 5000;
    while (!typed.join('').includes('plain text') && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
    }
    t.dispose();
    assert.ok(typed.join('').includes('plain text'), `pasted: ${JSON.stringify(typed)}`);
  },

  async 'runs on the local UI host (extensionKind ui, D15)'() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.equal(ext.extensionKind, vscode.ExtensionKind.UI);
  },

  async 'signed out: the Accounts provider has no session and hands out no token (decision 3)'() {
    const session = await vscode.authentication.getSession('aiworkforceone-hq', [], {
      createIfNone: false,
      silent: true,
    });
    assert.equal(session, undefined);
  },

  async 'hq.host is application-scoped: a workspace cannot set it (decision 26, U25)'() {
    const config = vscode.workspace.getConfiguration('hq');
    const inspected = config.inspect('host');
    assert.equal(inspected.defaultValue, 'https://hq.aiworkforceone.com');
    let refused = false;
    try {
      await config.update('host', 'https://evil.example', vscode.ConfigurationTarget.Workspace);
    } catch {
      refused = true;
    }
    assert.ok(refused, 'writing an application setting at workspace scope is refused');
    assert.equal(config.inspect('host').workspaceValue, undefined);
  },

  async 'hq:// is a writable, case-sensitive file system that answers Unavailable while signed out (D7)'() {
    assert.equal(vscode.workspace.fs.isWritableFileSystem('hq'), true);
    const uri = vscode.Uri.parse('hq://awo/hq-3f9a1c2e/src/app.py');
    let code;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (err) {
      code = err && err.code;
    }
    // Not FileNotFound: nothing is known about the team until someone signs in, and no request left.
    assert.equal(code, 'Unavailable');
  },

  async 'a tagged hq:// folder of an account not signed in fails closed (D3, MA-S10, MA-S11)'() {
    // A well-formed tag of nobody signed in here, and malformed authorities: all Unavailable, never
    // another account's folder.
    for (const authority of [
      'a0123456789ab@awo',
      'A0123456789AB@awo',
      'a0123456789ab@awo:443',
      'x@y@awo',
    ]) {
      let code;
      try {
        await vscode.workspace.fs.stat(
          vscode.Uri.parse(`hq://${authority}/hq-3f9a1c2e/src/app.py`),
        );
      } catch (err) {
        code = err && err.code;
      }
      assert.equal(code, 'Unavailable', authority);
    }
  },

  async 'more than one account: the Accounts provider lists none while signed out, and its sessions are not credentials'() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const auth = ext.packageJSON.contributes.authentication;
    assert.deepEqual(auth, [{ id: 'aiworkforceone-hq', label: 'AI Workforce One HQ' }]);
    const session = await vscode.authentication.getSession('aiworkforceone-hq', [], {
      createIfNone: false,
      silent: true,
    });
    assert.equal(session, undefined);
  },

  async 'the extension reports 0.2.2'() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.equal(ext.packageJSON.version, '0.2.2');
  },

  async 'a host outside the allow-list is never signed in to'() {
    const config = vscode.workspace.getConfiguration('hq');
    await config.update('host', 'https://evil.example', vscode.ConfigurationTarget.Global);
    try {
      // Returns without any network request: the service refuses the host first.
      const result = await vscode.commands.executeCommand('hq.signIn');
      assert.equal(result, 'host-not-allowed');
    } finally {
      await config.update('host', undefined, vscode.ConfigurationTarget.Global);
    }
  },
};

async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(cases)) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.log(`  FAIL ${name}: ${err && err.message}`);
      failures.push(name);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} integration case(s) failed`);
}

module.exports = { run };
