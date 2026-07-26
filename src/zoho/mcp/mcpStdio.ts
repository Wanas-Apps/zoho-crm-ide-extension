/**
 * Standalone **stdio** MCP server — the entry point an external agent (Antigravity,
 * Cursor, Claude Desktop, …) launches as a subprocess. It exposes the SAME set of
 * Zoho tools as the in-process HTTP server, but authenticates from the shared
 * session file (sessionFile.ts) instead of VS Code SecretStorage, so it works
 * with VS Code closed.
 *
 * Transport hygiene: stdout is the JSON-RPC channel — NOTHING may be written to
 * it except protocol frames. All diagnostics go to stderr (console.error).
 *
 * Auth: configures the bundled `wanas-zcrm-extractor` authService with a
 * file-backed token store + the proxy transport, so access-token refresh routes
 * through the user's OAuth proxy and refreshed tokens persist back to the file.
 *
 * Writes are enabled by default (the launching agent prompts before each tool
 * call). Set ZOHO_MCP_READONLY=1 to hard-disable the 6 write tools.
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import authService = require('wanas-zcrm-extractor/src/services/authService');
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools, SERVER_INFO } from './mcpServer';
import { buildTools } from './mcpTools';
import { OrgApi, OrgHttp, OrgAuth, FetchLike } from './orgApi';
import { FunctionPort, ToolCtx } from './mcpTools';
import { fnService } from '../functionServiceBridge';
import { createProxyHttp, HttpLikeClient } from '../authProxy';
import {
    resolveSessionPath,
    defaultSessionPath,
    orgSessionPath,
    readSessionFile,
    updateSessionTokens,
    SessionFile,
    SessionTokens
} from './sessionFile';
import { assertOrgPin, createOrgGuard, extractOrgId } from './orgGuard';
import { findProjectOrg, rootsToDirs } from './projectOrg';

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

function rawAuth(): OrgAuth {
    return {
        isAuthenticated: () => authService.isAuthenticated(),
        getAccessToken: () => authService.getAccessToken(),
        getApiBaseUrl: () => authService.getApiBaseUrl()
    };
}

function getFetch(): FetchLike {
    const fetchImpl = (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!fetchImpl) {
        throw new Error('global fetch unavailable — run the MCP server under Node ≥18.');
    }
    return fetchImpl;
}

/** Live-org probe over the UNGUARDED stack (guarding it would deadlock). */
function makeLiveOrgFetcher(): () => Promise<string> {
    const rawApi = new OrgApi(new OrgHttp(rawAuth(), getFetch()));
    return async () => extractOrgId(await rawApi.orgInfo());
}

/**
 * Expected org from the client's MCP roots: ask for the workspace folders and
 * look for the nearest project pointer in each. '' when the client exposes no
 * roots (most do not) or no root carries a pointer.
 */
async function projectOrgFromRoots(server: McpServer): Promise<string> {
    let roots: Array<{ uri?: unknown }>;
    try {
        const res = await server.server.listRoots(undefined, { timeout: 3000 });
        roots = (res?.roots as Array<{ uri?: unknown }>) || [];
    } catch {
        logErr('client exposes no MCP roots — org binding falls back to the session claim.');
        return '';
    }
    for (const dir of rootsToDirs(roots)) {
        const hit = await findProjectOrg(dir);
        if (hit) {
            logErr(`org ${hit.org.orgId}${hit.org.name ? ` "${hit.org.name}"` : ''} resolved from project pointer in ${hit.dir} (via MCP roots)`);
            return hit.org.orgId;
        }
    }
    return '';
}

/** Build the tool context (OrgApi + FunctionPort + confirm) for the stdio run.
 *  Everything tool-facing awaits the wrong-org guard before touching the org. */
function buildStdioCtx(readonly: boolean, ensureOrg: () => Promise<void>): ToolCtx {
    const auth = rawAuth();
    const fetchImpl = getFetch();

    const guardedAuth: OrgAuth = {
        isAuthenticated: auth.isAuthenticated,
        getApiBaseUrl: auth.getApiBaseUrl,
        getAccessToken: async () => {
            await ensureOrg();
            return auth.getAccessToken();
        }
    };
    const api = new OrgApi(new OrgHttp(guardedAuth, fetchImpl));

    // Function run/push need a working dir for artifacts + staged .ds files.
    const outputDir = path.join(os.tmpdir(), 'zoho-mcp-work');

    // fnService routes through the bridged apiClient (not OrgHttp), so each
    // port method awaits the org guard itself.
    const functions: FunctionPort = {
        runStandalone: async (apiName, args) => {
            await ensureOrg();
            return fnService.runTest({ target: apiName, args: args as Record<string, unknown>, outputDir });
        },
        getFunctionCode: async (apiName) => {
            await ensureOrg();
            const code = await fnService.getRemoteCode(apiName);
            if (!code) {
                throw new Error(`No function named "${apiName}" found in this org.`);
            }
            return code;
        },
        pushFunction: async (apiName, code) => {
            await ensureOrg();
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
    const expectedOrgEnv = (process.env.ZOHO_MCP_EXPECTED_ORG || '').trim();

    // Project pointer: nearest .zoho-crm-ide.json above $ZOHO_MCP_PROJECT (or
    // cwd) tells us which org this project belongs to — no manual pinning.
    const projectStart = (process.env.ZOHO_MCP_PROJECT || '').trim() || process.cwd();
    const projectHit = await findProjectOrg(projectStart);
    if (projectHit) {
        logErr(`project pointer: org ${projectHit.org.orgId}${projectHit.org.name ? ` "${projectHit.org.name}"` : ''} (${projectHit.dir})`);
    }

    // Session file: explicit path > the project org's per-org file > legacy.
    const explicit = (process.argv[2] || process.env.ZOHO_MCP_SESSION || '').trim();
    let sessionPath: string;
    if (explicit) {
        sessionPath = resolveSessionPath(explicit);
    } else if (projectHit) {
        const perOrg = orgSessionPath(projectHit.org.dc, projectHit.org.orgId);
        sessionPath = (await fsp.access(perOrg).then(() => true, () => false)) ? perOrg : defaultSessionPath();
    } else {
        sessionPath = defaultSessionPath();
    }

    const session = await readSessionFile(sessionPath);
    // Boot-time wrong-org check (pure, offline): an env pin or project pointer
    // refuses a session file that claims a different org before the server
    // ever advertises tools. The live check runs on the first tool call.
    const bootOrg = expectedOrgEnv || projectHit?.org.orgId || '';
    assertOrgPin(session.org?.id, bootOrg);
    await configureAuth(sessionPath, session);

    const boundOrg = bootOrg || (session.org?.id || '').trim();
    logErr(`session loaded from ${sessionPath} (dc=${session.dc}, org=${boundOrg || 'unbound'}, readonly=${readonly})`);
    if (!boundOrg) {
        logErr('warning: session has no org binding — re-export it ("Enable External MCP Access") and refresh the agent config to enable wrong-org protection.');
    }

    const server = new McpServer(SERVER_INFO);
    // Expected-org resolution order: env pin / boot pointer > the client's MCP
    // roots (resolved lazily — roots only exist after the handshake).
    const ensureOrg = createOrgGuard({
        claimedOrgId: session.org?.id,
        resolveExpectedOrgId: async () => bootOrg || (await projectOrgFromRoots(server)),
        fetchLiveOrgId: makeLiveOrgFetcher(),
        log: logErr
    });
    registerAllTools(server, buildStdioCtx(readonly, ensureOrg));

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logErr(`stdio MCP server ready — ${buildTools().length} tools registered`);
}

main().catch((e) => {
    logErr(`fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
});
