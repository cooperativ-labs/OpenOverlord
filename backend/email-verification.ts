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

import { confirmEmailHtml, confirmEmailSubject } from './email-templates/index.ts';

const FROM_ADDRESS = 'Overlord <verify@notifications.cooperativ.io>';

/** Public site URL used for branded links in transactional emails. */
const SITE_URL = process.env.OVERLORD_SITE_URL ?? 'https://ovld.ai';

let resendClient: Resend | null = null;

function requireResendClient(): Resend {
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export async function sendVerificationEmailViaResend({
  user,
  url,
  token
}: {
  user: { email: string; name?: string | null };
  url: string;
  token: string;
}): Promise<void> {
  const { error } = await requireResendClient().emails.send({
    from: FROM_ADDRESS,
    to: user.email,
    subject: confirmEmailSubject(),
    html: confirmEmailHtml({ confirmationUrl: url, token, siteUrl: SITE_URL })
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
