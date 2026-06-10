# Zoho OAuth Proxy (Catalyst Advanced I/O Function)

A serverless **Advanced I/O function** that holds the Zoho OAuth app's
**client_id + client_secret** server-side and performs the token exchange /
refresh / revoke on behalf of the **Zoho CRM IDE Extension** — so the published
VS Code extension never ships the secret.

```
Extension ──(action + code / refresh_token + dc)──▶  this function  ──(+ client_secret)──▶  Zoho accounts server
          ◀──────────────── token JSON ──────────────────────────────────────────────────
```

## API

Advanced I/O functions are invoked at **one** fixed URL, so operations are
selected by an `action` field in the JSON body (there are no sub-paths).

**Endpoint:** `POST https://<your-catalyst-domain>/server/zoho_oauth_proxy/execute`

| `action`  | Body                          | Returns |
| --------- | ----------------------------- | ------- |
| `token`   | `{ code, redirect_uri, dc, consent? }` | Zoho token set (`access_token`, `refresh_token`, `api_domain`, `expires_in`, …). `consent: true` also records the user (see below). |
| `refresh` | `{ refresh_token, dc }`       | new `access_token` (+ `api_domain`, `expires_in`) |
| `revoke`  | `{ refresh_token, dc }`       | `{ "revoked": true }` |

A **GET** to the same URL returns a health/status object. `dc` is the
data-center suffix the extension already stores (`com`, `eu`, `in`, `jp`,
`com.au`, `com.cn`, `ca`, `sa`).

## Environment variables (Catalyst console → Serverless → Environment Variables)

| Variable                 | Required | Purpose |
| ------------------------ | -------- | ------- |
| `ZOHO_CLIENT_ID`         | ✅       | Your Zoho **Server-based** app Client ID |
| `ZOHO_CLIENT_SECRET`     | ✅       | Your Zoho app Client Secret (never returned or logged) |
| `PROXY_SHARED_SECRET`    | optional | If set, requests must send header `x-proxy-token: <value>` |
| `ALLOWED_REDIRECT_HOSTS` | optional | Comma list of allowed `redirect_uri` hosts (default `127.0.0.1,localhost`) |

## User capture (opt-in)

When the extension sends `{ action: "token", …, consent: true }`, a **successful**
exchange also records the user in the **`VScodeUsers`** Data Store table
(Table ID `8040000001822123`) via the Catalyst Node SDK:

- Reads from Zoho with the fresh access token: the current user's name/email
  (`/crm/v8/users?type=CurrentUser`), the org name/id + **super-admin email**
  (`/crm/v8/org` → `primary_email`, the org's first/primary user), and the
  **active-user count** (`/crm/v8/users?type=ActiveUsers`, paged).
- INSERTs a row (`email`, `name`, `org`, `org_id`, `dc`, `consent`,
  `SuperAdminEmail`, `UserCount`, `license_details`). **`email` is unique — if it
  already exists, nothing is written** (no update). `SuperAdminEmail` falls back
  to the user's own email if the org has no primary email; `license_details`
  stores the org's `license_details` object as a JSON string.
- Best-effort and time-boxed (8s): a capture failure never blocks or breaks the
  login. Any `consent` value other than `true` skips capture entirely.

Needs the `zcatalyst-sdk-node` dependency (in `package.json`) and Data Store write
access (default project/function credentials cover this). Override the table name
with the optional `USERS_TABLE` env var.

## Security Rule

Set this function's access level to **`no_auth`** (Catalyst console → Serverless
→ Security Rules) — the extension is not a Catalyst user. The redirect-host
allowlist and the optional `PROXY_SHARED_SECRET` are the guards. The token
exchange also requires a valid, single-use Zoho `code` issued for *your* app.

## Register the redirect URIs (once) in your Zoho app

The extension uses a loopback redirect on the first free port of `3000`, `3737`,
`8980`. In your Zoho API console app, add all three **Authorized Redirect URIs**:

```
http://127.0.0.1:3000/zoho/callback
http://127.0.0.1:3737/zoho/callback
http://127.0.0.1:8980/zoho/callback
```

## Deploy to Catalyst

This folder holds the function's files: `index.js` (an Express app),
`package.json`, `catalyst-config.json`. It depends on **express**, so run
`npm install` in the function folder before deploying (Catalyst ships
`node_modules`). It uses Node 18's global `fetch` for the Zoho calls.

```bash
npm install -g zcatalyst-cli         # if not already installed
catalyst login

# In your Catalyst project, scaffold an Advanced I/O (Node 18) function so the
# CLI generates a catalyst-config.json matching your CLI version:
catalyst functions:add               # choose: Advanced I/O → Node.js

# Then copy index.js + package.json from here into the scaffolded function
# folder (overwriting the scaffold's index.js). If the scaffold's
# catalyst-config.json differs, keep the scaffold's but ensure the type is
# Advanced I/O and the stack is Node 18.

# Install express INTO the function folder so node_modules ships with the deploy:
cd functions/<your-function-name> && npm install && cd -

catalyst deploy --only functions     # or: catalyst deploy
```

After deploy, set `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET`, set the Security Rule
to `no_auth`, and grab the function URL
(`https://<project>-<id>.<env>.catalystserverless.com/server/<your-function-name>/`,
plus a production URL once promoted). **Send me that URL** and I'll wire the
extension to call it with `{ action: "token" | "refresh" | "revoke", … }`
(keeping BYO credentials as a fallback).

## Local test

```bash
# The handler is a plain function — exercise it with a mock req/res, or run it
# locally with the Catalyst CLI:
catalyst serve
curl https://localhost:3000/server/zoho_oauth_proxy/execute   # health (GET)
```
