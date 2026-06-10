import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Authorizer, makeActor } from './authorizer.js';
import { PERMISSIONS } from './permissions.js';
import { Role } from './types.js';

describe('Authorizer', () => {
  const auth = new Authorizer();

  describe('ADMIN role', () => {
    const admin = makeActor('admin-user', [Role.ADMIN]);

    it('grants any domain action via wildcard', () => {
      assert.equal(auth.can(admin, PERMISSIONS.USER_CREATE).allowed, true);
      assert.equal(auth.can(admin, PERMISSIONS.ROLE_ASSIGN).allowed, true);
      assert.equal(auth.can(admin, PERMISSIONS.CONNECTOR_CONFIGURE).allowed, true);
      assert.equal(auth.can(admin, PERMISSIONS.TICKET_DELETE).allowed, true);
    });
  });

  describe('MEMBER role', () => {
    const member = makeActor('member-user', [Role.MEMBER]);

    it('allows ticket operations via ticket:* wildcard', () => {
      assert.equal(auth.can(member, PERMISSIONS.TICKET_CREATE).allowed, true);
      assert.equal(auth.can(member, PERMISSIONS.TICKET_READ).allowed, true);
      assert.equal(auth.can(member, PERMISSIONS.TICKET_UPDATE).allowed, true);
      assert.equal(auth.can(member, PERMISSIONS.TICKET_DELETE).allowed, true);
    });

    it('allows own token management via user_token:self:* wildcard', () => {
      assert.equal(auth.can(member, PERMISSIONS.USER_TOKEN_SELF_CREATE).allowed, true);
      assert.equal(auth.can(member, PERMISSIONS.USER_TOKEN_SELF_REVOKE).allowed, true);
    });

    it('denies user management', () => {
      assert.equal(auth.can(member, PERMISSIONS.USER_CREATE).allowed, false);
      assert.equal(auth.can(member, PERMISSIONS.USER_DISABLE).allowed, false);
      assert.equal(auth.can(member, PERMISSIONS.USER_DELETE).allowed, false);
    });

    it('denies role assignment', () => {
      assert.equal(auth.can(member, PERMISSIONS.ROLE_ASSIGN).allowed, false);
      assert.equal(auth.can(member, PERMISSIONS.ROLE_REVOKE).allowed, false);
    });

    it('denies connector configuration', () => {
      assert.equal(auth.can(member, PERMISSIONS.CONNECTOR_CONFIGURE).allowed, false);
    });

    it('allows project read but not create', () => {
      assert.equal(auth.can(member, PERMISSIONS.PROJECT_READ).allowed, true);
      assert.equal(auth.can(member, PERMISSIONS.PROJECT_CREATE).allowed, false);
    });
  });

  describe('no roles', () => {
    const noRoles = makeActor('anon', []);

    it('denies everything', () => {
      assert.equal(auth.can(noRoles, PERMISSIONS.TICKET_READ).allowed, false);
      assert.equal(auth.can(noRoles, PERMISSIONS.PROJECT_READ).allowed, false);
    });
  });

  describe('denial reasons', () => {
    it('includes role name in the denial reason', () => {
      const member = makeActor('m', [Role.MEMBER]);
      const result = auth.can(member, PERMISSIONS.USER_CREATE);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('MEMBER'));
    });

    it('includes the granted role in the approval reason', () => {
      const admin = makeActor('a', [Role.ADMIN]);
      const result = auth.can(admin, PERMISSIONS.USER_CREATE);
      assert.equal(result.allowed, true);
      assert.ok(result.reason.includes('ADMIN'));
    });
  });
});
