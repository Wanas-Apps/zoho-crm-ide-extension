/**
 * Standalone **stdio** MCP server — the entry point an external agent (Antigravity,
 * Cursor, Claude Desktop, …) launches as a subprocess. It exposes the SAME 13
 * Zoho tools as the in-process HTTP server, but authenticates from the shared
 * session file (sessionFile.ts) instead of VS Code SecretStorage, so it works
 * with VS Code closed.
 *
 * Transport hygiene: stdout is the JSON-RPC channel — NOTHING may be written to
 * it except protocol frames. All diagnostics go to stderr (console.error).
 *
 * Auth: configures the bundled `@wanasapps/zcrm-core` authService with a
 * file-backed token store + the proxy transport, so access-token refresh routes
 * through the user's OAuth proxy and refreshed tokens persist back to the file.
 *
 * Writes are enabled by default (the launching agent prompts before each tool
 * call). Set ZOHO_MCP_READONLY=1 to hard-disable the 6 write tools.
 */

import * as os from 'os';
import * as path from 'path';
import authService = require('@wanasapps/zcrm-core/src/services/authService');
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools, SERVER_INFO } from './mcpServer';
import { OrgApi, OrgHttp, OrgAuth, FetchLike } from './orgApi';
import { FunctionPort, ToolCtx } from './mcpTools';
import { fnService } from '../functionServiceBridge';
import { createProxyHttp, HttpLikeClient } from '../authProxy';
import {
    resolveSessionPath,
    readSessionFile,
    updateSessionTokens,
    SessionFile,
    SessionTokens
} from './sessionFile';

const logErr = (msg: string) => process.stderr.write(`[zoho-mcp] ${msg}\n`);

/** A token store over the shared-session file: hydrate from it, persist back. */
function fileTokenStore(sessionPath: string, initial: SessionFile) {
    let cache: SessionTokens = initial.tokens;
    return {
        loadTokens: async (): Promise<SessionTokens> => cache,
        loadTokensSync: (): SessionTokens => cache,
        saveTokens: async (tokens: SessionTokens): Promise<void> => {
            cache = { ...cache, ...tokens };
            await updateSessionTokens(sessionPath, tokens).catch((e) =>
                logErr(`could not persist refreshed tokens: ${e instanceof Error ? e.message : String(e)}`)
            );
        }
    };
}

/** Configure the shared authService singleton for headless proxy-mode auth. */
async function configureAuth(sessionPath: string, session: SessionFile): Promise<void> {
    const dc = session.dc || 'com';
    const store = fileTokenStore(sessionPath, session);

    // Proxy transport: refresh/revoke route through the user's OAuth proxy. The
    // proxy adapter only forwards refresh_token + dc, so client id/secret are
    // placeholders here (never used). Non-token URLs are never sent to this port.
    const noFallback: HttpLikeClient = {
        post: async () => {
            throw new Error('unexpected non-token request on the auth transport');
        }
    };
    const http = session.proxy
        ? createProxyHttp({ target: session.proxy, getDc: () => dc, fallback: noFallback })
        : undefined;

    authService.configure({
        credentials: {
            getClientId: () => '',
            getClientSecret: () => '',
            getDc: () => dc
        },
        store,
        logger: {
            logInfo: (m: string, c?: string) => logErr(`${c || 'auth'}: ${m}`),
            logError: (e: unknown, c?: string) => logErr(`${c || 'auth'}: ${e instanceof Error ? e.message : String(e)}`)
        },
        ...(http ? { http } : {})
    });
    await authService.hydrate();
}

/** Build the tool context (OrgApi + FunctionPort + confirm) for the stdio run. */
function buildStdioCtx(readonly: boolean): ToolCtx {
    const auth: OrgAuth = {
        isAuthenticated: () => authService.isAuthenticated(),
        getAccessToken: () => authService.getAccessToken(),
        getApiBaseUrl: () => authService.getApiBaseUrl()
    };
    const fetchImpl = (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!fetchImpl) {
        throw new Error('global fetch unavailable — run the MCP server under Node ≥18.');
    }
    const api = new OrgApi(new OrgHttp(auth, fetchImpl));

    // Function run/push need a working dir for artifacts + staged .ds files.
    const outputDir = path.join(os.tmpdir(), 'zoho-mcp-work');

    const functions: FunctionPort = {
        runStandalone: (apiName, args) =>
            fnService.runTest({ target: apiName, args: args as Record<string, unknown>, outputDir }),
        getFunctionCode: async (apiName) => {
            const code = await fnService.getRemoteCode(apiName);
            if (!code) {
                throw new Error(`No function named "${apiName}" found in this org.`);
            }
            return code;
        },
        pushFunction: async (apiName, code) => {
            const fs = await import('fs');
            const safe = String(apiName).replace(/[^A-Za-z0-9_]/g, '_');
            const dir = path.join(os.tmpdir(), 'zoho-mcp-push');
            await fs.promises.mkdir(dir, { recursive: true });
            const file = path.join(dir, `mcp.${safe}.ds`);
            await fs.promises.writeFile(file, code, 'utf8');
            try {
                return await fnService.pushCode({ file, outputDir });
            } finally {
                await fs.promises.rm(file, { force: true }).catch(() => undefined);
            }
        }
    };

    // Writes enabled by default (the launching agent gates each call). In
    // read-only mode, every confirm-gated write is declined.
    const confirm = async (): Promise<boolean> => !readonly;

    return { api, functions, confirm };
}

async function main(): Promise<void> {
    const readonly = /^(1|true|yes|y|on|enabled)$/i.test((process.env.ZOHO_MCP_READONLY || '').trim());
    const sessionPath = resolveSessionPath(process.argv[2]);

    const session = await readSessionFile(sessionPath);
    await configureAuth(sessionPath, session);
    logErr(`session loaded from ${sessionPath} (dc=${session.dc}, readonly=${readonly})`);

    const server = new McpServer(SERVER_INFO);
    registerAllTools(server, buildStdioCtx(readonly));

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logErr('stdio MCP server ready — 13 tools registered');
}

main().catch((e) => {
    logErr(`fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
});
