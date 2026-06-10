/*
 * M1 foundation smoke tests for the Zoho connection bridge.
 *
 * Verifies — in an extension-host-like context (mocked `vscode`) — that the
 * extension's ports drive the reused CLI AuthService correctly:
 *   - SecretStorageStore round-trip, folder-keying, client_secret caching
 *   - WorkspaceConfigStore defaults/overrides
 *   - CredentialProvider wiring
 *   - End-to-end bridge: AuthService configured with the SecretStorage store +
 *     credentials + a mock HTTP client → hydrate → single-flight refresh that
 *     persists back to the keychain (and never writes under process.cwd()).
 *
 * No test framework. Run with:  node test/zoho-foundation.test.js  (after compile)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------------------
// Mutable `vscode` mock (installed before requiring compiled adapters).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Fake SecretStorage (VS Code SecretStorage shape).
// ---------------------------------------------------------------------------
function makeSecrets(initial) {
    const m = new Map(Object.entries(initial || {}));
    return {
        map: m,
        get: async (k) => m.get(k),
        store: async (k, v) => { m.set(k, v); },
        delete: async (k) => { m.delete(k); }
    };
}

const silentLog = { logInfo() {}, logError() {} };
function makeHttp(accessToken) {
    const calls = { post: 0 };
    return {
        calls,
        async post() {
            calls.post++;
            await new Promise((r) => setTimeout(r, 10));
            return { data: { access_token: accessToken, expires_in: 3600, api_domain: 'https://www.zohoapis.com' } };
        }
    };
}
const expiredTokens = () => ({ access_token: 'old', refresh_token: 'r1', api_domain: 'https://www.zohoapis.com', expiry_time: Date.now() - 1000 });
const freshTokens = () => ({ access_token: 'good', refresh_token: 'r1', api_domain: 'https://www.zohoapis.com', expiry_time: Date.now() + 3600_000 });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

// ---------------------------------------------------------------------------
// Modules under test (compiled adapters + the bridged CLI AuthService).
// ---------------------------------------------------------------------------
const { SecretStorageStore } = require('../out/zoho/secretStore.js');
const { WorkspaceConfigStore } = require('../out/zoho/configStore.js');
const { CredentialProvider } = require('../out/zoho/credentialProvider.js');
const authModule = require('@wanasapps/zcrm-core/src/services/authService');
const { AuthService } = authModule;

const KEY = 'zohoDeluge.connection:aaaa';
const KEY2 = 'zohoDeluge.connection:bbbb';

(async () => {
    console.log('\n-- SecretStorageStore --');
    {
        const secrets = makeSecrets();
        const store = new SecretStorageStore(secrets, KEY);
        await store.saveTokens(freshTokens());
        const loaded = await store.loadTokens();
        ok('saveTokens then loadTokens round-trips', loaded && loaded.access_token === 'good');

        await store.setClientSecret('shh');
        await store.prime();
        ok('client_secret is cached for synchronous reads', store.getCachedClientSecret() === 'shh');
        ok('saveTokens preserves client_secret in the bundle', JSON.parse(secrets.map.get(KEY)).client_secret === 'shh');

        // Folder-keying: a second key is fully independent.
        const store2 = new SecretStorageStore(secrets, KEY2);
        ok('distinct folder key has no tokens', (await store2.loadTokens()) === null);
        await store2.saveTokens(freshTokens());
        ok('two folder keys hold independent bundles', secrets.map.has(KEY) && secrets.map.has(KEY2) && secrets.map.get(KEY) !== secrets.map.get(KEY2));

        await store.clear();
        ok('clear() removes the secret entry', !secrets.map.has(KEY) && store.getCachedClientSecret() === undefined);
    }

    console.log('\n-- WorkspaceConfigStore --');
    {
        configValues = {};
        const cfg = new WorkspaceConfigStore('zohoDeluge');
        ok('defaults: dc=com, concurrency=5, clientId/scopes undefined',
            cfg.getDc() === 'com' && cfg.getConcurrency() === 5 && cfg.getClientId() === undefined && cfg.getScopes() === undefined);
        configValues = { 'zohoDeluge.clientId': '1000.ABC', 'zohoDeluge.dc': 'eu', 'zohoDeluge.scopes': 'ZohoCRM.modules.READ', 'zohoDeluge.concurrency': 10 };
        ok('reads configured overrides',
            cfg.getClientId() === '1000.ABC' && cfg.getDc() === 'eu' && cfg.getScopes() === 'ZohoCRM.modules.READ' && cfg.getConcurrency() === 10);
    }

    console.log('\n-- CredentialProvider --');
    {
        configValues = { 'zohoDeluge.clientId': '1000.XYZ', 'zohoDeluge.dc': 'in' };
        const cfg = new WorkspaceConfigStore('zohoDeluge');
        const secrets = makeSecrets();
        const store = new SecretStorageStore(secrets, KEY);
        await store.setClientSecret('topsecret');
        await store.prime();
        const creds = new CredentialProvider(cfg, store, () => 'http://127.0.0.1:0/cb');
        ok('client_id/dc from config', creds.getClientId() === '1000.XYZ' && creds.getDc() === 'in');
        ok('client_secret from secret cache', creds.getClientSecret() === 'topsecret');
        ok('redirect uri from supplier', creds.getRedirectUri() === 'http://127.0.0.1:0/cb');
        ok('unset scopes returns undefined (CLI default applies)', creds.getScopes() === undefined);
    }

    console.log('\n-- Bridge: AuthService + SecretStorage store --');
    {
        // Pre-seed the keychain with an EXPIRED token bundle + client_secret.
        const initialBundle = JSON.stringify({ tokens: expiredTokens(), client_secret: 'sec' });
        const secrets = makeSecrets({ [KEY]: initialBundle });
        const store = new SecretStorageStore(secrets, KEY);
        await store.prime();

        configValues = { 'zohoDeluge.clientId': '1000.ABC', 'zohoDeluge.dc': 'com' };
        const cfg = new WorkspaceConfigStore('zohoDeluge');
        const creds = new CredentialProvider(cfg, store, () => undefined);
        const http = makeHttp('refreshed-token');

        const auth = new AuthService({ store, credentials: creds, logger: silentLog, http });
        const hydrated = await auth.hydrate();
        ok('hydrate loads the pre-seeded (expired) token from the keychain', hydrated && hydrated.access_token === 'old');

        const results = await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken()));
        ok('concurrent expired getAccessToken triggers exactly ONE refresh', http.calls.post === 1);
        ok('all callers receive the refreshed token', results.every((t) => t === 'refreshed-token'));

        const persisted = JSON.parse(secrets.map.get(KEY));
        ok('refreshed token persisted back to the keychain', persisted.tokens.access_token === 'refreshed-token');
        ok('client_secret survives the token write', persisted.client_secret === 'sec');

        ok('credential getter pulls client_secret from the cache', auth.getClientSecret() === 'sec');
        ok('credential getter pulls client_id from config', auth.getClientId() === '1000.ABC');
        ok('unset scopes falls through to CLI default scope set', /ZohoCRM\.modules\.ALL/.test(auth.getScopes()));
    }

    console.log('\n-- No side effects on the import path --');
    {
        const cwdTokenFile = path.join(process.cwd(), 'storage', 'auth', 'tokens.json');
        ok('requiring the bridge wrote no tokens file under process.cwd()', !fs.existsSync(cwdTokenFile));
        const cwdLogFile = path.join(process.cwd(), 'storage', 'logs', 'errors.log');
        ok('requiring the bridge wrote no log file under process.cwd()', !fs.existsSync(cwdLogFile));
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    Module._load = originalLoad;
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
