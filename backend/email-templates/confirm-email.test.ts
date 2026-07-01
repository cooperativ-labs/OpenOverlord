import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmEmailHtml, confirmEmailSubject } from './confirm-email.ts';

test('confirmEmailHtml interpolates the confirmation URL, token, and site URL', () => {
  const html = confirmEmailHtml({
    confirmationUrl: 'https://ovld.ai/verify?token=abc123',
    token: '482913',
    siteUrl: 'https://ovld.ai'
  });

  assert.match(html, /<!doctype html>/i);
  // CTA button and fallback link both point at the confirmation URL.
  assert.ok(html.includes('href="https://ovld.ai/verify?token=abc123"'));
  // One-time code is rendered.
  assert.ok(html.includes('482913'));
  // Footer brand link uses the site URL.
  assert.ok(html.includes('href="https://ovld.ai"'));
});

test('confirmEmailHtml escapes values to prevent attribute/markup injection', () => {
  const html = confirmEmailHtml({
    confirmationUrl: 'https://ovld.ai/verify?a=1&b="><script>x</script>',
    token: '<b>1</b>',
    siteUrl: 'https://ovld.ai'
  });

  // Raw injection payload must not appear verbatim.
  assert.ok(!html.includes('"><script>x</script>'));
  // Ampersand and quote in the URL are entity-encoded.
  assert.ok(html.includes('a=1&amp;b=&quot;&gt;&lt;script&gt;'));
  // Token markup is escaped in element content.
  assert.ok(html.includes('&lt;b&gt;1&lt;/b&gt;'));
});

test('confirmEmailSubject is a non-empty string', () => {
  assert.equal(typeof confirmEmailSubject(), 'string');
  assert.ok(confirmEmailSubject().length > 0);
});
