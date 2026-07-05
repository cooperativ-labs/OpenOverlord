import assert from 'node:assert/strict';

/** Shared fixture values for email template tests. */
export const TEST_SITE_URL = 'https://app.ovld.ai';
export const TEST_TOKEN = '482913';
export const TEST_EMAIL = 'user@example.com';
export const TEST_OLD_EMAIL = 'old@example.com';
export const TEST_NEW_EMAIL = 'new@example.com';

export const INJECTION_SCRIPT = '"><script>x</script>';
export const INJECTION_TOKEN = '<b>1</b>';

export function testConfirmationUrl({ path }: { path: string }): string {
  return `${TEST_SITE_URL}${path}?token=abc123`;
}

export function testInjectionConfirmationUrl({ path }: { path: string }): string {
  return `${TEST_SITE_URL}${path}?a=1&b=${INJECTION_SCRIPT}`;
}

export function assertValidEmailDocument(html: string): void {
  assert.match(html, /<!doctype html>/i);
}

export function assertIncludesSiteUrl(html: string): void {
  assert.ok(html.includes(`href="${TEST_SITE_URL}"`));
}

export function assertSubjectEquals(subjectFn: () => string, expected: string): void {
  assert.equal(subjectFn(), expected, `subject line regressed; expected exactly "${expected}"`);
}

export function assertEscapesUrlInjection(html: string): void {
  assert.ok(!html.includes(INJECTION_SCRIPT));
  assert.ok(html.includes('a=1&amp;b=&quot;&gt;&lt;script&gt;'));
}

export function assertEscapesTokenMarkup(html: string): void {
  assert.ok(html.includes('&lt;b&gt;1&lt;/b&gt;'));
}
