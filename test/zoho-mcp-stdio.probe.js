/*
 * E2E probe for the standalone stdio MCP server. Spawns the REAL bundled binary
 * (dist/mcp-stdio.js) the way an external agent (Antigravity) would, connects
 * with the SDK's own stdio MCP client, and verifies it boots from a session file
 * and advertises all 13 tools. (Tool *execution* needs a live org + proxy, so it
 * is covered by the HTTP probe against the shared tool layer, not here.)
 *
 *   node test/zoho-mcp-stdio.probe.js   (after `npm run compile && npm run bundle`)
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n)); };

const STDIO_BIN = path.join(__dirname, '..', 'dist', 'mcp-stdio.js');

(async () => {
    if (!fs.existsSync(STDIO_BIN)) {
        console.error(`SKIP: ${STDIO_BIN} not built — run \`npm run bundle\` first.`);
        process.exit(1);
    }

    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

    // A dummy-but-well-formed session file: boot + tools/list make no network
    // calls (auth only fires on an actual tool invocation), so a fake proxy/token
    // is enough to prove the binary launches and registers its tools.
    const sessionPath = path.join(os.tmpdir(), `zoho-mcp-stdio-probe-${Date.now()}.json`);
    fs.writeFileSync(
        sessionPath,
        JSON.stringify({
            v: 1,
            dc: 'com',
            proxy: { url: 'https://proxy.invalid/exec', token: 'x' },
            tokens: { refresh_token: 'DUMMY', api_domain: 'https://www.zohoapis.com' }
        }),
        'utf8'
    );

    const client = new Client({ name: 'stdio-probe', version: '0' });
    const transport = new StdioClientTransport({
        command: process.execPath, // the current node
        args: [STDIO_BIN, sessionPath],
        env: { ...process.env, ZOHO_MCP_SESSION: sessionPath },
        stderr: 'inherit'
    });

    try {
        await client.connect(transport);
        ok('stdio binary boots + completes MCP handshake', true);

        const list = await client.listTools();
        const names = list.tools.map((t) => t.name);
        ok('advertises all 13 tools over stdio', names.length === 13);
        ok('includes a read tool (zoho_org_info)', names.includes('zoho_org_info'));
        ok('includes a write tool (zoho_push_function)', names.includes('zoho_push_function'));

        await client.close();
    } catch (e) {
        ok('stdio binary boots + completes MCP handshake', false);
        console.error('  ERROR:', e && (e.stack || e.message || e));
    } finally {
        fs.unlinkSync(sessionPath);
    }

    console.log(`\nTotal: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASHED:', e.stack || e); process.exit(1); });
