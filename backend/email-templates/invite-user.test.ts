import assert from 'node:assert/strict';
import test from 'node:test';

import { inviteUserHtml, inviteUserSubject } from './invite-user.ts';

test('inviteUserHtml interpolates the email, confirmation URL, and site URL', () => {
  const html = inviteUserHtml({
    email: 'new.user@example.com',
    confirmationUrl: 'https://ovld.ai/invite?token=abc123',
    siteUrl: 'https://ovld.ai'
  });

  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes('href="https://ovld.ai/invite?token=abc123"'));
  assert.ok(html.includes('new.user@example.com'));
  assert.ok(html.includes('href="https://ovld.ai"'));
});

test('inviteUserHtml escapes values to prevent attribute/markup injection', () => {
  const html = inviteUserHtml({
    email: '"><script>x</script>',
    confirmationUrl: 'https://ovld.ai/invite?a=1&b="><script>x</script>',
    siteUrl: 'https://ovld.ai'
  });

  assert.ok(!html.includes('"><script>x</script>'));
  assert.ok(html.includes('a=1&amp;b=&quot;&gt;&lt;script&gt;'));
});

test('inviteUserSubject is a non-empty string', () => {
  assert.equal(typeof inviteUserSubject(), 'string');
  assert.ok(inviteUserSubject().length > 0);
});
