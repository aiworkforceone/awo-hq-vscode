// hq-vscode-multi-account U23, in a REAL VS Code (test/run-integration.mjs, second run). The window
// opens on a team folder of account B, which is not signed in here. VS Code does not re-resolve a
// failed root or a failed editor on a `Changed` event (nonprod 2026-10-02: the root stayed "!" and
// the tab stayed on "could not be opened" until a manual Refresh), so the extension revives them
// when B becomes usable. And it must revive NOTHING else (review W1):
//   1. sign in as B: the "!" root lists and the failed tab shows the file, by themselves;
//   2. add A and open one of A's files; open B's README (loaded), edit and save it (it has undo
//      history); edit B's notes.md and leave it unsaved;
//   3. HQ revokes B; a B file opened now fails (an error tab);
//   4. sign in as B again: ONLY that failed tab reopens. The loaded README is the same document and
//      its undo still works; notes.md keeps its unsaved edits; A's tab is untouched.
//   5. live re-test #2 (round 3): the team goes off; a file opened now fails. Wake Team (the off
//      notice's link): HQ says running while the machine still boots (files refused a few seconds
//      more). The failed tab fills by itself once the team serves, with no Try Again.
// The fake HQ (two users, per-user grants, revocation) runs in this extension host.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const vscode = require('vscode');

const EXTENSION_ID = 'aiworkforceone.awo-hq';
const PORT = Number(process.env.HQ_FAKE_PORT);
const HOST = `http://127.0.0.1:${PORT}`;
const USER_B = { id: process.env.HQ_FAKE_USER, email: 'owner@client.test', name: 'Client Owner' };
const USER_A = { id: 'u-returns-a', email: 'a@agency.test', name: 'Agency' };
const tagOf = (userId) =>
  `a${createHash('sha256').update(`${HOST}|${userId}`).digest('hex').slice(0, 12)}`;
const WS_ID = '3f9a1c2e-1111-4222-8333-444455556666';
const ORGS = [
  {
    id: 'o1',
    slug: 'awo',
    name: 'AWO',
    role: 'owner',
    remoteAccess: { allowed: true },
    workspaces: [
      {
        id: WS_ID,
        alias: 'hq-3f9a1c2e',
        name: 'Backend team',
        state: 'running',
        rights: { forward: true, attach: true, files: { read: true, write: true } },
        supported: true,
      },
    ],
  },
];
const FILES = {
  'README.md': 'hello, team!\n',
  'notes.md': 'notes\n',
  'z.md': 'zed\n',
  'secret.env': 'TOKEN=live-secret-value\n',
  'y.md': 'why\n',
};

/** Every request the fake answered: `METHOD /path?query user`. */
const seen = [];
const fake = {
  /** Who the browser approves next. */
  approveAs: USER_B,
  /** access token → { user, revoked } */
  grants: new Map(),
  /** The team machine is off: listed `asleep`, its files refused 409 RUNNER_UNAVAILABLE. */
  off: false,
  /** After a wake: HQ already says running, but files are refused until then (the boot). */
  bootUntil: 0,
  /** 0.2.2: the team secret whose value secret.env holds exists (the file is served masked). */
  secretSet: true,
  /** 0.2.2: the events socket is served (from step 6 on; before, upgrades are refused). */
  eventsOn: false,
  /** Open events sockets and the teams each subscribed. */
  subscribers: [],
  /** HQ's push after a secret change (content-free), to every socket subscribed to the team. */
  pushSecretsChanged() {
    for (const s of fake.subscribers) {
      s.ws.send(JSON.stringify({ type: 'secrets-changed', workspaceId: WS_ID }));
    }
  },
  revoke(userId) {
    for (const g of fake.grants.values()) if (g.user.id === userId) g.revoked = true;
  },
};

/** The listing as HQ answers it now: the team `asleep` while off. */
const listed = () =>
  ORGS.map((o) => ({
    ...o,
    workspaces: o.workspaces.map((w) => ({ ...w, state: fake.off ? 'asleep' : 'running' })),
  }));

