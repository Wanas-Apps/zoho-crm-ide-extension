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

    // Neutral cwd: the repo itself may carry a .zoho-crm-ide.json (sign-in
    // writes one into the open workspace), which would org-bind this case.
    const neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zoho-mcp-cwd-'));
    const client = new Client({ name: 'stdio-probe', version: '0' });
    const transport = new StdioClientTransport({
        command: process.execPath, // the current node
        args: [STDIO_BIN, sessionPath],
        env: { ...process.env, ZOHO_MCP_SESSION: sessionPath },
        cwd: neutralCwd,
        stderr: 'inherit'
    });

    try {
        await client.connect(transport);
        ok('stdio binary boots + completes MCP handshake', true);

        const list = await client.listTools();
        const names = list.tools.map((t) => t.name);
        ok('advertises all 56 tools over stdio', names.length === 56);
        ok('includes a read tool (zoho_org_info)', names.includes('zoho_org_info'));
        ok('includes a write tool (zoho_push_function)', names.includes('zoho_push_function'));

        await client.close();
    } catch (e) {
        ok('stdio binary boots + completes MCP handshake', false);
        console.error('  ERROR:', e && (e.stack || e.message || e));
    } finally {
        fs.unlinkSync(sessionPath);
        fs.rmSync(neutralCwd, { recursive: true, force: true });
    }

    // Wrong-org guard: a server entry pinned to org B must refuse a session
    // file claiming org A at boot (before any tool is advertised).
    {
        const { spawn } = require('child_process');
        const pinnedSession = path.join(os.tmpdir(), `zoho-mcp-stdio-pin-${Date.now()}.json`);
        fs.writeFileSync(
            pinnedSession,
            JSON.stringify({
                v: 1,
                dc: 'com',
                proxy: { url: 'https://proxy.invalid/exec', token: 'x' },
                org: { id: '111', name: 'Org A' },
                tokens: { refresh_token: 'DUMMY', api_domain: 'https://www.zohoapis.com' }
            }),
            'utf8'
        );
        try {
            const result = await new Promise((resolve) => {
                const child = spawn(process.execPath, [STDIO_BIN, pinnedSession], {
                    env: { ...process.env, ZOHO_MCP_SESSION: pinnedSession, ZOHO_MCP_EXPECTED_ORG: '222' },
                    stdio: ['ignore', 'ignore', 'pipe']
                });
                let stderr = '';
                child.stderr.on('data', (d) => { stderr += d; });
                const t = setTimeout(() => { child.kill(); resolve({ code: -1, stderr }); }, 15000);
                child.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr }); });
            });
            ok('pinned entry refuses a wrong-org session at boot (exit 1)', result.code === 1);
            ok('refusal names both orgs on stderr', /111/.test(result.stderr) && /222/.test(result.stderr));
        } finally {
            fs.unlinkSync(pinnedSession);
        }
    }

    // Project pointer: a .zoho-crm-ide.json in the working directory binds the
    // org with NO env pin — a session claiming a different org must be refused.
    {
        const { spawn } = require('child_process');
        const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoho-mcp-proj-'));
        fs.writeFileSync(
            path.join(projDir, '.zoho-crm-ide.json'),
            JSON.stringify({ v: 1, org_id: '111', dc: 'com', org_name: 'Org A' }),
            'utf8'
        );
        const otherOrgSession = path.join(projDir, 'session-org-222.json');
        fs.writeFileSync(
            otherOrgSession,
            JSON.stringify({
                v: 1,
                dc: 'com',
                proxy: { url: 'https://proxy.invalid/exec', token: 'x' },
                org: { id: '222', name: 'Org B' },
                tokens: { refresh_token: 'DUMMY', api_domain: 'https://www.zohoapis.com' }
            }),
            'utf8'
        );
        try {
            const env = { ...process.env, ZOHO_MCP_SESSION: otherOrgSession };
            delete env.ZOHO_MCP_EXPECTED_ORG;
            const result = await new Promise((resolve) => {
                const child = spawn(process.execPath, [STDIO_BIN], { cwd: projDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
                let stderr = '';
                child.stderr.on('data', (d) => { stderr += d; });
                const t = setTimeout(() => { child.kill(); resolve({ code: -1, stderr }); }, 15000);
                child.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr }); });
            });
            ok('project pointer discovered from cwd', /project pointer: org 111/.test(result.stderr));
            ok('pointer org vs session claim mismatch refused at boot (exit 1)', result.code === 1 && /111/.test(result.stderr) && /222/.test(result.stderr));
        } finally {
            fs.rmSync(projDir, { recursive: true, force: true });
        }
    }

    console.log(`\nTotal: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASHED:', e.stack || e); process.exit(1); });
