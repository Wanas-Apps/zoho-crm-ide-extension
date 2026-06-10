/**
 * Classify a token-refresh failure so the auth provider reacts correctly:
 *  - invalid_grant : the refresh token is revoked/expired → clear session, prompt re-login.
 *  - throttled     : Zoho's per-minute refresh cap (429) → keep session, back off.
 *  - transient     : network/5xx → keep session, retry later.
 * Pure (no vscode).
 *
 * Note: `invalid_client` is deliberately NOT treated as `invalid_grant`. It
 * signals a misconfigured/rotated client_id or client_secret (a server/proxy
 * problem), not a revoked user grant — re-login wouldn't fix it and would throw
 * away a perfectly good refresh token. It falls through to `transient`.
 */
export type RefreshErrorKind = 'invalid_grant' | 'throttled' | 'transient';

export function classifyRefreshError(err: unknown): RefreshErrorKind {
    const e = err as { message?: string; response?: { status?: number; data?: { error?: string } } } | undefined;
    const code = String(e?.response?.data?.error ?? '');
    const msg = String(e?.message ?? '');
    const status = e?.response?.status;

    if (/invalid_grant|invalid_code|invalid_token/i.test(code) ||
        /invalid_grant|invalid_code/i.test(msg)) {
        return 'invalid_grant';
    }
    if (status === 429 || /too.?many|throttl|rate.?limit/i.test(code) || /\b429\b|too.?many/i.test(msg)) {
        return 'throttled';
    }
    return 'transient';
}