function startFakeHq() {
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, HOST);
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const grant = token ? fake.grants.get(token[1]) : undefined;
    seen.push(`${req.method} ${url.pathname}${url.search} ${grant ? grant.user.id : '-'}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-hq-nonce': `n${(n += 1)}`,
          ...headers,
        });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const p = url.pathname;
      if (p === '/api/remote/device/start') {
        return send(200, {
          deviceCode: `dc-${(n += 1)}`,
          userCode: 'WDJB-MJHT',
          verificationUrl: `${HOST}/device`,
          verificationUrlComplete: `${HOST}/device`,
          expiresIn: 600,
          interval: 5,
        });
      }
      if (p === '/api/remote/device/poll') {
        n += 1;
        const access = `hqa_test_${n}`;
        fake.grants.set(access, { user: fake.approveAs, revoked: false });
        return send(200, {
          status: 'approved',
          grantId: `g-returns-${n}`,
          accessToken: access,
          accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          refreshToken: `hqr_test_${n}`,
          user: fake.approveAs,
          orgs: ORGS,
        });
      }
      if (!grant || grant.revoked) return send(401, { error: 'no', code: 'REMOTE_TOKEN_INVALID' });
      if (p === '/api/remote/nonce')
        return send(200, { nonce: `nonce-${(n += 1)}`, expiresIn: 60 });
      if (p === '/api/remote/orgs') return send(200, listed());
      const base = `/api/remote/orgs/awo/workspaces/${WS_ID}`;
      const path = url.searchParams.get('path') ?? '';
      if (p === `${base}/wake` && req.method === 'POST') {
        fake.off = false;
        fake.bootUntil = Date.now() + 6_000;
        return send(202, { state: 'waking' });
      }
      if ((fake.off || Date.now() < fake.bootUntil) && p.startsWith(`${base}/fs/`)) {
        return send(409, {
          error: 'The team machine is asleep.',
          code: 'RUNNER_UNAVAILABLE',
          details: { state: fake.off ? 'asleep' : 'starting', hint: 'reconnect' },
        });
      }
      if (p === `${base}/fs/tree`) {
        return send(200, {
          entries: Object.keys(FILES).map((f) => ({
            path: f,
            type: 'file',
            size: FILES[f].length,
            mtimeMs: 1,
            etag: `e-${f}-${FILES[f].length}`,
          })),
        });
      }
      if (p === `${base}/fs/stat`) {
        if (path === '')
          return send(200, { path: '', type: 'dir', size: 0, mtimeMs: 1, etag: 'd1' });
        if (FILES[path] !== undefined) {
          const etag = `e-${path}-${FILES[path].length}`;
          return send(200, { path, type: 'file', size: FILES[path].length, mtimeMs: 1, etag });
        }
        return send(404, { error: 'not found', code: 'NOT_FOUND' });
      }
      if (p === `${base}/fs/file` && req.method === 'GET') {
        if (FILES[path] === undefined) return send(404, { error: 'not found', code: 'NOT_FOUND' });
        // A team secret's value is in secret.env: served masked while the secret exists (the file,
        // its etag and its lstat stay exactly the same either way, as on a real machine).
        const masked = fake.secretSet && path === 'secret.env';
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          etag: `e-${path}-${FILES[path].length}`,
          'x-hq-masked': masked ? '1' : '0',
        });
        return res.end(
          masked ? FILES[path].replace('live-secret-value', '[REDACTED]') : FILES[path],
        );
      }
      if (p === `${base}/fs/file` && req.method === 'PUT') {
        FILES[path] = Buffer.concat(chunks).toString('utf8');
        const etag = `e-${path}-${FILES[path].length}`;
        return send(200, { path, type: 'file', size: FILES[path].length, mtimeMs: 2, etag });
      }
      if (p === base) return send(200, listed()[0].workspaces[0]);
      return send(404, { error: 'not found' });
    });
  });
  // The events socket: refused until step 6 (the file system then falls back to its own refresh, as
  // when one is refused); from then on a minimal one that subscribes and pushes `secrets-changed`.
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!fake.eventsOn || !(req.url || '').startsWith('/ws/remote/events')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f.type !== 'subscribe') return;
        fake.subscribers.push({ ws, workspaceId: f.workspaceId });
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            workspaceId: f.workspaceId,
            state: 'running',
            watch: true,
          }),
        );
      });
    });
  });
  // Longer than the device flow's 5 s poll: Node's default (5 s) races the client's reuse of the
  // kept-alive socket, which is a flake of this fake, not of HQ.
  server.keepAliveTimeout = 60_000;
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tabUris = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => t.input && t.input.uri && t.input.uri.toString())
    .filter(Boolean);
const docOf = (uri) =>
  vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
/** Opened the way the Explorer and Open Recent open it: a failed read keeps an error tab. */
const open = (uri) =>
  Promise.resolve(vscode.commands.executeCommand('vscode.open', uri, { preview: false })).catch(
    () => undefined,
  );

async function run() {
  const server = await startFakeHq();
  try {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    assert.ok(folder, 'the window opened on the team folder');
    assert.equal(folder.uri.authority, `${tagOf(USER_B.id)}@awo`);
    await vscode.commands.executeCommand('workbench.view.explorer');
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext.activate();
    const readme = vscode.Uri.joinPath(folder.uri, 'README.md');

    // ── 1. U23: a folder and an editor of an account that is not signed in come back on sign-in.
    await open(readme);
    assert.ok(!docOf(readme), 'not readable while B is not signed in');
    console.log(`  (tabs while unavailable: ${JSON.stringify(tabUris())})`);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(
      seen.filter((s) => s.includes('/fs/')),
      [],
      'no file request while signed out',
    );
    fake.approveAs = USER_B;
    assert.equal(await vscode.commands.executeCommand('hq.signIn'), 'approved');
    await until(
      () => seen.some((s) => s.startsWith('GET ') && s.includes('/fs/tree')),
      20_000,
      'the Explorer lists the folder',
    );
    await until(
      () => docOf(readme) && docOf(readme).getText() === FILES['README.md'],
      20_000,
      'the editor shows the file',
    );
    assert.ok(tabUris().includes(readme.toString()), 'the file is open in a tab');
    console.log(
      '  ok  a folder and an editor of an account that was not signed in come back on sign-in (U23)',
    );

    // ── 2. A second account and its tab; B's README edited and saved; B's notes.md left unsaved.
    fake.approveAs = USER_A;
    assert.equal(await vscode.commands.executeCommand('hq.addAccount'), 'approved');
    const aFile = vscode.Uri.from({
      scheme: 'hq',
      authority: `${tagOf(USER_A.id)}@awo`,
      path: '/hq-3f9a1c2e/README.md',
    });
    await open(aFile);
    await until(() => docOf(aFile), 10_000, "A's file opens");
    const docA = docOf(aFile);

    const docReadme = docOf(readme);
    const original = docReadme.getText();
    const ed = await vscode.window.showTextDocument(docReadme, { preview: false });
    await ed.edit((e) => e.insert(new vscode.Position(0, 0), 'saved edit\n'));
    assert.ok(await docReadme.save(), 'the edit is saved through HQ');
    const readmeVersion = docReadme.version;

    const notes = vscode.Uri.joinPath(folder.uri, 'notes.md');
    await open(notes);
    await until(() => docOf(notes), 10_000, 'notes.md opens');
    const docNotes = docOf(notes);
    const ned = await vscode.window.showTextDocument(docNotes, { preview: false });
    await ned.edit((e) => e.insert(new vscode.Position(0, 0), 'unsaved line\n'));
    assert.ok(docNotes.isDirty);

    // ── 3. HQ revokes B; a B file opened now fails (its read is refused, the revocation confirmed).
    const mark = seen.length;
    fake.revoke(USER_B.id);
    const z = vscode.Uri.joinPath(folder.uri, 'z.md');
    await open(z);
    await until(
      () =>
        seen
          .slice(mark)
          .some((s) => s.startsWith('GET /api/remote/orgs ') && s.endsWith(USER_B.id)),
      10_000,
      'HQ was asked whether B is revoked',
    );
    await new Promise((r) => setTimeout(r, 1500));
    if (!tabUris().includes(z.toString())) await open(z); // B is gone now: refused at once
    assert.ok(!docOf(z), 'z is not readable while B is revoked');
    // The LOADED README is refused too now (as when VS Code re-checks an open file): only the
    // "never loaded" rule keeps it from being reopened.
    let refusedReadme = false;
    await vscode.workspace.fs.stat(readme).catch(() => (refusedReadme = true));
    assert.ok(refusedReadme, 'the README is refused while B is revoked');

    // ── 4. Sign in as B again: ONLY the failed tab reopens.
    fake.approveAs = USER_B;
    assert.equal(await vscode.commands.executeCommand('hq.addAccount'), 'approved');
    // Within 30 s of the first revive: the gate runs this one at the end of its window.
    await until(
      () => docOf(z) && docOf(z).getText() === FILES['z.md'],
      45_000,
      'the failed tab shows z',
    );
    await new Promise((r) => setTimeout(r, 1500)); // anything else the revive would do, it has done
    assert.equal(docOf(readme), docReadme, 'the loaded README is the same document');
    assert.equal(docReadme.isClosed, false);
    assert.equal(docReadme.version, readmeVersion, 'the loaded README was not reloaded');
    await vscode.window.showTextDocument(docReadme, { preview: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(docReadme.getText(), original, 'its undo history survived');
    assert.equal(docOf(notes), docNotes, 'notes.md is the same document');
    assert.ok(
      docNotes.isDirty && docNotes.getText().startsWith('unsaved line\n'),
      'its unsaved edit is intact',
    );
    assert.equal(docOf(aFile), docA, "A's document is untouched");
    assert.equal(docA.isClosed, false);
    assert.ok(tabUris().includes(aFile.toString()), "A's tab is still open");
    console.log(
      "  ok  only the failed tab reopens: a loaded tab keeps its undo, a dirty one its edits, another account's is untouched (W1)",
    );

    // ── 5. The team goes off; a file opened now fails; Wake Team; the tab fills by itself. The tab
    // is A's, whose team is NOT a folder of this window (opened from the Teams view or a search):
    // no folder refresh ever asks that team again, as in the live re-test.
    fake.off = true;
    const y = aFile.with({ path: '/hq-3f9a1c2e/y.md' });
    await open(y);
    await new Promise((r) => setTimeout(r, 1000));
    if (!tabUris().includes(y.toString())) await open(y);
    assert.ok(!docOf(y), 'y is not readable while the team is off');
    const wakeMark = seen.length;
    const wakeAt = Date.now();
    // The off notice's "Wake Team" link: [account tag, team id].
    await vscode.commands.executeCommand('hq.wakeTeamOf', tagOf(USER_A.id), WS_ID);
    assert.ok(
      seen
        .slice(wakeMark)
        .some((s) => s.startsWith(`POST /api/remote/orgs/awo/workspaces/${WS_ID}/wake`)),
      'the wake was asked for',
    );
    await until(
      () => docOf(y) && docOf(y).getText() === FILES['y.md'],
      60_000,
      'the tab refused while the team was off shows y once it serves',
    );
    const fsAfterWake = seen.slice(wakeMark).filter((s) => s.includes('/fs/'));
    console.log(
      `  ok  a tab refused while its team was off fills by itself once the team serves, after a boot that refused it again (live #2; ${Math.round((Date.now() - wakeAt) / 1000)} s, ${fsAfterWake.length} file requests)`,
    );

    // ── 6. 0.2.2 live FAIL 1: an open masked file follows the team's secrets, with no Revert. The
    // file itself does not change (same etag, same size, same mtime): only its masking does.
    fake.eventsOn = true;
    const sec = vscode.Uri.joinPath(folder.uri, 'secret.env');
    await open(sec);
    await until(
      () => docOf(sec) && docOf(sec).getText().includes('[REDACTED]'),
      15_000,
      'secret.env opens masked',
    );
    await until(() => fake.subscribers.length > 0, 45_000, 'the events socket subscribed the team');
    fake.secretSet = false; // the secret is deleted in HQ
    fake.pushSecretsChanged();
    await until(
      () => docOf(sec) && docOf(sec).getText().includes('live-secret-value'),
      15_000,
      'the open editor unmasks by itself after the secret is deleted',
    );
    fake.secretSet = true; // and added again
    fake.pushSecretsChanged();
    await until(
      () => docOf(sec) && docOf(sec).getText().includes('[REDACTED]'),
      15_000,
      'the open editor re-masks by itself after the secret is added',
    );
    console.log(
      '  ok  an open masked file unmasks and re-masks by itself when the secret changes (0.2.2 live FAIL 1)',
    );
  } catch (err) {
    console.log(`  FAIL U23/live #2: ${err && err.message}`);
    console.log(`  seen: ${JSON.stringify(seen.slice(-40))}`);
    console.log(`  tabs: ${JSON.stringify(tabUris())}`);
    throw err;
  } finally {
    server.close();
  }
}

module.exports = { run };
