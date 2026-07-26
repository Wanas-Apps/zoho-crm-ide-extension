/*
 * M4 tests: MetadataIndex loaded from a REAL pulled folder (the CLI's
 * test_metadata sample) + the pure completion-context analyzer. No vscode
 * runtime needed. Run with:  node test/zoho-index.test.js   (after compile)
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

const { MetadataIndex, buildFunctionGroups } = require('../out/zoho/metadataIndex.js');
const { analyzeOrgContext } = require('../out/providers/orgContext.js');

const SAMPLE = path.resolve('D:/Projects/Zoho CRM Tools/wanas-zcrm-extractor/test_metadata');

(async () => {
    console.log('\n-- MetadataIndex (real sample pull) --');
    const sampleExists = fs.existsSync(path.join(SAMPLE, '.zcrm', '.store', 'functions.json'));
    if (!sampleExists) {
        console.log('  SKIP sample folder not found at ' + SAMPLE);
    } else {
        const idx = new MetadataIndex();
        await idx.load(SAMPLE);

        const sa = idx.getStandaloneCompletions();
        ok('loads 51 standalone functions', sa.length === 51);
        ok('every standalone label is namespaced', sa.every((s) => s.label.startsWith('standalone.')));

        const ataya = idx.getStandaloneSignature('ataya');
        const atayaNs = idx.getStandaloneSignature('standalone.ataya');
        ok('resolves a standalone fn by bare + namespaced key', !!ataya && ataya === atayaNs);
        ok('uses functions.json arguments for params', !!ataya && ataya.detail === 'string standalone.ataya(string crmAPIRequest)');
        ok('emits a snippet insertText with a tabstop', !!ataya && /standalone\.ataya\(\$\{1:crmAPIRequest\}\)\$0/.test(ataya.insertText));

        const testing = idx.getStandaloneSignature('testing');
        ok('null arguments → zero params', !!testing && /standalone\.testing\(\)$/.test(testing.detail) && testing.insertText === 'standalone.testing()$0');

        ok('loads 125 modules', idx.getModuleCompletions().length === 125);
        ok('isModule recognizes a real module', idx.isModule('Leads') === true && idx.isModule('Contacts') === true);
        ok('isModule rejects a non-module', idx.isModule('NotARealModule') === false);

        const leadFields = idx.getFieldSymbols('Leads');
        ok('Leads has field symbols', leadFields.length > 0 && leadFields.some((f) => f.label === 'Email'));
        ok('field detail carries the data type + module', leadFields.some((f) => /·\s*Leads$/.test(f.detail)));
        ok('field symbols are cached (stable reference)', idx.getFieldSymbols('Leads') === leadFields);
        ok('a module with an empty field map yields no fields', idx.getFieldSymbols('Cases').length === 0);

        ok('hover resolves a standalone fn', !!idx.getHoverSymbol('standalone.ataya'));
        ok('hover resolves a module', !!idx.getHoverSymbol('Leads'));
        ok('hasData() true after load', idx.hasData() === true);
    }

    console.log('\n-- MetadataIndex (empty / missing folder) --');
    {
        const idx = new MetadataIndex();
        await idx.load(path.join(require('os').tmpdir(), 'zcrm_no_such_' + process.pid));
        ok('missing store → empty, no throw', idx.getStandaloneCompletions().length === 0 && idx.getModuleCompletions().length === 0);
        ok('hasData() false when empty', idx.hasData() === false);
        ok('getFieldSymbols on unknown module is empty', idx.getFieldSymbols('Whatever').length === 0);
    }

    console.log('\n-- Completion context analyzer --');
    {
        const src = { isModule: (n) => n === 'Leads' || n === 'Contacts' };
        const a = (s) => analyzeOrgContext(s, src);

        ok('standalone. → standalone (replace 11)', JSON.stringify(a('x = standalone.')) === JSON.stringify({ kind: 'standalone', replaceLen: 11 }));
        ok('standalone.partial → standalone (replace 15)', JSON.stringify(a('y = standalone.my_f')) === JSON.stringify({ kind: 'standalone', replaceLen: 15 }));
        ok('Module. → moduleMember (replace 0)', JSON.stringify(a('Leads.')) === JSON.stringify({ kind: 'moduleMember', module: 'Leads', replaceLen: 0 }));
        ok('Module.partial → moduleMember (replace 2)', JSON.stringify(a('rec = Leads.Em')) === JSON.stringify({ kind: 'moduleMember', module: 'Leads', replaceLen: 2 }));
        ok('first call-arg string → moduleArg', JSON.stringify(a('x = zoho.crm.getRecords("Lea')) === JSON.stringify({ kind: 'moduleArg', partial: 'Lea' }));
        ok('later call-arg string w/ known module → fieldArg', JSON.stringify(a('x = zoho.crm.searchRecords("Leads", "Ema')) === JSON.stringify({ kind: 'fieldArg', module: 'Leads', partial: 'Ema' }));
        ok('later call-arg string w/ unknown module → null', a('x = zoho.crm.searchRecords("Bogus", "Ema') === null);
        ok('normal variable member access is NOT hijacked', a('x = myVar.toUpper') === null);
        ok('bare standalone (no dot) → null', a('x = standalone') === null);
        ok('plain string (not a crm call) → null', a('info "hello') === null);
        ok('empty source never matches module contexts', analyzeOrgContext('Leads.', { isModule: () => false }) === null);
    }

    console.log('\n-- buildFunctionGroups (all-category grouping) --');
    {
        const raw = [
            { api_name: 'b_fn', name: 'B Fn', category: 'Automation' },
            { api_name: 'a_fn', name: 'A Fn', category: 'Automation' },
            { api_name: 'z_std', name: 'Z', category: 'Standalone' },
            { api_name: 'a_std', category: 'Standalone' },
            { name: 'no api name', category: 'Button' }
        ];
        const ds = new Map([['z_std', '/p/crm/functions/standalone/standalone.z_std.ds'], ['a_fn', '/p/crm/functions/automation/automation.a_fn.ds']]);
        const groups = buildFunctionGroups(raw, ds);
        ok('Standalone group is first', groups[0] && groups[0].category === 'Standalone');
        ok('Standalone functions sorted by apiName', groups[0].functions.map((f) => f.apiName).join(',') === 'a_std,z_std');
        ok('dsPath attached by api_name', groups[0].functions[1].dsPath === '/p/crm/functions/standalone/standalone.z_std.ds');
        ok('missing dsPath stays undefined', groups[0].functions[0].dsPath === undefined);
        ok('Automation grouped + sorted', groups.find((g) => g.category === 'Automation').functions.map((f) => f.apiName).join(',') === 'a_fn,b_fn');
        ok('entry without api_name is skipped', !groups.find((g) => g.category === 'Button'));
        ok('name falls back to api_name', groups[0].functions[0].name === 'a_std');
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
