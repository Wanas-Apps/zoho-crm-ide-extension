import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

/**
 * Proxy-mode auth transport.
 *
 * In proxy mode the published extension carries NO Zoho client_secret: instead
 * of POSTing the OAuth token endpoint directly, it sends the loopback
 * authorization `code` (or a refresh/revoke request) to a backend proxy that
 * adds the secret server-side (see `oauth-proxy/index.js`).
 *
 * The trick that avoids editing the shared `wanas-zcrm-extractor` AuthService:
 * we inject an axios-shaped `http` port into the AuthService. The AuthService
 * still builds its usual `client_id/client_secret` token requests, but this
 * adapter intercepts the three token-endpoint URLs and re-dispatches them to the
 * proxy as `{ action }` calls. So `handleCallback`, `refreshAccessToken` and
 * `revokeRefreshToken` all flow through the proxy with zero core changes; any
 * other URL is delegated to the real fallback client untouched.
 *
 * Pure Node (no `vscode`) so the mapping is unit-testable without a host.
 */

/**
 * Baked-in proxy so the extension ships zero-config: proxy mode is the
 * out-of-the-box flow (data-center pick only — no Client ID / Secret prompt).
 * A user can still override these by setting `zohoDeluge.authProxyUrl` /
 * `zohoDeluge.authProxyToken`; clearing the URL is not possible from settings
 * (blank falls back to this default), so point those at a different proxy to
 * override. The token must match the deployed proxy's `PROXY_SHARED_SECRET`.
 *
 * NOTE: the token below ships inside the published VSIX, so it is NOT a real
 * secret — it only raises the bar for casual abuse. The proxy's actual guard is
 * its redirect-host allowlist (127.0.0.1 / localhost only).
 */
export const DEFAULT_PROXY_URL = 'https://wanas-apps-759141647.catalystserverless.com/server/vs-login/';
export const DEFAULT_PROXY_TOKEN = 'O3lRE4M6YvD6yyIej0TMLXzL6ig3CUEZ3rzvuHQhkSA';

/**
 * The proxy's Zoho app Client ID (public — NOT a secret). Used to build the
 * loopback authorize URL in proxy mode. Preferred source is the proxy's health
 * endpoint (`fetchProxyClientId`); this baked value is the fallback for proxy
 * builds whose health endpoint doesn't advertise `client_id`. MUST match the
 * `ZOHO_CLIENT_ID` env var configured on the deployed proxy.
 */
export const DEFAULT_CLIENT_ID = '1000.M1XE1M7CA4VFDDIRANB8E5AKIBQ72U';

export interface ProxyTarget {
    url: string;
    token?: string;
}

/** The subset of WorkspaceConfigStore that proxy resolution needs. */
export interface ProxyConfigSource {
    getAuthProxyUrl(): string | undefined;
    getAuthProxyToken(): string | undefined;
}

/**
 * Resolve the active proxy target from settings (falling back to the baked-in
 * defaults). Returns undefined when no proxy is configured → BYO-credentials
 * mode.
 */
export function resolveProxy(config: ProxyConfigSource): ProxyTarget | undefined {
    const userUrl = (config.getAuthProxyUrl() || '').trim();
    const url = userUrl || DEFAULT_PROXY_URL;
    if (!url) {
        return undefined;
    }
    const userToken = (config.getAuthProxyToken() || '').trim();
    // The baked-in token pairs with the baked-in URL only. If the user points at
    // their OWN proxy, use their token (if any) — never leak our default token to
    // a third-party URL.
    const token = userToken || (userUrl ? '' : DEFAULT_PROXY_TOKEN);
    return { url, token: token || undefined };
}

/** axios-like minimal response shape that the AuthService consumes. */
export interface HttpLikeResponse {
    data: unknown;
    status: number;
}

/** axios-like minimal client (`.post(url, body, config)`). */
export interface HttpLikeClient {
    post(url: string, body: string, config?: unknown): Promise<HttpLikeResponse>;
}

export type JsonPoster = (
    url: string,
    jsonBody: Record<string, unknown>,
    headers: Record<string, string>
) => Promise<HttpLikeResponse>;

export type JsonGetter = (url: string, headers: Record<string, string>) => Promise<HttpLikeResponse>;

/**
 * Translate one of the Zoho OAuth token-endpoint requests the AuthService emits
 * into the proxy's `{ action, ... }` body. Returns undefined for any URL that is
 * NOT a token/refresh/revoke call (those are delegated to the fallback client).
 */
