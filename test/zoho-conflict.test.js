/*
 * M4.5 tests: ConflictGuard pure core, SnapshotStore (fake Memento), and the
 * vscode-mocked ConflictGuard (prompts/backups/snapshots). Run with:
 *   node test/zoho-conflict.test.js   (after compile)
 */
'use strict';

const assert = require('assert');
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

// --- vscode mock (settable warning result) ----------------------------------
const vmock = { nextWarning: undefined, diffCalls: 0 };
const vscode = {
    window: {
        showWarningMessage: async () => vmock.nextWarning
    },
    commands: { executeCommand: async () => { vmock.diffCalls++; } },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

const cg = require('../out/zoho/conflictGuard.js');
const { SnapshotStore } = require('../out/zoho/snapshotStore.js');
const { ConflictGuard } = require('../out/zoho/conflictGuard.vscode.js');

const format = (s) => s.replace(/\s+/g, ' ').trim();
const H = (s) => cg.normalizeAndHash(s, format);

function makeMemento() {
    const m = new Map();
    return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); }, _m: m };
}
function fakeOutput() { return { appendLine() {} }; }
function tmpDir(tag) { const d = path.join(os.tmpdir(), `zcrm_cg_${tag}_${process.pid}_${Math.floor(Math.random() * 1e6)}`); fs.mkdirSync(d, { recursive: true }); return d; }

