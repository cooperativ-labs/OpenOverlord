import assert from 'node:assert/strict';
import test from 'node:test';

import { changeEmailHtml, changeEmailSubject } from './change-email.ts';
import {
  assertEscapesTokenMarkup,
  assertEscapesUrlInjection,
  assertIncludesSiteUrl,
  assertSubjectEquals,
  assertValidEmailDocument,
  INJECTION_SCRIPT,
  INJECTION_TOKEN,
  TEST_NEW_EMAIL,
  TEST_OLD_EMAIL,
  TEST_SITE_URL,
  TEST_TOKEN,
  testConfirmationUrl,
  testInjectionConfirmationUrl
} from './test-fixtures.ts';

test('changeEmailHtml interpolates old/new email, confirmation URL, token, and site URL', () => {
  const confirmationUrl = testConfirmationUrl({ path: '/verify' });
  const html = changeEmailHtml({
    email: TEST_OLD_EMAIL,
    newEmail: TEST_NEW_EMAIL,
    confirmationUrl,
    token: TEST_TOKEN,
    siteUrl: TEST_SITE_URL
  });

  assertValidEmailDocument(html);
  assert.ok(html.includes(`href="${confirmationUrl}"`));
  assert.ok(html.includes(TEST_TOKEN));
  assert.ok(html.includes(TEST_OLD_EMAIL));
  assert.ok(html.includes(TEST_NEW_EMAIL));
  assertIncludesSiteUrl(html);
});

test('changeEmailHtml escapes values to prevent attribute/markup injection', () => {
  const html = changeEmailHtml({
    email: TEST_OLD_EMAIL,
    newEmail: INJECTION_SCRIPT,
    confirmationUrl: testInjectionConfirmationUrl({ path: '/verify' }),
    token: INJECTION_TOKEN,
    siteUrl: TEST_SITE_URL
  });

  assertEscapesUrlInjection(html);
  assertEscapesTokenMarkup(html);
});

test('changeEmailSubject returns the expected subject line', () => {
  assertSubjectEquals(changeEmailSubject, 'Confirm your new email address');
});
