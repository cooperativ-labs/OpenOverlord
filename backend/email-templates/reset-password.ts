/**
 * Transactional email template: password reset.
 */

import {
  buildTransactionalEmail,
  emailInlineCode,
  escapeConfirmationUrl,
  renderBodyBlock,
  renderCtaButton,
  renderEyebrow,
  renderFallbackLink,
  renderHeadline,
  renderTokenBlock
} from './layout.ts';

export interface ResetPasswordParams {
  /** Email address the reset was requested for. */
  email: string;
  /** URL the recipient clicks to reset their password. */
  confirmationUrl: string;
  /**
   * Optional one-time 6-digit code shown as a typed alternative to the link,
   * for the OTP-driven password-reset flow. Omit for link-only resets.
   */
  token?: string;
  /** Public site URL used for the footer brand link. */
  siteUrl: string;
}

export function resetPasswordSubject(): string {
  return 'Reset your password';
}

export function resetPasswordHtml({
  email,
  confirmationUrl,
  token,
  siteUrl
}: ResetPasswordParams): string {
  const link = escapeConfirmationUrl(confirmationUrl);

  const cardContent = [
    renderEyebrow('PASSWORD RESET'),
    renderHeadline('Reset your password.'),
    renderBodyBlock(`<p style="margin: 0 0 14px">
                    Someone requested a password reset for
                    ${emailInlineCode(email)}. If that was you, set a new one below.
                  </p>
                  <p style="margin: 0; color: #a8a29e; font-size: 14px">
                    This link expires in 1 hour. After resetting, all other active sessions will be
                    signed out.
                  </p>`),
    renderCtaButton({ href: link.href, label: 'Reset Password&nbsp;→' }),
    ...(token ? [renderTokenBlock({ token })] : []),
    renderFallbackLink({ href: link.href, text: link.text })
  ].join('\n');

  return buildTransactionalEmail({
    title: 'Reset your password.',
    preheader: 'Reset your Overlord password.',
    siteUrl,
    cardContent,
    footerExtra: `<div style="margin: 8px 0">
                  If you didn't request a reset, you can safely ignore this email — your password
                  won't change.
                </div>`
  });
}
