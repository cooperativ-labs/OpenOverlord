import assert from 'node:assert/strict';
import test from 'node:test';

import { inviteUserHtml, inviteUserSubject } from './invite-user.ts';
import {
  assertEscapesUrlInjection,
  assertIncludesSiteUrl,
  assertSubjectNonEmpty,
  assertValidEmailDocument,
  INJECTION_SCRIPT,
  TEST_EMAIL,
  TEST_SITE_URL,
  testConfirmationUrl,
  testInjectionConfirmationUrl
} from './test-fixtures.ts';

test('inviteUserHtml interpolates the email, confirmation URL, and site URL', () => {
  const confirmationUrl = testConfirmationUrl({ path: '/invite' });
  const html = inviteUserHtml({
    email: TEST_EMAIL,
    confirmationUrl,
    siteUrl: TEST_SITE_URL
  });

  assertValidEmailDocument(html);
  assert.ok(html.includes(`href="${confirmationUrl}"`));
  assert.ok(html.includes(TEST_EMAIL));
  assertIncludesSiteUrl(html);
});

test('inviteUserHtml escapes values to prevent attribute/markup injection', () => {
  const html = inviteUserHtml({
    email: INJECTION_SCRIPT,
    confirmationUrl: testInjectionConfirmationUrl({ path: '/invite' }),
    siteUrl: TEST_SITE_URL
  });

  assertEscapesUrlInjection(html);
});

test('inviteUserSubject is a non-empty string', () => {
  assertSubjectNonEmpty(inviteUserSubject);
});
