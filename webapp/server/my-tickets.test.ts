import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-my-tickets-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { db, WORKSPACE, setActiveWorkspaceUser, nowIso, newId } = await import('./db.ts');
const {
  createProject,
  createTicket,
  updateTicket,
  deleteTicket,
  listTickets,
  listWorkspaceStatuses,
  listWorkspaceMyTickets,
  reorderWorkspaceMyTickets
} = await import('./repository.ts');
const { ApiError } = await import('./errors.ts');

// A fresh local DB no longer seeds a persistent operator (contract 0.21), so
// create one and make it the active actor that assigned-ticket queries scope to.
const operatorId = newId(); // workspace_users.id — the active actor
{
  const userId = newId(); // Better Auth user id; the trigger creates profiles.id = userId
  const now = nowIso();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, 'Test Operator', 'test-op@overlord.local', 0, ?, ?)`
  ).run(userId, now, now);
  db.prepare(
    `INSERT INTO workspace_users (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'test:op', 'active', '{}', ?, ?, 1)`
  ).run(operatorId, WORKSPACE.id, userId, now, now);
  setActiveWorkspaceUser(operatorId);
}

const statuses = listWorkspaceStatuses();
const backlog = statuses.find(s => s.key === 'backlog')!;
const inProgress = statuses.find(s => s.key === 'in_progress')!;

test('the test database resolves an active operator', () => {
  assert.ok(operatorId, 'operator should be set for My Tickets');
});

test('lists tickets assigned to the operator across projects, with project context', () => {
  const projectA = createProject({ name: 'MT Project A', color: '#112233' });
  const projectB = createProject({ name: 'MT Project B' });
  const a1 = createTicket({ projectId: projectA.id, firstObjective: 'A1' });
  const b1 = createTicket({ projectId: projectB.id, firstObjective: 'B1' });
  const unassigned = createTicket({ projectId: projectA.id, firstObjective: 'U' });
  updateTicket(unassigned.id, { assignedWorkspaceUserId: null });
  const deleted = createTicket({ projectId: projectA.id, firstObjective: 'D' });
  deleteTicket(deleted.id);

  const ids = listWorkspaceMyTickets().tickets.map(t => t.id);
  assert.ok(ids.includes(a1.id));
  assert.ok(ids.includes(b1.id));
  assert.ok(!ids.includes(unassigned.id), 'unassigned ticket must be excluded');
  assert.ok(!ids.includes(deleted.id), 'deleted ticket must be excluded');

  const a1Dto = listWorkspaceMyTickets().tickets.find(t => t.id === a1.id)!;
  assert.equal(a1Dto.projectName, 'MT Project A');
  assert.equal(a1Dto.projectColor, '#112233');
  assert.equal(a1Dto.myPosition, null);
});

test('within-column reorder writes personal position and leaves board_position untouched', () => {
  const project = createProject({ name: 'MT Reorder' });
  const t1 = createTicket({ projectId: project.id, firstObjective: 'r1' });
  const t2 = createTicket({ projectId: project.id, firstObjective: 'r2' });
  const beforeBoard = new Map(listTickets(project.id).map(t => [t.id, t.boardPosition]));

  // Put t2 above t1 in the backlog column.
  reorderWorkspaceMyTickets({ statusId: backlog.id, orderedTicketIds: [t2.id, t1.id] });

  const afterBoard = new Map(listTickets(project.id).map(t => [t.id, t.boardPosition]));
  assert.equal(afterBoard.get(t1.id), beforeBoard.get(t1.id), 'board_position must not change');
  assert.equal(afterBoard.get(t2.id), beforeBoard.get(t2.id), 'board_position must not change');

  const tickets = listWorkspaceMyTickets().tickets;
  assert.equal(tickets.find(t => t.id === t2.id)!.myPosition, 100);
  assert.equal(tickets.find(t => t.id === t1.id)!.myPosition, 200);
  const order = tickets.filter(t => t.id === t1.id || t.id === t2.id).map(t => t.id);
  assert.deepEqual(order, [t2.id, t1.id], 'positioned tickets sort by personal position');
});

test('cross-column drag changes the ticket status, type, and board_position', () => {
  const project = createProject({ name: 'MT CrossCol' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'x' });
  assert.equal(listTickets(project.id).find(t => t.id === ticket.id)!.statusId, backlog.id);

  reorderWorkspaceMyTickets({ statusId: inProgress.id, orderedTicketIds: [ticket.id] });

  const after = listTickets(project.id).find(t => t.id === ticket.id)!;
  assert.equal(after.statusId, inProgress.id);
  assert.equal(after.statusType, 'execute');
  assert.equal(after.boardPosition, 100, 'board_position resets to top-of-new-column');

  const moved = listWorkspaceMyTickets().tickets.find(t => t.id === ticket.id)!;
  assert.equal(moved.statusId, inProgress.id);
  assert.equal(moved.myPosition, 100);
});

test('a personal position is ignored once the ticket leaves that column via another surface', () => {
  const project = createProject({ name: 'MT Stale' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 's' });
  reorderWorkspaceMyTickets({ statusId: backlog.id, orderedTicketIds: [ticket.id] });
  // Move it via the project-board status-change path; the stored position keeps
  // its old status_id and must no longer apply.
  updateTicket(ticket.id, { statusId: inProgress.id });

  const moved = listWorkspaceMyTickets().tickets.find(t => t.id === ticket.id)!;
  assert.equal(moved.statusId, inProgress.id);
  assert.equal(moved.myPosition, null, 'stale position is ignored at read time');
});

test('reorder into a status the workspace lacks is rejected with a typed code', () => {
  const project = createProject({ name: 'MT Reject' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'rej' });
  assert.throws(
    () => reorderWorkspaceMyTickets({ statusId: 'does-not-exist', orderedTicketIds: [ticket.id] }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.status === 409 &&
      err.code === 'STATUS_UNAVAILABLE_FOR_WORKSPACE'
  );
});

test('excludes tickets whose project has been deleted', () => {
  const project = createProject({ name: 'MT DeletedProj' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'dp' });
  assert.ok(listWorkspaceMyTickets().tickets.some(t => t.id === ticket.id));

  db.prepare(`UPDATE projects SET deleted_at = ? WHERE id = ?`).run(nowIso(), project.id);
  assert.ok(
    !listWorkspaceMyTickets().tickets.some(t => t.id === ticket.id),
    'a ticket in a deleted project must be excluded'
  );
});

test('a personal position survives reassignment and is restored when the ticket returns', () => {
  const project = createProject({ name: 'MT Reassign' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'ra' });
  reorderWorkspaceMyTickets({ statusId: backlog.id, orderedTicketIds: [ticket.id] });

  updateTicket(ticket.id, { assignedWorkspaceUserId: null });
  assert.ok(!listWorkspaceMyTickets().tickets.some(t => t.id === ticket.id));

  updateTicket(ticket.id, { assignedWorkspaceUserId: operatorId });
  const restored = listWorkspaceMyTickets().tickets.find(t => t.id === ticket.id)!;
  assert.equal(restored.myPosition, 100, 'the personal position row persists across reassignment');
});

test('reorder rejects a ticket not assigned to the operator', () => {
  const project = createProject({ name: 'MT NotMine' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'nm' });
  updateTicket(ticket.id, { assignedWorkspaceUserId: null });
  assert.throws(
    () => reorderWorkspaceMyTickets({ statusId: backlog.id, orderedTicketIds: [ticket.id] }),
    (err: unknown) => err instanceof ApiError && err.status === 403
  );
});

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
