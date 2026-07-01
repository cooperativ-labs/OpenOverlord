import assert from 'node:assert/strict';
import test from 'node:test';

import { magicLinkHtml, magicLinkSubject } from './magic-link.ts';

test('magicLinkHtml interpolates the email, confirmation URL, token, and site URL', () => {
  const html = magicLinkHtml({
    email: 'user@example.com',
    confirmationUrl: 'https://ovld.ai/verify?token=abc123',
    token: '482913',
    siteUrl: 'https://ovld.ai'
  });

  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes('href="https://ovld.ai/verify?token=abc123"'));
  assert.ok(html.includes('482913'));
  assert.ok(html.includes('user@example.com'));
  assert.ok(html.includes('href="https://ovld.ai"'));
});

test('magicLinkHtml escapes values to prevent attribute/markup injection', () => {
  const html = magicLinkHtml({
    email: '"><script>x</script>',
    confirmationUrl: 'https://ovld.ai/verify?a=1&b="><script>x</script>',
    token: '<b>1</b>',
    siteUrl: 'https://ovld.ai'
  });

  assert.ok(!html.includes('"><script>x</script>'));
  assert.ok(html.includes('a=1&amp;b=&quot;&gt;&lt;script&gt;'));
  assert.ok(html.includes('&lt;b&gt;1&lt;/b&gt;'));
});

test('magicLinkSubject is a non-empty string', () => {
  assert.equal(typeof magicLinkSubject(), 'string');
  assert.ok(magicLinkSubject().length > 0);
});
