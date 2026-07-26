/**
 * VS Code glue for the embedded MCP server.
 *
 * Responsibilities:
 *  - Build the ToolCtx (OrgApi over the live connection + a FunctionPort that
 *    reuses the extension's guards/services + a modal confirm gate for writes).
 *  - Start the loopback MCP server (mcpServer.ts).
 *  - Register it with VS Code's native MCP discovery (vscode.lm.register
 *    McpServerDefinitionProvider) so Copilot/agent mode picks it up with the
 *    right URL + Bearer header — and feature-detect that API so older hosts
 *    simply skip registration instead of throwing.
 *  - Provide "Copy MCP Config" (for external clients) and "Restart MCP Server".
 *
 * The 1.101 MCP API is newer than the pinned @types/vscode, so those specific
 * members are reached through narrow `any` casts + runtime feature detection.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { ZohoConnection } from '../connection';
import { FunctionOps } from '../functionOps';
import { fnService } from '../functionServiceBridge';
import { OrgApi, OrgHttp, OrgAuth, FetchLike } from './orgApi';
import { FunctionPort, ToolCtx } from './mcpTools';
import { startMcpServer, McpServerHandle } from './mcpServer';
import { buildSessionFile, writeSessionFile, defaultSessionPath, orgSessionPath } from './sessionFile';
import { writeProjectOrgFile, PROJECT_ORG_FILE } from './projectOrg';
import { fetchWhoAmI, WhoAmI } from '../whoami';

const PROVIDER_ID = 'zohoDeluge.mcpProvider';
const SERVER_LABEL = 'Zoho CRM IDE';

interface McpDeps {
    connection: ZohoConnection;
    functionOps: FunctionOps;
}

/**
 * Wire the MCP server into the extension. Safe to call once at activation;
 * starts the server lazily-but-eagerly and registers the discovery provider.
 */
export function activateMcp(context: vscode.ExtensionContext, deps: McpDeps): void {
    const { connection, functionOps } = deps;
    const output = connection.output;

    const ctxFactory = (): ToolCtx => buildToolCtx(connection, functionOps);

    let handle: McpServerHandle | undefined;
    const onDidChange = new vscode.EventEmitter<void>();
    context.subscriptions.push(onDidChange);

    const start = async (): Promise<void> => {
        if (handle) {
            return;
        }
        try {
            handle = await startMcpServer({ ctxFactory });
            output.appendLine(`[MCP] server listening at ${handle.url}`);
            onDidChange.fire();
        } catch (e) {
            output.appendLine(`[MCP] failed to start: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const stop = async (): Promise<void> => {
        if (handle) {
            await handle.dispose();
            handle = undefined;
            onDidChange.fire();
        }
    };

    context.subscriptions.push({ dispose: () => void stop() });

    // --- Native VS Code MCP discovery (feature-detected for ≥1.101) -----------
    const lm = vscode as unknown as {
        lm?: {
            registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
        };
        McpHttpServerDefinition?: new (
            label: string,
            uri: vscode.Uri,
            headers?: Record<string, string>,
            version?: string
        ) => unknown;
    };

    if (lm.lm?.registerMcpServerDefinitionProvider && lm.McpHttpServerDefinition) {
        const McpHttpServerDefinition = lm.McpHttpServerDefinition;
        const provider = {
            onDidChangeMcpServerDefinitions: onDidChange.event,
            provideMcpServerDefinitions: async () => {
                if (!handle) {
                    return [];
                }
                return [
                    new McpHttpServerDefinition(
                        SERVER_LABEL,
                        vscode.Uri.parse(handle.url),
                        { Authorization: `Bearer ${handle.token}` },
                        '0.7.0'
                    )
                ];
            }
        };
        try {
            context.subscriptions.push(lm.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
        } catch (e) {
            output.appendLine(`[MCP] discovery registration failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    } else {
        output.appendLine('[MCP] this VS Code build has no native MCP discovery API — use "Copy MCP Config" for an external client.');
    }

    // --- Commands -------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('zohoDeluge.copyMcpConfig', async () => {
            if (!handle) {
                await start();
            }
            if (!handle) {
                void vscode.window.showErrorMessage('Zoho MCP server is not running.');
                return;
            }
            const config = mcpClientConfig(handle);
            await vscode.env.clipboard.writeText(config);
            void vscode.window.showInformationMessage('Zoho MCP server config copied to clipboard.');
        }),
        vscode.commands.registerCommand('zohoDeluge.restartMcpServer', async () => {
            await stop();
            await start();
            void vscode.window.showInformationMessage(
                handle ? `Zoho MCP server restarted at ${handle.url}` : 'Zoho MCP server failed to restart (see Zoho output).'
            );
        }),
        vscode.commands.registerCommand('zohoDeluge.enableExternalMcp', () => exportSession(connection, output)),
        vscode.commands.registerCommand('zohoDeluge.copyAntigravityConfig', () =>
            copyStdioConfig(context, connection, output)
        )
    );

    void start();
}

