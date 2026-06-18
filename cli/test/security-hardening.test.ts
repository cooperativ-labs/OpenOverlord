import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecrets } from '../dist/redact-secrets.js';
import { detectCloudSyncRoot } from '../dist/sync-root.js';
import { durationToIso } from '../dist/user-token.js';

// ---- redactSecrets -------------------------------------------------------

test('redactSecrets masks an out_ token but keeps the non-secret prefix', () => {
  const secret = 'out_ab12cd34deadbeefdeadbeefdeadbeefdeadbeef';
  const masked = redactSecrets(`auth failed for ${secret}`);
  assert.match(masked, /out_ab12cd34…\[redacted\]/);
  assert.ok(!masked.includes('deadbeef'));
});

test('redactSecrets leaves non-token text untouched', () => {
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here');
});

// ---- detectCloudSyncRoot -------------------------------------------------

test('detectCloudSyncRoot flags iCloud, Dropbox, OneDrive, and Google Drive', () => {
  assert.equal(
    detectCloudSyncRoot('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/.ovld')?.provider,
    'iCloud Drive'
  );
  assert.equal(detectCloudSyncRoot('/Users/x/Dropbox/.ovld')?.provider, 'Dropbox');
  assert.equal(detectCloudSyncRoot('/Users/x/OneDrive - Acme/.ovld')?.provider, 'OneDrive');
  assert.equal(detectCloudSyncRoot('/Users/x/Google Drive/.ovld')?.provider, 'Google Drive');
});

test('detectCloudSyncRoot returns null for a normal home directory', () => {
  assert.equal(detectCloudSyncRoot('/Users/x/.ovld'), null);
  assert.equal(detectCloudSyncRoot('/home/agent/.ovld'), null);
});

// ---- durationToIso -------------------------------------------------------

test('durationToIso adds days/weeks/months/hours/years', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(durationToIso('90d', now), new Date('2026-04-01T00:00:00.000Z').toISOString());
  assert.equal(durationToIso('2w', now), new Date('2026-01-15T00:00:00.000Z').toISOString());
  assert.equal(durationToIso('3mo', now), new Date('2026-04-01T00:00:00.000Z').toISOString());
  assert.equal(durationToIso('6h', now), new Date('2026-01-01T06:00:00.000Z').toISOString());
});

test('durationToIso rejects malformed durations', () => {
  assert.throws(() => durationToIso('soon'));
  assert.throws(() => durationToIso('10x'));
});
