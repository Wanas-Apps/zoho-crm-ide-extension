/**
 * Wanas Apps branding for the OAuth callback page. The logo is loaded from
 * `images/WanasApps-logo.svg` and embedded as a base64 data-URI `<img>` so the
 * success/failure page remains fully self-contained — the short-lived loopback
 * server never has to serve a second asset request.
 */

import * as fs from 'fs';
import * as path from 'path';

export const WANAS_WEBSITE = 'https://www.wanasapps.com';
export const WANAS_SUPPORT_EMAIL = 'support@wanasapps.com';

/**
 * Lazily-resolved base64 data URI for the Wanas Apps logo.
 * Read once on first access, then cached for the process lifetime.
 */
let _logoDataUri: string | undefined;
function getLogoDataUri(): string {
    if (_logoDataUri === undefined) {
        // The logo SVG ships at `<extensionRoot>/images/WanasApps-logo.svg`.
        // `__dirname` differs by build: the shipped bundle is
        // `<extensionRoot>/dist/extension.js` (→ `../images`), while the tsc
        // output the tests load is `<extensionRoot>/out/zoho/branding.js`
        // (→ `../../images`). Try both, and degrade to no logo (rather than
        // crashing the loopback callback) if the asset can't be found.
        const candidates = [
            path.join(__dirname, '..', 'images', 'WanasApps-logo.svg'),
            path.join(__dirname, '..', '..', 'images', 'WanasApps-logo.svg')
        ];
        _logoDataUri = '';
        for (const logoPath of candidates) {
            try {
                const svgBytes = fs.readFileSync(logoPath);
                _logoDataUri = `data:image/svg+xml;base64,${svgBytes.toString('base64')}`;
                break;
            } catch {
                /* try the next candidate */
            }
        }
    }
    return _logoDataUri;
}

/** Escape user-supplied text for safe HTML interpolation. */
export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
    );
}

/**
 * Render the branded OAuth result page. `status === 200` reads as success
 * (green); anything else reads as failure (red). Includes the Wanas Apps logo,
 * a website link, and a contact-for-help prompt.
 */
export function renderBrandedPage(opts: { status: number; title: string; message: string }): string {
    const ok = opts.status === 200;
    const title = escapeHtml(opts.title);
    const message = escapeHtml(opts.message);
    const logoSrc = getLogoDataUri();
    const logoBlock = logoSrc
        ? `<div class="wa-logo"><img src="${logoSrc}" alt="Wanas Apps" /></div>`
        : '';
    // Status is conveyed by a glyph + text, never colour alone (accessibility).
    const mark = ok ? '✓' : '✕';
    const statusClass = ok ? 'ok' : 'fail';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Wanas Apps</title>
<style>
  :root {
    color-scheme: light dark;
    --wa-bg: #0b0f19; --wa-fg: #f3f4f6; --wa-muted: #9ca3af; --wa-sub: #cbd5e1;
    --wa-rule: #1f2937; --wa-foot: #6b7280; --wa-link: #3b9dff;
    --wa-ok: #10b981; --wa-fail: #ef4444;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --wa-bg: #f6f8fa; --wa-fg: #1f2328; --wa-muted: #57606a; --wa-sub: #424a53;
      --wa-rule: #d0d7de; --wa-foot: #6e7781; --wa-link: #0969da;
      --wa-ok: #1a7f37; --wa-fail: #cf222e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, "Segoe UI", Arial, sans-serif;
    background: var(--wa-bg); color: var(--wa-fg);
  }
  .card { text-align: center; max-width: 520px; padding: 40px 28px; }
  .wa-logo { max-width: 240px; margin: 0 auto 28px; }
  .wa-logo img { width: 100%; height: auto; display: block; }
  .status { font-size: 24px; margin: 0 0 10px; }
  .status.ok { color: var(--wa-ok); }
  .status.fail { color: var(--wa-fail); }
  .status .mark { margin-right: 8px; }
  .msg { color: var(--wa-muted); margin: 0 0 28px; line-height: 1.5; }
  .rule { height: 1px; background: var(--wa-rule); margin: 28px auto; max-width: 360px; }
  .ask { color: var(--wa-sub); margin: 0 0 10px; }
  .links { margin: 0 0 24px; }
  a { color: var(--wa-link); text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  .foot { color: var(--wa-foot); font-size: 12px; margin: 0; }
  @media (forced-colors: active) {
    .status.ok, .status.fail, a { color: LinkText; }
    .msg, .ask, .foot { color: CanvasText; }
  }
</style>
</head>
<body>
  <div class="card">
    ${logoBlock}
    <h1 class="status ${statusClass}"><span class="mark" aria-hidden="true">${mark}</span>${title}</h1>
    <p class="msg">${message}</p>
    <div class="rule"></div>
    <p class="ask">Need a hand, or want a custom Zoho build?</p>
    <p class="links"><a href="${WANAS_WEBSITE}">wanasapps.com</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="mailto:${WANAS_SUPPORT_EMAIL}">Contact us for help</a></p>
    <p class="foot">Wanas Apps · Zoho CRM IDE Extension</p>
  </div>
</body>
</html>`;
}

