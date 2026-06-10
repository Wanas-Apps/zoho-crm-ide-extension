/*
 * M2 login tests: OAuth state, loopback server (real HTTP round-trip), whoami
 * parsing, and the single-session lock. No vscode runtime needed (the modules
 * under test use only Node http/net/crypto + the bridged apiClient at require
 * time). Run with:  node test/zoho-login.test.js   (after compile)
 */
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { agent: false }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

function makeMemento() {
    const m = new Map();
    return {
        get: (k, d) => (m.has(k) ? m.get(k) : d),
        update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); }
    };
}

const oauth = require('../out/zoho/oauth.js');
const { parseWhoAmI } = require('../out/zoho/whoami.js');
const { SessionLock } = require('../out/zoho/sessionLock.js');

(async () => {
    console.log('\n-- OAuth state --');
    {
        const s1 = oauth.generateState();
        const s2 = oauth.generateState();
        ok('state is 32 hex chars', /^[0-9a-f]{32}$/.test(s1));
        ok('states are unique', s1 !== s2);
        ok('validateState accepts the same state', oauth.validateState(s1, s1) === true);
        ok('validateState rejects a different state', oauth.validateState(s1, s2) === false);
        ok('validateState rejects non-strings', !oauth.validateState(s1, undefined) && !oauth.validateState(s1, 123));
    }

    console.log('\n-- Free-port selection --');
    {
        const blocker = net.createServer();
        await new Promise((r) => blocker.listen(3000, '127.0.0.1', r));
        const port = await oauth.firstFreePort([3000, 3737, 8980]);
        ok('firstFreePort skips a busy port', port !== 3000 && [3737, 8980].includes(port));
        await new Promise((r) => blocker.close(r));
    }

    console.log('\n-- Loopback server (real HTTP) --');
    {
        const state = oauth.generateState();
        const server = await oauth.createLoopbackServer({ expectedState: state });
        ok('redirectUri binds 127.0.0.1 + callback path', /^http:\/\/127\.0\.0\.1:\d+\/zoho\/callback$/.test(server.redirectUri));
        const codePromise = server.waitForCode(5000);
        const res = await httpGet(`${server.redirectUri}?code=abc123&state=${state}`);
        const code = await codePromise;
        ok('resolves the authorization code on matching state', code === 'abc123');
        ok('serves a 200 success page', res.status === 200 && /Signed in to Zoho CRM/.test(res.body));
        server.dispose();
    }
    {
        const state = oauth.generateState();
        const server = await oauth.createLoopbackServer({ expectedState: state });
        // Attach the settle handler synchronously to avoid an unhandled rejection
        // while we await the unrelated HTTP request.
        const outcome = server.waitForCode(5000).then(() => 'resolved', () => 'rejected');
        const res = await httpGet(`${server.redirectUri}?code=xyz&state=WRONG`);
        ok('rejects on state mismatch (CSRF guard)', (await outcome) === 'rejected');
        ok('serves a 400 on mismatch', res.status === 400);
        server.dispose();
    }
    {
        const state = oauth.generateState();
        const server = await oauth.createLoopbackServer({ expectedState: state });
        const outcome = server.waitForCode(5000).then(() => 'resolved', () => 'rejected');
        const res = await httpGet(`${server.redirectUri}?error=access_denied&state=${state}`);
        ok('rejects when Zoho returns an error', (await outcome) === 'rejected');
        ok('serves a 400 on provider error', res.status === 400);
        server.dispose();
    }

    console.log('\n-- whoami parsing --');
    {
        const w = parseWhoAmI(
            { users: [{ full_name: 'Jane Doe', email: 'jane@acme.com', role: { name: 'Admin' } }] },
            { org: [{ company_name: 'Acme Inc', zorg_id: 776655 }] },
            'eu'
        );
        ok('parses user + org + dc', w.userName === 'Jane Doe' && w.email === 'jane@acme.com' && w.org === 'Acme Inc' && w.orgId === '776655' && w.dc === 'eu');
        const empty = parseWhoAmI({}, {}, 'com');
        ok('degrades gracefully on empty responses', empty.org === 'Zoho CRM' && empty.userName === 'Zoho user' && empty.orgId === '' && empty.dc === 'com');
    }

    console.log('\n-- Session lock --');
    {
        const lock = new SessionLock(makeMemento());
        ok('initially inactive', lock.get() === undefined && lock.isActive() === false);
        await lock.set({ org: 'Acme Inc', orgId: '776655', apiDomain: 'https://www.zohoapis.com', dc: 'com', email: 'jane@acme.com' });
        const a = lock.get();
        ok('binds one active session', !!a && a.org === 'Acme Inc' && a.apiDomain === 'https://www.zohoapis.com' && lock.isActive());
        await lock.clear();
        ok('clear releases the lock', lock.get() === undefined && lock.isActive() === false);
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
