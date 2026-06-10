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
    }

    console.log('\n-- MCP tools (registry + confirm-gate) --');
    {
        const { buildTools, runTool } = require('../out/zoho/mcp/mcpTools.js');
        const tools = buildTools();
        const byName = (n) => tools.find((t) => t.name === n);

        ok('exposes 13 tools', tools.length === 13);
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

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
