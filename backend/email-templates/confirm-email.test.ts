import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmEmailHtml, confirmEmailSubject } from './confirm-email.ts';
import {
  assertEscapesTokenMarkup,
  assertEscapesUrlInjection,
  assertIncludesSiteUrl,
  assertSubjectEquals,
  assertValidEmailDocument,
  INJECTION_TOKEN,
  TEST_SITE_URL,
  TEST_TOKEN,
  testConfirmationUrl,
  testInjectionConfirmationUrl
} from './test-fixtures.ts';

test('confirmEmailHtml interpolates the confirmation URL, token, and site URL', () => {
  const confirmationUrl = testConfirmationUrl({ path: '/verify' });
  const html = confirmEmailHtml({
    confirmationUrl,
    token: TEST_TOKEN,
    siteUrl: TEST_SITE_URL
  });

  assertValidEmailDocument(html);
  assert.ok(html.includes(`href="${confirmationUrl}"`));
  assert.ok(html.includes(TEST_TOKEN));
  assertIncludesSiteUrl(html);
});

test('confirmEmailHtml escapes values to prevent attribute/markup injection', () => {
  const html = confirmEmailHtml({
    confirmationUrl: testInjectionConfirmationUrl({ path: '/verify' }),
    token: INJECTION_TOKEN,
    siteUrl: TEST_SITE_URL
  });

  assertEscapesUrlInjection(html);
  assertEscapesTokenMarkup(html);
});

test('confirmEmailSubject returns the expected subject line', () => {
  assertSubjectEquals(confirmEmailSubject, 'Confirm your email to start running agents');
});
