/**
 * Transactional email template: password reset.
 */

import { escapeHtmlAttribute, escapeHtmlText } from './html.ts';

export interface ResetPasswordParams {
  /** Email address the reset was requested for. */
  email: string;
  /** URL the recipient clicks to reset their password. */
  confirmationUrl: string;
  /** Public site URL used for the footer brand link. */
  siteUrl: string;
}

export function resetPasswordSubject(): string {
  return 'Reset your password';
}

export function resetPasswordHtml({
  email,
  confirmationUrl,
  siteUrl
}: ResetPasswordParams): string {
  const confirmationHref = escapeHtmlAttribute(confirmationUrl);
  const confirmationText = escapeHtmlText(confirmationUrl);
  const emailText = escapeHtmlText(email);
  const siteHref = escapeHtmlAttribute(siteUrl);

  return `<!doctype html>
<html lang="en" style="margin: 0; padding: 0">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <title>Reset your password.</title>
    <!--[if mso]>
      <style>
        * {
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif !important;
        }
      </style>
    <![endif]-->
    <style>
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap');
      body,
      table,
      td,
      a {
        -webkit-text-size-adjust: 100%;
        -ms-text-size-adjust: 100%;
      }
      table,
      td {
        mso-table-lspace: 0pt;
        mso-table-rspace: 0pt;
      }
      img {
        -ms-interpolation-mode: bicubic;
        border: 0;
        outline: none;
        text-decoration: none;
      }
      body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
      }
      a {
        color: #1c1917;
      }
      a.cta:hover {
        background: #000 !important;
      }
      a.text-link:hover {
        text-decoration: underline !important;
      }
      /* Responsive */
      @media only screen and (max-width: 620px) {
        .container {
          width: 100% !important;
          padding-left: 20px !important;
          padding-right: 20px !important;
        }
        .card {
          padding: 28px 24px !important;
          border-radius: 18px !important;
        }
        .headline {
          font-size: 26px !important;
          line-height: 1.15 !important;
        }
        .otp {
          font-size: 30px !important;
          letter-spacing: 8px !important;
        }
        .footer {
          padding: 24px 24px 32px !important;
        }
        .stack-block {
          padding: 14px 16px !important;
        }
      }
    </style>
  </head>
  <body
    style="
      margin: 0;
      padding: 0;
      background: #f6f4ef;
      font-family: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      color: #1c1917;
    "
  >
    <!-- Preheader (hidden in clients, shown in inbox preview) -->
    <div
      style="
        display: none;
        max-height: 0;
        overflow: hidden;
        mso-hide: all;
        font-size: 1px;
        line-height: 1px;
        color: #f6f4ef;
      "
    >
      Reset your Overlord password.
    </div>

    <table
      role="presentation"
      cellpadding="0"
      cellspacing="0"
      border="0"
      width="100%"
      style="background: #f6f4ef"
    >
      <tr>
        <td align="center" style="padding: 32px 16px 8px">
          <!-- Brand row -->
          <table
            role="presentation"
            cellpadding="0"
            cellspacing="0"
            border="0"
            width="600"
            class="container"
            style="max-width: 600px; width: 100%"
          >
            <tr>
              <td align="left" style="padding: 0 4px 24px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align: middle; padding-right: 12px">
                      <img
                        src="https://zitmmhvbilhjjdwgxlfm.supabase.co/storage/v1/object/public/org-images/Overlord/256.png"
                        width="36"
                        height="36"
                        alt="Overlord"
                        style="display: block; width: 36px; height: 36px; border-radius: 8px"
                      />
                    </td>
                    <td
                      style="
                        vertical-align: middle;
                        font-family:
                          'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                        font-weight: 600;
                        font-size: 18px;
                        letter-spacing: -0.02em;
                        color: #1c1917;
                      "
                    >
                      Overlord
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>

          <!-- Card -->
          <table
            role="presentation"
            cellpadding="0"
            cellspacing="0"
            border="0"
            width="600"
            class="container"
            style="max-width: 600px; width: 100%"
          >
            <tr>
              <td
                class="card"
                style="
                  background: #ffffff;
                  border: 1px solid #e7e5e0;
                  border-radius: 20px;
                  padding: 40px 40px 36px;
                "
              >
                <!-- Eyebrow -->
                <div
                  style="
                    font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.22em;
                    text-transform: uppercase;
                    color: #a8a29e;
                    margin: 0 0 18px;
                  "
                >
                  PASSWORD RESET
                </div>
                <!-- Headline -->
                <h1
                  class="headline"
                  style="
                    margin: 0 0 16px;
                    font-family: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-weight: 600;
                    font-size: 30px;
                    line-height: 1.1;
                    letter-spacing: -0.04em;
                    color: #1c1917;
                  "
                >
                  Reset your password.
                </h1>
                <!-- Body -->
                <div
                  style="
                    font-family: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-size: 16px;
                    line-height: 1.6;
                    color: #57534e;
                  "
                >
                  <p style="margin: 0 0 14px">
                    Someone requested a password reset for
                    <span
                      style="
                        font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
                        font-size: 0.92em;
                        background: #f4f3ee;
                        border: 1px solid #e7e5e0;
                        border-radius: 4px;
                        padding: 1px 6px;
                        color: #1c1917;
                      "
                      >${emailText}</span
                    >. If that was you, set a new one below.
                  </p>
                  <p style="margin: 0; color: #a8a29e; font-size: 14px">
                    This link expires in 1 hour. After resetting, all other active sessions will be
                    signed out.
                  </p>
                </div>

                <!-- CTA -->
                <table
                  role="presentation"
                  cellpadding="0"
                  cellspacing="0"
                  border="0"
                  style="margin: 28px 0 8px"
                >
                  <tr>
                    <td style="background: #1c1917; border-radius: 9999px">
                      <a
                        class="cta"
                        href="${confirmationHref}"
                        style="
                          display: inline-block;
                          padding: 14px 28px;
                          font-family:
                            'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                          font-weight: 600;
                          font-size: 15px;
                          letter-spacing: -0.01em;
                          color: #fafaf7;
                          text-decoration: none;
                          border-radius: 9999px;
                        "
                      >
                        Reset Password&nbsp;→
                      </a>
                    </td>
                  </tr>
                </table>

                <div
                  style="
                    margin-top: 24px;
                    padding-top: 24px;
                    border-top: 1px solid #e7e5e0;
                    font-family: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-size: 13px;
                    line-height: 1.5;
                    color: #a8a29e;
                  "
                >
                  Button doesn't work? Paste this URL into your browser:<br />
                  <a
                    class="text-link"
                    href="${confirmationHref}"
                    style="color: #57534e; word-break: break-all; text-decoration: underline"
                    >${confirmationText}</a
                  >
                </div>
              </td>
            </tr>
          </table>

          <!-- Footer -->
          <table
            role="presentation"
            cellpadding="0"
            cellspacing="0"
            border="0"
            width="600"
            class="container"
            style="max-width: 600px; width: 100%"
          >
            <tr>
              <td
                class="footer"
                align="left"
                style="
                  padding: 28px 4px 40px;
                  font-family: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                  font-size: 12px;
                  line-height: 1.6;
                  color: #a8a29e;
                "
              >
                <div style="margin-bottom: 8px">
                  <a
                    class="text-link"
                    href="${siteHref}"
                    style="color: #57534e; text-decoration: none; font-weight: 500"
                    >ovld.ai</a
                  >
                  &nbsp;·&nbsp; Agent work, organized.
                </div>
                <div style="margin: 8px 0">
                  If you didn't request a reset, you can safely ignore this email — your password
                  won't change.
                </div>
                <div style="margin-top: 8px; color: #a8a29e">
                  You're receiving this because someone — probably you — used this email address
                  with Overlord. If that wasn't you, you can safely ignore this message.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
