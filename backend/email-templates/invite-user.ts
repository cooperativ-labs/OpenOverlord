/**
 * Transactional email template: workspace invite.
 */

import {
  buildTransactionalEmail,
  emailInlineCode,
  escapeConfirmationUrl,
  renderBodyBlock,
  renderCtaButton,
  renderEyebrow,
  renderFallbackLink,
  renderHeadline
} from './layout.ts';

export interface InviteUserParams {
  /** Email address the invite was sent to. */
  email: string;
  /** URL the recipient clicks to accept the invite. */
  confirmationUrl: string;
  /** Public site URL used for the footer brand link. */
  siteUrl: string;
}

export function inviteUserSubject(): string {
  return "You've been invited to Overlord";
}

export function inviteUserHtml({ email, confirmationUrl, siteUrl }: InviteUserParams): string {
  const link = escapeConfirmationUrl(confirmationUrl);

  const cardContent = [
    renderEyebrow('WORKSPACE INVITE'),
    renderHeadline("You've been invited to Overlord."),
    renderBodyBlock(`<p style="margin: 0 0 14px">
                    Someone added
                    ${emailInlineCode(email)}
                    to a workspace on Overlord — a control plane for running AI coding agents on
                    tickets, with human review on every diff.
                  </p>
                  <p style="margin: 0">
                    Accept the invite to set up your account and join the board.
                  </p>`),
    renderCtaButton({ href: link.href, label: 'Accept Invite&nbsp;→' }),
    renderFallbackLink({ href: link.href, text: link.text })
  ].join('\n');

  return buildTransactionalEmail({
    title: "You've been invited to Overlord.",
    preheader: "You've been invited to a workspace on Overlord.",
    siteUrl,
    cardContent
  });
}
