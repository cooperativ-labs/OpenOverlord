/**
 * Transactional email template: sign-up / sign-in email confirmation.
 */

import {
  buildTransactionalEmail,
  escapeConfirmationUrl,
  renderBodyBlock,
  renderCtaButton,
  renderEyebrow,
  renderFallbackLink,
  renderHeadline,
  renderTokenBlock
} from './layout.ts';

export interface ConfirmEmailParams {
  /** URL the recipient clicks to confirm their address. */
  confirmationUrl: string;
  /** One-time verification code shown as a fallback to the link. */
  token: string;
  /** Public site URL used for the footer brand link. */
  siteUrl: string;
}

export function confirmEmailSubject(): string {
  return 'Confirm your email to start running agents';
}

export function confirmEmailHtml({ confirmationUrl, token, siteUrl }: ConfirmEmailParams): string {
  const link = escapeConfirmationUrl(confirmationUrl);

  const cardContent = [
    renderEyebrow('CONFIRM SIGNUP'),
    renderHeadline('Confirm your email to start running agents.'),
    renderBodyBlock(`<p style="margin: 0 0 14px">
                    Welcome to Overlord. One last step — confirm this is your email address so we
                    can open up your workspace.
                  </p>
                  <p style="margin: 0">
                    Once confirmed, you can create tickets, assign Claude Code, Codex, Cursor,
                    Gemini, or OpenCode, and review diffs before anything lands.
                  </p>`),
    renderCtaButton({ href: link.href, label: 'Confirm Email&nbsp;→' }),
    renderTokenBlock({ token }),
    renderFallbackLink({ href: link.href, text: link.text })
  ].join('\n');

  return buildTransactionalEmail({
    title: 'Confirm your email to start running agents.',
    preheader: 'Confirm your email to finish setting up Overlord.',
    siteUrl,
    cardContent
  });
}
