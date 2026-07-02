/**
 * Transactional email template: confirm a new email address after a change request.
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

export interface ChangeEmailParams {
  /** Current (old) email address on the account. */
  email: string;
  /** New email address being confirmed. */
  newEmail: string;
  /** URL the recipient clicks to confirm the change. */
  confirmationUrl: string;
  /** One-time verification code shown as a fallback to the link. */
  token: string;
  /** Public site URL used for the footer brand link. */
  siteUrl: string;
}

export function changeEmailSubject(): string {
  return 'Confirm your new email address';
}

export function changeEmailHtml({
  email,
  newEmail,
  confirmationUrl,
  token,
  siteUrl
}: ChangeEmailParams): string {
  const link = escapeConfirmationUrl(confirmationUrl);

  const cardContent = [
    renderEyebrow('EMAIL CHANGE'),
    renderHeadline('Confirm your new email address.'),
    renderBodyBlock(`<p style="margin: 0 0 14px">
                    We received a request to change the email on your Overlord account from
                    ${emailInlineCode(email)}
                    to
                    ${emailInlineCode(newEmail)}.
                  </p>
                  <p style="margin: 0">
                    Confirm to finish the switch. Your sign-ins, tickets, and agent history all move
                    with you.
                  </p>`),
    renderCtaButton({ href: link.href, label: 'Confirm New Email&nbsp;→' }),
    renderTokenBlock({ token }),
    renderFallbackLink({ href: link.href, text: link.text })
  ].join('\n');

  return buildTransactionalEmail({
    title: 'Confirm your new email address.',
    preheader: 'Confirm the new email address for your Overlord account.',
    siteUrl,
    cardContent,
    footerExtra: `<div style="margin: 8px 0">
                  If you didn't ask to change your email, ignore this message — nothing will change.
                </div>`
  });
}
