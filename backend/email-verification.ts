/**
 * Resend-backed verification email sender, injected into `createAuth` as
 * `sendVerificationEmail` (see `auth/src/auth/config.ts` and `backend/auth.ts`).
 *
 * Mirrors the `onDeleteUser` callback-injection pattern: the Auth Layer only
 * knows about an optional callback shape, the Backend supplies the concrete
 * provider. `verificationEmailSenderFromEnv()` returns `undefined` when
 * `RESEND_API_KEY` is unset, which keeps sign-up/sign-in verification
 * disabled entirely (the existing behavior for offline/local editions).
 */

import { Resend } from 'resend';

import type { EmailOTPType } from '../auth/src/auth/config.ts';

import {
  confirmEmailHtml,
  confirmEmailSubject,
  magicLinkHtml,
  magicLinkSubject,
  resetPasswordHtml,
  resetPasswordSubject
} from './email-templates/index.ts';

const FROM_ADDRESS = 'Overlord <verify@notifications.cooperativ.io>';

/** Public site URL used for branded links in transactional emails. */
const SITE_URL = process.env.OVERLORD_SITE_URL ?? 'https://app.ovld.ai';

let resendClient: Resend | null = null;

function requireResendClient(): Resend {
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export async function sendVerificationEmailViaResend({
  user,
  url,
  token,
  otp
}: {
  user: { email: string; name?: string | null };
  url: string;
  token: string;
  /**
   * Real 6-digit OTP minted by the auth layer alongside the link. When present
   * it is shown in the email's code block; the raw verification `token` (a long
   * JWT-style string that cannot be typed as a code) is only used to build the
   * clickable link, never displayed.
   */
  otp?: string;
}): Promise<void> {
  const { error } = await requireResendClient().emails.send({
    from: FROM_ADDRESS,
    to: user.email,
    subject: confirmEmailSubject(),
    html: confirmEmailHtml({ confirmationUrl: url, token: otp ?? token, siteUrl: SITE_URL })
  });
  if (error) {
    throw new Error(`Failed to send verification email via Resend: ${error.message}`);
  }
}

export function verificationEmailSenderFromEnv():
  | typeof sendVerificationEmailViaResend
  | undefined {
  return process.env.RESEND_API_KEY ? sendVerificationEmailViaResend : undefined;
}

/**
 * Deliver a standalone one-time code for the `emailOTP` plugin's passwordless
 * sign-in and password-reset flows (see `sendEmailOTP` in
 * `auth/src/auth/config.ts`). The code is rendered into the matching branded
 * template's 6-digit block; the link is a convenience pointing at the app,
 * where the recipient types the code. Sign-up confirmation does not flow
 * through here — that email is sent by `sendVerificationEmailViaResend` with a
 * minted `otp` already attached.
 */
export async function sendEmailOTPViaResend({
  email,
  otp,
  type
}: {
  email: string;
  otp: string;
  type: EmailOTPType;
}): Promise<void> {
  const { subject, html } = renderEmailOTP({ email, otp, type });
  const { error } = await requireResendClient().emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html
  });
  if (error) {
    throw new Error(`Failed to send ${type} OTP email via Resend: ${error.message}`);
  }
}

function renderEmailOTP({ email, otp, type }: { email: string; otp: string; type: EmailOTPType }): {
  subject: string;
  html: string;
} {
  switch (type) {
    case 'forget-password':
      return {
        subject: resetPasswordSubject(),
        html: resetPasswordHtml({
          email,
          confirmationUrl: `${SITE_URL}/reset-password`,
          token: otp,
          siteUrl: SITE_URL
        })
      };
    // sign-in, email-verification, and change-email all present the same
    // "here is your one-time code" surface; email-verification is normally sent
    // via the sign-up link path, so this callback path handles sign-in codes.
    default:
      return {
        subject: magicLinkSubject(),
        html: magicLinkHtml({
          email,
          confirmationUrl: SITE_URL,
          token: otp,
          siteUrl: SITE_URL
        })
      };
  }
}

export function emailOTPSenderFromEnv(): typeof sendEmailOTPViaResend | undefined {
  return process.env.RESEND_API_KEY ? sendEmailOTPViaResend : undefined;
}
