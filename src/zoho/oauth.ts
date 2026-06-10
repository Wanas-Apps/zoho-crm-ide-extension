import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { renderBrandedPage } from './branding';

/**
 * Loopback OAuth helpers, re-authored for the extension (the CLI's terminal
 * `runOAuthServer` is intentionally NOT imported). Pure Node — no `vscode`
 * dependency — so the server is integration-testable without a host.
 *
 * Security baseline (per design §4.1/§9.4): bind to 127.0.0.1 only, validate an
 * unguessable `state`, short listener lifetime, single-shot capture.
 */

export const DEFAULT_PORTS = [3000, 3737, 8980];
export const CALLBACK_PATH = '/zoho/callback';
const LOOPBACK_HOST = '127.0.0.1';

/** Cryptographically-random anti-CSRF state token. */
export function generateState(): string {
    return crypto.randomBytes(16).toString('hex');
}

/** Constant-time-ish state comparison. */
export function validateState(expected: string, actual: unknown): boolean {
    if (typeof actual !== 'string' || actual.length === 0 || actual.length !== expected.length) {
        return false;
    }
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
    } catch {
        return false;
    }
}

/** Resolve the first port in `ports` that can be bound on 127.0.0.1. */
export async function firstFreePort(ports: number[] = DEFAULT_PORTS): Promise<number> {
    for (const port of ports) {
        if (await isPortFree(port)) {
            return port;
        }
    }
    throw new Error(
        `All loopback ports are busy (${ports.join(', ')}). Close whatever is using them and try signing in again.`
    );
}

function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => tester.close(() => resolve(true)));
        tester.listen(port, LOOPBACK_HOST);
    });
}

export interface LoopbackServer {
    readonly port: number;
    /** Exact redirect URI to register in the Zoho app and send in the auth URL. */
    readonly redirectUri: string;
    /** Resolve with the authorization `code` once Zoho redirects back. */
    waitForCode(timeoutMs?: number): Promise<string>;
    dispose(): void;
}

export interface LoopbackOptions {
    expectedState: string;
    preferredPorts?: number[];
}

/**
 * Start a single-shot loopback server on 127.0.0.1. The returned `redirectUri`
 * must be used both in the Zoho app registration and the auth URL.
 */
export async function createLoopbackServer(opts: LoopbackOptions): Promise<LoopbackServer> {
    const port = await firstFreePort(opts.preferredPorts ?? DEFAULT_PORTS);
    const redirectUri = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;

    // The redirect can hit this handler BEFORE `waitForCode()` is called (e.g.
    // the browser already has a live Zoho session and redirects instantly). To
    // avoid dropping the code, buffer the outcome until a waiter registers.
    let resolveFn: ((code: string) => void) | undefined;
    let rejectFn: ((err: Error) => void) | undefined;
    let pendingCode: string | undefined;
    let pendingErr: Error | undefined;
    let settled = false;
    const settleResolve = (code: string) => {
        if (settled) { return; }
        settled = true;
        if (resolveFn) { resolveFn(code); } else { pendingCode = code; }
    };
    const settleReject = (err: Error) => {
        if (settled) { return; }
        settled = true;
        if (rejectFn) { rejectFn(err); } else { pendingErr = err; }
    };

    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url || '/', redirectUri);
        if (reqUrl.pathname !== CALLBACK_PATH) {
            res.writeHead(404);
            res.end();
            return;
        }

        const err = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (err) {
            sendPage(res, 400, 'Authorization failed', String(err));
            settleReject(new Error(`Authorization failed: ${err}`));
            return;
        }
        if (!validateState(opts.expectedState, state)) {
            sendPage(res, 400, 'Authorization failed', 'Security check failed (state mismatch). Please try signing in again.');
            settleReject(new Error('OAuth state mismatch — possible CSRF; sign-in aborted.'));
            return;
        }
        if (!code) {
            sendPage(res, 400, 'Authorization failed', 'No authorization code was returned.');
            settleReject(new Error('No authorization code returned by Zoho.'));
            return;
        }
        sendPage(res, 200, 'Signed in to Zoho CRM', 'You can close this tab and return to your editor.');
        settleResolve(code);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK_HOST, () => resolve());
    });

    return {
        port,
        redirectUri,
        waitForCode(timeoutMs = 120000): Promise<string> {
            return new Promise<string>((resolve, reject) => {
                // The callback may already have arrived before we started waiting.
                if (pendingErr) { reject(pendingErr); return; }
                if (pendingCode !== undefined) { resolve(pendingCode); return; }
                const timer = setTimeout(() => {
                    settleReject(new Error('Timed out waiting for the Zoho sign-in to complete.'));
                }, timeoutMs);
                resolveFn = (c) => { clearTimeout(timer); resolve(c); };
                rejectFn = (e) => { clearTimeout(timer); reject(e); };
            });
        },
        dispose(): void {
            try {
                server.close();
            } catch {
                /* already closed */
            }
        }
    };
}

function sendPage(res: http.ServerResponse, status: number, title: string, message: string): void {
    // Single-shot listener: close the socket so disposing the server can't leave
    // a kept-alive connection to be reset. The page is fully self-contained
    // (logo inlined), so the browser never requests a second asset.
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    res.end(renderBrandedPage({ status, title, message }));
}
