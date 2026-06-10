/*
 * Proxy-mode auth transport tests (M-proxy). Pure Node — exercises the mapping
 * from the AuthService's Zoho token-endpoint calls to the backend proxy's
 * { action } body, proxy resolution from settings, the injected http adapter,
 * and the client_id health fetch. No vscode runtime needed.
 * Run with:  node test/zoho-proxy.test.js   (after compile)
 */
'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

const {
    mapTokenRequestToProxy,
    resolveProxy,
    createProxyHttp,
    fetchProxyClientId,
    DEFAULT_PROXY_URL
} = require('../out/zoho/authProxy.js');

(async () => {
    console.log('\n-- mapTokenRequestToProxy --');
    {
        const token = mapTokenRequestToProxy(
            'https://accounts.zoho.eu/oauth/v2/token',
            'grant_type=authorization_code&client_id=1000.X&client_secret=shh&redirect_uri=' +
                encodeURIComponent('http://127.0.0.1:3000/zoho/callback') + '&code=THECODE',
            'eu'
        );
        ok('authorization_code → action token', token && token.action === 'token');
        ok('token carries code/redirect_uri/dc', token.code === 'THECODE' &&
            token.redirect_uri === 'http://127.0.0.1:3000/zoho/callback' && token.dc === 'eu');
        ok('token never forwards client_secret', !('client_secret' in token));
        ok('consent defaults to false', token.consent === false);
        const consented = mapTokenRequestToProxy(
            'https://accounts.zoho.eu/oauth/v2/token',
            'grant_type=authorization_code&code=C&redirect_uri=' +
                encodeURIComponent('http://127.0.0.1:3000/zoho/callback'),
            'eu',
            true
        );
        ok('consent=true forwarded into the token body', consented.consent === true);
    }
    {
        const refresh = mapTokenRequestToProxy(
            'https://accounts.zoho.com/oauth/v2/token',
            'grant_type=refresh_token&client_id=1000.X&client_secret=shh&refresh_token=RT',
            'com'
        );
        ok('refresh_token → action refresh', refresh && refresh.action === 'refresh' &&
            refresh.refresh_token === 'RT' && refresh.dc === 'com');
    }
    {
        const revoke = mapTokenRequestToProxy(
            'https://accounts.zoho.in/oauth/v2/token/revoke',
            'token=RT',
            'in'
        );
        ok('revoke endpoint → action revoke', revoke && revoke.action === 'revoke' &&
            revoke.refresh_token === 'RT' && revoke.dc === 'in');
    }
    {
        const other = mapTokenRequestToProxy('https://www.zohoapis.com/crm/v8/users', '', 'com');
        ok('non-token URL is not mapped', other === undefined);
    }

    console.log('\n-- resolveProxy --');
    {
        const none = resolveProxy({ getAuthProxyUrl: () => undefined, getAuthProxyToken: () => undefined });
        ok('blank URL → BYO mode (undefined)', none === undefined || (DEFAULT_PROXY_URL && none));
        const set = resolveProxy({ getAuthProxyUrl: () => '  https://p/exec  ', getAuthProxyToken: () => '  sek  ' });
        ok('trims URL + token', set.url === 'https://p/exec' && set.token === 'sek');
        const noTok = resolveProxy({ getAuthProxyUrl: () => 'https://p/exec', getAuthProxyToken: () => '' });
        ok('empty token → undefined token', noTok.url === 'https://p/exec' && noTok.token === undefined);
    }

    console.log('\n-- createProxyHttp (injected transport) --');
    {
        const calls = [];
        const http = createProxyHttp({
            target: { url: 'https://p/exec', token: 'sek' },
            getDc: () => 'eu',
            postJson: async (url, body, headers) => { calls.push({ url, body, headers }); return { data: { access_token: 'AT', api_domain: 'https://www.zohoapis.eu' }, status: 200 }; }
        });
        const res = await http.post('https://accounts.zoho.eu/oauth/v2/token',
            'grant_type=authorization_code&code=C&redirect_uri=' + encodeURIComponent('http://127.0.0.1:3000/zoho/callback'));
        ok('returns axios-shaped { data }', res.data && res.data.access_token === 'AT');
        ok('POSTs the proxy URL with action token', calls.length === 1 && calls[0].url === 'https://p/exec' && calls[0].body.action === 'token');
        ok('attaches x-proxy-token header', calls[0].headers['x-proxy-token'] === 'sek');
        ok('injects dc from getDc()', calls[0].body.dc === 'eu');
        ok('consent defaults to false without getConsent', calls[0].body.consent === false);
    }
    {
        const calls = [];
        const http = createProxyHttp({
            target: { url: 'https://p/exec' },
            getDc: () => 'com',
            getConsent: () => true,
            postJson: async (url, body, headers) => { calls.push({ url, body, headers }); return { data: {}, status: 200 }; }
        });
        await http.post('https://accounts.zoho.com/oauth/v2/token',
            'grant_type=authorization_code&code=C&redirect_uri=' + encodeURIComponent('http://127.0.0.1:3000/zoho/callback'));
        ok('getConsent()=true forwarded into the token body', calls.length === 1 && calls[0].body.consent === true);
    }
    {
        let delegated = false;
        const http = createProxyHttp({
            target: { url: 'https://p/exec' },
            getDc: () => 'com',
            postJson: async () => { throw new Error('should not be called'); },
            fallback: { post: async () => { delegated = true; return { data: {}, status: 200 }; } }
        });
        await http.post('https://www.zohoapis.com/crm/v8/whatever', 'x=1');
        ok('delegates non-token URLs to the fallback client', delegated === true);
    }

    console.log('\n-- fetchProxyClientId --');
    {
        const id = await fetchProxyClientId({ url: 'https://p/exec', token: 'sek' },
            async (url, headers) => { return { data: { client_id: '1000.ABC' }, status: 200 }; });
        ok('reads client_id from health response', id === '1000.ABC');
        let threw = false;
        try {
            await fetchProxyClientId({ url: 'https://p/exec' }, async () => ({ data: { ok: true }, status: 200 }));
        } catch { threw = true; }
        ok('throws when health omits client_id', threw === true);
    }

    console.log('\n----------------------------------------');
    console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
    console.log('----------------------------------------');
    if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error('SUITE CRASHED:', e.stack); process.exit(1); });
