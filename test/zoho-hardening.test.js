/*
 * M7 tests: retention pruning, field-meta picklist hovers (real sample), URI
 * callback helpers, refresh-error classification, self-client helpers, and
 * configStore.getRetention. Run with:  node test/zoho-hardening.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

// vscode mock (only configStore needs it).
let configValues = {};
const vscode = {
    workspace: {
        getConfiguration: (section) => ({
            get: (key, dflt) => {
                const full = section ? `${section}.${key}` : key;
                return Object.prototype.hasOwnProperty.call(configValues, full) ? configValues[full] : dflt;
            }
        })
    }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

const retention = require('../out/zoho/retention.js');
const fieldMeta = require('../out/zoho/fieldMeta.js');
const uriCallback = require('../out/zoho/uriCallback.js');
const { classifyRefreshError } = require('../out/zoho/refreshError.js');
const selfClient = require('../out/zoho/selfClientFallback.js');
const { MetadataIndex } = require('../out/zoho/metadataIndex.js');
const { WorkspaceConfigStore } = require('../out/zoho/configStore.js');

const SAMPLE = path.resolve('D:/Projects/Zoho CRM Tools/wanas-zcrm-extractor/test_metadata');

(async () => {
    console.log('\n-- retention --');
    {
        const p = retention.parseArtifactName('Foo-2026-06-09T12-30-45-123Z.json', '.json');
        ok('parseArtifactName splits api + ISO ts', !!p && p.apiName === 'Foo' && p.ts === '2026-06-09T12-30-45-123Z');
        ok('parseArtifactName rejects an unparseable name', retention.parseArtifactName('weird.json', '.json') === null);

        const names = [
            'Foo-2026-01-01T00-00-00-001Z.json',
            'Foo-2026-01-02T00-00-00-001Z.json',
            'Foo-2026-01-03T00-00-00-001Z.json',
            'Bar-2026-01-01T00-00-00-001Z.json'
        ];
        const del = retention.planRetention(names, '.json', 2);
        ok('planRetention keeps newest N per function', del.length === 1 && del[0].includes('2026-01-01') && del[0].startsWith('Foo'));
        ok('planRetention keep=0 keeps everything', retention.planRetention(names, '.json', 0).length === 0);

        const dir = path.join(os.tmpdir(), `zcrm_ret_${process.pid}_${Math.floor(Math.random() * 1e6)}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
        fs.writeFileSync(path.join(dir, 'unparseable.json'), 'x');
        const res = await retention.pruneDir(dir, '.json', 2);
        ok('pruneDir deletes only the over-retention parseable files', res.scanned === 5 && res.deleted === 1);
        ok('pruneDir leaves unparseable files alone', fs.existsSync(path.join(dir, 'unparseable.json')));
        ok('pruneDir tolerates a missing dir', (await retention.pruneDir(path.join(dir, 'nope'), '.json', 2)).deleted === 0);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\n-- fieldMeta --');
    {
        const m = fieldMeta.extractFieldMeta({ data_type: 'picklist', field_label: 'State', pick_list_values: [{ display_value: '-None-' }, { display_value: 'Open' }, { display_value: 'Closed' }] });
        ok('extractFieldMeta filters -None- from the picklist', m.dataType === 'picklist' && m.picklist.join(',') === 'Open,Closed');
        const big = fieldMeta.renderFieldHover('Leads', 'F', { dataType: 'picklist', picklist: Array.from({ length: 20 }, (_, i) => 'v' + i) }, 15);
        ok('renderFieldHover caps values + counts the remainder', big.includes('Values:') && big.includes('and 5 more'));
        ok('renderFieldHover for non-picklist shows the data type only', !fieldMeta.renderFieldHover('Leads', 'F', { dataType: 'text', picklist: [] }).includes('Values:'));
    }

    console.log('\n-- field hover over the real sample --');
    if (!fs.existsSync(path.join(SAMPLE, '.zcrm', '.store', 'index.json'))) {
        console.log('  SKIP sample not found');
    } else {
        const idx = new MetadataIndex();
        await idx.load(SAMPLE);
        const modules = idx.getModuleCompletions().map((s) => s.label);
        const hit = findPicklistField(SAMPLE, modules);
        if (!hit) {
            console.log('  SKIP no picklist field with a fields-meta file found');
        } else {
            const meta = await new fieldMeta.FieldMetaReader(SAMPLE).read(hit.module, hit.field);
            ok('FieldMetaReader reads a real picklist field', !!meta && meta.dataType === 'picklist' && meta.picklist.includes(hit.sampleValue) && !meta.picklist.includes('-None-'));
            const detail = await idx.getFieldHoverDetail(hit.module, hit.field);
            ok('MetadataIndex.getFieldHoverDetail returns rich markdown', typeof detail === 'string' && detail.includes('picklist') && detail.includes(hit.field));
            ok('getFieldHoverDetail returns undefined for a non-module', (await idx.getFieldHoverDetail('NotARealModule', 'x')) === undefined);
        }
    }

    console.log('\n-- uriCallback --');
    {
        ok('callbackUri composes scheme + ext id', uriCallback.callbackUri('vscode', 'wanas-apps.zoho-crm-ide-extension') === 'vscode://wanas-apps.zoho-crm-ide-extension/zoho/callback');
        const q = uriCallback.parseCallbackQuery('?code=abc&state=xyz');
        ok('parseCallbackQuery extracts code + state', q.code === 'abc' && q.state === 'xyz');

        const okSink = uriCallback.createCallbackSink('state01');
        const okOutcome = okSink.promise.then((c) => 'code:' + c, () => 'rej');
        okSink.handle('?code=THECODE&state=state01');
        ok('sink resolves the code on matching state', (await okOutcome) === 'code:THECODE');

        const badSink = uriCallback.createCallbackSink('state01');
        const badOutcome = badSink.promise.then(() => 'res', () => 'rej');
        badSink.handle('?code=THECODE&state=WRONG0');
        ok('sink rejects on state mismatch', (await badOutcome) === 'rej');

        const errSink = uriCallback.createCallbackSink('state01');
        const errOutcome = errSink.promise.then(() => 'res', () => 'rej');
        errSink.handle('?error=access_denied&state=state01');
        ok('sink rejects on provider error', (await errOutcome) === 'rej');

        const onceSink = uriCallback.createCallbackSink('state01');
        const onceOutcome = onceSink.promise.then((c) => c, () => 'rej');
        onceSink.handle('?code=FIRST&state=state01');
        onceSink.handle('?code=SECOND&state=state01');
        ok('sink is single-shot (ignores later callbacks)', (await onceOutcome) === 'FIRST');
    }

    console.log('\n-- refreshError --');
    {
        ok('invalid_grant from response error', classifyRefreshError({ response: { data: { error: 'invalid_grant' } } }) === 'invalid_grant');
        ok('invalid_grant from message', classifyRefreshError({ message: 'Zoho OAuth Token Refresh Error: invalid_code' }) === 'invalid_grant');
        ok('throttled from 429', classifyRefreshError({ response: { status: 429 } }) === 'throttled');
        ok('transient otherwise', classifyRefreshError({ message: 'socket hang up' }) === 'transient');
    }

    console.log('\n-- selfClientFallback --');
    {
        ok('validateGrantCode accepts a plausible code', selfClient.validateGrantCode('  1000.abcDEF_-12345  ') === '1000.abcDEF_-12345');
        ok('validateGrantCode rejects junk', selfClient.validateGrantCode('no') === undefined);
        const seeded = selfClient.seedTokensFromRefresh('  rt-123  ', 1000);
        ok('seedTokensFromRefresh trims + marks expired', seeded.refresh_token === 'rt-123' && seeded.expiry_time < 1000);
    }

    console.log('\n-- configStore.getRetention --');
    {
        configValues = {};
        ok('getRetention defaults to 20', new WorkspaceConfigStore('zohoDeluge').getRetention() === 20);
        configValues = { 'zohoDeluge.testArtifacts.retention': 5 };
        ok('getRetention reads the configured value', new WorkspaceConfigStore('zohoDeluge').getRetention() === 5);
        configValues = { 'zohoDeluge.testArtifacts.retention': -3 };
        ok('getRetention clamps negatives to the default', new WorkspaceConfigStore('zohoDeluge').getRetention() === 20);
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    Module._load = originalLoad;
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });

function findPicklistField(sampleRoot, modules) {
    const base = path.join(sampleRoot, 'crm', 'meta', 'modules');
    for (const mod of modules) {
        const fdir = path.join(base, mod, 'fields');
        let files;
        try { files = fs.readdirSync(fdir); } catch { continue; }
        for (const f of files) {
            try {
                const j = JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'));
                if (j.data_type === 'picklist' && Array.isArray(j.pick_list_values)) {
                    const val = j.pick_list_values.map((p) => p && p.display_value).find((v) => v && v !== '-None-');
                    if (val) {
                        return { module: mod, field: j.api_name, sampleValue: val };
                    }
                }
            } catch { /* skip */ }
        }
    }
    return null;
}