(async () => {
    console.log('\n-- ConflictGuard pure core --');
    {
        ok('hashCode is deterministic + distinguishes input', cg.hashCode('a') === cg.hashCode('a') && cg.hashCode('a') !== cg.hashCode('b'));
        ok('normalizeAndHash funnels whitespace-only diffs to one hash', H('info  "x";') === H('info "x";'));
        ok('snapshotKey is org-scoped + case-insensitive', cg.snapshotKey('o1', 'Foo') === cg.snapshotKey('o1', 'foo') && cg.snapshotKey('o1', 'Foo') !== cg.snapshotKey('o2', 'Foo'));

        const base = 'B', loc = 'L', live = 'V';
        ok('decidePush SAFE when local===live', cg.decidePush({ baseHash: 'b', localHash: 'x', liveHash: 'x' }) === 'SAFE');
        ok('decidePush NO_BASE when base missing', cg.decidePush({ baseHash: undefined, localHash: 'l', liveHash: 'v' }) === 'NO_BASE');
        ok('decidePush CONFLICT when both changed', cg.decidePush({ baseHash: 'b', localHash: 'l', liveHash: 'v' }) === 'CONFLICT');
        ok('decidePush LIVE_AHEAD when only live changed', cg.decidePush({ baseHash: 'b', localHash: 'b', liveHash: 'v' }) === 'LIVE_AHEAD');
        ok('decidePush SAFE when only local changed', cg.decidePush({ baseHash: 'b', localHash: 'l', liveHash: 'b' }) === 'SAFE');

        ok('decideOverwritePull CLEAN when no local file', cg.decideOverwritePull({ hasLocalFile: false, isDirty: false }) === 'CLEAN');
        ok('decideOverwritePull DIRTY when editor dirty', cg.decideOverwritePull({ hasLocalFile: true, isDirty: true }) === 'DIRTY');
        ok('decideOverwritePull DIRTY when local diverged from base', cg.decideOverwritePull({ hasLocalFile: true, isDirty: false, localHash: 'l', baseHash: 'b' }) === 'DIRTY');
        ok('decideOverwritePull CLEAN when local===base', cg.decideOverwritePull({ hasLocalFile: true, isDirty: false, localHash: 'b', baseHash: 'b' }) === 'CLEAN');

        ok('apiNameFromDsPath parses standalone.<api>.ds', cg.apiNameFromDsPath('/x/standalone.Get_Assistants.ds') === 'Get_Assistants');
        ok('apiNameFromDsPath keeps multi-dot api', cg.apiNameFromDsPath('/x/standalone.a.b.ds') === 'a.b');
        ok('apiNameFromDsPath rejects a plain .ds', cg.apiNameFromDsPath('/x/foo.ds') === undefined);
        ok('isStandaloneDsPath true for the standalone tree (both seps)', cg.isStandaloneDsPath('C:/p/crm/functions/standalone/standalone.A.ds') && cg.isStandaloneDsPath('C:\\p\\crm\\functions\\standalone\\standalone.A.ds'));
        ok('isStandaloneDsPath false for automation / bare', !cg.isStandaloneDsPath('/p/crm/functions/automation/automation.A.ds') && !cg.isStandaloneDsPath('/p/standalone.A.ds'));
    }

    console.log('\n-- SnapshotStore --');
    {
        let org = 'orgA';
        const store = new SnapshotStore(makeMemento(), () => org);
        await store.record('Foo', 'h1', '/w/crm/functions/standalone/standalone.Foo.ds');
        ok('record→get round-trips', store.get('Foo') && store.get('Foo').hash === 'h1');
        ok('get is case-insensitive', store.get('foo') && store.get('foo').hash === 'h1');
        ok('getByDsPath resolves via the path index', store.getByDsPath('/w/crm/functions/standalone/standalone.Foo.ds') && store.getByDsPath('/w/crm/functions/standalone/standalone.Foo.ds').hash === 'h1');
        ok('pulledAt is an ISO timestamp', /^\d{4}-\d{2}-\d{2}T/.test(store.get('Foo').pulledAt));
        org = 'orgB';
        ok('org isolation: other org has no snapshot', store.get('Foo') === undefined);
        org = 'orgA';
        await store.clearAll();
        ok('clearAll empties snapshots', store.get('Foo') === undefined);

        const noOrg = new SnapshotStore(makeMemento(), () => undefined);
        await noOrg.record('Foo', 'h');
        ok('record is a no-op when no org is active', noOrg.get('Foo') === undefined);
    }

    console.log('\n-- ConflictGuard (vscode-mocked) --');
    {
        const mkGuard = (store, remoteCode) => new ConflictGuard({
            store,
            fetchRemote: async (apiName) => (remoteCode === null ? null : { apiName, id: 'id1', code: remoteCode }),
            format,
            output: fakeOutput(),
            getOutputDir: () => undefined
        });
        const dsPath = (dir) => path.join(dir, 'standalone.MyFn.ds');

        // 1. No live counterpart → proceed (Create path handles it).
        {
            const store = new SnapshotStore(makeMemento(), () => 'o');
            const r = await mkGuard(store, null).guardPush('/x/standalone.MyFn.ds', 'code');
            ok('guardPush proceeds when the function does not exist live', r.proceed === true);
        }
        // 2. SAFE (local === live) → proceed, no prompt.
        {
            vmock.nextWarning = 'SHOULD_NOT_BE_USED';
            const store = new SnapshotStore(makeMemento(), () => 'o');
            await store.record('MyFn', H('same code'));
            const r = await mkGuard(store, 'same code').guardPush('/x/standalone.MyFn.ds', 'same code');
            ok('guardPush SAFE proceeds without a prompt', r.proceed === true);
        }
        // 3. CONFLICT (both changed) → blocked unless override.
        {
            const store = new SnapshotStore(makeMemento(), () => 'o');
            await store.record('MyFn', H('base v0'));
            vmock.nextWarning = undefined; // user dismissed
            const blocked = await mkGuard(store, 'live v2').guardPush('/x/standalone.MyFn.ds', 'local v1');
            ok('guardPush CONFLICT blocks when not overridden', blocked.proceed === false);
            vmock.nextWarning = 'Overwrite live with my version';
            const overridden = await mkGuard(store, 'live v2').guardPush('/x/standalone.MyFn.ds', 'local v1');
            ok('guardPush CONFLICT proceeds on explicit override', overridden.proceed === true);
        }
        // 4. LIVE_AHEAD (only live changed) → push anyway proceeds.
        {
            const store = new SnapshotStore(makeMemento(), () => 'o');
            await store.record('MyFn', H('base v0'));
            vmock.nextWarning = 'Push anyway (overwrite live)';
            const r = await mkGuard(store, 'live v2').guardPush('/x/standalone.MyFn.ds', 'base v0');
            ok('guardPush LIVE_AHEAD proceeds on "push anyway"', r.proceed === true);
        }
        // 5. Overwrite-pull: dirty → prompt + backup; declined → no proceed.
        {
            const dir = tmpDir('pull');
            const f = dsPath(dir);
            fs.writeFileSync(f, 'local edits', 'utf8');
            const store = new SnapshotStore(makeMemento(), () => 'o');
            const guard = new ConflictGuard({ store, fetchRemote: async () => null, format, output: fakeOutput(), getOutputDir: () => dir });
            vmock.nextWarning = undefined; // decline
            const declined = await guard.guardOverwritePull(f, { isDirty: true });
            ok('guardOverwritePull blocks a dirty overwrite when declined', declined.proceed === false);
            vmock.nextWarning = 'Overwrite (back up first)';
            const accepted = await guard.guardOverwritePull(f, { isDirty: true });
            const backups = fs.readdirSync(path.join(dir, '.zcrm', '.backups'));
            ok('guardOverwritePull proceeds + writes a backup when accepted', accepted.proceed === true && backups.length === 1 && /MyFn-.*\.ds$/.test(backups[0]));
            fs.rmSync(dir, { recursive: true, force: true });
        }
        // 6. Overwrite-pull: clean file → proceed silently + still backs up.
        {
            const dir = tmpDir('pull2');
            const f = dsPath(dir);
            fs.writeFileSync(f, 'clean', 'utf8');
            const store = new SnapshotStore(makeMemento(), () => 'o');
            await store.record('MyFn', H('clean'), f);
            const guard = new ConflictGuard({ store, fetchRemote: async () => null, format, output: fakeOutput(), getOutputDir: () => dir });
            vmock.nextWarning = 'SHOULD_NOT_BE_USED';
            const r = await guard.guardOverwritePull(f, { isDirty: false });
            ok('guardOverwritePull clean proceeds + still backs up', r.proceed === true && fs.existsSync(path.join(dir, '.zcrm', '.backups')));
            fs.rmSync(dir, { recursive: true, force: true });
        }
        // 7. recordPulled + recordManyFromFolder hash the on-disk .ds.
        {
            const root = tmpDir('rec');
            const saDir = path.join(root, 'crm', 'functions', 'standalone');
            fs.mkdirSync(saDir, { recursive: true });
            const a = path.join(saDir, 'standalone.Alpha.ds');
            const b = path.join(saDir, 'standalone.Beta.ds');
            fs.writeFileSync(a, 'alpha code', 'utf8');
            fs.writeFileSync(b, 'beta code', 'utf8');
            const store = new SnapshotStore(makeMemento(), () => 'o');
            const guard = new ConflictGuard({ store, fetchRemote: async () => null, format, output: fakeOutput(), getOutputDir: () => root });
            await guard.recordManyFromFolder(root);
            ok('recordManyFromFolder snapshots every standalone .ds', store.get('Alpha') && store.get('Alpha').hash === H('alpha code') && store.get('Beta') && store.get('Beta').hash === H('beta code'));
            fs.rmSync(root, { recursive: true, force: true });
        }
        vmock.nextWarning = undefined;
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    Module._load = originalLoad;
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
