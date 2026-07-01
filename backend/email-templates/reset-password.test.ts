import assert from 'node:assert/strict';
import test from 'node:test';

import { resetPasswordHtml, resetPasswordSubject } from './reset-password.ts';

test('resetPasswordHtml interpolates the email, confirmation URL, and site URL', () => {
  const html = resetPasswordHtml({
    email: 'user@example.com',
    confirmationUrl: 'https://ovld.ai/reset?token=abc123',
    siteUrl: 'https://ovld.ai'
  });

  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes('href="https://ovld.ai/reset?token=abc123"'));
  assert.ok(html.includes('user@example.com'));
  assert.ok(html.includes('href="https://ovld.ai"'));
});

test('resetPasswordHtml escapes values to prevent attribute/markup injection', () => {
  const html = resetPasswordHtml({
    email: '"><script>x</script>',
    confirmationUrl: 'https://ovld.ai/reset?a=1&b="><script>x</script>',
    siteUrl: 'https://ovld.ai'
  });

  assert.ok(!html.includes('"><script>x</script>'));
  assert.ok(html.includes('a=1&amp;b=&quot;&gt;&lt;script&gt;'));
});

test('resetPasswordSubject is a non-empty string', () => {
  assert.equal(typeof resetPasswordSubject(), 'string');
  assert.ok(resetPasswordSubject().length > 0);
});
