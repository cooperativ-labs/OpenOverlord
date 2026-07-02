import assert from 'node:assert/strict';
import test from 'node:test';

import { magicLinkHtml, magicLinkSubject } from './magic-link.ts';
import {
  assertEscapesTokenMarkup,
  assertEscapesUrlInjection,
  assertIncludesSiteUrl,
  assertSubjectNonEmpty,
  assertValidEmailDocument,
  INJECTION_SCRIPT,
  INJECTION_TOKEN,
  TEST_EMAIL,
  TEST_SITE_URL,
  TEST_TOKEN,
  testConfirmationUrl,
  testInjectionConfirmationUrl
} from './test-fixtures.ts';

test('magicLinkHtml interpolates the email, confirmation URL, token, and site URL', () => {
  const confirmationUrl = testConfirmationUrl({ path: '/verify' });
  const html = magicLinkHtml({
    email: TEST_EMAIL,
    confirmationUrl,
    token: TEST_TOKEN,
    siteUrl: TEST_SITE_URL
  });

  assertValidEmailDocument(html);
  assert.ok(html.includes(`href="${confirmationUrl}"`));
  assert.ok(html.includes(TEST_TOKEN));
  assert.ok(html.includes(TEST_EMAIL));
  assertIncludesSiteUrl(html);
});

test('magicLinkHtml escapes values to prevent attribute/markup injection', () => {
  const html = magicLinkHtml({
    email: INJECTION_SCRIPT,
    confirmationUrl: testInjectionConfirmationUrl({ path: '/verify' }),
    token: INJECTION_TOKEN,
    siteUrl: TEST_SITE_URL
  });

  assertEscapesUrlInjection(html);
  assertEscapesTokenMarkup(html);
});

test('magicLinkSubject is a non-empty string', () => {
  assertSubjectNonEmpty(magicLinkSubject);
});
