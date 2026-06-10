/*
 * Ambient declarations for the slice of `@modelcontextprotocol/sdk` the embedded
 * MCP server consumes.
 *
 * Why a shim: the SDK is published ESM-only (`type: module`) with an `exports`
 * map and a `./*` wildcard. The runtime specifier that resolves correctly under
 * Node/esbuild is `@modelcontextprotocol/sdk/server/<file>.js`, but the project's
 * `tsconfig` uses classic `node` module resolution, which ignores `exports` and
 * so can't find a physical `server/mcp.js` next to the package root. Rather than
 * migrate the whole build to `node16`/`bundler` resolution (which would force
 * `.js` extensions on every relative import and break the `import = require`
 * core bridge), we declare the minimal surface here — the same approach already
 * used for the JS core in `zcrm-core.d.ts`. esbuild still bundles the real
 * module via the exports map at build time.
 */

declare module '@modelcontextprotocol/sdk/server/mcp.js' {
    export class McpServer {
        constructor(serverInfo: { name: string; version: string });
        registerTool(name: string, config: unknown, cb: unknown): unknown;
        connect(transport: unknown): Promise<void>;
        close(): Promise<void>;
    }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
    export class StdioServerTransport {
        constructor();
        close(): Promise<void>;
    }
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp.js' {
    import type { IncomingMessage, ServerResponse } from 'http';

    export interface StreamableHTTPServerTransportOptions {
        /** `undefined` selects stateless mode (a fresh transport per request). */
        sessionIdGenerator: undefined | (() => string);
    }

    export class StreamableHTTPServerTransport {
        constructor(options: StreamableHTTPServerTransportOptions);
        handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
        close(): Promise<void>;
    }
}
