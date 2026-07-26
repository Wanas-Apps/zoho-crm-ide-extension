/*
 * E2E probe (not part of the unit suite): boots the real compiled MCP server,
 * connects with the SDK's own MCP client over Streamable-HTTP, and exercises
 * the auth gate + tool listing + a read call + a confirm-gated write.
 *
 *   node test/zoho-mcp-e2e.probe.js   (after `npm run compile`)
 */
'use strict';

const { startMcpServer } = require('../out/zoho/mcp/mcpServer.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n)); };

// Fake org context: records what got called; confirm() approves writes.
const calls = [];
const ctxFactory = () => ({
    api: {
        queryRecords: async (q) => { calls.push(['query', q]); return { data: [{ id: '1', Last_Name: 'Probe' }] }; },
        listModules: async () => ({ modules: [{ api_name: 'Leads' }] }),
        createRecord: async (m, d) => { calls.push(['create', m, d]); return { data: [{ code: 'SUCCESS' }] }; }
    },
    functions: {},
    confirm: async () => true
});

(async () => {
    const handle = await startMcpServer({ ctxFactory });
    console.log('server at', handle.url);

    // 1) Unauthorized (no Bearer) → connection rejected.
    {
        let denied = false;
        const c = new Client({ name: 'probe', version: '0' });
        const t = new StreamableHTTPClientTransport(new URL(handle.url));
        try { await c.connect(t); } catch { denied = true; }
        await c.close().catch(() => {});
        ok('rejects connection without Bearer token', denied);
    }

    // 2) Authorized handshake + tools/list.
    const client = new Client({ name: 'probe', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: { Authorization: `Bearer ${handle.token}` } }
    });
    await client.connect(transport);
    ok('connects with valid Bearer token', true);

    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    ok('lists all 56 tools', names.length === 56);
    ok('includes a read tool (zoho_query_records)', names.includes('zoho_query_records'));
    ok('includes a write tool (zoho_create_record)', names.includes('zoho_create_record'));

    // 3) Read call round-trips JSON.
    {
        const r = await client.callTool({ name: 'zoho_query_records', arguments: { select_query: 'select id from Leads' } });
        const text = r.content && r.content[0] && r.content[0].text;
        ok('read tool returns org JSON', /Probe/.test(text) && calls.some((c) => c[0] === 'query'));
    }

    // 4) Write call passes through the confirm gate (approved here).
    {
        const r = await client.callTool({ name: 'zoho_create_record', arguments: { module: 'Leads', data: { Last_Name: 'X' } } });
        const text = r.content && r.content[0] && r.content[0].text;
        ok('write tool runs after confirm approves', /SUCCESS/.test(text) && calls.some((c) => c[0] === 'create'));
    }

    // 5) Bad input surfaces a structured error, not a crash. (The SDK validates
    //    inputSchema at the protocol layer; our runTool BAD_INPUT is a backstop.)
    {
        const r = await client.callTool({ name: 'zoho_get_record', arguments: { module: 'Leads' } });
        const text = r.content && r.content[0] && r.content[0].text;
        ok('schema mismatch → isError (validation)', r.isError === true && /validation|BAD_INPUT/i.test(text));
    }

    await client.close();
    await handle.dispose();

    console.log(`\nTotal: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
    // process.exit() here races libuv's async-handle close on Windows (the
    // uv_async_send assertion in win/async.c) while undici sockets from the
    // HTTP transports are still tearing down. Set exitCode and let the loop
    // drain instead; the unref'd watchdog force-exits only if something hangs.
    process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('PROBE CRASHED:', e.stack || e); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 10_000).unref());
