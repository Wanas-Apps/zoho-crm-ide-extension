import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DEFAULT_PORTS, CALLBACK_PATH } from './oauth';

export interface CollectedCredentials {
    dc: string;
    clientId: string;
    clientSecret: string;
}

const DC_CHOICES = ['com', 'eu', 'in', 'jp', 'com.au', 'com.cn', 'ca', 'sa'];

const DC_LABELS: Record<string, string> = {
    com: 'zoho.com (US)',
    eu: 'zoho.eu (Europe)',
    in: 'zoho.in (India)',
    jp: 'zoho.jp (Japan)',
    'com.au': 'zoho.com.au (Australia)',
    'com.cn': 'zoho.com.cn (China)',
    ca: 'zohocloud.ca (Canada)',
    sa: 'zoho.sa (Saudi Arabia)'
};

/**
 * Proxy-mode sign-in: the Client ID/Secret live in the backend proxy, so the
 * user only needs to pick their data center. A lightweight quick-pick replaces
 * the BYO credentials webview. Returns the chosen `dc`, or undefined if cancelled.
 */
export async function collectDataCenter(existingDc?: string): Promise<string | undefined> {
    const current = existingDc && DC_CHOICES.includes(existingDc) ? existingDc : 'com';
    const items: vscode.QuickPickItem[] = DC_CHOICES.map((dc) => ({
        label: dc,
        description: DC_LABELS[dc],
        picked: dc === current
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Connect to Zoho CRM — select your data center',
        placeHolder: `Your org's Zoho domain suffix (currently: ${current})`,
        ignoreFocusOut: true
    });
    return picked?.label;
}

/**
 * Show a hardened-CSP webview that collects the user's BYO Zoho Server-based
 * app credentials (DC + client_id + client_secret) with inline registration
 * instructions. The client_secret only ever transits the webview→extension
 * postMessage boundary; the caller persists it to SecretStorage. Returns
 * undefined if the user cancels or closes the panel.
 */
export function collectCredentials(
    existing: { dc?: string; clientId?: string },
    ports: number[] = DEFAULT_PORTS
): Promise<CollectedCredentials | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'zohoDeluge.login',
            'Sign in to Zoho CRM',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false }
        );

        const nonce = crypto.randomBytes(16).toString('base64');
        const redirectUris = ports.map((p) => `http://127.0.0.1:${p}${CALLBACK_PATH}`);
        panel.webview.html = renderHtml(panel.webview, nonce, redirectUris, existing);

        let done = false;
        const finish = (result: CollectedCredentials | undefined) => {
            if (done) {
                return;
            }
            done = true;
            resolve(result);
            panel.dispose();
        };

        panel.webview.onDidReceiveMessage((msg) => {
            if (!msg || typeof msg !== 'object') {
                return;
            }
            if (msg.type === 'submit') {
                const dc = typeof msg.dc === 'string' && msg.dc ? msg.dc : 'com';
                const clientId = typeof msg.clientId === 'string' ? msg.clientId.trim() : '';
                const clientSecret = typeof msg.clientSecret === 'string' ? msg.clientSecret.trim() : '';
                if (!clientId || !clientSecret) {
                    return; // client-side already validates; ignore incomplete submits
                }
                finish({ dc, clientId, clientSecret });
            } else if (msg.type === 'cancel') {
                finish(undefined);
            }
        });

        panel.onDidDispose(() => finish(undefined));
    });
}

function renderHtml(
    webview: vscode.Webview,
    nonce: string,
    redirectUris: string[],
    existing: { dc?: string; clientId?: string }
): string {
    const csp = [
        `default-src 'none'`,
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`
    ].join('; ');

    const options = DC_CHOICES.map(
        (dc) => `<option value="${dc}"${dc === (existing.dc || 'com') ? ' selected' : ''}>${escapeHtml(DC_LABELS[dc] || dc)}</option>`
    ).join('');
    const uriList = redirectUris.map((u) => `<li><code>${escapeHtml(u)}</code></li>`).join('');
    const existingClientId = escapeHtml(existing.clientId || '');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 24px 32px; max-width: 720px; }
  h1 { font-size: 1.4em; }
  ol { line-height: 1.6; padding-left: 20px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  ul.uris { list-style: none; padding-left: 0; }
  ul.uris li { margin: 4px 0; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input, select { width: 100%; padding: 6px 8px; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
  .row { display: flex; gap: 12px; margin-top: 24px; }
  button { padding: 7px 16px; border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: default; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
  .err { color: var(--vscode-errorForeground); font-size: 0.9em; min-height: 1.2em; margin-top: 6px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 24px 0; }
</style>
</head>
<body>
  <h1>Connect this folder to Zoho CRM</h1>
  <p class="hint">Your credentials are stored in the OS keychain for this workspace folder only. The Client Secret is never written into your project.</p>

  <ol>
    <li>Open the <b>Zoho API Console</b> (<code>api-console.zoho.&lt;dc&gt;</code>) and create a <b>Server-based Application</b>.</li>
    <li>Under <b>Authorized Redirect URIs</b>, add all of these (so any free local port works):
      <ul class="uris">${uriList}</ul>
    </li>
    <li>Copy the generated <b>Client ID</b> and <b>Client Secret</b> into the fields below.</li>
  </ol>

  <hr />

  <label for="dc">Data center</label>
  <select id="dc">${options}</select>
  <div class="hint">The Zoho domain suffix for your org (e.g. <code>com</code> for zoho.com).</div>

  <label for="clientId">Client ID</label>
  <input id="clientId" type="text" autocomplete="off" spellcheck="false" autofocus aria-required="true" value="${existingClientId}" placeholder="1000.XXXXXXXXXXXXXXXX" />

  <label for="clientSecret">Client Secret</label>
  <input id="clientSecret" type="password" autocomplete="off" spellcheck="false" aria-required="true" placeholder="••••••••••••••••" />

  <div id="err" class="err" role="alert" aria-live="assertive"></div>

  <div class="row">
    <button id="signin" class="primary">Sign in</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  $('clientId').focus();
  $('signin').addEventListener('click', () => {
    const clientId = $('clientId').value.trim();
    const clientSecret = $('clientSecret').value.trim();
    $('clientId').setAttribute('aria-invalid', String(!clientId));
    $('clientSecret').setAttribute('aria-invalid', String(!clientSecret));
    if (!clientId || !clientSecret) {
      $('err').textContent = 'Enter both the Client ID and Client Secret.';
      (clientId ? $('clientSecret') : $('clientId')).focus();
      return;
    }
    $('err').textContent = '';
    $('signin').disabled = true;
    $('cancel').disabled = true;
    $('signin').textContent = 'Signing in…';
    vscode.postMessage({ type: 'submit', dc: $('dc').value, clientId, clientSecret });
  });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
    );
}
