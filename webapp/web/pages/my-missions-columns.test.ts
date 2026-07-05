import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MissionDto, WorkspaceStatusDto } from '../../shared/contract.ts';

import {
  buildMergedStatusColumns,
  groupMissionsByMergedColumn,
  resolveMergedColumnReorder
} from './my-missions-columns.ts';

function status(
  workspaceId: string,
  id: string,
  name: string,
  position: number,
  type: WorkspaceStatusDto['type'] = 'draft'
): WorkspaceStatusDto {
  return {
    id,
    workspaceId,
    key: id,
    name,
    type,
    position,
    isDefault: false,
    isTerminal: false
  };
}

// The merge/group helpers only read id/statusId/workspaceId, so a partial cast
// keeps the fixtures readable without fabricating a whole MissionDto.
function mission(id: string, workspaceId: string, statusId: string): MissionDto {
  return { id, workspaceId, statusId } as unknown as MissionDto;
}

describe('buildMergedStatusColumns', () => {
  it('deduplicates like-named statuses across workspaces into one column', () => {
    const statuses = new Map<string, WorkspaceStatusDto[]>([
      ['ws-a', [status('ws-a', 'a-todo', 'Todo', 1), status('ws-a', 'a-done', 'Done', 2)]],
      ['ws-b', [status('ws-b', 'b-todo', 'todo', 1), status('ws-b', 'b-done', 'Done', 2)]]
    ]);

    const merged = buildMergedStatusColumns(['ws-a', 'ws-b'], statuses);

    assert.deepEqual(
      merged.columns.map(column => column.key),
      ['todo', 'done']
    );
    const todo = merged.byKey.get('todo');
    assert.ok(todo);
    // First-seen workspace owns the display casing.
    assert.equal(todo.name, 'Todo');
    assert.equal(todo.statusIdByWorkspace.get('ws-a'), 'a-todo');
    assert.equal(todo.statusIdByWorkspace.get('ws-b'), 'b-todo');
    assert.equal(merged.keyByStatusId.get('b-todo'), 'todo');
  });

  it('appends a status only one workspace has after the shared columns', () => {
    const statuses = new Map<string, WorkspaceStatusDto[]>([
      ['ws-a', [status('ws-a', 'a-todo', 'Todo', 1)]],
      ['ws-b', [status('ws-b', 'b-todo', 'Todo', 1), status('ws-b', 'b-review', 'Review', 2)]]
    ]);

    const merged = buildMergedStatusColumns(['ws-a', 'ws-b'], statuses);

    assert.deepEqual(
      merged.columns.map(column => column.key),
      ['todo', 'review']
    );
    const review = merged.byKey.get('review');
    assert.ok(review);
    assert.equal(review.statusIdByWorkspace.has('ws-a'), false);
    assert.equal(review.statusIdByWorkspace.get('ws-b'), 'b-review');
  });

  it('orders each workspace by status position before merging', () => {
    const statuses = new Map<string, WorkspaceStatusDto[]>([
      ['ws-a', [status('ws-a', 'a-done', 'Done', 3), status('ws-a', 'a-todo', 'Todo', 1)]]
    ]);

    const merged = buildMergedStatusColumns(['ws-a'], statuses);

    assert.deepEqual(
      merged.columns.map(column => column.key),
      ['todo', 'done']
    );
  });
});

describe('groupMissionsByMergedColumn', () => {
  it('buckets missions into merged columns and preserves server order', () => {
    const statuses = new Map<string, WorkspaceStatusDto[]>([
      ['ws-a', [status('ws-a', 'a-todo', 'Todo', 1)]],
      ['ws-b', [status('ws-b', 'b-todo', 'todo', 1)]]
    ]);
    const merged = buildMergedStatusColumns(['ws-a', 'ws-b'], statuses);

    const missions = [
      mission('m1', 'ws-a', 'a-todo'),
      mission('m2', 'ws-b', 'b-todo'),
      mission('m3', 'ws-a', 'a-todo')
    ];

    const { columns, uncategorized } = groupMissionsByMergedColumn(missions, merged.keyByStatusId);

    assert.deepEqual(columns['todo'], ['m1', 'm2', 'm3']);
    assert.deepEqual(uncategorized, []);
  });

  it('drops missions with an unknown status into the uncategorized bucket', () => {
    const merged = buildMergedStatusColumns(
      ['ws-a'],
      new Map([['ws-a', [status('ws-a', 'a-todo', 'Todo', 1)]]])
    );

    const { columns, uncategorized } = groupMissionsByMergedColumn(
      [mission('m1', 'ws-a', 'deleted-status')],
      merged.keyByStatusId
    );

    assert.deepEqual(uncategorized, ['m1']);
    assert.equal(Object.keys(columns).length, 0);
  });
});

describe('resolveMergedColumnReorder', () => {
  const statuses = new Map<string, WorkspaceStatusDto[]>([
    ['ws-a', [status('ws-a', 'a-todo', 'Todo', 1), status('ws-a', 'a-review', 'Review', 2)]],
    ['ws-b', [status('ws-b', 'b-todo', 'Todo', 1)]]
  ]);
  const merged = buildMergedStatusColumns(['ws-a', 'ws-b'], statuses);

  it('resolves to the moved card workspace status and its own workspace slice', () => {
    const missions = [
      mission('m1', 'ws-a', 'a-todo'),
      mission('m2', 'ws-b', 'b-todo'),
      mission('m3', 'ws-a', 'a-todo')
    ];
    const missionById = new Map(missions.map(m => [m.id, m]));
    const column = merged.byKey.get('todo');
    assert.ok(column);

    const plan = resolveMergedColumnReorder(
      column,
      missionById.get('m3')!,
      ['m1', 'm2', 'm3'],
      missionById
    );

    assert.ok(plan);
    // Targets ws-a's To Do status, carrying only ws-a's missions in order.
    assert.equal(plan.statusId, 'a-todo');
    assert.deepEqual(plan.orderedMissionIds, ['m1', 'm3']);
  });

  it('returns null when the column does not exist in the card workspace', () => {
    const review = merged.byKey.get('review');
    assert.ok(review);
    // "Review" exists only in ws-a; a ws-b card cannot move there.
    const wsBcard = mission('m2', 'ws-b', 'b-todo');
    const plan = resolveMergedColumnReorder(review, wsBcard, ['m2'], new Map([['m2', wsBcard]]));
    assert.equal(plan, null);
  });
});
