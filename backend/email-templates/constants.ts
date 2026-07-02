/** Shared brand values used across transactional email templates. */
export const EMAIL_BRAND = {
  name: 'Overlord',
  domainLabel: 'app.ovld.ai',
  tagline: 'Agent work, organized.',
  logoPath: '/images/256.png'
} as const;

export const STANDARD_DISCLAIMER =
  "You're receiving this because someone — probably you — used this email address with Overlord. If that wasn't you, you can safely ignore this message.";
