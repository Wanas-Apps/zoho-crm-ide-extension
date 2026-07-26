/*
 * MCP capability-layer tests: OrgHttp + OrgApi (pure, no vscode / no MCP SDK).
 * Run with:  node test/zoho-mcp.test.js   (after compile)
 */
'use strict';

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

const { OrgHttp, OrgApi, OrgError } = require('../out/zoho/mcp/orgApi.js');

const authOk = { isAuthenticated: () => true, getAccessToken: async () => 'TOK', getApiBaseUrl: () => 'https://www.zohoapis.com' };
const authOff = { isAuthenticated: () => false, getAccessToken: async () => '', getApiBaseUrl: () => '' };

function mkFetch(resp = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: resp.ok !== false, status: resp.status || 200, async text() { return JSON.stringify(resp.body || {}); } };
    };
    return { fetchImpl, calls };
}

(async () => {
    console.log('\n-- OrgHttp --');
    {
        const { fetchImpl } = mkFetch();
        let code = '';
        try { await new OrgHttp(authOff, fetchImpl).get('/x'); } catch (e) { code = e.code; }
        ok('not authenticated → NOT_AUTHENTICATED before any fetch', code === 'NOT_AUTHENTICATED');
    }
    {
        const { fetchImpl, calls } = mkFetch({ body: { ok: 1 } });
        const data = await new OrgHttp(authOk, fetchImpl).get('/crm/v8/org');
        ok('builds base + path URL', calls[0].url === 'https://www.zohoapis.com/crm/v8/org');
        ok('sends Zoho-oauthtoken bearer', calls[0].init.headers.Authorization === 'Zoho-oauthtoken TOK');
        ok('GET has no body', calls[0].init.body === undefined);
        ok('returns parsed JSON', data && data.ok === 1);
    }
    {
        const { fetchImpl } = mkFetch({ ok: false, status: 400, body: { message: 'bad' } });
        let err;
        try { await new OrgHttp(authOk, fetchImpl).get('/x'); } catch (e) { err = e; }
        ok('HTTP !ok → OrgError API_ERROR with message', err instanceof OrgError && err.code === 'API_ERROR' && /bad/.test(err.message));
    }
    {
        const { fetchImpl } = mkFetch({ body: { status: 'error', message: 'nope' } });
        let code = '';
        try { await new OrgHttp(authOk, fetchImpl).post('/x', {}); } catch (e) { code = e.code; }
        ok('body status=error → API_ERROR even on HTTP 200', code === 'API_ERROR');
    }

    console.log('\n-- OrgApi endpoints --');
    const last = (calls) => calls[calls.length - 1];
    {
        const { fetchImpl, calls } = mkFetch({ body: {} });
        const api = new OrgApi(new OrgHttp(authOk, fetchImpl));

        await api.queryRecords('select Last_Name from Leads limit 5');
        ok('queryRecords → POST /coql with select_query', last(calls).url.endsWith('/crm/v8/coql') && last(calls).init.method === 'POST' && JSON.parse(last(calls).init.body).select_query.includes('Leads'));

        await api.getRecord('Leads', '123');
        ok('getRecord → GET /crm/v8/Leads/123', last(calls).url.endsWith('/crm/v8/Leads/123') && last(calls).init.method === 'GET');

        await api.createRecord('Leads', { Last_Name: 'X' });
        ok('createRecord → POST module with {data:[...]}', last(calls).init.method === 'POST' && last(calls).url.endsWith('/crm/v8/Leads') && JSON.parse(last(calls).init.body).data[0].Last_Name === 'X');

        await api.updateRecord('Leads', '123', { Last_Name: 'Y' });
        ok('updateRecord → PUT module/id with {data:[...]}', last(calls).init.method === 'PUT' && last(calls).url.endsWith('/crm/v8/Leads/123'));

        await api.listModules();
        ok('listModules → GET /settings/modules', last(calls).url.endsWith('/crm/v8/settings/modules'));

        await api.getFields('Leads');
        ok('getFields → GET /settings/fields?module=Leads', last(calls).url.endsWith('/crm/v8/settings/fields?module=Leads'));

        await api.createField('Leads', { field_label: 'X', data_type: 'text' });
        ok('createField → POST /settings/fields?module with {fields:[...]}', last(calls).init.method === 'POST' && last(calls).url.includes('/settings/fields?module=Leads') && JSON.parse(last(calls).init.body).fields[0].data_type === 'text');

        await api.updateField('Leads', 'f99', { field_label: 'Z' });
        ok('updateField → PUT /settings/fields/{id}?module with id injected', last(calls).init.method === 'PUT' && last(calls).url.includes('/settings/fields/f99?module=Leads') && JSON.parse(last(calls).init.body).fields[0].id === 'f99');

        await api.listFunctions();
        ok('listFunctions → GET /settings/functions', last(calls).url.endsWith('/crm/v8/settings/functions'));

        await api.orgInfo();
        ok('orgInfo → GET /crm/v8/org', last(calls).url.endsWith('/crm/v8/org'));

        await api.rawRequest('GET', '/crm/v8/users');
        ok('rawRequest → GET /crm/v8/users', last(calls).url.endsWith('/crm/v8/users') && last(calls).init.method === 'GET');

        await api.listVariables();
        ok('listVariables → GET /settings/variables', last(calls).url.endsWith('/crm/v8/settings/variables'));

        await api.listTags('Leads');
        ok('listTags → GET /settings/tags?module=Leads', last(calls).url.endsWith('/crm/v8/settings/tags?module=Leads'));

        await api.listUsers('ActiveUsers');
        ok('listUsers → GET /users?type=ActiveUsers', last(calls).url.includes('/users?type=ActiveUsers'));

        await api.listWorkflows('Leads');
        ok('listWorkflows → GET /settings/automation/workflow_rules?module=Leads', last(calls).url.includes('/workflow_rules?module=Leads'));
    }

    console.log('\n-- MCP tools (registry + confirm-gate) --');
    {
        const { buildTools, runTool } = require('../out/zoho/mcp/mcpTools.js');
        const tools = buildTools();
        const byName = (n) => tools.find((t) => t.name === n);

        ok('exposes 56 tools', tools.length === 56);
        ok('reads are not gated, writes are', byName('zoho_query_records').kind === 'read' && byName('zoho_create_record').kind === 'write' && byName('zoho_run_standalone').kind === 'write');
        ok('every tool has a zod schema + run', tools.every((t) => t.schema && typeof t.run === 'function'));

        const mkCtx = (approve) => {
            const confirms = [];
            return {
                confirms,
                ctx: {
                    api: { queryRecords: async () => 'RESULT', createRecord: async () => 'CREATED' },
                    functions: { runStandalone: async () => 'RAN' },
                    confirm: async (s) => { confirms.push(s); return approve; }
                }
            };
        };

        // read → no confirm
        {
            const { ctx, confirms } = mkCtx(false);
            const r = await runTool(byName('zoho_query_records'), { select_query: 'select id from Leads' }, ctx);
            ok('read tool runs without confirm', r === 'RESULT' && confirms.length === 0);
        }
        // write declined → USER_DECLINED, handler not run
        {
            const { ctx, confirms } = mkCtx(false);
            let code = '';
            try { await runTool(byName('zoho_create_record'), { module: 'Leads', data: { Last_Name: 'X' } }, ctx); } catch (e) { code = e.code; }
            ok('write declined → USER_DECLINED + confirm shown', code === 'USER_DECLINED' && confirms.length === 1 && /Create 1 record in Leads/.test(confirms[0]));
        }
        // write approved → runs
        {
            const { ctx, confirms } = mkCtx(true);
            const r = await runTool(byName('zoho_create_record'), { module: 'Leads', data: { Last_Name: 'X' } }, ctx);
            ok('write approved → handler runs after confirm', r === 'CREATED' && confirms.length === 1);
        }
        // bad input → BAD_INPUT, no confirm
        {
            const { ctx, confirms } = mkCtx(true);
            let code = '';
            try { await runTool(byName('zoho_create_record'), { module: 'Leads' }, ctx); } catch (e) { code = e.code; }
            ok('schema mismatch → BAD_INPUT before confirm', code === 'BAD_INPUT' && confirms.length === 0);
        }
    }

    console.log('\n-- shared-session file --');
    {
        const sf = require('../out/zoho/mcp/sessionFile.js');
        const path = require('path');
        const os = require('os');
        const fs = require('fs');

        // path resolution: explicit > env > default
        ok('resolveSessionPath explicit wins', sf.resolveSessionPath('/tmp/x.json', {}) === path.resolve('/tmp/x.json'));
        ok('resolveSessionPath reads env', sf.resolveSessionPath(undefined, { ZOHO_MCP_SESSION: '/tmp/y.json' }) === path.resolve('/tmp/y.json'));
        ok('resolveSessionPath default ends with session.json', /session\.json$/.test(sf.resolveSessionPath(undefined, {})));

        // build → assert usable
        const built = sf.buildSessionFile({
            dc: 'eu',
            proxy: { url: 'https://proxy.example/exec', token: 'shh' },
            tokens: { refresh_token: 'R', api_domain: 'https://www.zohoapis.eu' },
            now: '2026-06-10T00:00:00Z'
        });
        ok('buildSessionFile sets version + dc + proxy', built.v === sf.SESSION_FILE_VERSION && built.dc === 'eu' && built.proxy.url.includes('proxy'));
        let okAssert = true;
        try { sf.assertUsableSession(built); } catch { okAssert = false; }
        ok('assertUsableSession passes a complete file', okAssert);

        // missing proxy / refresh token → clear errors
        let noProxy = '';
        try { sf.assertUsableSession({ v: 1, dc: 'com', tokens: { refresh_token: 'R' } }); } catch (e) { noProxy = e.message; }
        ok('assert rejects missing proxy', /proxy/i.test(noProxy));
        let noTok = '';
        try { sf.assertUsableSession({ v: 1, dc: 'com', proxy: { url: 'x' }, tokens: {} }); } catch (e) { noTok = e.message; }
        ok('assert rejects missing refresh_token', /refresh_token/i.test(noTok));

        // round-trip write → read → update (real temp file)
        const tmp = path.join(os.tmpdir(), `zoho-mcp-test-${Date.now()}.json`);
        await sf.writeSessionFile(tmp, built);
        const readBack = await sf.readSessionFile(tmp);
        ok('write→read round-trips refresh_token', readBack.tokens.refresh_token === 'R');
        await sf.updateSessionTokens(tmp, { access_token: 'A2', expiry_time: 999 });
        const after = await sf.readSessionFile(tmp);
        ok('updateSessionTokens merges + preserves proxy', after.tokens.access_token === 'A2' && after.proxy.url.includes('proxy') && after.tokens.refresh_token === 'R');
        fs.unlinkSync(tmp);
    }

    console.log('\n-- per-org sessions --');
    {
        const sf = require('../out/zoho/mcp/sessionFile.js');
        const path = require('path');

        // org-keyed path: ~/.zoho-crm-ide/sessions/<dc>-<orgId>.json
        const p = sf.orgSessionPath('eu', '7005000123', '/home/u');
        ok('orgSessionPath keys by dc + orgId under sessions/', /sessions[\\/]eu-7005000123\.json$/.test(p) && p.includes('.zoho-crm-ide'));
        const hostile = sf.orgSessionPath('com', '..\\..\\evil/../x', '/home/u');
        ok('orgSessionPath sanitizes hostile org ids', path.basename(hostile) === hostile.slice(hostile.length - path.basename(hostile).length) && !/\.\./.test(path.basename(hostile)));

        // org claim travels in the file
        const withOrg = sf.buildSessionFile({
            dc: 'com',
            proxy: { url: 'https://proxy.example/exec' },
            tokens: { refresh_token: 'R' },
            org: { id: '7005000123', name: 'Acme' },
            now: '2026-06-10T00:00:00Z'
        });
        ok('buildSessionFile carries the org claim', withOrg.org && withOrg.org.id === '7005000123' && withOrg.org.name === 'Acme');
        let stillOk = true;
        try { sf.assertUsableSession(withOrg); } catch { stillOk = false; }
        ok('org claim does not break assertUsableSession', stillOk);
    }

    console.log('\n-- org guard (wrong-org protection) --');
    {
        const og = require('../out/zoho/mcp/orgGuard.js');

        // startup pin check (pure, no network)
        let okPin = true;
        try { og.assertOrgPin('123', ''); og.assertOrgPin(undefined, ''); } catch { okPin = false; }
        ok('no pin → any claim accepted', okPin);
        let okMatch = true;
        try { og.assertOrgPin('123', '123'); } catch { okMatch = false; }
        ok('pin matches claim → accepted', okMatch);
        let mm = '';
        try { og.assertOrgPin('999', '123'); } catch (e) { mm = e.message; }
        ok('pin vs claim mismatch → throws with both ids', /123/.test(mm) && /999/.test(mm));
        let noClaim = '';
        try { og.assertOrgPin(undefined, '123'); } catch (e) { noClaim = e.message; }
        ok('pin but claimless session → throws re-export hint', /re-?export/i.test(noClaim));

        // org id extraction from /crm/v8/org response
        ok('extractOrgId reads zorg_id as string', og.extractOrgId({ org: [{ zorg_id: 7005000123 }] }) === '7005000123');
        ok('extractOrgId tolerates empty/missing', og.extractOrgId({}) === '' && og.extractOrgId(undefined) === '');

        // lazy org guard: resolve expected org on first use, memoize success,
        // retry after transient failure
        {
            let calls = 0;
            const guard = og.createOrgGuard({
                claimedOrgId: '123',
                resolveExpectedOrgId: async () => '123',
                fetchLiveOrgId: async () => { calls++; return '123'; }
            });
            await guard();
            await guard();
            ok('guard verifies once and memoizes success', calls === 1);
        }
        {
            const guard = og.createOrgGuard({
                claimedOrgId: '123',
                resolveExpectedOrgId: async () => '123',
                fetchLiveOrgId: async () => '999'
            });
            let code = '';
            try { await guard(); } catch (e) { code = e.code; }
            ok('live org mismatch → ORG_MISMATCH', code === 'ORG_MISMATCH');
        }
        {
            // a project-resolved expected org that contradicts the session claim
            // refuses BEFORE any live fetch (the wrong session file is loaded)
            let liveCalls = 0;
            const guard = og.createOrgGuard({
                claimedOrgId: '123',
                resolveExpectedOrgId: async () => '999',
                fetchLiveOrgId: async () => { liveCalls++; return '999'; }
            });
            let code = '';
            try { await guard(); } catch (e) { code = e.code; }
            ok('resolved org vs claim mismatch → ORG_MISMATCH before live fetch', code === 'ORG_MISMATCH' && liveCalls === 0);
        }
        {
            // unbound (no pin, no pointer, no claim) → legacy mode, no live fetch
            let liveCalls = 0;
            let warned = '';
            const guard = og.createOrgGuard({
                claimedOrgId: undefined,
                resolveExpectedOrgId: async () => '',
                fetchLiveOrgId: async () => { liveCalls++; return '1'; },
                log: (m) => { warned = m; }
            });
            await guard();
            ok('fully unbound session passes without a live fetch + warns', liveCalls === 0 && /org/i.test(warned));
        }
        {
            // claim only (no pin/pointer) → live must match the claim
            const guard = og.createOrgGuard({
                claimedOrgId: '123',
                resolveExpectedOrgId: async () => '',
                fetchLiveOrgId: async () => '999'
            });
            let code = '';
            try { await guard(); } catch (e) { code = e.code; }
            ok('claim-only binding still live-checks', code === 'ORG_MISMATCH');
        }
        {
            let calls = 0;
            const guard = og.createOrgGuard({
                claimedOrgId: '123',
                resolveExpectedOrgId: async () => '123',
                fetchLiveOrgId: async () => { calls++; if (calls === 1) { throw new Error('net down'); } return '123'; }
            });
            let firstFailed = false;
            try { await guard(); } catch { firstFailed = true; }
            await guard();
            ok('transient fetch error is not memoized — retries then passes', firstFailed && calls === 2);
        }
    }

    console.log('\n-- project org pointer (.zoho-crm-ide.json) --');
    {
        const po = require('../out/zoho/mcp/projectOrg.js');
        const path = require('path');
        const os = require('os');
        const fs = require('fs');

        // parsing
        const good = JSON.stringify({ v: 1, org_id: '7005000123', dc: 'eu', org_name: 'Acme' });
        const parsed = po.parseProjectOrg(good);
        ok('parseProjectOrg reads org_id/dc/org_name', parsed && parsed.orgId === '7005000123' && parsed.dc === 'eu' && parsed.name === 'Acme');
        ok('parseProjectOrg rejects missing org_id', po.parseProjectOrg(JSON.stringify({ v: 1, dc: 'com' })) === undefined);
        ok('parseProjectOrg rejects non-JSON', po.parseProjectOrg('not json {') === undefined);
        const numeric = po.parseProjectOrg(JSON.stringify({ v: 1, org_id: 7005000123, dc: 'com' }));
        ok('parseProjectOrg coerces numeric org_id to string', !!numeric && numeric.orgId === '7005000123');

        // writer round-trips through the parser
        const body = po.buildProjectOrgJson({ orgId: '42', dc: 'com', name: 'X' });
        const roundTrip = po.parseProjectOrg(body);
        ok('buildProjectOrgJson round-trips', !!roundTrip && roundTrip.orgId === '42' && roundTrip.dc === 'com');

        // discovery: same dir, walk-up from a nested dir, not found
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zoho-proj-'));
        const nested = path.join(base, 'a', 'b');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(base, po.PROJECT_ORG_FILE), good, 'utf8');
        const hitSame = await po.findProjectOrg(base);
        ok('findProjectOrg finds the file in the start dir', !!hitSame && hitSame.org.orgId === '7005000123' && hitSame.dir === base);
        const hitUp = await po.findProjectOrg(nested);
        ok('findProjectOrg walks up to a parent', !!hitUp && hitUp.org.orgId === '7005000123');
        const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'zoho-none-'));
        ok('findProjectOrg returns undefined when absent', (await po.findProjectOrg(lonely)) === undefined);
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(lonely, { recursive: true, force: true });

        // MCP roots → candidate dirs
        const dirs = po.rootsToDirs([
            { uri: 'file:///D:/Projects/Demo' },
            { uri: 'https://example.com/not-a-file' },
            { name: 'no uri at all' }
        ]);
        ok('rootsToDirs converts file URIs and skips the rest', dirs.length === 1 && /Demo$/.test(dirs[0]));
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
