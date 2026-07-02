/**
 * Resend-backed workspace-invitation email sender, used by
 * `inviteWorkspaceMember` (`backend/workspaces.ts`). Mirrors
 * `backend/email-verification.ts`: `invitationEmailSenderFromEnv()` returns
 * `undefined` when `RESEND_API_KEY` is unset, which keeps invitations working
 * (the invitation row is still created) but silently skips sending the email —
 * matching the offline/local-edition behavior of verification email.
 */

import { Resend } from 'resend';

import { inviteUserHtml, inviteUserSubject } from './email-templates/index.ts';

const FROM_ADDRESS = 'Overlord <verify@notifications.cooperativ.io>';

/** Public site URL used for branded links in transactional emails. */
const SITE_URL = process.env.OVERLORD_SITE_URL ?? 'https://app.ovld.ai';

let resendClient: Resend | null = null;

function requireResendClient(): Resend {
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export async function sendInviteEmailViaResend({
  email,
  confirmationUrl
}: {
  email: string;
  confirmationUrl: string;
}): Promise<void> {
  const { error } = await requireResendClient().emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject: inviteUserSubject(),
    html: inviteUserHtml({ email, confirmationUrl, siteUrl: SITE_URL })
  });
  if (error) {
    throw new Error(`Failed to send invitation email via Resend: ${error.message}`);
  }
}

export function invitationEmailSenderFromEnv(): typeof sendInviteEmailViaResend | undefined {
  return process.env.RESEND_API_KEY ? sendInviteEmailViaResend : undefined;
}

/** Accept-invite landing page URL the recipient's browser lands on. */
export function inviteAcceptUrl(rawToken: string): string {
  return `${SITE_URL}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}
