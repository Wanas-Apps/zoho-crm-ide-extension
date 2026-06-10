/*
 * M3 tests: SyncLock mutex + MetadataSync wiring/guards. The extractor is
 * injected, so no network/CLI engine runs. No vscode runtime needed.
 * Run with:  node test/zoho-sync.test.js   (after compile)
 */
'use strict';

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

const { SyncLock } = require('../out/zoho/syncLock.js');
const { MetadataSync } = require('../out/zoho/metadataSync.js');

function makeExtractor(stats, progressScript) {
    const calls = [];
    return {
        calls,
        async extract(onProgress, outputDir, options) {
            calls.push({ outputDir, options });
            for (const p of progressScript || []) {
                onProgress(p.stage, p.message, p.details);
            }
            return stats;
        }
    };
}

function makeDeps(over) {
    return Object.assign(
        {
            isAuthenticated: () => true,
            getOutputDir: () => 'D:/proj',
            getConcurrency: () => 7,
            lock: new SyncLock()
        },
        over
    );
}

(async () => {
    console.log('\n-- SyncLock --');
    {
        const lk = new SyncLock();
        const events = [];
        const sub = lk.onChange((v) => events.push(v));
        ok('initially unlocked', lk.isLocked() === false);
        const r = await lk.runExclusive(async () => 42);
        ok('runExclusive returns the fn result', r === 42);
        ok('onChange fired locked=true then false', events[0] === true && events[1] === false);
        ok('unlocked after success', lk.isLocked() === false);

        let failedRun = false;
        try {
            await lk.runExclusive(async () => { throw new Error('boom'); });
        } catch {
            failedRun = true;
        }
        ok('releases the lock after a failure', failedRun && lk.isLocked() === false);

        let rejected = false;
        const long = lk.runExclusive(() => new Promise((r) => setTimeout(r, 30)));
        try {
            await lk.runExclusive(async () => 1);
        } catch (e) {
            rejected = /already in progress/.test(e.message);
        }
        ok('rejects a concurrent runExclusive', rejected);
        await long;

        sub.dispose();
        const before = events.length;
        await lk.runExclusive(async () => 1);
        ok('dispose() stops the listener', events.length === before);
    }

    console.log('\n-- MetadataSync guards --');
    {
        const s1 = new MetadataSync(makeDeps({ isAuthenticated: () => false, extractor: makeExtractor({}) }));
        let threw = '';
        try { await s1.pull(); } catch (e) { threw = e.message; }
        ok('pull requires authentication', /Sign in/.test(threw));

        const s2 = new MetadataSync(makeDeps({ getOutputDir: () => undefined, extractor: makeExtractor({}) }));
        threw = '';
        try { await s2.pull(); } catch (e) { threw = e.message; }
        ok('pull requires an open workspace folder', /workspace folder/.test(threw));
    }

    console.log('\n-- MetadataSync wiring --');
    {
        const ex = makeExtractor({ modulesCount: 3, errors: [] });
        const res = await new MetadataSync(makeDeps({ extractor: ex })).pull({ withCounts: true });
        ok('passes the absolute outputDir to extract()', ex.calls[0].outputDir === 'D:/proj');
        ok('passes concurrency from deps', ex.calls[0].options.concurrency === 7);
        ok('passes withCounts through', ex.calls[0].options.withCounts === true);
        ok('returns stats + outputDir', res.stats.modulesCount === 3 && res.outputDir === 'D:/proj');
        ok('errorCount is 0 on a clean run', res.errorCount === 0);

        const ex2 = makeExtractor({ errors: [{ endpoint: 'a' }, { endpoint: 'b' }] });
        const res2 = await new MetadataSync(makeDeps({ extractor: ex2 })).pull();
        ok('errorCount counts stats.errors', res2.errorCount === 2);
        ok('withCounts defaults to false', ex2.calls[0].options.withCounts === false);

        const progress = [];
        const ex3 = makeExtractor({ errors: [] }, [
            { stage: 'MODULES_START', message: 'start', details: { total: 10 } },
            { stage: 'MODULE_PROGRESS', message: '[2/10] Extracted: Leads', details: { completed: 2, total: 10, module: 'Leads' } }
        ]);
        await new MetadataSync(makeDeps({ extractor: ex3 })).pull({ onProgress: (p) => progress.push(p) });
        ok('maps engine stages to PullProgress', progress.length === 2 && progress[0].stage === 'MODULES_START');
        ok('forwards completed/total details', progress[1].completed === 2 && progress[1].total === 10);
    }

    console.log('\n-- MetadataSync locking --');
    {
        let release;
        const gate = new Promise((r) => (release = r));
        const exLong = { calls: [], async extract() { this.calls.push(1); await gate; return { errors: [] }; } };
        const lock = new SyncLock();
        const sync = new MetadataSync(makeDeps({ extractor: exLong, lock }));
        const p1 = sync.pull();
        ok('isPulling() true while running', sync.isPulling() === true);
        let concurrentRejected = false;
        try { await sync.pull(); } catch (e) { concurrentRejected = /already in progress/.test(e.message); }
        ok('concurrent pull rejected by the lock', concurrentRejected);
        ok('extractor invoked exactly once', exLong.calls.length === 1);
        release();
        await p1;
        ok('isPulling() false after completion', sync.isPulling() === false);
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
