/**
 * The embedded MCP HTTP server. Exposes the Zoho CRM tools (from `buildTools`)
 * to MCP-speaking LLM agents over a loopback Streamable-HTTP endpoint guarded by
 * a per-launch Bearer token.
 *
 * Design notes:
 *  - Raw Node `http` (NOT express) — express is bundle-gated out of the
 *    extension. The MCP SDK's StreamableHTTPServerTransport speaks plain
 *    req/res, so no web framework is needed.
 *  - Stateless: a fresh McpServer + transport per request (sessionIdGenerator
 *    undefined). No session affinity to manage; each call is self-contained.
 *  - Pure of vscode. The vscode glue (auth adapter, confirm modal, the VS Code
 *    MCP registration) lives in mcpActivate.ts; this file only needs a ToolCtx
 *    factory so each request runs against a freshly-read auth/session.
 *
 * The SDK is ESM-only (`type: module`) but its compiled CJS build is imported
 * from the explicit `dist/cjs/...` paths so TypeScript's classic node module
 * resolution (and esbuild) both resolve it without an exports-map round-trip.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildTools, runTool, ToolCtx, ToolDef } from './mcpTools';
import { OrgError } from './orgApi';

/** Live handle for a started server. */
export interface McpServerHandle {
    /** The full endpoint URL agents POST to (e.g. http://127.0.0.1:1234/mcp). */
    readonly url: string;
    /** The Bearer token agents must present. */
    readonly token: string;
    /** The bound loopback port. */
    readonly port: number;
    /** Stop the server and free the port. */
    dispose(): Promise<void>;
}

export interface McpServerOptions {
    /** Build the per-request tool context (auth/session read fresh each call). */
    ctxFactory: () => ToolCtx;
    /** Override the Bearer token (defaults to a random 24-byte hex string). */
    token?: string;
    /** Override the loopback port (defaults to an OS-assigned ephemeral port). */
    port?: number;
}

const SERVER_INFO = { name: 'zoho-crm-ide', version: '0.7.0' };
const MCP_PATH = '/mcp';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Build a fresh McpServer with every Zoho tool registered against `ctx`. */
function makeServer(ctx: ToolCtx): McpServer {
    const server = new McpServer(SERVER_INFO);
    registerAllTools(server, ctx);
    return server;
}

/** Register every Zoho tool on an existing McpServer. Shared by the HTTP server
 *  (this file) and the stdio server (mcpStdio.ts) so both expose an identical
 *  tool surface. */
export function registerAllTools(server: McpServer, ctx: ToolCtx): void {
    for (const tool of buildTools()) {
        registerOne(server, tool, ctx);
    }
}

export { SERVER_INFO };

/** Adapt one ToolDef into an SDK tool registration. The SDK validates args
 *  against the shape; `runTool` re-validates and enforces the write confirm. */
function registerOne(server: McpServer, tool: ToolDef, ctx: ToolCtx): void {
    const handler = async (args: unknown) => {
        try {
            const result = await runTool(tool, args, ctx);
            return { content: [{ type: 'text', text: safeJson(result) }] };
        } catch (e) {
            const code = e instanceof OrgError ? e.code : 'ERROR';
            const message = e instanceof Error ? e.message : String(e);
            return {
                content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
                isError: true
            };
        }
    };
    // The SDK's generic inference over heterogeneous per-tool shapes doesn't add
    // safety here (we validate in runTool), so cast at this single boundary.
    (server.registerTool as unknown as (n: string, c: unknown, cb: unknown) => unknown)(
        tool.name,
        { description: tool.description, inputSchema: tool.schema.shape },
        handler
    );
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value ?? null, null, 2);
    } catch {
        return JSON.stringify({ note: 'result not serializable', value: String(value) });
    }
}

/** Read and JSON-parse a request body (POST). Empty body → undefined. */
function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

/** Constant-time Bearer check against the launch token. */
function authorized(req: http.IncomingMessage, token: string): boolean {
    const h = req.headers['authorization'];
    if (!h || Array.isArray(h)) {
        return false;
    }
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) {
        return false;
    }
    const a = Buffer.from(m[1]);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: McpServerOptions,
    token: string
): Promise<void> {
    const pathOnly = (req.url || '/').split('?')[0];
    if (pathOnly !== MCP_PATH) {
        res.writeHead(404, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
    }
    if (!authorized(req, token)) {
        res.writeHead(401, { ...JSON_HEADERS, 'WWW-Authenticate': 'Bearer' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
        return;
    }

    const body = req.method === 'POST' ? await readBody(req) : undefined;

    // Stateless: a fresh server + transport per request, torn down on close.
    const server = makeServer(opts.ctxFactory());
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
}

/**
 * Start the MCP server on a loopback port. Resolves once it is listening.
 */
export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
    const token = options.token || crypto.randomBytes(24).toString('hex');

    const httpServer = http.createServer((req, res) => {
        handle(req, res, options, token).catch((e) => {
            if (!res.headersSent) {
                res.writeHead(500, JSON_HEADERS);
            }
            res.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
                    id: null
                })
            );
        });
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port ?? 0, '127.0.0.1', () => {
            httpServer.removeListener('error', reject);
            resolve();
        });
    });

    const addr = httpServer.address();
    const port = addr && typeof addr === 'object' ? addr.port : options.port ?? 0;

    return {
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        token,
        port,
        dispose: () =>
            new Promise<void>((resolve) => {
                httpServer.close(() => resolve());
            })
    };
}
