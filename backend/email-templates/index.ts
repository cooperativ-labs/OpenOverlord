/**
 * Transactional email templates.
 *
 * Each template is a pure function that renders a full HTML document from typed
 * parameters, ready to hand to the email provider (Resend — see
 * `backend/email-verification.ts`). Add new transactional templates
 * (password reset, invitations, etc.) as sibling modules and re-export them here.
 */

export { changeEmailHtml, type ChangeEmailParams, changeEmailSubject } from './change-email.ts';
export { confirmEmailHtml, type ConfirmEmailParams, confirmEmailSubject } from './confirm-email.ts';
export { inviteUserHtml, type InviteUserParams, inviteUserSubject } from './invite-user.ts';
export { magicLinkHtml, type MagicLinkParams, magicLinkSubject } from './magic-link.ts';
export {
  resetPasswordHtml,
  type ResetPasswordParams,
  resetPasswordSubject
} from './reset-password.ts';
