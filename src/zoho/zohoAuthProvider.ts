import * as vscode from 'vscode';
import { ZohoConnection } from './connection';
import { SessionLock, ActiveSession } from './sessionLock';
import { ZohoStatusBar } from './statusBar';
import { collectCredentials, collectDataCenter } from './loginWebview';
import { fetchProxyClientId, DEFAULT_CLIENT_ID } from './authProxy';
import { createLoopbackServer, generateState } from './oauth';
import { fetchWhoAmI, WhoAmI } from './whoami';
import { classifyRefreshError } from './refreshError';
import { writeProjectOrgFile, PROJECT_ORG_FILE } from './mcp/projectOrg';

export const PROVIDER_ID = 'zoho';
export const PROVIDER_LABEL = 'Zoho CRM';
const SESSION_SCOPES = ['crm'];

/**
 * VS Code AuthenticationProvider for Zoho CRM (native Accounts menu). Owns the
 * full interactive sign-in (BYO credentials → loopback OAuth → token exchange →
 * whoami → single-session lock) and sign-out (revoke + clear). One session per
 * host (design §4.7).
 */
export class ZohoAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
    private readonly _onDidChangeSessions =
        new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    private session: vscode.AuthenticationSession | undefined;
    private signingIn = false;

    constructor(
        private readonly connection: ZohoConnection,
        private readonly sessionLock: SessionLock,
        private readonly statusBar: ZohoStatusBar,
        /** Invoked after a successful interactive sign-in (e.g. auto-pull). */
        private readonly onSignedIn?: () => void
    ) {
        // Reflect persisted state at startup.
        const active = this.sessionLock.get();
        if (active && this.connection.isAuthenticated()) {
            this.session = this.toSession(active, '');
            this.statusBar.showLoggedIn(active.org);
            void vscode.commands.executeCommand('setContext', 'zohoDeluge.loggedIn', true);
        } else {
            this.statusBar.showLoggedOut();
            void vscode.commands.executeCommand('setContext', 'zohoDeluge.loggedIn', false);
        }
    }

    async getSessions(): Promise<vscode.AuthenticationSession[]> {
        if (!this.connection.isAuthenticated()) {
            return [];
        }
        const active = this.sessionLock.get();
        if (!active) {
            return [];
        }
        let accessToken = '';
        try {
            accessToken = await this.connection.auth.getAccessToken();
        } catch (err) {
            await this.handleRefreshFailure(err);
            return [];
        }
        this.session = this.toSession(active, accessToken);
        return [this.session];
    }

    async createSession(): Promise<vscode.AuthenticationSession> {
        return this.signIn();
    }

    async removeSession(): Promise<void> {
        await this.signOut();
    }

    dispose(): void {
        this._onDidChangeSessions.dispose();
    }

    // -- orchestration --------------------------------------------------------

    /** Public entry for the `zohoDeluge.login` command. */
    async signIn(): Promise<vscode.AuthenticationSession> {
        if (this.signingIn) {
            throw new Error('A Zoho sign-in is already in progress.');
        }
        this.signingIn = true;
        try {
            const { connection } = this;

            // Single-session lock: confirm switching away from an active org.
            const active = this.sessionLock.get();
            if (active && connection.isAuthenticated()) {
                const choice = await vscode.window.showWarningMessage(
                    `Already signed in to ${active.org}. Sign out and connect a different org?`,
                    { modal: true },
                    'Switch org'
                );
                if (choice !== 'Switch org') {
                    throw new Error('Sign-in cancelled.');
                }
                await this.signOut();
            }

            // Pick up a just-edited proxy URL without requiring a window reload.
            connection.refreshAuthMode();
            let dc = connection.config.getDc();

            if (connection.isProxyMode()) {
                // Proxy mode: the Client ID/Secret live in the backend proxy, so
                // the user only chooses a data center. The (non-secret) client_id
                // is fetched from the proxy to build the authorize URL; every
                // later refresh/revoke is signed by the proxy.
                const picked = await collectDataCenter(dc);
                if (!picked) {
                    throw new Error('Zoho sign-in cancelled.');
                }
                dc = picked;
                await connection.config.setDc(dc);
                if (!connection.getProxyClientId()) {
                    // Prefer the proxy's health-advertised client_id; fall back to
                    // the (non-secret) zohoDeluge.clientId setting, then to the
                    // baked-in DEFAULT_CLIENT_ID, so proxy builds whose health
                    // endpoint doesn't expose client_id still sign in zero-config.
                    let id: string | undefined;
                    try {
                        id = await fetchProxyClientId(connection.proxy!);
                    } catch (err) {
                        id = connection.config.getClientId() || DEFAULT_CLIENT_ID;
                        if (!id) {
                            throw err;
                        }
                    }
                    connection.setProxyClientId(id);
                }
                // Opt-in user capture: ask whether to share account details with
                // WanasApps. Only proxy mode can capture (the proxy writes the
                // row); declining (or dismissing) still signs in normally.
                const share = await vscode.window.showInformationMessage(
                    'Share your name, email and org with us to get news and updates about this extension? ' +
                        'It also helps us improve it. Optional — you can decline and still sign in.',
                    { modal: true },
                    'Share',
                    "Don't share"
                );
                connection.setConsent(share === 'Share');
            } else {
                // BYO credentials (webview on first run / after full disconnect).
                connection.setConsent(false);
                const clientId = connection.config.getClientId();
                const clientSecret = connection.secrets.getCachedClientSecret();
                if (!clientId || !clientSecret) {
                    const creds = await collectCredentials({ dc, clientId }, connection.config.getLoopbackPorts());
                    if (!creds) {
                        throw new Error('Zoho sign-in cancelled.');
                    }
                    await connection.config.setClientId(creds.clientId);
                    await connection.config.setDc(creds.dc);
                    await connection.secrets.setClientSecret(creds.clientSecret);
                    dc = creds.dc;
                }
            }

            const who = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Signing in to Zoho CRM…',
                    cancellable: false
                },
                async () => {
                    const state = generateState();
                    const loopback = await createLoopbackServer({
                        expectedState: state,
                        preferredPorts: connection.config.getLoopbackPorts()
                    });
                    try {
                        connection.setRedirectUri(loopback.redirectUri);
                        const authUrl = `${connection.auth.getAuthorizationUrl()}&state=${state}`;
                        const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
                        if (!opened) {
                            throw new Error('Could not open the browser to complete Zoho sign-in.');
                        }
                        const code = await loopback.waitForCode(180000);
                        await connection.auth.handleCallback(code);
                    } finally {
                        loopback.dispose();
                        connection.setRedirectUri(undefined);
                    }
                    return this.confirmIdentity(dc);
                }
            );

            const session: ActiveSession = {
                org: who.org,
                orgId: who.orgId,
                apiDomain: connection.auth.getApiBaseUrl(),
                dc,
                email: who.email,
                folder: connection.outputDir,
                since: Date.now()
            };
            await this.sessionLock.set(session);
            await vscode.commands.executeCommand('setContext', 'zohoDeluge.loggedIn', true);
            this.statusBar.showLoggedIn(who.org);

            // Bind the workspace to this org (non-secret pointer file) so the
            // external stdio MCP server can resolve the org from the project.
            if (connection.outputDir && who.orgId) {
                try {
                    await writeProjectOrgFile(connection.outputDir, { orgId: who.orgId, dc, name: who.org });
                    connection.output.appendLine(`[AUTH] ${PROJECT_ORG_FILE} → org ${who.orgId} ("${who.org}")`);
                } catch (e) {
                    connection.output.appendLine(
                        `[WARN] could not write ${PROJECT_ORG_FILE}: ${e instanceof Error ? e.message : String(e)}`
                    );
                }
            }

            const accessToken = connection.auth.tokens?.access_token || '';
            const vsSession = this.toSession(session, accessToken);
            this.session = vsSession;
            this._onDidChangeSessions.fire({ added: [vsSession], removed: [], changed: [] });

            void vscode.window.showInformationMessage(
                `Connected to Zoho CRM — ${who.org}${who.email ? ` (${who.email})` : ''}.`
            );

            // Fire-and-forget post-sign-in hook (auto-pull). Never fails sign-in.
            try {
                this.onSignedIn?.();
            } catch {
                /* hook errors are non-fatal */
            }
            return vsSession;
        } finally {
            this.signingIn = false;
        }
    }

    /** Public entry for the `zohoDeluge.logout` command. */
    async signOut(): Promise<void> {
        const removed = this.session;
        const { connection } = this;
        try {
            await connection.auth.revokeRefreshToken();
        } catch {
            connection.auth.tokens = null;
        }
        // Keep the BYO app credentials (client_id/secret) for easy re-login;
        // only the session tokens are cleared.
        await connection.secrets.clearTokens();
        await this.sessionLock.clear();
        await vscode.commands.executeCommand('setContext', 'zohoDeluge.loggedIn', false);
        this.statusBar.showLoggedOut();
        this.session = undefined;
        if (removed) {
            this._onDidChangeSessions.fire({ added: [], removed: [removed], changed: [] });
        }
    }

    /** whoami with ambiguous-state recovery (tokens saved but identity call
     *  failed): keep the session, warn, and proceed with a minimal identity. */
    private async confirmIdentity(dc: string): Promise<WhoAmI> {
        try {
            return await fetchWhoAmI(dc);
        } catch (err) {
            this.connection.output.appendLine(
                `[WARN] Signed in, but could not confirm user/org: ${describe(err)}`
            );
            void vscode.window.showWarningMessage(
                'Signed in to Zoho, but confirming your user/organization failed. You are connected; details may be limited until the next sync.'
            );
            return { userName: 'Zoho user', email: '', org: 'Zoho CRM', orgId: '', dc };
        }
    }

    /** Refresh failed — clear + re-login only when the token is truly revoked;
     *  throttle/transient failures keep the session and back off. */
    private async handleRefreshFailure(err: unknown): Promise<void> {
        const kind = classifyRefreshError(err);
        this.connection.output.appendLine(`[ERROR] Token refresh failed (${kind}): ${describe(err)}`);
        if (kind !== 'invalid_grant') {
            void vscode.window.showWarningMessage(
                kind === 'throttled'
                    ? 'Zoho is rate-limiting token refreshes — please wait a moment and try again.'
                    : 'Could not reach Zoho to refresh your session — check your connection and try again.'
            );
            return;
        }
        this.connection.auth.tokens = null;
        await this.connection.secrets.clearTokens();
        await this.sessionLock.clear();
        await vscode.commands.executeCommand('setContext', 'zohoDeluge.loggedIn', false);
        this.statusBar.showLoggedOut();
        const removed = this.session;
        this.session = undefined;
        if (removed) {
            this._onDidChangeSessions.fire({ added: [], removed: [removed], changed: [] });
        }
        const action = await vscode.window.showWarningMessage(
            'Your Zoho session expired. Sign in again to continue.',
            'Sign in'
        );
        if (action === 'Sign in') {
            void this.signIn().catch(() => undefined);
        }
    }

    private toSession(active: ActiveSession, accessToken: string): vscode.AuthenticationSession {
        const label = active.email ? `${active.org} (${active.email})` : active.org;
        return {
            id: `zoho:${active.orgId || active.dc}`,
            accessToken,
            account: { id: active.orgId || active.dc, label },
            scopes: SESSION_SCOPES
        };
    }
}

function describe(err: unknown): string {
    if (err && typeof err === 'object') {
        const e = err as { message?: string; response?: { data?: unknown } };
        if (e.response?.data) {
            try {
                return typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
            } catch {
                /* fall through */
            }
        }
        return e.message || String(err);
    }
    return String(err);
}
