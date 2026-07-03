import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeRunDelta,
  draftChangeRationalesFromNotes,
  readChangedFiles,
  recordBashObservedChanges,
  recordRationaleNotes,
  recordTouchedFiles,
  resetRationaleNotes,
  resetTouchedFiles,
  writeBaseline
} from '../src/vcs.ts';
import { writeActiveSession } from '../src/vcs-sessions.ts';

const MISSION_ID = 'coo:9';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** A throwaway git repo with one committed file, plus an isolated OVLD_HOME. */
function makeRepo(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ovld-vcs-home-'));
  process.env.OVLD_HOME = home;
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ovld-vcs-repo-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'committed.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function paths(repo: string): string[] {
  return computeRunDelta({ workingDirectory: repo, missionId: MISSION_ID })
    .map(entry => entry.filePath)
    .sort();
}

function classified(repo: string): {
  filePath: string;
  attribution?: string;
  claimedByMissionIds?: string[];
}[] {
  return computeRunDelta({ workingDirectory: repo, missionId: MISSION_ID })
    .map(entry => ({
      filePath: entry.filePath,
      attribution: entry.attribution,
      claimedByMissionIds: entry.claimedByMissionIds
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

test('computeRunDelta reports both mine and unclaimed delta paths, classifying each (completeness first)', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  const mine = path.join(repo, 'mine.ts');
  writeFileSync(mine, 'export const mine = 1;\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [mine] });

  // Concurrent mission dirties another file; NOT recorded as touched here, but the
  // worktree delta still surfaces it — flagged, not silently dropped.
  writeFileSync(path.join(repo, 'concurrent.ts'), 'export const other = 2;\n');

  assert.deepEqual(classified(repo), [
    { filePath: 'concurrent.ts', attribution: 'unclaimed', claimedByMissionIds: undefined },
    { filePath: 'mine.ts', attribution: 'mine', claimedByMissionIds: undefined }
  ]);
});

test('a touched file already dirty (committed) earlier is still reported', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  const committed = path.join(repo, 'committed.txt');
  writeFileSync(committed, 'base\nmore\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [committed] });

  assert.deepEqual(paths(repo), ['committed.txt']);
});

test('without a touched log, deliver falls back to baseline-delta (hookless connectors)', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  writeFileSync(path.join(repo, 'a.ts'), 'a\n');
  writeFileSync(path.join(repo, 'b.ts'), 'b\n');

  assert.deepEqual(paths(repo), ['a.ts', 'b.ts']);
});

test('files dirty before the session began are excluded from the run delta', () => {
  const repo = makeRepo();
  const preexisting = path.join(repo, 'preexisting.ts');
  writeFileSync(preexisting, 'pre\n');
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  const mine = path.join(repo, 'mine.ts');
  writeFileSync(mine, 'mine\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [mine] });

  assert.deepEqual(paths(repo), ['mine.ts']);
});

test('.overlordignore excludes matching files from the run delta', () => {
  const repo = makeRepo();
  // Commit the paths first so `git status --porcelain` lists each modified file
  // individually (it collapses a fully-untracked directory to a single entry).
  execFileSync('mkdir', ['-p', path.join(repo, 'build')]);
  for (const rel of ['install-state.gz', 'debug.log', 'build/out.js', 'src.ts']) {
    const abs = path.join(repo, rel);
    execFileSync('mkdir', ['-p', path.dirname(abs)]);
    writeFileSync(abs, 'base\n');
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'tracked']);

  writeFileSync(
    path.join(repo, '.overlordignore'),
    '# generated artifacts\ninstall-state.gz\n*.log\nbuild/\n'
  );
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  for (const rel of ['install-state.gz', 'debug.log', 'build/out.js', 'src.ts']) {
    const abs = path.join(repo, rel);
    writeFileSync(abs, 'changed\n');
    recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [abs] });
  }

  assert.deepEqual(paths(repo), ['src.ts']);
});

test('.overlordignore negation (!) re-includes a previously ignored file', () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, '.overlordignore'), '*.gz\n!keep.gz\n');
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  for (const rel of ['drop.gz', 'keep.gz']) {
    const abs = path.join(repo, rel);
    writeFileSync(abs, 'x\n');
    recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [abs] });
  }

  assert.deepEqual(paths(repo), ['keep.gz']);
});

test('resetTouchedFiles clears a prior session log so its edits are no longer confirmed by the next session', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });

  // Session A edits stale.ts.
  const stale = path.join(repo, 'stale.ts');
  writeFileSync(stale, 'stale\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [stale] });
  assert.deepEqual(classified(repo), [
    { filePath: 'stale.ts', attribution: 'mine', claimedByMissionIds: undefined }
  ]);

  // Session B (re)attaches — reset clears A's log — then edits only mine.ts.
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  const mine = path.join(repo, 'mine.ts');
  writeFileSync(mine, 'mine\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [mine] });

  // stale.ts is still dirty and belongs to the prior session, so B's log no longer
  // confirms it — but the worktree delta still reports it, flagged for review.
  assert.deepEqual(classified(repo), [
    { filePath: 'mine.ts', attribution: 'mine', claimedByMissionIds: undefined },
    { filePath: 'stale.ts', attribution: 'unclaimed', claimedByMissionIds: undefined }
  ]);
});