/**
 * Export the live session to the shared-session file so the standalone stdio MCP
 * server (used by external agents like Antigravity) can authenticate. Requires
 * proxy mode — the file carries a refresh token but no client secret, so token
 * refresh must route through the user's OAuth proxy.
 */
async function exportSession(connection: ZohoConnection, output: vscode.OutputChannel): Promise<void> {
    if (!connection.isAuthenticated()) {
        void vscode.window.showWarningMessage('Sign in to Zoho CRM first, then export the session.');
        return;
    }
    if (!connection.proxy) {
        void vscode.window.showErrorMessage(
            'External MCP access requires proxy mode (set zohoDeluge.authProxyUrl). ' +
                'In bring-your-own-credentials mode the stdio server cannot refresh tokens safely.'
        );
        return;
    }
    const tokens = connection.auth.tokens;
    if (!tokens || !tokens.refresh_token) {
        void vscode.window.showErrorMessage('No refresh token in the current session — sign in again, then export.');
        return;
    }

    // Bind the export to the signed-in org: the claim is what the stdio
    // server's wrong-org guard enforces, so an unlabeled export is refused.
    const dc = connection.config.getDc() || 'com';
    let who: WhoAmI;
    try {
        who = await fetchWhoAmI(dc);
    } catch (e) {
        void vscode.window.showErrorMessage(
            `Could not confirm the signed-in org (${e instanceof Error ? e.message : String(e)}) — try the export again.`
        );
        return;
    }
    if (!who.orgId) {
        void vscode.window.showErrorMessage('Zoho did not report an org id for this session — sign in again, then export.');
        return;
    }

    const session = buildSessionFile({
        dc,
        proxy: { url: connection.proxy.url, token: connection.proxy.token },
        org: { id: who.orgId, name: who.org },
        tokens: {
            refresh_token: tokens.refresh_token,
            access_token: tokens.access_token,
            api_domain: tokens.api_domain,
            expiry_time: tokens.expiry_time
        },
        now: new Date().toISOString()
    });

    // Org-keyed file is the real session store (one per org — exports never
    // clobber another org); the legacy single file keeps old configs working.
    const filePath = orgSessionPath(dc, who.orgId);
    const legacyPath = defaultSessionPath();
    try {
        await writeSessionFile(filePath, session);
        await writeSessionFile(legacyPath, session);
    } catch (e) {
        void vscode.window.showErrorMessage(`Could not write session file: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    output.appendLine(`[MCP] session exported to ${filePath} (org ${who.orgId} "${who.org}", proxy mode)`);
    output.appendLine(`[MCP] legacy session.json also updated (unpinned) — prefer the per-org config from "Copy Antigravity Config".`);

    // Refresh the project's org pointer so the stdio server can resolve this
    // org straight from the workspace (no manual pinning).
    if (connection.outputDir) {
        try {
            await writeProjectOrgFile(connection.outputDir, { orgId: who.orgId, dc, name: who.org });
            output.appendLine(`[MCP] ${PROJECT_ORG_FILE} → org ${who.orgId} ("${who.org}")`);
        } catch (e) {
            output.appendLine(`[WARN] could not write ${PROJECT_ORG_FILE}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const pick = await vscode.window.showInformationMessage(
        `External MCP access enabled for ${who.org} — session written to ${filePath}.`,
        'Copy Antigravity Config'
    );
    if (pick === 'Copy Antigravity Config') {
        await vscode.commands.executeCommand('zohoDeluge.copyAntigravityConfig');
    }
}

/** Copy a ready-to-paste stdio MCP config for an external agent (Antigravity).
 *  Signed in → an org-pinned entry (per-org session path + ZOHO_MCP_EXPECTED_ORG)
 *  so the server refuses to serve any other org; otherwise the legacy unpinned
 *  entry plus a reminder to export first. */
async function copyStdioConfig(
    context: vscode.ExtensionContext,
    connection: ZohoConnection,
    output: vscode.OutputChannel
): Promise<void> {
    const stdioEntry = path.join(context.extensionPath, 'dist', 'mcp-stdio.js');
    const exported = !!connection.proxy && connection.isAuthenticated();

    let env: Record<string, string> = { ZOHO_MCP_SESSION: defaultSessionPath() };
    let pinnedTo: WhoAmI | undefined;
    if (exported) {
        try {
            const who = await fetchWhoAmI(connection.config.getDc() || 'com');
            if (who.orgId) {
                pinnedTo = who;
                env = {
                    ZOHO_MCP_SESSION: orgSessionPath(who.dc, who.orgId),
                    ZOHO_MCP_EXPECTED_ORG: who.orgId
                };
            }
        } catch (e) {
            output.appendLine(`[MCP] could not pin config to an org (${e instanceof Error ? e.message : String(e)}) — copying the unpinned legacy entry.`);
        }
    }

    const config = JSON.stringify(
        {
            mcpServers: {
                'zoho-crm-ide': {
                    command: 'node',
                    args: [stdioEntry],
                    env
                }
            }
        },
        null,
        2
    );
    await vscode.env.clipboard.writeText(config);
    output.appendLine(`[MCP] Antigravity (stdio) config copied to clipboard${pinnedTo ? ` (pinned to org ${pinnedTo.orgId} "${pinnedTo.org}")` : ' (unpinned)'}.`);
    void vscode.window.showInformationMessage(
        pinnedTo
            ? `Antigravity MCP config copied (pinned to ${pinnedTo.org}). Paste it into Antigravity's MCP settings.`
            : exported
              ? 'Antigravity MCP config copied (unpinned — could not confirm the org). Paste it into Antigravity\'s MCP settings.'
              : 'Antigravity MCP config copied. Run "Enable External MCP Access" first so the server can sign in.'
    );
}

/** Build the per-request tool context: OrgApi + FunctionPort + confirm modal. */
function buildToolCtx(connection: ZohoConnection, functionOps: FunctionOps): ToolCtx {
    const auth: OrgAuth = {
        isAuthenticated: () => connection.isAuthenticated(),
        getAccessToken: () => connection.auth.getAccessToken(),
        getApiBaseUrl: () => connection.auth.getApiBaseUrl()
    };
    const fetchImpl = (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!fetchImpl) {
        throw new Error('global fetch is unavailable in this runtime (need Node ≥18 / VS Code ≥1.101).');
    }
    const api = new OrgApi(new OrgHttp(auth, fetchImpl));

    const functions: FunctionPort = {
        runStandalone: async (apiName, args) => {
            // Reuse FunctionOps guards (auth + outputDir + org-match) by resolving
            // the live target then running through it; keeps the standalone rule.
            const resolved = await fnService.resolveTarget(apiName);
            return functionOps.run(resolved, args as Record<string, unknown>);
        },
        getFunctionCode: async (apiName) => {
            const code = await fnService.getRemoteCode(apiName);
            if (!code) {
                throw new Error(`No function named "${apiName}" found in this org.`);
            }
            return code;
        },
        pushFunction: async (apiName, code) => pushByApiName(connection, apiName, code)
    };

    const confirm = async (summary: string): Promise<boolean> => {
        const choice = await vscode.window.showWarningMessage(
            `Allow the Zoho MCP agent to: ${summary}?`,
            { modal: true, detail: 'This performs a WRITE against your live Zoho CRM org.' },
            'Proceed'
        );
        return choice === 'Proceed';
    };

    return { api, functions, confirm };
}

/**
 * Push a code string to an existing function by api_name. The core's pushCode is
 * file-based (and category-agnostic — it pushes by the resolved id), so we
 * stage the code to a temp `.ds` whose filename encodes the api_name, push, and
 * clean up. Works for every function category, not just standalone.
 */
async function pushByApiName(connection: ZohoConnection, apiName: string, code: string): Promise<unknown> {
    const outputDir = connection.outputDir;
    if (!outputDir) {
        throw new Error('Open the workspace folder bound to your org first.');
    }
    const safe = String(apiName).replace(/[^A-Za-z0-9_]/g, '_');
    const dir = path.join(os.tmpdir(), 'zoho-mcp-push');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `mcp.${safe}.ds`);
    await fs.writeFile(file, code, 'utf8');
    try {
        return await fnService.pushCode({ file, outputDir });
    } finally {
        await fs.rm(file, { force: true }).catch(() => undefined);
    }
}

/** A ready-to-paste MCP client config block (e.g. for ~/.cursor or mcp.json). */
function mcpClientConfig(handle: McpServerHandle): string {
    return JSON.stringify(
        {
            mcpServers: {
                'zoho-crm-ide': {
                    url: handle.url,
                    headers: { Authorization: `Bearer ${handle.token}` }
                }
            }
        },
        null,
        2
    );
}
