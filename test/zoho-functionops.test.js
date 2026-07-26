/*
 * M5 tests: pure FunctionOps (path/name/coerce/org-match/hints + guard
 * ordering), the plain-text run renderer, and updateStandaloneContext.
 * Run with:  node test/zoho-functionops.test.js   (after compile)
 */
'use strict';

const Module = require('module');

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

// vscode mock (only needed for functionCommands' updateStandaloneContext).
const ctxCalls = [];
const vscode = {
    commands: { executeCommand: (cmd, key, val) => { if (cmd === 'setContext') ctxCalls.push({ key, val }); return Promise.resolve(); } }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

const fnops = require('../out/zoho/functionOps.js');
const { renderTestResult } = require('../out/zoho/runRenderer.js');
const { updateStandaloneContext } = require('../out/zoho/functionCommands.js');

function mockSvc(over) {
    const calls = { resolveTarget: 0, executeTest: 0, pullOne: 0, pushCode: 0, assertStandalone: 0, lastOutputDir: undefined };
    return Object.assign({
        calls,
        async resolveTarget() { calls.resolveTarget++; return { mode: 'local', script: '', apiName: 'Foo', namespace: 'standalone', category: 'Standalone', args: [{ type: 'int', name: 'n' }] }; },
        async executeTest(p) { calls.executeTest++; calls.lastOutputDir = p.outputDir; return { resolved: p.resolved, args: p.args, response: {}, fnResult: { status: 'success' }, savedPath: '/x.json', success: true }; },
        async pullOne(p) { calls.pullOne++; calls.lastOutputDir = p.outputDir; return { apiName: 'Foo', filePath: '/f.ds', namespace: 'standalone', category: 'Standalone' }; },
        async pushCode(p) { calls.pushCode++; calls.lastOutputDir = p.outputDir; return { apiName: 'Foo', id: '1', filePath: p.file, category: 'Standalone' }; },
        async createFunction(p) { return { apiName: p.apiName, id: '1', pushed: true, filePath: '/c.ds' }; },
        assertStandalone() { calls.assertStandalone++; },
        isStandalone() { return true; }
    }, over);
}
const mkOps = (svc, over) => new fnops.FunctionOps(Object.assign({
    svc, getOutputDir: () => 'D:/proj', isAuthenticated: () => true, getCurrentApiDomain: () => 'https://a', getSessionApiDomain: () => 'https://a'
}, over));

(async () => {
    console.log('\n-- path / name helpers --');
    ok('isStandalonePath true for all function categories (standalone, automation, button, schedule, etc.)', fnops.isStandalonePath('C:/p/crm/functions/standalone/standalone.Foo.ds') && fnops.isStandalonePath('C:/p/crm/functions/automation/automation.Bar.ds') && fnops.isStandalonePath('C:/p/crm/functions/button/button.Btn.ds'));
    ok('isStandalonePath false for non-function paths', !fnops.isStandalonePath('/p/scratch.ds') && !fnops.isStandalonePath('/p/other/foo.txt'));
    ok('deriveApiNameFromPath parses <ns>.<api>.ds', fnops.deriveApiNameFromPath('/p/standalone.Get_Assistants.ds') === 'Get_Assistants' && fnops.deriveApiNameFromPath('/p/standalone.a.b.ds') === 'a.b' && fnops.deriveApiNameFromPath('/p/foo.ds') === 'foo');
    ok('deriveNamespaceFromPath', fnops.deriveNamespaceFromPath('/p/standalone.Foo.ds') === 'standalone' && fnops.deriveNamespaceFromPath('/p/foo.ds') === undefined);
    ok('needsPushBeforeRun true when no category (not on org yet)', fnops.needsPushBeforeRun({ category: null }) === true && fnops.needsPushBeforeRun({ category: undefined }) === true);
    ok('needsPushBeforeRun false once the function exists on the org', fnops.needsPushBeforeRun({ category: 'Standalone' }) === false);

    console.log('\n-- coercion --');
    ok('coerceArg int', fnops.coerceArg('5', 'int') === 5 && fnops.coerceArg('x', 'int') === 'x');
    ok('coerceArg double', fnops.coerceArg('3.14', 'decimal') === 3.14);
    ok('coerceArg bool', fnops.coerceArg('true', 'bool') === true && fnops.coerceArg('no', 'bool') === false);
    ok('coerceArg string passthrough', fnops.coerceArg('hi', 'string') === 'hi');
    ok('buildArgMap coerces by declared type', JSON.stringify(fnops.buildArgMap([{ type: 'int', name: 'n' }, { type: 'string', name: 's' }], { n: '7', s: 'hi' })) === JSON.stringify({ n: 7, s: 'hi' }));

    console.log('\n-- org-match + hints --');
    {
        let okm = true; try { fnops.assertOrgMatch('https://a', 'https://a'); } catch { okm = false; }
        ok('assertOrgMatch passes when equal', okm);
        let c = ''; try { fnops.assertOrgMatch('https://a', 'https://b'); } catch (e) { c = e.code; }
        ok('assertOrgMatch WRONG_ORG on mismatch', c === 'WRONG_ORG');
        c = ''; try { fnops.assertOrgMatch(undefined, 'https://b'); } catch (e) { c = e.code; }
        ok('assertOrgMatch fail-closed on undefined', c === 'WRONG_ORG');
        const codes = Object.keys(fnops.FN_ERROR_HINTS);
        ok('every error hint is non-empty and free of "zcrm"', codes.length > 0 && codes.every((k) => fnops.FN_ERROR_HINTS[k] && !/zcrm/i.test(fnops.FN_ERROR_HINTS[k])));
        ok('hintFor maps a coded error', fnops.hintFor(fnops.fnError('x', 'NOT_STANDALONE')) === fnops.FN_ERROR_HINTS.NOT_STANDALONE);
        ok('hintFor undefined for an uncoded error', fnops.hintFor(new Error('x')) === undefined);
    }

    console.log('\n-- FunctionOps guards (no svc call until valid) --');
    {
        const svc = mockSvc();
        let c = '';
        try { await mkOps(svc, { isAuthenticated: () => false }).resolveForRun('/p/standalone.Foo.ds'); } catch (e) { c = e.code; }
        ok('not authenticated → NOT_AUTHENTICATED before svc', c === 'NOT_AUTHENTICATED' && svc.calls.resolveTarget === 0);

        c = '';
        try { await mkOps(svc, { getOutputDir: () => undefined }).resolveForRun('/p/standalone.Foo.ds'); } catch (e) { c = e.code; }
        ok('no folder → NO_FOLDER before svc', c === 'NO_FOLDER' && svc.calls.resolveTarget === 0);

        c = '';
        try { await mkOps(svc, { getSessionApiDomain: () => 'https://b' }).resolveForRun('/p/standalone.Foo.ds'); } catch (e) { c = e.code; }
        ok('wrong org → WRONG_ORG before svc', c === 'WRONG_ORG' && svc.calls.resolveTarget === 0);

        const resolved = await mkOps(svc).resolveForRun('/p/standalone.Foo.ds');
        ok('valid resolveForRun calls assertStandalone + returns target', resolved.apiName === 'Foo' && svc.calls.assertStandalone === 1);

        await mkOps(svc).run(resolved, { n: 5 });
        ok('run passes the absolute outputDir + args to executeTest', svc.calls.executeTest === 1 && svc.calls.lastOutputDir === 'D:/proj');

        // pull is read-only → no org-match required (works under an org mismatch).
        svc.calls.lastOutputDir = undefined;
        await mkOps(svc, { getSessionApiDomain: () => 'https://b' }).pull('Foo');
        ok('pull does NOT require org-match (read-only)', svc.calls.pullOne === 1 && svc.calls.lastOutputDir === 'D:/proj');
    }

    console.log('\n-- renderTestResult (plain text) --');
    {
        const out = renderTestResult({ resolved: { apiName: 'Foo' }, fnResult: { output: { value: 'hi' }, logs: [{ line_number: 3, category: 'info', value: 'log1' }], network_logs: [], metrics: { statements_executed: 2, time_taken_in_ms: 5 } }, savedPath: '/x.json', success: true });
        ok('renders SUCCESS + fn name', /✓ SUCCESS/.test(out) && /standalone\.Foo/.test(out));
        ok('unwraps the {value} envelope', /Return: hi/.test(out));
        ok('shows info logs with line numbers', /L3 .*log1/.test(out));
        ok('metrics with safe defaults', /2 statements/.test(out) && /0 mail/.test(out) && /5ms/.test(out));
        ok('shows the saved-artifact path', /Saved → \/x\.json/.test(out));
        ok('contains NO ANSI escape codes', !/\x1b/.test(out));
        const fail = renderTestResult({ resolved: { apiName: 'Bar' }, fnResult: { output: null, metrics: {} }, savedPath: '', success: false });
        ok('renders FAILED + empty return', /✗ FAILED/.test(fail) && /Return: \(empty\)/.test(fail));

        // Compile/runtime errors must be surfaced (from response.functions[].error).
        const compileErr = renderTestResult({
            resolved: { apiName: 'ataya' },
            response: { functions: [{ output: null, metrics: null, status: 'failure', error: { line_number: 7, function_name: 'ataya', type: 'COMPILE_ERROR', message: 'The syntax is incorrect. Please check the format.' } }] },
            fnResult: { output: null, metrics: {}, error: { line_number: 7, function_name: 'ataya', type: 'COMPILE_ERROR', message: 'The syntax is incorrect. Please check the format.' } },
            savedPath: '/x.json',
            success: false
        });
        ok('renders the error type + line + message', /Errors \(1\):/.test(compileErr) && /\[COMPILE_ERROR\] L7 in ataya: The syntax is incorrect\./.test(compileErr));
        // Falls back to fnResult.error when response.functions is absent.
        const fallbackErr = renderTestResult({ resolved: { apiName: 'Baz' }, fnResult: { output: null, metrics: {}, error: 'Unexpected token' }, savedPath: '', success: false });
        ok('error fallback + string-shaped error', /Errors \(1\):/.test(fallbackErr) && /Unexpected token/.test(fallbackErr));
        // No error block on success.
        ok('no Errors section on success', !/Errors \(/.test(out));
    }

    console.log('\n-- updateStandaloneContext --');
    {
        const mkEditor = (langId, fsPath) => ({ document: { languageId: langId, uri: { fsPath, scheme: 'file' } } });
        ctxCalls.length = 0;
        updateStandaloneContext(mkEditor('deluge', 'C:/p/crm/functions/standalone/standalone.Foo.ds'));
        ok('true for a deluge standalone .ds', ctxCalls.some((c) => c.key === 'zohoDeluge.isStandaloneFn' && c.val === true));
        ctxCalls.length = 0;
        updateStandaloneContext(mkEditor('deluge', 'C:/p/scratch.ds'));
        ok('false for a non-standalone .ds', ctxCalls.some((c) => c.key === 'zohoDeluge.isStandaloneFn' && c.val === false));
        ctxCalls.length = 0;
        updateStandaloneContext(undefined);
        ok('false when there is no editor', ctxCalls.some((c) => c.key === 'zohoDeluge.isStandaloneFn' && c.val === false));
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    Module._load = originalLoad;
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
