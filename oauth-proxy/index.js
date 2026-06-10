'use strict';

/**
 * Zoho OAuth token-exchange proxy — Catalyst **Advanced I/O Function (Express)**.
 *
 * Holds the Zoho OAuth app's client_id + client_secret SERVER-SIDE, so the
 * published VS Code extension never carries the secret. The extension POSTs the
 * loopback authorization `code` (or a refresh/revoke request) here; this
 * function adds the secret, talks to Zoho's accounts server, and returns Zoho's
 * token response verbatim.
 *
 * Exported as an Express app (`module.exports = app`) — the Catalyst Advanced
 * I/O runtime invokes it as a request handler. Express parses the JSON body and
 * handles routing/methods.
 *
 * Invocation (one fixed URL — Advanced I/O has no real sub-paths):
 *   POST https://<domain>/server/<function>/   body: { action, ... }
 *   GET  https://<domain>/server/<function>/   → health
 *
 * Body by action:
 *   { action: "token",   code, redirect_uri, dc }   → Zoho token set
 *   { action: "refresh", refresh_token, dc }         → new access token
 *   { action: "revoke",  refresh_token, dc }         → { revoked: true }
 *
 * Env vars (Catalyst console → Serverless → Environment Variables):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET            (required)
 *   PROXY_SHARED_SECRET                           (optional → require x-proxy-token header)
 *   ALLOWED_REDIRECT_HOSTS                         (optional, default 127.0.0.1,localhost)
 *
 * Security Rule: set this function to `no_auth`. The redirect-host allowlist +
 * optional shared secret are the guards. Dependency: express (run `npm install`
 * in this folder before `catalyst deploy` so node_modules ships).
 */

const express = require('express');
const crypto = require('crypto');

const CLIENT_ID = process.env.ZOHO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || '';
const SHARED_SECRET = process.env.PROXY_SHARED_SECRET || '';
const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || '127.0.0.1,localhost')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

// Catalyst Data Store table for opt-in user capture (Table ID 8040000001822123).
const USERS_TABLE = process.env.USERS_TABLE || 'VScodeUsers';

// dc (the workspace setting `zohoDeluge.dc`) → Zoho accounts server host.
const ACCOUNTS_DOMAINS = {
    com: 'accounts.zoho.com',
    eu: 'accounts.zoho.eu',
    in: 'accounts.zoho.in',
    jp: 'accounts.zoho.jp',
    'com.au': 'accounts.zoho.com.au',
    'com.cn': 'accounts.zoho.com.cn',
    ca: 'accounts.zohocloud.ca',
    sa: 'accounts.zoho.sa',
    ae: 'accounts.zoho.ae'
};

const app = express();
app.use(express.json());

// Health — GET any path.
app.get('*', (req, res) => {
    console.log(`[oauth] Incoming GET (Health check) request to ${req.originalUrl || req.path}`);
    res.status(200).json({
        service: 'zoho-oauth-proxy',
        ok: true,
        configured: Boolean(CLIENT_ID && CLIENT_SECRET),
        // The client_id is NOT a secret — the extension needs it to build the
        // loopback authorization URL in proxy mode (the secret stays server-side).
        client_id: CLIENT_ID || '',
        actions: ['token', 'refresh', 'revoke']
    });
});

