import { EMAIL_BRAND, STANDARD_DISCLAIMER } from './constants.ts';
import { escapeHtmlAttribute, escapeHtmlText } from './html.ts';

const EMAIL_STYLES = `
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
      }`;

export interface TransactionalEmailParams {
  title: string;
  preheader: string;
  siteUrl: string;
  cardContent: string;
  footerExtra?: string;
}

/** Escape a URL for use in href attributes and visible fallback link text. */
export function escapeConfirmationUrl(url: string): { href: string; text: string } {
  return {
    href: escapeHtmlAttribute(url),
    text: escapeHtmlText(url)
  };
}

/** Inline monospace chip for email addresses and similar values. */
export function emailInlineCode(value: string): string {
  return `<span
                      style="
                        font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
                        font-size: 0.92em;
                        background: #f4f3ee;
                        border: 1px solid #e7e5e0;
                        border-radius: 4px;
                        padding: 1px 6px;
                        color: #1c1917;
                      "
                      >${escapeHtmlText(value)}</span>`;
}

export function renderEyebrow(text: string): string {
  return `<div
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
                  ${escapeHtmlText(text)}
                </div>`;
}

export function renderHeadline(text: string): string {
  return `<h1
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
                  ${escapeHtmlText(text)}
                </h1>`;
}

export function renderBodyBlock(innerHtml: string): string {
  return `<div
                  style="
                    font-family: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-size: 16px;
                    line-height: 1.6;
                    color: #57534e;
                  "
                >
                  ${innerHtml}
                </div>`;
}

export function renderCtaButton({ href, label }: { href: string; label: string }): string {
  return `<table
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
                        href="${href}"
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
                        ${label}
                      </a>
                    </td>
                  </tr>
                </table>`;
}

export function renderFallbackLink({ href, text }: { href: string; text: string }): string {
  return `<div
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
                    href="${href}"
                    style="color: #57534e; word-break: break-all; text-decoration: underline"
                    >${text}</a
                  >
                </div>`;
}

export function renderTokenBlock({ token }: { token: string }): string {
  const tokenText = escapeHtmlText(token);

  return `<table
                  role="presentation"
                  cellpadding="0"
                  cellspacing="0"
                  border="0"
                  width="100%"
                  style="margin: 28px 0 24px"
                >
                  <tr>
                    <td
                      style="
                        border-top: 1px solid #e7e5e0;
                        text-align: center;
                        position: relative;
                      "
                    >
                      <span
                        style="
                          background: #ffffff;
                          padding: 0 12px;
                          position: relative;
                          top: -10px;
                          font-family: 'IBM Plex Mono', monospace;
                          font-size: 11px;
                          letter-spacing: 0.18em;
                          color: #a8a29e;
                          text-transform: uppercase;
                        "
                      >
                        OR USE CODE
                      </span>
                    </td>
                  </tr>
                </table>

                <div style="text-align: center; margin-bottom: 12px">
                  <div
                    style="
                      font-family: 'Space Grotesk', sans-serif;
                      font-size: 14px;
                      color: #78716c;
                      margin-bottom: 12px;
                    "
                  >
                    Enter this verification code in Overlord
                  </div>
                  <div
                    class="otp"
                    style="
                      display: inline-block;
                      padding: 18px 24px;
                      background: #fafaf9;
                      border: 1px solid #e7e5e0;
                      border-radius: 16px;
                      font-family: 'IBM Plex Mono', monospace;
                      font-size: 34px;
                      font-weight: 500;
                      letter-spacing: 0.35em;
                      color: #1c1917;
                      line-height: 1;
                    "
                  >
                    ${tokenText}
                  </div>
                  <div
                    style="
                      margin-top: 12px;
                      font-family: 'Space Grotesk', sans-serif;
                      font-size: 13px;
                      color: #a8a29e;
                    "
                  >
                    This code expires in 1 hour.
                  </div>
                </div>`;
}

export function buildTransactionalEmail({
  title,
  preheader,
  siteUrl,
  cardContent,
  footerExtra = ''
}: TransactionalEmailParams): string {
  const siteHref = escapeHtmlAttribute(siteUrl);
  const logoHref = escapeHtmlAttribute(`${siteUrl.replace(/\/$/, '')}${EMAIL_BRAND.logoPath}`);
  const preheaderText = escapeHtmlText(preheader);

  return `<!doctype html>
<html lang="en" style="margin: 0; padding: 0">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <title>${escapeHtmlText(title)}</title>
    <!--[if mso]>
      <style>
        * {
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif !important;
        }
      </style>
    <![endif]-->
    <style>${EMAIL_STYLES}
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
      ${preheaderText}
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
                        src="${logoHref}"
                        width="36"
                        height="36"
                        alt="${EMAIL_BRAND.name}"
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
                      ${EMAIL_BRAND.name}
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
                ${cardContent}
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
                    >${EMAIL_BRAND.domainLabel}</a
                  >
                  &nbsp;·&nbsp; ${EMAIL_BRAND.tagline}
                </div>
                ${footerExtra}
                <div style="margin-top: 8px; color: #a8a29e">
                  ${STANDARD_DISCLAIMER}
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
