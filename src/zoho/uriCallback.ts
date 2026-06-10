import { validateState } from './oauth';

/**
 * Helpers for a `vscode://`-style UriHandler OAuth callback — the fallback path
 * when a loopback listener can't be reached (Remote/Codespaces/web). Pure (no
 * vscode): the provider supplies `vscode.env.uriScheme` + the extension id and
 * forwards incoming URIs' query strings into `createCallbackSink`.
 */
export function callbackUri(uriScheme: string, extensionId: string): string {
    return `${uriScheme}://${extensionId}/zoho/callback`;
}

export function parseCallbackQuery(query: string): { code?: string; state?: string; error?: string } {
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    return {
        code: params.get('code') || undefined,
        state: params.get('state') || undefined,
        error: params.get('error') || undefined
    };
}

export interface CallbackSink {
    readonly promise: Promise<string>;
    /** Feed an incoming callback query string. Single-shot. */
    handle(query: string): void;
}

export function createCallbackSink(expectedState: string): CallbackSink {
    let settled = false;
    let resolveFn: (code: string) => void;
    let rejectFn: (err: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return {
        promise,
        handle(query: string): void {
            if (settled) {
                return;
            }
            const { code, state, error } = parseCallbackQuery(query);
            if (error) {
                settled = true;
                rejectFn(new Error(`Authorization failed: ${error}`));
                return;
            }
            if (!validateState(expectedState, state)) {
                settled = true;
                rejectFn(new Error('OAuth state mismatch — possible CSRF; sign-in aborted.'));
                return;
            }
            if (!code) {
                settled = true;
                rejectFn(new Error('No authorization code returned by Zoho.'));
                return;
            }
            settled = true;
            resolveFn(code);
        }
    };
}