// Token exchange / refresh / revoke — POST any path, dispatched by `action`.
app.post('*', async (req, res) => {
    try {
        console.log(`[oauth] Incoming POST request to ${req.originalUrl || req.path}`);
        if (!CLIENT_ID || !CLIENT_SECRET) {
            console.error('[oauth] Error: ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET are not set.');
            return res.status(500).json({ error: 'server_misconfigured', error_description: 'ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET are not set.' });
        }
        if (SHARED_SECRET && !safeEqual(req.get('x-proxy-token') || '', SHARED_SECRET)) {
            console.warn('[oauth] Warning: Missing or invalid x-proxy-token header.');
            return res.status(401).json({ error: 'unauthorized' });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : parseBody(req.body);
        const action = String(body.action || '').toLowerCase();
        const host = accountsHost(body.dc);
        
        console.log(`[oauth] Parsed action: '${action}', dc: '${body.dc}', resolved host: '${host}'`);

        if (action === 'token') {
            console.log(`[oauth] Processing 'token' action with redirect_uri: '${body.redirect_uri}'`);
            if (!body.code || !body.redirect_uri || !host) {
                console.warn('[oauth] Missing required parameters for token action:', { hasCode: !!body.code, hasRedirectUri: !!body.redirect_uri, hasHost: !!host });
                return res.status(400).json({ error: 'invalid_request', error_description: 'code, redirect_uri and a valid dc are required.' });
            }
            if (!isAllowedRedirect(body.redirect_uri)) {
                console.warn(`[oauth] Invalid redirect_uri: '${body.redirect_uri}'. Allowed hosts: ${ALLOWED_REDIRECT_HOSTS.join(', ')}`);
                return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `redirect_uri host must be one of: ${ALLOWED_REDIRECT_HOSTS.join(', ')}` });
            }
            
            console.log(`[oauth] Sending request to https://${host}/oauth/v2/token (grant_type: authorization_code)`);
            const out = await zohoPost(`https://${host}/oauth/v2/token`, {
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: body.redirect_uri,
                code: body.code
            });
            
            log('token', body.dc, out.body);
            // Opt-in user capture (best-effort) — never blocks or breaks login.
            if (isConsented(body.consent) && out.body && out.body.access_token && !out.body.error) {
                console.log(`[capture] User consented. Initiating capture process...`);
                await withTimeout(captureUser(req, out.body.access_token, out.body.api_domain, body.dc), 8000)
                    .catch((e) => console.error('[capture] Unhandled error during user capture:', (e && e.message) || e));
            } else {
                console.log(`[capture] Skipping user capture. Consented: ${isConsented(body.consent)}, Has Token: ${!!(out.body && out.body.access_token)}, Error: ${out.body && out.body.error}`);
            }
            
            const responseStatus = out.body && out.body.error ? 400 : out.status;
            console.log(`[oauth] Returning 'token' response with status ${responseStatus}`);
            return res.status(responseStatus).json(out.body);
        }

        if (action === 'refresh') {
            console.log(`[oauth] Processing 'refresh' action`);
            if (!body.refresh_token || !host) {
                console.warn('[oauth] Missing required parameters for refresh action:', { hasRefreshToken: !!body.refresh_token, hasHost: !!host });
                return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token and a valid dc are required.' });
            }
            
            console.log(`[oauth] Sending request to https://${host}/oauth/v2/token (grant_type: refresh_token)`);
            const out = await zohoPost(`https://${host}/oauth/v2/token`, {
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: body.refresh_token
            });
            
            log('refresh', body.dc, out.body);
            const responseStatus = out.body && out.body.error ? 400 : out.status;
            console.log(`[oauth] Returning 'refresh' response with status ${responseStatus}`);
            return res.status(responseStatus).json(out.body);
        }

        if (action === 'revoke') {
            console.log(`[oauth] Processing 'revoke' action`);
            if (!body.refresh_token || !host) {
                console.warn('[oauth] Missing required parameters for revoke action:', { hasRefreshToken: !!body.refresh_token, hasHost: !!host });
                return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token and a valid dc are required.' });
            }
            
            console.log(`[oauth] Sending request to https://${host}/oauth/v2/token/revoke`);
            const out = await zohoPost(`https://${host}/oauth/v2/token/revoke`, { token: body.refresh_token });
            
            log('revoke', body.dc, out.body);
            const revoked = !(out.body && out.body.error);
            console.log(`[oauth] Revoke result: ${revoked}`);
            return res.status(200).json({ revoked, zoho: out.body });
        }

        console.warn(`[oauth] Invalid action requested: '${action}'`);
        return res.status(400).json({ error: 'invalid_action', error_description: "action must be 'token', 'refresh' or 'revoke'." });
    } catch (e) {
        console.error('[oauth] Unhandled upstream error in POST handler:', e);
        return res.status(502).json({ error: 'upstream_error', error_description: String((e && e.message) || e) });
    }
});

// Any other method.
app.all('*', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));

module.exports = app;

// --- helpers ----------------------------------------------------------------

function accountsHost(dc) {
    return ACCOUNTS_DOMAINS[String(dc || '').toLowerCase()];
}

