import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { nowIso } from './util.js';

describe('createProject slug reuse', () => {
  it('allows reusing a slug after the previous project is soft-deleted', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'cli' });

    const first = createProject({ ctx, name: 'Overlord', slug: 'overlord' });
    db.prepare(
      `UPDATE projects SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
    ).run(nowIso(), nowIso(), first.id);

    const second = createProject({ ctx, name: 'Overlord', slug: 'overlord' });
    assert.notEqual(second.id, first.id);
    assert.equal(second.slug, 'overlord');

    db.close();
  });
});
