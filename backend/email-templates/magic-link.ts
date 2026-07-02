/**
 * Transactional email template: passwordless sign-in (magic link).
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

export interface MagicLinkParams {
  /** Email address the sign-in link was requested for. */
  email: string;
  /** URL the recipient clicks to sign in. */
  confirmationUrl: string;
  /** One-time verification code shown as a fallback to the link. */
  token: string;
  /** Public site URL used for the footer brand link. */
  siteUrl: string;
}

export function magicLinkSubject(): string {
  return 'Sign in to Overlord';
}

export function magicLinkHtml({ email, confirmationUrl, token, siteUrl }: MagicLinkParams): string {
  const link = escapeConfirmationUrl(confirmationUrl);

  const cardContent = [
    renderEyebrow('MAGIC LINK'),
    renderHeadline('Sign in to Overlord.'),
    renderBodyBlock(`<p style="margin: 0 0 14px">
                    You asked for a one-time sign-in link for
                    ${emailInlineCode(email)}. Tap the button below to land back in your workspace — no password required.
                  </p>
                  <p style="margin: 0; color: #a8a29e; font-size: 14px">
                    This link expires shortly and can only be used once.
                  </p>`),
    renderCtaButton({ href: link.href, label: 'Sign In&nbsp;→' }),
    renderTokenBlock({ token }),
    renderFallbackLink({ href: link.href, text: link.text })
  ].join('\n');

  return buildTransactionalEmail({
    title: 'Sign in to Overlord.',
    preheader: 'Your one-time sign-in link for Overlord.',
    siteUrl,
    cardContent,
    footerExtra: `<div style="margin: 8px 0">
                  If you didn't request this link, you can ignore this email — your account stays
                  locked.
                </div>`
  });
}