/** Fallback body parse (express.json already handles application/json). */
function parseBody(raw) {
    if (raw && typeof raw === 'object') {
        return raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    return {};
}

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) {
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

function isAllowedRedirect(redirectUri) {
    try {
        return ALLOWED_REDIRECT_HOSTS.includes(new URL(redirectUri).hostname.toLowerCase());
    } catch {
        return false;
    }
}

async function zohoPost(url, form) {
    console.log(`[zohoPost] Initiating POST request to ${url}`);
    
    // Create a safe copy of form for logging to prevent leaking secrets
    const safeForm = { ...form };
    if (safeForm.client_secret) safeForm.client_secret = '***';
    if (safeForm.code) safeForm.code = '***';
    if (safeForm.refresh_token) safeForm.refresh_token = '***';
    if (safeForm.token) safeForm.token = '***';
    console.log(`[zohoPost] Request payload (safe):`, safeForm);

    let r;
    try {
        r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString()
        });
        console.log(`[zohoPost] Received response with status: ${r.status} ${r.statusText}`);
    } catch (err) {
        console.error(`[zohoPost] Network error while fetching ${url}:`, err);
        return { status: 502, body: { error: 'network_error', error_description: String((err && err.message) || err) } };
    }

    let body;
    try {
        body = await r.json();
        
        // Log safe response body
        const safeBody = { ...body };
        if (safeBody.access_token) safeBody.access_token = '***';
        if (safeBody.refresh_token) safeBody.refresh_token = '***';
        console.log(`[zohoPost] Response body parsed successfully (safe):`, safeBody);
    } catch {
        console.error(`[zohoPost] Failed to parse JSON response from ${url}`);
        body = { error: 'invalid_response', error_description: 'Zoho returned a non-JSON response.' };
    }
    return { status: r.status, body };
}

/** Log outcomes WITHOUT ever printing tokens or the secret. */
function log(kind, dc, body) {
    const ok = !(body && body.error);
    if (ok) {
        console.log(`[oauth] [SUCCESS] Action: ${kind} | dc=${dc} | Response looks good.`);
    } else {
        console.error(`[oauth] [ERROR] Action: ${kind} | dc=${dc} | Zoho Error: ${body.error} | Description: ${body.error_description || 'N/A'}`);
    }
}

// --- opt-in user capture (Catalyst Data Store) ------------------------------

function isConsented(v) {
    return v === true || v === 'true';
}

/** Resolve a promise but give up (resolve undefined) after `ms` so a slow
 *  capture can never hang the login response. */
function withTimeout(promise, ms) {
    return Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => setTimeout(resolve, ms))
    ]);
}

/**
 * On a consented first login: look up the user's name/email/org from Zoho with
 * the freshly issued access token, then INSERT a row into VScodeUsers. `email`
 * is unique — if it already exists we do nothing. Best-effort throughout.
 */
