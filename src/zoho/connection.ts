import * as vscode from 'vscode';
import authService = require('wanas-zcrm-extractor/src/services/authService');
import { WorkspaceConfigStore } from './configStore';
import { SecretStorageStore } from './secretStore';
import { OutputChannelLog } from './log';
import { CredentialProvider } from './credentialProvider';
import { getConnectionKey, getWorkspaceFolder } from './connectionKey';
import { resolveProxy, createProxyHttp, ProxyTarget, HttpLikeClient } from './authProxy';

/**
 * The live Zoho connection for the current host: the shared CLI AuthService
 * (which `apiClient` and the metadata/function services reuse) configured to
 * read/write through VS Code SecretStorage + workspace settings + an
 * OutputChannel, scoped to the open workspace folder.
 */
export interface ZohoConnection {
    readonly auth: typeof authService;
    readonly secrets: SecretStorageStore;
    readonly config: WorkspaceConfigStore;
    readonly output: vscode.OutputChannel;
    readonly folder: vscode.WorkspaceFolder | undefined;
    /**
     * Absolute filesystem path of the bound workspace folder — the `outputDir`
     * that MUST be passed to every CLI service call (extract/pullOne/pushCode/
     * createFunction/executeTest) in M3/M5, so the services never fall back to
     * their `process.cwd()`-derived default and scatter files outside the
     * workspace. Undefined when no folder is open (features stay disabled).
     */
    readonly outputDir: string | undefined;
    readonly secretKey: string;
    isAuthenticated(): boolean;
    /** Set the loopback redirect URI used by getAuthorizationUrl()/exchange. */
    setRedirectUri(uri: string | undefined): void;
    /** The active OAuth proxy target, or undefined in BYO-credentials mode. */
    readonly proxy: ProxyTarget | undefined;
    /** True when an OAuth proxy is configured (no client_secret needed). */
    isProxyMode(): boolean;
    /** The client_id fetched from the proxy (proxy mode), used to build the
     *  authorize URL. Undefined until fetched. */
    getProxyClientId(): string | undefined;
    /** Cache the proxy-supplied client_id for this session. */
    setProxyClientId(id: string | undefined): void;
    /** Re-read the proxy settings and re-wire the auth transport. Call at the
     *  start of sign-in so a just-edited proxy URL takes effect without a reload. */
    refreshAuthMode(): void;
    /** The user's opt-in to proxy-side user capture for the next token exchange. */
    getConsent(): boolean;
    /** Set the capture opt-in (proxy mode only; written into the `token` body). */
    setConsent(v: boolean): void;
}

let current: ZohoConnection | undefined;

/**
 * Initialize the project-scoped Zoho connection. Configures the shared CLI
 * AuthService with the extension's ports and hydrates tokens for this folder.
 * Safe to call once at activation; does no network I/O and never writes outside
 * SecretStorage / the OutputChannel.
 */
export async function initZohoConnection(context: vscode.ExtensionContext): Promise<ZohoConnection> {
    const folder = getWorkspaceFolder();
    const key = getConnectionKey(folder);

    // The `zoho-output` language id binds a TextMate grammar (syntaxes/
    // zoho-output.tmLanguage.json) so run results + logs are colorized by the
    // user's theme (SUCCESS green, FAILED/errors red, separators dimmed, …).
    const output = vscode.window.createOutputChannel('Zoho CRM IDE', 'zoho-output');
    context.subscriptions.push(output);

    const config = new WorkspaceConfigStore('zohoDeluge', folder?.uri);
    const secrets = new SecretStorageStore(context.secrets, key);
    const logger = new OutputChannelLog(output);
    // The loopback server sets the redirect URI at sign-in time (M2).
    let redirectUri: string | undefined;
    // Proxy mode (set lazily in applyAuthMode / by sign-in).
    let proxyTarget: ProxyTarget | undefined;
    let proxyClientId: string | undefined;
    // Per-sign-in opt-in to proxy-side user capture (default: do not capture).
    let consent = false;
    const credentials = new CredentialProvider(
        config,
        secrets,
        () => redirectUri,
        () => proxyClientId
    );

    // The AuthService's default http port is axios; keep it so proxy mode can
    // delegate any non-token URL back to the real client.
    const realHttp = authService.http as unknown as HttpLikeClient;

    /**
     * Read the proxy settings and wire the AuthService's `http` port: proxy
     * transport when a proxy URL is set, plain axios otherwise. Idempotent.
     */
    const applyAuthMode = (): void => {
        proxyTarget = resolveProxy(config);
        if (proxyTarget) {
            authService.configure({
                http: createProxyHttp({
                    target: proxyTarget,
                    getDc: () => config.getDc(),
                    getConsent: () => consent,
                    fallback: realHttp
                })
            });
        } else {
            authService.configure({ http: realHttp });
            proxyClientId = undefined;
        }
    };

    // Configure the shared singleton (apiClient + services reuse it) and hydrate.
    authService.configure({ credentials, store: secrets, logger });
    applyAuthMode();
    await secrets.prime();
    await authService.hydrate();

    current = {
        auth: authService,
        secrets,
        config,
        output,
        folder,
        outputDir: folder?.uri.fsPath,
        secretKey: key,
        isAuthenticated: () => authService.isAuthenticated(),
        setRedirectUri: (uri) => { redirectUri = uri; },
        get proxy() { return proxyTarget; },
        isProxyMode: () => !!proxyTarget,
        getProxyClientId: () => proxyClientId,
        setProxyClientId: (id) => { proxyClientId = id; },
        refreshAuthMode: applyAuthMode,
        getConsent: () => consent,
        setConsent: (v) => { consent = v; }
    };

    logger.logInfo(
        `Connection initialized for ${folder ? folder.uri.fsPath : '(no workspace folder)'} — ` +
            `${authService.isAuthenticated() ? 'authenticated' : 'logged out'}`,
        'connection'
    );

    // Keep multiple windows in sync: re-hydrate if this connection's secret
    // changes elsewhere (read-only mirror).
    context.subscriptions.push(
        context.secrets.onDidChange(async (e) => {
            if (e.key === key) {
                // Another window changed this connection's secret — reload it.
                secrets.invalidate();
                await secrets.prime();
                await authService.hydrate();
            }
        })
    );

    return current;
}

/** The current connection, if `initZohoConnection` has run. */
export function getZohoConnection(): ZohoConnection | undefined {
    return current;
}
