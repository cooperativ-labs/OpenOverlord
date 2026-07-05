import assert from 'node:assert/strict';
import test from 'node:test';

import { resetPasswordHtml, resetPasswordSubject } from './reset-password.ts';
import {
  assertEscapesUrlInjection,
  assertIncludesSiteUrl,
  assertSubjectEquals,
  assertValidEmailDocument,
  INJECTION_SCRIPT,
  TEST_EMAIL,
  TEST_SITE_URL,
  TEST_TOKEN,
  testConfirmationUrl,
  testInjectionConfirmationUrl
} from './test-fixtures.ts';

test('resetPasswordHtml interpolates the email, confirmation URL, and site URL', () => {
  const confirmationUrl = testConfirmationUrl({ path: '/reset' });
  const html = resetPasswordHtml({
    email: TEST_EMAIL,
    confirmationUrl,
    siteUrl: TEST_SITE_URL
  });

  assertValidEmailDocument(html);
  assert.ok(html.includes(`href="${confirmationUrl}"`));
  assert.ok(html.includes(TEST_EMAIL));
  assertIncludesSiteUrl(html);
});

test('resetPasswordHtml escapes values to prevent attribute/markup injection', () => {
  const html = resetPasswordHtml({
    email: INJECTION_SCRIPT,
    confirmationUrl: testInjectionConfirmationUrl({ path: '/reset' }),
    siteUrl: TEST_SITE_URL
  });

  assertEscapesUrlInjection(html);
});

test('resetPasswordHtml renders the 6-digit code block only when a token is provided', () => {
  const confirmationUrl = testConfirmationUrl({ path: '/reset' });

  const withCode = resetPasswordHtml({
    email: TEST_EMAIL,
    confirmationUrl,
    token: TEST_TOKEN,
    siteUrl: TEST_SITE_URL
  });
  assert.ok(withCode.includes(TEST_TOKEN), 'the OTP code must appear when a token is given');
  assert.ok(withCode.includes('OR USE CODE'), 'the code block label must render with a token');

  const withoutCode = resetPasswordHtml({
    email: TEST_EMAIL,
    confirmationUrl,
    siteUrl: TEST_SITE_URL
  });
  assert.ok(
    !withoutCode.includes('OR USE CODE'),
    'the code block must be omitted for link-only resets'
  );
});

test('resetPasswordSubject returns the expected subject line', () => {
  assertSubjectEquals(resetPasswordSubject, 'Reset your password');
});