async function captureUser(req, accessToken, apiDomain, dc) {
    console.log(`[capture] Starting captureUser for apiDomain=${apiDomain}, dc=${dc}`);
    const who = await fetchWhoAmI(apiDomain, accessToken);
    
    console.log(`[capture] Extracted user info:`, { 
        email: who.email ? '***@***.***' : null, 
        nameLength: who.name ? who.name.length : 0, 
        org: who.org, 
        orgId: who.orgId, 
        userCount: who.userCount 
    });

    if (!who.email) {
        console.warn('[capture] No email resolved from Zoho CRM — skipping Datastore registration.');
        return;
    }

    try {
        console.log(`[capture] Initializing Catalyst SDK to query ${USERS_TABLE}...`);
        // Lazy-require so non-capture paths/local tests don't need the SDK present.
        const catalyst = require('zcatalyst-sdk-node');
        const app = catalyst.initialize(req);

        // email is unique → skip if already registered.
        const escaped = who.email.replace(/'/g, "''");
        console.log(`[capture] Checking if user exists in ${USERS_TABLE}...`);
        const existing = await app.zcql().executeZCQLQuery(`SELECT ROWID FROM ${USERS_TABLE} WHERE email = '${escaped}'`);
        
        if (Array.isArray(existing) && existing.length > 0) {
            console.log(`[capture] User already registered (found ${existing.length} record). Skipping insert.`);
            return;
        }

        console.log(`[capture] User not found. Inserting new row into ${USERS_TABLE}...`);
        await app.datastore().table(USERS_TABLE).insertRow({
            email: who.email,
            name: who.name || '',
            org: who.org || '',
            org_id: who.orgId || '',
            dc: dc || '',
            consent: true,
            SuperAdminEmail: who.superAdminEmail || who.email,
            UserCount: who.userCount || 0,
            license_details: who.licenseDetails ? JSON.stringify(who.licenseDetails) : ''
        });
        console.log('[capture] Successfully registered new user in Datastore.');
    } catch (err) {
        console.error('[capture] Error during Catalyst Datastore operations:', err);
    }
}

/**
 * Read (read-only) from Zoho CRM v8 with the fresh access token:
 *  - the current user's email + name      (/users?type=CurrentUser)
 *  - the org name + id + super-admin email (/org → primary_email = the org's
 *    first/primary user)
 *  - the count of ACTIVE users            (/users?type=ActiveUsers, paged)
 */
async function fetchWhoAmI(apiDomain, accessToken) {
    const base = apiDomain || 'https://www.zohoapis.com';
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    const result = { email: '', name: '', org: '', orgId: '', superAdminEmail: '', userCount: 0, licenseDetails: null };
    
    console.log(`[whoami] Fetching CurrentUser, Org info, and ActiveUsers count concurrently...`);
    
    // Fire all three fetches concurrently to minimize total wait time.
    const userPromise = fetch(`${base}/crm/v8/users?type=CurrentUser`, { headers })
        .then(r => r.json())
        .catch(err => { console.error(`[whoami] Error fetching CurrentUser:`, err); return null; });
        
    const orgPromise = fetch(`${base}/crm/v8/org`, { headers })
        .then(r => r.json())
        .catch(err => { console.error(`[whoami] Error fetching Org info:`, err); return null; });

    const countPromise = countActiveUsers(base, headers)
        .catch(err => { console.error(`[whoami] Error counting active users:`, err); return 0; });

    // Wait for all to finish. The maximum time is bounded by the slowest request, not the sum.
    const [userJson, orgJson, totalCount] = await Promise.all([userPromise, orgPromise, countPromise]);

    const u = userJson && Array.isArray(userJson.users) && userJson.users[0];
    if (u) {
        result.email = u.email || '';
        result.name = u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || '';
        console.log(`[whoami] Successfully fetched CurrentUser (email: ***, name length: ${result.name.length})`);
    } else {
        console.warn(`[whoami] Failed to extract user from CurrentUser response.`);
    }

    const o = orgJson && Array.isArray(orgJson.org) && orgJson.org[0];
    if (o) {
        result.org = o.company_name || '';
        result.orgId = String(o.id || o.zgid || '');
        result.superAdminEmail = o.primary_email || '';
        result.licenseDetails = o.license_details || null;
        console.log(`[whoami] Successfully fetched Org (name: ${result.org}, id: ${result.orgId})`);
    } else {
        console.warn(`[whoami] Failed to extract org from /org response.`);
    }

    result.userCount = totalCount || 0;
    console.log(`[whoami] Successfully recorded ${result.userCount} active users.`);

    return result;
}

/** Count ACTIVE Zoho CRM users by paging /users?type=ActiveUsers. Capped at 5 pages (1000 users) to prevent OAuth timeout. */
async function countActiveUsers(base, headers) {
    let total = 0;
    for (let page = 1; page <= 5; page++) {
        console.log(`[countUsers] Fetching page ${page} of ActiveUsers...`);
        const r = await fetch(`${base}/crm/v8/users?type=ActiveUsers&page=${page}&per_page=200`, { headers });
        if (!r.ok) {
            console.warn(`[countUsers] Non-OK response on page ${page}: ${r.status}`);
            break;
        }
        const d = await r.json();
        const users = d && Array.isArray(d.users) ? d.users : [];
        total += users.length;
        console.log(`[countUsers] Page ${page} returned ${users.length} users. Running total: ${total}`);
        if (users.length === 0 || !(d.info && d.info.more_records)) {
            console.log(`[countUsers] Reached end of pagination at page ${page}.`);
            break;
        }
    }
    return total;
}