test('recordBashObservedChanges folds newly-dirty paths into the touched-files log', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  // A Bash call (e.g. codegen) writes a file with no matching native edit-tool call.
  writeFileSync(path.join(repo, 'generated.ts'), 'export const generated = 1;\n');
  const first = recordBashObservedChanges({ workingDirectory: repo, missionId: MISSION_ID });
  assert.equal(first.addedCount, 1);
  assert.deepEqual(classified(repo), [
    { filePath: 'generated.ts', attribution: 'mine', claimedByMissionIds: undefined }
  ]);

  // A second Bash call with no further changes should not re-record the same path.
  const second = recordBashObservedChanges({ workingDirectory: repo, missionId: MISSION_ID });
  assert.equal(second.addedCount, 0);

  // A third Bash call that further edits the same file re-records it (new content hash).
  writeFileSync(path.join(repo, 'generated.ts'), 'export const generated = 2;\n');
  const third = recordBashObservedChanges({ workingDirectory: repo, missionId: MISSION_ID });
  assert.equal(third.addedCount, 1);
});

test('git mv performed via Bash is captured by the snapshot diff (rename shows as the new path)', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });

  git(repo, ['mv', 'committed.txt', 'renamed.txt']);
  const result = recordBashObservedChanges({ workingDirectory: repo, missionId: MISSION_ID });
  assert.equal(result.addedCount, 1);
  assert.deepEqual(classified(repo), [
    { filePath: 'renamed.txt', attribution: 'mine', claimedByMissionIds: undefined }
  ]);
});

test('computeRunDelta classifies files claimed by another active mission so deliver can exclude them', () => {
  const repo = makeRepo();
  const otherMissionId = 'coo:10';
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  writeActiveSession({ workingDirectory: repo, missionId: MISSION_ID, sessionKey: 'sess_me' });
  writeActiveSession({
    workingDirectory: repo,
    missionId: otherMissionId,
    sessionKey: 'sess_other'
  });

  const mine = path.join(repo, 'mine.ts');
  const claimed = path.join(repo, 'claimed.ts');
  const unclaimed = path.join(repo, 'unclaimed.ts');
  writeFileSync(mine, 'mine\n');
  writeFileSync(claimed, 'claimed\n');
  writeFileSync(unclaimed, 'unclaimed\n');

  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [mine] });
  recordTouchedFiles({ workingDirectory: repo, missionId: otherMissionId, files: [claimed] });

  assert.deepEqual(classified(repo), [
    {
      filePath: 'claimed.ts',
      attribution: 'claimed',
      claimedByMissionIds: [otherMissionId]
    },
    { filePath: 'mine.ts', attribution: 'mine', claimedByMissionIds: undefined },
    {
      filePath: 'unclaimed.ts',
      attribution: 'unclaimed',
      claimedByMissionIds: undefined
    }
  ]);
});

test('without my touched log, peer claims do not suppress baseline-delta reporting', () => {
  const repo = makeRepo();
  const otherMissionId = 'coo:10';
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  writeActiveSession({
    workingDirectory: repo,
    missionId: otherMissionId,
    sessionKey: 'sess_other'
  });

  const claimed = path.join(repo, 'claimed.ts');
  writeFileSync(claimed, 'claimed\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: otherMissionId, files: [claimed] });

  assert.deepEqual(classified(repo), [
    { filePath: 'claimed.ts', attribution: undefined, claimedByMissionIds: undefined }
  ]);
});

test('draftChangeRationalesFromNotes drafts rationales for changed files with edit notes', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  resetRationaleNotes({ workingDirectory: repo, missionId: MISSION_ID });

  const changed = path.join(repo, 'delivery-draft.ts');
  writeFileSync(changed, 'export const draft = true;\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [changed] });
  recordRationaleNotes({
    workingDirectory: repo,
    missionId: MISSION_ID,
    notes: [
      {
        filePath: changed,
        toolName: 'Write',
        intent: 'added local delivery rationale draft support',
        transcriptContext: 'Implement Track A rationale prefill.'
      }
    ]
  });

  const drafts = draftChangeRationalesFromNotes({
    workingDirectory: repo,
    missionId: MISSION_ID,
    files: computeRunDelta({ workingDirectory: repo, missionId: MISSION_ID })
  });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.file_path, 'delivery-draft.ts');
  assert.match(drafts[0]?.label ?? '', /Delivery Draft/);
  assert.match(drafts[0]?.summary ?? '', /added local delivery rationale draft support/);
  assert.match(drafts[0]?.summary ?? '', /Implement Track A/);
  assert.match(drafts[0]?.why ?? '', /active objective/);
});

test('draftChangeRationalesFromNotes prefers a note whose content hash matches the current file', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  resetRationaleNotes({ workingDirectory: repo, missionId: MISSION_ID });

  const changed = path.join(repo, 'reuse.ts');
  writeFileSync(changed, 'first\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [changed] });
  recordRationaleNotes({
    workingDirectory: repo,
    missionId: MISSION_ID,
    notes: [{ filePath: changed, toolName: 'Write', intent: 'wrote the first draft' }]
  });

  writeFileSync(changed, 'second\n');
  recordRationaleNotes({
    workingDirectory: repo,
    missionId: MISSION_ID,
    notes: [{ filePath: changed, toolName: 'Edit', intent: 'updated to the final draft' }]
  });

  const drafts = draftChangeRationalesFromNotes({
    workingDirectory: repo,
    missionId: MISSION_ID,
    files: computeRunDelta({ workingDirectory: repo, missionId: MISSION_ID })
  });

  assert.equal(drafts.length, 1);
  assert.match(drafts[0]?.summary ?? '', /updated to the final draft/);
});
