import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { generateUserTokenSecret, hashUserTokenSecret, USER_TOKEN_PREFIX } from './token.ts';

// `generateUserTokenSecret` is the single source of the USER_TOKEN secret
// format: every writer of `user_tokens` (REST repository, OAuth approval) mints
// through it, and `verifyUserToken` looks rows up by the same hash. These
// assertions pin the format so a drift between mint and verify cannot recur.

test('generateUserTokenSecret mints the out_-prefixed lookup format', () => {
  const { secret, prefix, hash } = generateUserTokenSecret();

  assert.ok(secret.startsWith(USER_TOKEN_PREFIX), 'secrets carry the recognizable out_ prefix');
  assert.match(
    prefix,
    /^out_[0-9a-f]{8}$/,
    'the non-secret lookup prefix is out_ plus 4 random hex bytes'
  );
  assert.ok(secret.startsWith(prefix), 'the full secret embeds the lookup prefix');
  assert.match(
    secret.slice(prefix.length),
    /^[0-9a-f]{48}$/,
    'the secret part is 24 random hex bytes'
  );
  assert.equal(hash, hashUserTokenSecret(secret), 'the returned hash is the stored-form hash');
});

test('hashUserTokenSecret matches the persisted sha256 hex format', () => {
  const raw = 'out_0123456789abcdef';
  assert.equal(hashUserTokenSecret(raw), createHash('sha256').update(raw).digest('hex'));
});

test('generated secrets are unique per call', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    seen.add(generateUserTokenSecret().secret);
  }
  assert.equal(seen.size, 100);
});