export function mapTokenRequestToProxy(
    url: string,
    body: string,
    dc: string,
    consent = false
): Record<string, unknown> | undefined {
    const params = new URLSearchParams(body || '');
    if (/\/oauth\/v2\/token\/revoke\/?$/.test(url)) {
        return { action: 'revoke', refresh_token: params.get('token') || '', dc };
    }
    if (/\/oauth\/v2\/token\/?$/.test(url)) {
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
            // `consent` is the user's opt-in to the proxy's user-capture (the
            // proxy only writes a VScodeUsers row when this is true). Capture
            // happens on the initial token exchange only — refresh/revoke omit it.
            return {
                action: 'token',
                code: params.get('code') || '',
                redirect_uri: params.get('redirect_uri') || '',
                dc,
                consent
            };
        }
        if (grant === 'refresh_token') {
            return { action: 'refresh', refresh_token: params.get('refresh_token') || '', dc };
        }
    }
    return undefined;
}

/**
 * Build the axios-shaped `http` port to inject into the AuthService for proxy
 * mode. `getDc` reads the current data center at call time; `fallback` handles
 * any non-token URL (defaults to throwing, since the AuthService only ever uses
 * its `http` port for token endpoints).
 */
export function createProxyHttp(opts: {
    target: ProxyTarget;
    getDc: () => string;
    getConsent?: () => boolean;
    postJson?: JsonPoster;
    fallback?: HttpLikeClient;
}): HttpLikeClient {
    const postJson = opts.postJson || defaultPostJson;
    return {
        async post(url, body, config) {
            const mapped = mapTokenRequestToProxy(
                url,
                body,
                opts.getDc(),
                opts.getConsent ? opts.getConsent() : false
            );
            if (!mapped) {
                if (opts.fallback) {
                    return opts.fallback.post(url, body, config);
                }
                throw new Error(`Auth proxy transport: unsupported URL ${url}`);
            }
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (opts.target.token) {
                headers['x-proxy-token'] = opts.target.token;
            }
            return postJson(opts.target.url, mapped, headers);
        }
    };
}

/**
 * Fetch the proxy's (non-secret) Zoho client_id from its health endpoint. The
 * extension needs it only to build the loopback authorization URL; every later
 * refresh/revoke is supplied by the proxy.
 */
export async function fetchProxyClientId(target: ProxyTarget, getJson?: JsonGetter): Promise<string> {
    const get = getJson || defaultGetJson;
    const headers: Record<string, string> = {};
    if (target.token) {
        headers['x-proxy-token'] = target.token;
    }
    const res = await get(target.url, headers);
    const data = res.data as { client_id?: unknown } | undefined;
    const id = data && data.client_id ? String(data.client_id) : '';
    if (!id) {
        throw new Error(
            'The auth proxy did not return a client_id. Check that zohoDeluge.authProxyUrl points at the proxy and that it is configured (ZOHO_CLIENT_ID set).'
        );
    }
    return id;
}

// --- default Node http(s) transport -----------------------------------------
// Zero-dependency so it works on the oldest supported VS Code engine (Node 16,
// which has no global fetch). Resolves on ANY JSON response (including 4xx) so
// the AuthService's `response.data.error` check can surface Zoho/proxy errors;
// rejects only on transport failure.

const defaultPostJson: JsonPoster = (url, jsonBody, headers) =>
    request(url, 'POST', { 'Content-Type': 'application/json', ...headers }, JSON.stringify(jsonBody));

const defaultGetJson: JsonGetter = (url, headers) => request(url, 'GET', headers);

function request(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body?: string
): Promise<HttpLikeResponse> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`Invalid auth proxy URL: ${url}`));
            return;
        }
        const transport = target.protocol === 'http:' ? http : https;
        const payload = body !== undefined ? Buffer.from(body, 'utf8') : undefined;
        const req = transport.request(
            target,
            {
                method,
                headers: payload ? { ...headers, 'Content-Length': String(payload.length) } : headers
            },
            (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => {
                    let data: unknown;
                    try {
                        data = raw ? JSON.parse(raw) : {};
                    } catch {
                        data = {
                            error: 'invalid_response',
                            error_description: 'The auth proxy returned a non-JSON response.'
                        };
                    }
                    resolve({ data, status: res.statusCode || 0 });
                });
            }
        );
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}
