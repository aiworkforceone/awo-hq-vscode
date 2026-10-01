/**
 * The folder-level answer to "why are there no files?" (nonprod 2026-09-30: an old runner image
 * showed only VS Code's "!"): one notification per change with the sentence, Open Team Settings
 * opening the team's HQ settings (Update machine lives there), and the reason on the team ROOT as
 * a decoration with a tooltip. fs-core reports changes only; this layer adds no repeats.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Team } from '@hq/client/teams.js';
import { stub, Uri } from './vscode-stub.js';
import { HqTeamIssues, UnopenableNames } from '../../src/fs/hq-fs-issues.js';
import { COPY } from '../../src/copy.js';
import {
  groupByFile,
  openMatch,
  SearchView,
  withShownPaths,
} from '../../src/search/search-view.js';

const WS = '3f9a1c2e-1111-4222-8333-444455556666';
const team = {
  alias: 'hq-3f9a1c2e',
  org: { slug: 'awo', name: 'AWO' },
  workspace: { id: WS, name: 'Backend team' },
} as unknown as Team;
const root = Uri.from({ scheme: 'hq', authority: 'awo', path: '/hq-3f9a1c2e' });
const file = Uri.from({ scheme: 'hq', authority: 'awo', path: '/hq-3f9a1c2e/src/a.ts' });
const flush = () => new Promise((r) => setTimeout(r, 0));

let issues: HqTeamIssues;
let changed: string[];

beforeEach(() => {
  stub.reset();
  issues = new HqTeamIssues({ host: () => 'https://hq-test.aiworkforceone.com' });
  changed = [];
  issues.onDidChangeFileDecorations((uris) => void changed.push(...uris.map((u) => u.toString())));
});

describe('HqTeamIssues', () => {
  it('needs an update: one warning with the sentence; Open Team Settings opens the team settings page', async () => {
    stub.choice = COPY.openTeamSettings;
    issues.onIssue(team, { kind: 'needs-update' });
    await flush();
    expect(stub.messages).toEqual([{ level: 'warn', text: COPY.updateNeededLong('Backend team') }]);
    expect(stub.opened).toEqual([`https://hq-test.aiworkforceone.com/workspaces/${WS}/settings`]);
  });

  it('the team root carries the reason (badge + tooltip); files below it and other teams do not', () => {
    issues.onIssue(team, { kind: 'needs-update' });
    expect(changed).toEqual([root.toString()]);
    expect(issues.provideFileDecoration(root as never)).toMatchObject({
      badge: '↑',
      tooltip: COPY.updateNeededLong('Backend team'),
    });
    expect(issues.provideFileDecoration(file as never)).toBeUndefined();
  });

  it('updating: an info notice with the ETA, and the folder tooltip says it too', () => {
    issues.onIssue(team, { kind: 'updating', etaSeconds: 90 });
    expect(stub.messages).toEqual([{ level: 'info', text: COPY.fsUpdating('Backend team', 90) }]);
    expect(issues.provideFileDecoration(root as never)).toMatchObject({
      badge: '…',
      tooltip: COPY.fsUpdating('Backend team', 90),
    });
  });

  it('back to normal: the decoration goes, with no notice; sign-out clears every folder', () => {
    issues.onIssue(team, { kind: 'needs-update' });
    stub.reset();
    issues.onIssue(team, null);
    expect(stub.messages).toEqual([]);
    expect(issues.provideFileDecoration(root as never)).toBeUndefined();
    issues.onIssue(team, { kind: 'updating', etaSeconds: null });
    changed = [];
    issues.clear();
    expect(changed).toEqual([root.toString()]);
    expect(issues.provideFileDecoration(root as never)).toBeUndefined();
  });

  it('dismissing the warning opens nothing', async () => {
    issues.onIssue(team, { kind: 'needs-update' });
    await flush();
    expect(stub.opened).toEqual([]);
  });
});

describe('W4: a search result opens the uri the Explorer shows', () => {
  it('openMatch builds the uri from the CLEANED path, so one file has one uri', async () => {
    const RLO = String.fromCharCode(0x202e); // hostile but openable (a control char is not: below)
    const FFFD = String.fromCharCode(0xfffd);
    const real = `src/evil${RLO}.txt`;
    await openMatch(
      { kind: 'match', team, match: { path: real, line: 3, column: 1, length: 1, preview: 'x' } },
      async (_t, p) => p.replace(RLO, FFFD),
    );
    expect(stub.shownDocs).toEqual([`hq://awo/hq-3f9a1c2e/src/evil${FFFD}.txt`]);
  });
});

describe('train 42 re-test: search results', () => {
  const FFFD = String.fromCharCode(0xfffd);
  const RLO = String.fromCharCode(0x202e);
  const ZW = String.fromCharCode(0x200b);

  it('each file is labelled with the path the Explorer shows (twins no longer look the same)', async () => {
    const nodes = groupByFile(team, {
      matches: [
        { path: `src/a${RLO}b.txt`, line: 1, column: 1, length: 1, preview: 'x' },
        { path: `src/a${ZW}b.txt`, line: 2, column: 1, length: 1, preview: 'y' },
      ],
      truncated: false,
      elapsedMs: 0,
    });
    const labelled = await withShownPaths(nodes, async (_t, p) =>
      p === `src/a${RLO}b.txt` ? `src/a${FFFD}b ~aaaaaa.txt` : `src/a${FFFD}b ~bbbbbb.txt`,
    );
    const view = new SearchView();
    const labels = labelled.filter((n) => n.kind === 'file').map((n) => view.getTreeItem(n).label);
    expect(labels).toEqual([`src/a${FFFD}b ~aaaaaa.txt`, `src/a${FFFD}b ~bbbbbb.txt`]);
  });

  it('a hit in a file whose name has control characters says why and opens nothing', async () => {
    stub.reset();
    const ESC = String.fromCharCode(0x1b);
    await openMatch(
      {
        kind: 'match',
        team,
        match: { path: `src/evil${ESC}.txt`, line: 1, column: 1, length: 1, preview: 'x' },
      },
      async (_t, p) => p,
    );
    expect(stub.messages).toEqual([{ level: 'warn', text: COPY.fsControlName }]);
    expect(stub.shownDocs).toEqual([]);
  });
});

describe('train 42 re-test: control-character names are marked in the Explorer', () => {
  it('a file HQ cannot open carries a "not openable" decoration with the rename sentence', () => {
    const FFFD = String.fromCharCode(0xfffd);
    const core = {
      team: () => team,
      isUnopenable: (_t: unknown, p: string) => p === `evil${FFFD}.txt`,
    };
    const marks = new UnopenableNames(core);
    const bad = Uri.from({ scheme: 'hq', authority: 'awo', path: `/hq-3f9a1c2e/evil${FFFD}.txt` });
    const ok = Uri.from({ scheme: 'hq', authority: 'awo', path: '/hq-3f9a1c2e/ok.txt' });
    expect(marks.provideFileDecoration(bad as never)).toMatchObject({
      badge: '⊘',
      tooltip: COPY.fsControlName,
    });
    expect(marks.provideFileDecoration(ok as never)).toBeUndefined();
    const other = Uri.from({ scheme: 'file', authority: '', path: `/x/evil${FFFD}.txt` });
    expect(marks.provideFileDecoration(other as never)).toBeUndefined();
  });
});
