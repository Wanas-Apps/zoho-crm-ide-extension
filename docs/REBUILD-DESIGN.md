# Zoho CRM IDE Extension — Major Rebuild Design Document (FINAL)

**Project:** `zoho-crm-ide-extension` (publisher `wanas-apps`)
**Location:** `D:/Projects/Zoho Deluge Extention`
**Companion CLI:** `wanas-zcrm-extractor` v1.8.0 (`D:/Projects/Zoho CRM V8 Metadata Extractor`)
**Status:** FINAL design — implementation-ready. File and symbol names are prescriptive targets; no code herein is final.
**Date:** 2026-06-09
**Revision:** Integrates principal-engineer review. Critical issues resolved in-place; residual risks flagged with mitigations and marked **(OPEN RISK)**. Reverse-engineered figures are marked **(unverified)**.

---

## 0. What changed in this revision (review integration summary)

The review surfaced four wrong/overstated factual claims and several structural risks. All are now resolved in the body; this table is the audit trail.

| # | Review finding | Resolution in this document |
|---|---|---|
| C1 | "`arguments: null` usually means zero params; `.ds` parser is the safety net" was **inverted**. Verified: 47/73 functions have populated `arguments`; only 19/51 standalone are `null`. | §6 Goal 5 rewritten: **`functions.json.arguments` is the primary, usually-populated source**; `.ds` line-1 parser is the rare fallback used only when `arguments === null` **and** the `.ds` shows non-empty params. Invariant flagged for second-org validation. |
| C2 | Process-global singleton `authService`/`configStore` breaks multi-org and is unsafe in a long-lived host (token clobbering across windows/orgs → wrong-org Push/Run). | §3 + §4 + §11 reordered: **auth-instancing (class/factory, not singleton) is pulled forward into M1**, not deferred to core-split. Until that lands, the extension is **hard-scoped to one org per host** with an explicit lock. |
| C3 | `StoragePort`/`LogPort`/`STORE_DIR` abstractions were **fictional** against today's code: `extract()` hardcodes `.zcrm` and `process.cwd()`; logger writes to `cwd/storage/logs`; nothing is injected. | §3.3/§3.4 rewritten with the concrete bridge mechanics (absolute `outputDir` on every call + logger monkeypatch) as the **honest M1 reality**. `.zdk` rename **dropped from scope**. |
| C4 | **No sync-conflict detection exists**; mitigations were advisory. Lost-update hazard destroys production code with no recovery. | New **§7.5 "Conflict safety (enforced)"** with per-function base-snapshot hashing, pre-push divergence block, pre-overwrite dirty/hash checks, and mandatory pre-overwrite backups. Promoted to a named milestone (**M4.5**). |
| C5 | Bundling risk understated: option (b) drags express/inquirer/commander/archiver/dotenv; `bin/cli.js` helpers (`FN_ERROR_HINTS`, `renderTestResult`) are CLI-coupled and leak `zcrm` command strings into UI. | §3.5 added: **mandatory `esbuild --metafile` gate** before committing to option (b); `bin/cli.js` helpers must be **re-authored, not imported**; `FN_ERROR_HINTS` rewritten for extension context. |
| C6 | "1 credit / 10s timeout" and v7 endpoint behavior stated as **fact** without source; **429-retry on the executing path is a duplicate-execution hazard**. | §7.2/§7.3 mark figures **(unverified)**; §7.6 added: **no automatic retry on executing/mutating paths** (Run, Push, Create) — 429/5xx surface, never silently re-execute. |
| Gaps | Refresh mutex; refresh-token revocation/throttle recovery; plain/untitled `.ds` handling; module-context detection design; `index.json` lacks `custom`; whoami ambiguous-state recovery; webview secret-entry threat model. | Addressed in §4.3.1 (refresh mutex), §4.6 (revocation/throttle recovery), §6 Goal 6 + §6.1 (module detection + field source), §10 (plain `.ds`, whoami recovery), §9.4 (webview threat model). |

---

## 1. Vision & Scope

### 1.1 What the extension is today
A purely **static** language extension for Zoho Deluge: TextMate grammar syntax highlighting, completion/hover/signature-help driven entirely by `src/data/delugeData.ts`, a formatter, and a small rule-based linter. It has **no network awareness**, no knowledge of any specific org, and no Zoho authentication. Providers cache their lookup maps in module-load IIFEs (`BARE_FUNCS`, `HOVER_DOCS`) and register against the `{ language: 'deluge' }` selector in `src/extension.ts`.

### 1.2 What it becomes
A **connected Deluge development environment** inside VS Code. After a one-time in-editor Zoho login, the extension:

1. Pulls the user's Zoho CRM org metadata (modules, fields, standalone functions, Deluge source) into the workspace.
2. Augments the existing static IntelliSense with **org-specific** completions: module api_names, field api_names per module, and `standalone.<fn>(...)` call completion + signature help **derived from the live org**.
3. Adds **Run / Pull / Push** editor-title buttons on `.ds` Deluge files, mapped to the CLI's verified live endpoints, gated to **standalone functions only**, with explicit confirmation and **enforced conflict safety** for any write/execute.
4. Keeps everything synchronized via a `FileSystemWatcher`-driven re-index of the pulled metadata.

### 1.3 Scope boundaries
**In scope (the 6 goals):** login UI; reuse of pull logic; Run/Pull/Push buttons; auto-pull on login; standalone-function IntelliSense; module/field IntelliSense.

**Explicitly out of scope for the rebuild (candidate follow-ups):** editing non-standalone functions; record CRUD; the CLI's `audit`/`llm`/`skill`/`dashboard` commands; the public `/crm/v2/.../actions/execute` production-invocation path (we use the internal `/actions/test` path for Run because only it returns logs/metrics); Zoho Creator support; the `.zcrm`→`.zdk` store-dir rename (**dropped** — see §3.3); multi-org concurrency within a single host (**hard-scoped out for M1–M5** — see §4.7).

### 1.4 Design principles
- **Static catalog is the floor, org data is an overlay.** Dynamic symbols are *added to*, never replace, `delugeData.ts`. Offline, the extension degrades cleanly to today's behavior.
- **One token accessor, one refresh.** Every authenticated call routes through a single `getAccessToken()` seam with an **in-flight refresh mutex** (§4.3.1) so refresh/retry/concurrency stay centralized and de-duplicated.
- **No embedded secret.** The published `.vsix` must contain no usable Zoho client secret (a hard security requirement — see §9).
- **Reads are quiet; writes and executes are loud and conflict-checked.** Pull is silent/automatic; Run, Push, and Create require explicit confirmation, **enforced conflict detection**, and **never auto-retry** (they execute/mutate live production code and consume credits).
- **Providers are stable; only their backing data changes.** Re-index swaps in-memory arrays; it never re-registers providers.
- **One org per host (for now).** A single authenticated session at a time, enforced by lock, until per-connection auth instancing is proven (§4.7).

---

## 2. High-Level Architecture

### 2.1 Component diagram

```
                          VS CODE EXTENSION HOST (Node)
┌───────────────────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────┐        ┌────────────────────────────────┐    │
│  │  UI LAYER                     │        │  COMMAND LAYER                 │    │
│  │  • LoginWebview (branded)     │        │  zohoDeluge.login / .logout    │    │
│  │  • StatusBarItem (Zoho: …)    │◄──────►│  zohoDeluge.pullMetadata       │    │
│  │  • editor/title buttons       │        │  zohoDeluge.run/.pull/.push    │    │
│  │    (Run / Pull / Push)        │        │  zohoDeluge.createFn           │    │
│  └───────────────┬──────────────┘        └───────────┬────────────────────┘    │
│                  ▼                                    ▼                         │
│  ┌──────────────────────────────┐        ┌────────────────────────────────┐    │
│  │  AUTH                         │        │  RUN/PULL/PUSH SERVICE         │    │
│  │  ZohoAuthProvider             │        │  FunctionOps (adapter over     │    │
│  │  (AuthenticationProvider)     │        │   core functionService)        │    │
│  │  + LoopbackServer (transient) │        │  • resolveTarget/executeTest   │    │
│  │  + DcResolver                 │        │  • pullOne / pushCode / create │    │
│  │  + RefreshMutex               │        │  + ConflictGuard (snapshots)   │    │
│  └───────────────┬──────────────┘        └───────────┬────────────────────┘    │
│                  │ getAccessToken()  (single-flight)  │                         │
│                  ▼                                    ▼                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  CORE (shared with CLI — interim: import bridge; target: @wanas/zcrm-core)│  │
│  │  AuthService (CLASS/factory, per-connection)  · apiClient (read-retry)    │  │
│  │  apiClientNoRetry (execute/write paths)  · crmMetadataService.extract()   │  │
│  │  functionService · delugeSignature · delugeFormatter · namespace util     │  │
│  │  ── StoragePort ─ LogPort ─ (NO process.exit, NO console, NO inquirer) ── │  │
│  └───────────────┬──────────────────────────────────────┬──────────────────┘  │
│                  │ extract(onProgress, ABS outputDir)     │ tokens             │
│                  ▼                                        ▼                     │
│  ┌──────────────────────────────┐        ┌────────────────────────────────┐    │
│  │  METADATA SYNC ENGINE         │        │  SECRETS / CONFIG              │    │
│  │  MetadataSync wrapper +       │        │  context.secrets (tokens,      │    │
│  │  SyncLock (watcher coord.)    │        │    client_secret)              │    │
│  └───────────────┬──────────────┘        │  workspace config (dc, scopes, │    │
│                  ▼ writes .zcrm + crm/**  │    client_id, concurrency)     │    │
│  ┌──────────────────────────────┐        │  workspaceState (active folder,│    │
│  │  WORKSPACE (on disk)          │        │    per-fn base snapshots)      │    │
│  └───────────────┬──────────────┘        └────────────────────────────────┘    │
│                  │ FileSystemWatcher(.store/*.json), gated by SyncLock          │
│                  ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  WORKSPACE METADATA INDEX  (MetadataIndex)  load()→symbols, onDidChange   │  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
│                  ▼  DelugeSymbol[] (merged with static delugeData)             │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  INTELLISENSE PROVIDERS (refactored to factories): STATIC ⊕ DYNAMIC      │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
            │ HTTPS (Zoho-oauthtoken)                  │ browser (openExternal)
            ▼                                          ▼
   accounts.zoho.<dc> / www.zohoapis.<dc>      User's default browser (consent)
```

### 2.2 Component descriptions

- **Auth (`src/auth/ZohoAuthProvider.ts`, `LoopbackServer.ts`, `DcResolver.ts`, `RefreshMutex.ts`)** — Implements `vscode.AuthenticationProvider` (id `zoho`). Owns the OAuth2 authorization-code flow, the transient loopback callback server, DC selection, **single-flight token refresh**, and the `getAccessToken()` seam. Instantiates a **per-connection `AuthService`** (class, not singleton — §4.7). Tokens live in `context.secrets`.
- **Metadata Sync engine (`src/metadata/MetadataSync.ts`, `SyncLock.ts`)** — Thin wrapper over core `crmMetadataService.extract(onProgress, ABSOLUTE_outputDir, opts)`. Maps progress stages onto `vscode.window.withProgress`, **always passes an absolute `outputDir`** under the chosen workspace folder, handles cancellation, and raises a `SyncLock` the `FileSystemWatcher` observes to coalesce writes (§5.4).
- **Workspace Metadata Index (`src/metadata/MetadataIndex.ts`)** — Loads `.store/{index,field_map,functions,modules_raw}.json` (+ `.ds` line-1 fallback) into in-memory `DelugeSymbol[]` collections, refreshed by a debounced, `SyncLock`-gated `FileSystemWatcher`. Exposes `getModuleSymbols()`, `getFieldSymbols(module)`, `getStandaloneFunctionSymbols()`, and `onDidChange`.
- **IntelliSense providers (existing, refactored)** — `completionProvider.ts`, `signatureHelpProvider.ts`, `hoverProvider.ts` become **factories** capturing the `MetadataIndex` and merging dynamic symbols with the static `delugeData` catalog.
- **Run/Pull/Push command layer (`src/commands/FunctionOps.ts`, `ConflictGuard.ts`)** — Adapter calling core `functionService` 1:1, supplying VS Code confirmation/argument UI **and enforced conflict checks** (§7.5). Renders results to an `OutputChannel`/webview. Uses the **no-retry** client for executing/mutating calls (§7.6).
- **UI (`src/ui/*`)** — `LoginWebview` (branded onboarding, hardened CSP — §9.4), `StatusBar`, and the `editor/title` Run/Pull/Push buttons.

---

## 3. Code-Reuse Strategy

The single biggest architectural decision. The review's central correction: **the reuse target is far more CLI-shaped than the original design admitted.** `authService` and `configStore` are process-global singletons; `crmMetadataService.extract()` hardcodes `.zcrm` and `process.cwd()`-derived defaults; the logger writes to `cwd/storage/logs/errors.log` and is imported (not injected) everywhere. The seams below are **work to be done**, not properties of today's code.

### 3.1 Option comparison

| | (a) Shared core `@wanas/zcrm-core` | (b) Import `wanas-zcrm-extractor/src/*` behind adapter | (c) Spawn `zcrm` CLI child process | (d) Vendor/port into extension |
|---|---|---|---|---|
| **Eng. cost** | High up-front (refactor CLI), low ongoing | Low up-front, **medium-high** ongoing (side-effect taming + monkeypatching) | Low up-front, medium ongoing | Medium up-front, high ongoing (manual re-sync) |
| **Coupling** | Clean, versioned | Imports private `src/` paths; inherits singleton state | Loose, but stdout is human text | Fork that drifts |
| **Token store** | One seam, injected | **Risk: singleton holds one token set; multi-org unsafe** (C2) | Two token stores; 20-refresh-cap risk | Controlled |
| **Bundle** | Clean (no express/inquirer) | **Pulls CLI module graph unless tree-shaken** (C5) | CLI not bundled; needs `zcrm` binary | Cleanest |
| **CLI version drift** | Lockstep | Breaks on CLI refactors | Survives if on-disk contract holds | Diverges |

### 3.2 Recommendation: **(a) extract `@wanas/zcrm-core`, with a hardened (b) bridge as interim — but with auth-instancing and the bundle gate pulled forward**

**Rationale (unchanged direction, corrected mechanics).** The valuable modules are pure-JS CommonJS with no native deps; they are a de-facto library. But the review is right that the seams the original design treated as already-true are not. Therefore:

- The **(b) import bridge remains the fastest path to M2–M5**, *but only after* two prerequisites the original design wrongly deferred to M6: (1) **auth must be instanced per connection** (C2), and (2) **the bundle graph must be measured** (C5). Both are pulled into **M1**.
- Option (c) is rejected as primary: it forks the token lifecycle into `~/.zcrm`, defeats SecretStorage, risks the refresh-token cap, and forces parsing of banner-laden stdout.
- Option (d) condemns us to manual drift.
- The end state remains **(a) `@wanas/zcrm-core`**, with the M1 adapter becoming its injection interface.

### 3.3 The seams to introduce — and their honest current state

These seams **do not exist today** and are real work:

1. **`StoragePort`** — replaces `configStore`'s `get/getAll/save/reload/clear`. CLI → `~/.zcrm/config.json`; extension → `SecretStorageStore` (tokens, client_secret) + `WorkspaceConfigStore` (dc, scopes, client_id, concurrency). **Current reality:** `configStore` is a singleton bound to `~/.zcrm`; `authService` reads/writes via `ZCRM_CLI_MODE` branches and a `TOKENS_PATH` under `process.cwd()`. The bridge must intercept these **before any auth call**.
2. **`LogPort`** — replaces direct `console.*`. CLI → stdout; extension → `OutputChannel`. **Current reality:** the logger writes to `process.cwd()/storage/logs/errors.log` and calls `console.*` directly, **imported by every module**. In the (b) bridge this requires **monkeypatching the logger module** at activation (or accepting debug-console output) until the core split injects `LogPort`.
3. **`PromptPort`** — replaces `inquirer`. Only matters for CLI handlers; core **service methods already take structured args**, so the extension supplies its own QuickInput/webview UI and never touches `inquirer`.
4. **No `process.exit` in core.** Errors throw; consumers decide. (Present in CLI handlers, not in the reused services — verify per-module during the bridge.)

**`extract()` output dir — the load-bearing correction (C3).** `crmMetadataService` defaults `outputDir` to `path.join(process.cwd(), 'storage/metadata')` and hardcodes `.zcrm/.store`, `.zcrm/.org`, `.zcrm/.logs`, and writes a `.zcrmignore`. In the extension host `process.cwd()` is unpredictable. **Mitigation: the extension MUST pass an absolute `outputDir` (the chosen workspace folder) on every `extract()`/`pullOne`/`pushCode`/`createFunction`/`executeTest` call.** This is verified as supported by the service signatures.

**`.zcrm`→`.zdk` rename: DROPPED from scope.** `extract()` always writes `.zcrm`; making `.zdk` real requires forking the CLI. The extension uses a single `STORE_DIR = '.zcrm'` constant for **reads and writes** and does not pretend to read-both. (Re-add only if/when the CLI is forked in the same effort.)

### 3.4 Migration steps (revised ordering)

1. **M1 (bridge + prerequisites):**
   a. **Auth-instancing first.** In the CLI repo (or a thin local fork imported by the extension), convert `authService` from `module.exports = new AuthService()` to **exporting the `AuthService` class/factory**. The extension constructs one instance per connection. This is the C2 fix and is a **prerequisite for any token-touching feature**.
   b. Wire `StoragePort` (SecretStorage) + a `LogPort`/logger-monkeypatch shim, injected **before** any auth call.
   c. Always pass absolute `outputDir`.
   d. **Bundle gate (C5):** run `esbuild --metafile` against the bridge and inspect what the CLI module graph drags in (express, inquirer, commander, archiver, dotenv). If they leak into the VSIX, the bridge is non-viable as-is and the **core split (M6) must precede M3**.
2. Extract `@wanas/zcrm-core` (start `0.x`, pin exact version). Move `src/utils/{apiClient,authService,delugeFormatter,delugeSignature,concurrency}.js`, `src/services/functionService.js`, `src/services/metadata/crmMetadataService.js`. Introduce `StoragePort`/`LogPort`; default-bind to the current `configStore`/`console` so the CLI is unchanged.
3. CLI: depend on `@wanas/zcrm-core`; verify all existing CLI commands pass.
4. Extension: `npm i @wanas/zcrm-core`; implement `SecretStorageStore` + `WorkspaceConfigStore` + `OutputChannelLog`; inject at activation.
5. Bundle with **esbuild**, `external: ['vscode']`; core deps (axios, fs-extra) bundle cleanly.
6. Delete the interim direct-`src/`-import bridge.

### 3.5 What must be RE-AUTHORED, not imported (C5)

`bin/cli.js` helpers are **CLI-coupled** and must be rewritten for the extension:
- **`FN_ERROR_HINTS`** — its messages literally say things like "create it first with `zcrm fn create`" and reference CLI flags. **Re-author** with extension-appropriate copy (command-palette actions, button names) — never surface `zcrm` command strings in extension UI.
- **`renderTestResult`** — terminal/ANSI rendering. **Re-author** for the `OutputChannel`/results webview.
- **`runOAuthServer`** — terminal-oriented loopback. **Re-author** as `LoopbackServer.ts` (the auth-URL/token-exchange *service* calls underneath are reusable; the orchestration is not).

**Bundle decision rule:** if the esbuild metafile shows express/inquirer/commander/archiver in the extension bundle and tree-shaking cannot remove them, **do not ship the (b) bridge** — promote M6 (core split) ahead of M3.

---

## 4. Authentication Design

### 4.1 Chosen OAuth model — **BYO confidential client (Server-based app) + loopback**

Zoho's token endpoint **requires `client_secret` even with PKCE; there is no fully secretless public-client flow** (verified against Zoho OAuth docs). We therefore **cannot** ship a public PKCE-only client and **must not** embed the CLI's shared secret.

**Model: Bring-Your-Own credentials.** The user registers their own Zoho **Server-based** application and enters `client_id` + `client_secret` once. This reuses the CLI's confidential authorization-code flow (`getAuthorizationUrl` → loopback → `handleCallback` → `refreshAccessToken`).

Delivered via a first-class **`AuthenticationProvider`** (id `zoho`) so VS Code renders the native Accounts menu. VS Code does **not** refresh for us; the provider stores the refresh token in SecretStorage and refreshes inside `getSessions`/`getAccessToken`.

**PKCE — demoted from a requirement to an optional hardening (gap fix).** PKCE does not remove the secret requirement. Whether Zoho accepts `code_challenge` for a confidential client is **(unverified)**. **The security posture does NOT depend on PKCE.** Baseline hardening is `state` + `127.0.0.1` binding + short listener lifetime; PKCE S256 is added *only if* a Zoho-console test confirms acceptance.

### 4.2 Secret handling (no embedded secret) — **project-scoped connection**
- The published extension contains **no** `client_id`/`client_secret`.
- **The connection is scoped to the workspace folder open in the IDE** (one folder ↔ one org ↔ one connection), mirroring the CLI's per-project `.env` model.
- The user's `client_secret` and all tokens live in **`context.secrets`** (OS keychain) as one JSON bundle: `{ access_token, refresh_token, api_domain, expiry_time, client_secret }`, **keyed by the workspace folder's path** (e.g. secret key `zoho:<folderFsPath>`). SecretStorage is per-machine, but folder-keying makes each project its own connection **without ever writing a secret into the project tree** (so it can never be committed). This is a hard rule: secrets never go in `.vscode/settings.json`.
- `client_id`, `dc`, `scopes`, and concurrency are **non-secret** → **workspace settings** (`.vscode/settings.json`, `zohoDeluge.*`). They live with the folder; safe to commit or gitignore.
- **CLI parity:** if a folder already has the CLI's gitignored `.env`/`.zcrm` config, the extension offers to import `client_id`/`dc` from it (secret only if the user opts in), so the two tools share one setup.
- **Fallbacks** for firewalled/no-port users: a **Self Client paste-grant-code** path and a **paste-refresh-token** path (validated via `refreshAccessToken()`).

### 4.3 Token storage in SecretStorage
- Token persistence routes through the **`StoragePort` seam**; `AuthService.saveTokens/loadTokens` map to `secrets.store/get`.
- **Hydrate once at activation** into the per-connection in-memory cache; drop the CLI's per-call `configStore.reload()+loadTokens()` disk re-read.
- `secrets.onDidChange` keeps multiple windows in sync (read-only mirror; writes are serialized through the single active host session — §4.7).
- Token shape preserved: `{ access_token, refresh_token (reused on refresh), api_domain, expires_in, expiry_time = Date.now()+expires_in*1000 }`. Refresh uses the 60s skew buffer (`now >= expiry_time - 60000`).

#### 4.3.1 Refresh mutex / single-flight (gap fix)
The singleton `authService` has **no in-flight refresh lock** — N concurrent calls on an expired token issue N concurrent `refreshAccessToken()` requests, wasting calls and risking Zoho's per-minute refresh throttle. **`getAccessToken()` wraps refresh in a `RefreshMutex`:** the first caller that observes expiry starts the refresh; concurrent callers await the same in-flight promise and reuse its result. This makes the "one token accessor, centralized refresh" principle real rather than asserted.

### 4.4 DC handling
- Login UI offers a DC picker: `com | eu | in | jp | com.au | com.cn` (+ `ca/zohocloud.ca`, `sa`, `uk`, `sg` per serverinfo — **(unverified)** exact set; default `com`). China starts auth at `accounts.zoho.com.cn`.
- After token exchange, **`api_domain` from the token response is authoritative** for all API calls (`getApiBaseUrl()`), so multi-DC works without extra config.

### 4.5 Login UX — step by step
1. User clicks status bar `Zoho: Logged out` → runs `zohoDeluge.login`, or uses Accounts menu → "Sign in with Zoho CRM".
2. **First run only:** `LoginWebview` (hardened CSP, §9.4) collects DC + `client_id` + `client_secret`, with inline instructions to create a Server-based app and register the redirect URI. Stores secret in SecretStorage; non-secrets in config.
3. Extension acquires the **single-session lock** (§4.7), then starts the transient `LoopbackServer` on a fixed documented port (default `3000`, with pre-registered fallbacks `3737`/`8980`) bound to `127.0.0.1`.
4. Build auth URL via `getAuthorizationUrl()` (+ `state`, optional `code_challenge`), open with `vscode.env.openExternal`. For Remote/Codespaces/web, fall back to a `UriHandler` deep link via `vscode.env.asExternalUri`.
5. Browser → Zoho consent (`access_type=offline&prompt=consent` forces a refresh_token) → redirect to `http://localhost:<port>/zoho/callback?code=...`.
6. Loopback captures `code`, **validates `state`**, calls `handleCallback(code)` (token exchange), saves tokens, closes the server, shows a styled success page.
7. **Confirm login (whoami)** with `GET /crm/v8/users?type=CurrentUser` + `GET /crm/v8/org`. See §10 for **ambiguous-state recovery** if these fail post-token-exchange.
8. Set `setContext('zohoDeluge.loggedIn', true)`; status bar → `Zoho: <org>`. Kick off **auto-pull** (§5.1).
9. **Logout** (`zohoDeluge.logout`): POST revoke to `oauth/v2/token/revoke`, `secrets.delete`, clear state and snapshots, release the session lock, `setContext('zohoDeluge.loggedIn', false)`.

### 4.6 Refresh-token revocation & throttle recovery (gap fix)
- **Revoked/invalid refresh token:** `refreshAccessToken()` returns `invalid_grant`/`invalid_code`/`invalid_client`. Detect, **clear the session**, surface a single actionable "Your Zoho session expired — sign in again" notification with a re-login button. Do not loop.
- **Per-minute refresh throttle** (Zoho historically caps access-token refreshes ~10/min — **(unverified)** exact value): the `RefreshMutex` (§4.3.1) already collapses bursts to one refresh; additionally, the **auto-pull-on-login burst** uses a *single* freshly-minted token (refresh happens at most once before pull starts), so the pull's many GETs do not each trigger a refresh.
- **20-refresh-tokens-per-user cap:** BYO single-app + single-host session (§4.7) avoids minting parallel sessions. Logout revokes, freeing a slot.

### 4.7 One-org-per-host enforcement (C2 resolution)
Even with auth instanced as a class, **M1–M5 ship a single active session per host** to eliminate the wrong-org Push/Run hazard:
- An **`ActiveSession` lock** in `workspaceState`/memory binds exactly one `{ org, api_domain, workspaceFolder }` at a time.
- Login while a session is active prompts "Switch org? This signs out of `<current>`." Switching = logout + login + re-pull into the new folder.
- All Run/Push/Create calls assert `activeSession.api_domain === resolved target's api_domain` before executing; mismatch aborts loudly.
- **(OPEN RISK)** True simultaneous multi-org (two windows, two orgs) is **deferred**. Mitigation: the `secrets.onDidChange` mirror plus the single-session lock means a second window detects an active session and operates read-only against the same org, or prompts to take over. Full multi-org concurrency requires the M6 core split's per-connection clients and is a named follow-up.

---

## 5. Metadata Sync Design

### 5.1 When/how pull runs
- **Auto on login (Goal #4):** immediately after §4.5 step 7, a full pull into the chosen folder via `vscode.window.withProgress({location: Notification, cancellable: true})`.
- **Manual:** `zohoDeluge.pullMetadata` + status-bar/title action (`$(sync)`).
- **On demand per function:** `zohoDeluge.pull` calls `functionService.pullOne` for a single `.ds` (conflict-checked — §7.5).
- Engine: core `crmMetadataService.extract(onProgress, ABSOLUTE_outputDir, { concurrency, withCounts })`. `MetadataSync` maps stages → progress: `FETCH_ORG`, `FETCH_MODULES`, `MODULE_PROGRESS{completed,total,module}`, `FETCH_FUNCTIONS`, `FUNCTION_PROGRESS`, `GENERATE_INDEX`, `COMPLETE`/`FAILURE`.

### 5.2 Where files live — the folder contract
Target = the **chosen workspace folder** (multi-root: explicit `showWorkspaceFolderPick`, persisted in `workspaceState`; §10). `STORE_DIR = '.zcrm'` (single constant; no `.zdk` — §3.3). Layout produced by `extract()`:

```
<wsFolder>/                                  ← ABSOLUTE outputDir passed by the extension
  .zcrm/
    .store/{index, field_map, modules, modules_raw, functions, webhooks, complete_metadata}.json
    .org/org.json
    .logs/
  crm/
    meta/modules/<Module>/{summary.json, <Module>.modules-meta.json,
                           fields/<Field>.fields-meta.json, layouts/, related_lists/, custom_views/}
    meta/{profiles, roles, ...}
    functions/<ns>/<ns>.<api_name>.ds        (ns ∈ standalone|automation|button|related_list|schedule|salessignals)
    functions/functions.json
    function_tests/<apiName>-<ISOts>.json      (Run history, §7)
  zcrm-project.json, meta.json, .zcrmignore, README.md
```

The extension **reads only compact `.store` JSON** for IntelliSense, and `crm/functions/**/*.ds` for editing/Run/Push.

### 5.3 Full vs incremental
- **Full pull** on login and explicit re-pull. The engine's end-of-run **stale sweep** deletes only files not rewritten this run, and only when the relevant listing succeeded and was non-empty — partial/failed runs never wipe data (verified). **Conflict caveat:** a full re-pull would overwrite dirty local `.ds` edits → gated by §7.5.
- **Incremental** for single-function `Pull` (`pullOne`) — read-only, never deletes, rewrites one `.ds` (conflict-checked).
- Delta pull keyed on `modified_time` is a post-M-core optimization, not in initial scope.

### 5.4 FileSystemWatcher re-indexing + SyncLock (gap fix)
- `vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(wsFolder, '.zcrm/.store/*.json'))` plus `crm/functions/standalone/*.ds`.
- `onDidCreate/Change/Delete` → **300ms trailing debounce**, cancel in-flight, then `MetadataIndex.load()` → fire `onDidChange`.
- **Watcher-storm coordination is concrete, not aspirational.** `MetadataSync` raises a **`SyncLock`** (a simple in-memory flag + a sentinel file `.zcrm/.store/.sync-in-progress`) before `extract()` and clears it on `COMPLETE`/`FAILURE`. The watcher handler **ignores events while the lock is held** and performs exactly one re-index when it observes the lock clear (or the sentinel's deletion). This gives `extract()`'s thousands of writes a single coalesced re-index.
- **Constraint:** `FileSystemWatcher` only fires inside open workspace folders → metadata **must** live in the workspace (it does), never in globalStorage.

### 5.5 Large-org performance / credit considerations
- **Index from compact JSON, not the per-field tree.** Power IntelliSense from `field_map.json`/`index.json`/`functions.json`/`modules_raw.json` (a handful of files). Per-field `fields-meta.json` is read **lazily** only for rich hovers/picklists.
- **Concurrency** 1–25 (default 5) via `mapWithConcurrency` + `apiClient`'s process-global semaphore. Setting: `zohoDeluge.pull.concurrency`.
- **(OPEN RISK) Large-org scale is extrapolated from a tiny sample** (125 modules, 73 functions, and `field_map` covering only **73 of 125** modules — verified; several modules map to `[]`). No load test, no memory budget, no eviction strategy for the in-memory field arrays. **Mitigation:** (1) lazy per-field reads keep the hot path small; (2) add a soft cap/telemetry-free warning if `field_map` exceeds e.g. 300 modules or total fields exceed a threshold, deferring field-symbol materialization to first use per module (build `getFieldSymbols(module)` lazily and cache). Real load testing against a large org is a named M7 task.
- **API rate limits:** `apiClient` does 429 backoff (1/2/4/8/16s) and 5xx retry **for reads only**. The expensive credit consumer is **Run** (§7), not pull.
- **Cancellation:** `withProgress` cancel aborts the pull; partial files survive via the stale-sweep guard; `SyncLock` is cleared in `finally`.

---

## 6. Feature-by-Feature Design (all 6 goals)

### 6.1 Data-source priority (authoritative — fixes C1)

Verified against the sample (`functions.json`: 73 total, 51 standalone, **19 standalone with `null` args, 47/73 with non-empty `arguments`**):

- **Function parameters:** **`functions.json` `arguments` is PRIMARY and usually populated.** `arguments: null` means **zero params**. The `.ds` line-1 parser (`delugeSignature.parseSignature`) is a **rare fallback**, used **only** when `arguments === null` **and** the `.ds` signature shows a non-empty parameter list (a divergence not observed in the sample). The parser only handles single-line, strictly `<type> <name>` params and silently drops anything else — so it is a last resort, never the default path.
- **(OPEN RISK)** The `null == zero-args` invariant rests on a **single org snapshot**. **Mitigation:** validate against a second org before relying on it; until then, when `arguments === null`, cheaply check `.ds` line 1 and prefer its params if non-empty.
- **Fields:** **`field_map.json` is authoritative** (`{ Module: { Field_api_name: data_type } }`). Do **not** use `summary.json.lookup_fields`/`formula_fields` (verified over-populated BUG). Note **`field_map` covers only 73/125 modules** in the sample and some modules map to `[]` — see §6 Goal 6 handling.
- **Custom-vs-standard module flag:** **`index.json` has NO `custom` flag** (verified). Use **`modules_raw.json`** for the custom/standard distinction; if absent, omit that documentation detail rather than guessing.

### Goal 1 — In-editor Zoho login UI
**Components:** `src/auth/ZohoAuthProvider.ts`, `LoopbackServer.ts`, `RefreshMutex.ts`, `src/ui/LoginWebview.ts`, `src/ui/StatusBar.ts`. **Flow:** §4.5. **package.json:** `contributes.authentication [{id:'zoho',label:'Zoho CRM'}]`, commands `zohoDeluge.login`/`.logout`, `activationEvents` `onCommand:zohoDeluge.login` + `onUri`.

### Goal 2 — Reuse the CLI's metadata-pull logic
**Component:** `src/metadata/MetadataSync.ts` → core `crmMetadataService.extract`. The extension supplies an **absolute `outputDir`** (C3), `concurrency`, and an `onProgress` adapter; the engine performs all V8 GETs through the shared `apiClient`. **Reuse:** `getNamespaceForCategory` for `.ds` folder mapping. No re-implementation of the pipeline.

### Goal 3 — Run / Pull / Push buttons
**Component:** `src/commands/FunctionOps.ts` + `ConflictGuard.ts`. Buttons in `contributes.menus['editor/title']`, group `navigation`, codicons `$(play)`/`$(cloud-download)`/`$(cloud-upload)`. Full design in §7.

### Goal 4 — Auto-pull on login
Login success → `MetadataSync.full()` (absolute outputDir) → on `COMPLETE`, `MetadataIndex.load()` → IntelliSense lights up. If no folder is open, prompt to open/select one (§10). **Conflict caveat:** auto-pull is gated by §7.5 against dirty local `.ds` files.

### Goal 5 — Standalone-function call IntelliSense (completion + signature help + hover)

**Components:** `MetadataIndex` (data) + refactored `completionProvider.ts`, `signatureHelpProvider.ts`, `hoverProvider.ts`.

**Files consumed:** `STORE_DIR/.store/functions.json` — `functions[]` each `{ api_name, name, return_type, category, arguments: null | [{name,type}], id, state, description }`. Filter `category.toLowerCase()==='standalone'` (51/73 in sample). **Param source per §6.1:** `arguments` primary; `.ds` parser only as the rare `null`-but-nonempty fallback.

**Symbol generation → `DelugeSymbol`** (`{label, detail, documentation, insertText?}` — confirmed shape):
- `label` = `standalone.<api_name>` (lowercase api_name — runtime-resolvable; **insert this**, not the `.ds` PascalCase member).
- `detail` = `${return_type} standalone.${api_name}(${params.map(p=>`${p.type} ${p.name}`).join(', ')})`.
- `documentation` = `Returns ${return_type}` + display `name` + `description||''`.
- `insertText` = `SnippetString` `standalone.${api_name}(${tabstops})$0`; zero-arg → `standalone.${api_name}()$0`.
- **Key by `api_name`** (unique) — two functions can share a display `name`.

**Merge with static catalog:**
- **Completion:** splice the standalone-function `DelugeSymbol[]` as an additional source array into the existing `toItem(sym, kind)` pipeline (zoho-chain + default branches), `CompletionItemKind.Function`. Trigger after `standalone.` (trigger char `.`). Org symbols are additive to `delugeData`.
- **Signature help:** make `BARE_FUNCS` (or a sibling map the resolver also checks) include dynamic standalone symbols keyed by `standalone.<api_name>` **and** `<api_name>`. `activeParameter` = existing comma-count logic. Zero new parsing code.
- **Hover:** overlay dynamic entries into `HOVER_DOCS`.

**Refresh:** all three maps rebuilt from `MetadataIndex.onDidChange` (post-pull / `functions.json` change). Deleted functions are swept on re-pull.

### Goal 6 — Module & field api_name IntelliSense

**Files consumed:**
- **Modules:** `STORE_DIR/.store/index.json` → `modules: [{api_name, singular_label, plural_label}]` (125 modules; **no `custom` flag**). For custom/standard, read **`modules_raw.json`** (§6.1).
- **Fields:** `STORE_DIR/.store/field_map.json` = `{ Module: { Field_api_name: data_type } }` (authoritative; **73/125 module coverage**, some `[]`). Rich hovers/picklists from lazy `crm/meta/modules/<Module>/fields/<Field>.fields-meta.json`.

**Symbol generation:**
- Module `DelugeSymbol`: `label=api_name`, `detail=singular_label/plural_label`, `documentation` notes custom-vs-standard **only if `modules_raw.json` provides it**. `CompletionItemKind.Class`/`Module`.
- Field `DelugeSymbol` (per module): `label=Field_api_name`, `detail=data_type`, `CompletionItemKind.Field`. Stored lazily in `Map<Module, DelugeSymbol[]>`, built on first request per module (§5.5 memory mitigation).

**Module-context detection for field completion (gap fix — concrete design):**
Field completion is module-scoped and **must not** dump all fields into the global list ("field explosion"). The detection pipeline, in priority order:
1. **Explicit member access `<Module>.`** — the token before `.` matches a known module api_name → emit `getFieldSymbols(module)`.
2. **`zoho.crm.*("<Module>", …)` call argument** — parse the module string literal already typed in the current call (the provider already extracts callee/args for signature help; reuse that to read arg 1) → emit fields for that module when the cursor is in a field-name position.
3. **Record-variable binding (best-effort, M7):** track `x = zoho.crm.getRecordById("Module", …)` then `x.` — deferred; not required for M4.
- **(OPEN RISK)** Robust binding-aware detection (case 3) is non-trivial. **Mitigation:** ship M4 with cases 1–2 only; **gate field completion strictly behind those contexts.** Without a detected module, fields are **not** offered. This means per-module field completion **partially ships** in M4 (member-access + call-arg contexts) and is explicitly a deferred sub-goal for richer binding tracking.

**Hover:** overlay field/module entries into `HOVER_DOCS`; field hover shows `data_type` and, lazily, picklist values from `fields-meta.json`.

**Refresh:** `MetadataIndex.onDidChange`.

---

## 7. Run / Pull / Push Design

All three map **1:1 to core `functionService` methods**, bypassing `bin/cli.js` handlers. The service does **no** confirmation/prompting — the extension supplies its own, **plus enforced conflict checks (§7.5) and a no-retry executing client (§7.6)**. Component: `src/commands/FunctionOps.ts` + `ConflictGuard.ts`.

### 7.1 Standalone-only constraint
Gated to standalone (`category==='Standalone'` case-insensitive, or `namespace==='standalone'`) via core `isStandalone()`/`assertStandalone()` (throws `NOT_STANDALONE`).
- `setContext('zohoDeluge.isStandaloneFn', <bool>)` on active-editor change, derived from the `.ds` path (`crm/functions/standalone/`) or parsed signature namespace. **Defaults to `false` when the path/namespace cannot be derived** (plain/untitled/non-tree `.ds` — §10).
- **Run/Push/Create** show only when `resourceLangId == deluge && zohoDeluge.loggedIn && zohoDeluge.isStandaloneFn`.
- **Pull** shows for any logged-in Deluge file that resolves to a live api_name (read-only). Plain/untitled `.ds` with no live counterpart: **all three hidden** (§10).
- Non-standalone tree `.ds` (`automation/`, `button/`, etc.): Run/Push/Create hidden; only Pull offered.

### 7.2 The three operations (verified wire contracts — do not "normalize")
- **Pull** → `functionService.pullOne({ apiName, outputDir })` (absolute outputDir). Read-only: `GET /crm/v8/settings/functions` (list → id) + `GET /crm/v8/settings/functions/{id}/code`, `formatDeluge`, write `crm/functions/<ns>/<ns>.<apiName>.ds`. Never deletes. **Conflict-checked before overwrite (§7.5).**
- **Push** → save editor, then `functionService.pushCode({ file, outputDir })`. Derives `apiName`, `findByApiName` → id, **multipart PUT `/crm/v8/settings/functions/{id}`** with file field `code`, filename `script.ds`, `text/plain`. **No retry** (one-shot, §7.6). On `FN_NOT_FOUND`, offer **Create**. **Divergence-blocked before PUT (§7.5).**
- **Create** → `functionService.createFunction({ apiName, returnType, fromFile, outputDir })`. **POST `/crm/v8/settings/functions`** with `metadata=JSON.stringify({functions:[descriptor]})` as a **query param**, body null. Descriptor hard-codes `category:'Standalone', language:'Deluge', runtime:'Deluge 1.0', source:'crm'`. With `fromFile`, code is pushed after the stub. **No retry (§7.6).**
- **Run** → save editor, `functionService.resolveTarget(filePath)` (reads in-editor script, `parseSignature` → args), then `functionService.executeTest({ resolved, args, outputDir })`. **POST `/crm/v7/settings/functions/{api_name}/actions/test`** (the only v7 endpoint — keep it; **(unverified)** reverse-engineered) body `{functions:[{script, arguments}]}`. **Executes live Deluge. No retry (§7.6).**

### 7.3 What "Run" surfaces (executeTest output + metrics)
`executeTest` returns `{resolved, args, response, fnResult, savedPath, success}` where `fnResult = response.functions[0]`. Render to a dedicated **`OutputChannel`** (and/or results webview) via a **re-authored** renderer (not the CLI's `renderTestResult` — C5), **defensively default-guarded** (shape reverse-engineered):
- `status` → success/failure banner (`success = fnResult.status==='success'`).
- `output` → return value (if object, display `output.value`).
- `logs[]` → `{line_number, category, value}`.
- `network_logs[]` → `{http_method, status_code, time_taken_in_ms, function_name, details:{url|task}}`.
- `metrics` → `{statements_executed, integration_task, send_mail, send_sms, time_taken_in_ms}` (guard each `|| 0`).

**Run history:** `executeTest` always writes `crm/function_tests/<apiName>-<ISOts>.json`. Add `zohoDeluge.cleanupTestArtifacts` (these accumulate unbounded).

### 7.4 Confirmation / safety UX
- **Run:** modal warning. **Copy must not assert unverified figures.** Use: "This **executes live Deluge against your production org** — it can create/update/delete records, send mail/SMS, and call external APIs, and **consumes Zoho function credits**. *(Credit cost and timeout are governed by Zoho and not guaranteed by this extension.)*" → confirm before `executeTest`. Argument collection via `QuickInput`/webview built from `resolved.args` (`[{type,name}]`), coercing with `coerceArg` rules (int/double/bool), passed as a flat `{name:value}` map.
- **Push:** modal warning ("Overwrites the live function's code; no automatic backup beyond the local pre-overwrite snapshot; no retry."). **Pre-push divergence check is mandatory (§7.5).**
- **Pull:** no confirmation (read-only), but **dirty/divergence check before overwrite (§7.5)**.
- **New-function Run** fails with `INVALID_DATA` (function must exist live) → offer **Create-then-Run** or **Push-then-Run**.
- All errors map through the **re-authored** `FN_ERROR_HINTS` (extension copy, no `zcrm` strings — C5): `DS_NOT_FOUND`, `NO_API_NAME`, `FN_NOT_FOUND`, `NAME_INVALID`, `NOT_STANDALONE`, `NAME_MISMATCH`, `EMPTY_CODE`, `CREATE_FAILED`, `PUSH_FAILED`.

### 7.5 Conflict safety (ENFORCED — resolves C4)

There is **no conflict detection anywhere in the reused pipeline.** This is the highest-severity functional gap and is built **in the extension** as a first-class, enforced mechanism — not advisory copy.

**Base-snapshot model.** On every successful Pull (full or `pullOne`), `ConflictGuard` records, per function, a **base snapshot**: `{ apiName, baseHash = sha256(formattedCode), pulledAt }` in `workspaceState` (keyed by org + apiName). This is the known-common-ancestor.

**Before any Push:**
1. Save the editor; compute `localHash = sha256(localCode)`.
2. **Fetch live code** (`GET …/functions/{id}/code`, `formatDeluge`); compute `liveHash`.
3. Decide:
   - `liveHash === baseHash` → live unchanged since pull → **safe**; PUT; update base snapshot to the new pushed code.
   - `liveHash !== baseHash` and `localHash !== baseHash` → **both diverged (true conflict)** → **BLOCK**. Show a diff (live vs local) and require explicit "Overwrite live with my version" or "Discard mine and pull live." No silent overwrite.
   - `liveHash !== baseHash` and `localHash === baseHash` → only live changed → offer **Pull live** instead of pushing stale local.

**Before any overwrite-Pull** (full re-pull or `pullOne` over an existing `.ds`):
1. If the editor/file is **dirty** (`isDirty` or `localHash !== baseHash`) → **prompt** ("Local edits to `<fn>` will be overwritten") with diff; require confirmation.
2. **Always write a pre-overwrite backup** to `.zcrm/.backups/<apiName>-<ISOts>.ds` before overwriting. (Bounded retention via the same cleanup command as test artifacts.)
3. After a successful pull, refresh the base snapshot.

**Auto-pull-on-login** runs the same overwrite-Pull guard: any dirty/diverged local `.ds` triggers a prompt rather than silent clobbering.

**(OPEN RISK)** The live-fetch-before-push adds one extra GET per push and a brief race window between fetch and PUT. **Mitigation:** the window is seconds; acceptable for an interactive single-user action. A server-side `If-Match`/etag would close it but Zoho's function API exposes no etag **(unverified)** — documented as a residual risk, not a blocker.

### 7.6 No auto-retry on executing/mutating paths (resolves C6)

`apiClient` retries 429 (1/2/4/8/16s) and 5xx — **safe for reads, hazardous for executing/mutating calls** because a 429-driven retry of a side-effecting function (create record, send mail) can **execute it multiple times**.

- Introduce **two client paths:** `apiClient` (read-retry, used by `extract`/Pull/whoami) and **`apiClientNoRetry`** for `executeTest` (Run), `pushCode` (Push), and `createFunction` (Create).
- On 429/5xx for an executing/mutating call: **surface the error**, do **not** re-issue. Offer the user a manual "Retry" only after confirming the previous attempt did not partially execute (we cannot guarantee idempotency).
- `putForm`/`postForm` already do not retry and bypass the concurrency gate — keep them on the no-retry path; the concurrency-gate inconsistency is benign for single-user interactive writes.
- **(unverified)** The "1 credit / 10s sync timeout" figures from the original design have **no source in code** (the only code timeout is axios's 30s client timeout). They are removed from user-facing copy (§7.4) and marked unverified here.

---

## 8. Workspace Folder & Data Layout (what the user sees)

```
my-zoho-project/                 ← chosen workspace folder = the "active org" binding (single session)
├── .zcrm/                       ← machine store (gitignore-able); IntelliSense reads .store/
│   ├── .store/                  ← index, field_map, functions, modules_raw, …
│   ├── .org/org.json
│   ├── .backups/<fn>-<ts>.ds    ← pre-overwrite backups (§7.5)
│   └── .logs/
├── crm/
│   ├── meta/modules/<Module>/{summary.json, fields/, layouts/, …}
│   └── functions/
│       ├── standalone/standalone.<name>.ds      ← editable; Run/Pull/Push enabled
│       ├── automation/ button/ schedule/ …      ← Pull-only (read)
│       ├── functions.json
│       └── ../function_tests/<name>-<ts>.json   ← Run history
├── zcrm-project.json  meta.json  README.md
└── .zcrmignore
```

User-facing affordances: **status bar** (`Zoho: <org>`), **editor-title buttons** on `.ds` files, **Accounts menu**, **command palette** (`Zoho CRM IDE: …`), **Output channel** ("Zoho CRM IDE"). Tokens and `client_secret` are **never** on disk (SecretStorage only). Base-snapshot hashes live in `workspaceState`, not in tracked files.

---

## 9. Settings, Secrets, Security

### 9.1 Settings (`contributes.configuration`, `zohoDeluge.*`)
- `zohoDeluge.dc` (enum, default `com`).
- `zohoDeluge.clientId` (string).
- `zohoDeluge.scopes` (string, default = CLI scopes incl. `ZohoCRM.settings.functions.ALL`, `ZohoCRM.modules.ALL`, `ZohoCRM.settings.ALL`).
- `zohoDeluge.pull.concurrency` (number 1–25, default 5).
- `zohoDeluge.testArtifacts.retention` (enum/number — §10.x retention).
- `zohoDeluge.activeFolder` / base snapshots — `workspaceState`, not user-editable JSON.
- Existing `deluge.lint.*` retained.
- **No `zohoDeluge.storeDir` setting** — `STORE_DIR` is a fixed `.zcrm` constant (§3.3).

### 9.2 Secrets (SecretStorage only)
`client_secret`, `access_token`, `refresh_token` (+ `api_domain`/`expiry_time`) → **`context.secrets`** as one JSON bundle. **Never** in `settings.json`, `workspaceState`, or any file. Logout revokes + deletes.

### 9.3 Security requirements
1. **No embedded usable secret** in the `.vsix` — BYO credentials only (§4.1).
2. **`state` + `127.0.0.1` binding + short listener lifetime** are the baseline loopback hardening. **PKCE S256 is optional, not relied upon** (§4.1).
3. **Minimal scopes** at consent; request execute scopes only if/when the public production-execute path is added (out of scope).
4. **Live-write gating** combines `resourceLangId==deluge`, `zohoDeluge.loggedIn`, `zohoDeluge.isStandaloneFn`, **explicit confirmation**, **org-match assertion** (§4.7), and **conflict check** (§7.5) — defense in depth.
5. **No auto-retry on executing/mutating endpoints** (§7.6).
6. Treat `settings/functions` CRUD/test endpoints as **undocumented, version-pinned**, with defensive error handling.

### 9.4 Webview secret-entry threat model (gap fix)
The user pastes `client_secret` into `LoginWebview`. Hardening:
- **Strict CSP** on the webview: `default-src 'none'; script-src 'nonce-<n>'; style-src 'nonce-<n>'`; no remote origins; nonce per render.
- **`localResourceRoots`** restricted to the extension's media dir; `enableScripts: true` only with the nonce gate.
- The secret transits the webview→extension boundary **once** via `postMessage`, is immediately written to `context.secrets`, and is **never echoed back, logged, or stored in webview state**. The webview field is cleared on submit.
- No external network from the webview; the auth URL is opened via `vscode.env.openExternal` from the extension host, not from webview script.

---

## 10. Error Handling, Offline Behavior, Edge Cases

- **No metadata / not logged in:** providers fall back to **static `delugeData` only**. `MetadataIndex` accessors return `[]`. Run/Pull/Push hidden until `loggedIn`.
- **Plain / untitled / non-tree `.ds` (gap fix):** scratch Deluge, Creator scripts, untitled buffers, or any `.ds` outside `crm/functions/`. `isStandaloneFn` **defaults to `false`** when path/namespace can't be derived → **Run/Push/Create hidden**; **Pull hidden** too (no live counterpart). IntelliSense degrades to **static-only** for these. This is the common authoring case and is explicitly handled.
- **Offline / network down:** `apiClient` throws (Zoho also returns soft errors in 200 bodies via `data.status==='error'` — callers handle thrown errors). Pull surfaces a non-blocking "couldn't reach Zoho" toast and keeps last-pulled metadata. IntelliSense keeps working off the on-disk index.
- **Token expiry:** `getAccessToken()` auto-refreshes within the 60s buffer, **single-flight** (§4.3.1). Refresh failure → §4.6 recovery.
- **Whoami failure post-token-exchange (gap fix):** if `users`/`org` calls fail after a successful token exchange (transient or scope-missing), **do not flip to logged-out** (tokens are valid). Set status bar to `Zoho: connected (org unknown)`, keep `loggedIn=true`, and offer "Retry org info." Only a refresh/`invalid_grant` failure clears the session. This removes the ambiguous "tokens saved but flagged logged-out" state.
- **Scope mismatch:** `OAUTH_SCOPE_MISMATCH` fails fast → prompt full re-login with updated scopes.
- **Multi-DC:** DC chosen at login; `api_domain` from token response authoritative thereafter. China → `accounts.zoho.com.cn`.
- **Multi-org / multi-root:** **one org ↔ one workspace folder ↔ one host session** (§4.7), explicit `showWorkspaceFolderPick`, persisted in `workspaceState`. Org-match asserted before every write/execute. True concurrent multi-org is **(OPEN RISK)**, deferred to post-M6.
- **No folder open:** prompt to open/select before auto-pull; defer pull.
- **Loopback `EADDRINUSE` (port 3000 collision is real):** try fallbacks `3737`/`8980`; if all busy, offer the Self-Client/paste-grant fallback.
- **Run on unsaved/new function:** `INVALID_DATA` → Create-then-Run.
- **Push divergence/conflict:** **blocked with diff** (§7.5), never silent.
- **Pull over dirty local:** **prompted with diff + backup** (§7.5).
- **Watcher storms on full pull:** coalesced via `SyncLock` (§5.4).
- **Test-artifact & backup retention:** `crm/function_tests/` and `.zcrm/.backups/` accumulate; `zohoDeluge.cleanupTestArtifacts` + `zohoDeluge.testArtifacts.retention` setting (default: keep latest 20 per function, prune older). Off-by-default vs keep-N is an open decision (§ Open decisions).
- **Multiline/unusual `.ds` signatures:** prefer `functions.json.arguments`; `.ds` parser is fallback (§6.1); treat array order as call order **(unverified vs Zoho docs)**.

---

## 11. Phased Implementation Roadmap (re-ordered per review)

The review's core ordering correction: **the features that touch tokens and production writes must not run on un-refactored singleton/import-bridge code.** Auth-instancing, the bundle gate, and conflict safety are pulled forward.

- **M1 — Foundation: auth-instancing + storage/log seams + bundle gate.**
  - Convert `authService` to a **class/factory** (not singleton) — C2 prerequisite.
  - `StoragePort` (SecretStorage) + `LogPort`/logger-monkeypatch shim; always pass **absolute `outputDir`** — C3.
  - **`esbuild --metafile` gate** on the (b) bridge — C5. If express/inquirer/archiver leak and can't be tree-shaken, **promote M6 ahead of M3.**
  - **Delivers:** a tested adapter proving the services run in the host with one-instance-per-connection auth, no `process.cwd()` scatter, no console/inquirer/exit leakage, and a measured bundle.
- **M2 — Login (Goal 1).** `ZohoAuthProvider` + `LoopbackServer` + `RefreshMutex` + `LoginWebview` (hardened CSP) + status bar + whoami (with ambiguous-state recovery) + logout/revoke + single-session lock (§4.7). **Delivers:** sign in/out; `zohoDeluge.loggedIn` drives future UI.
- **M3 — Metadata pull (Goals 2 & 4).** `MetadataSync` + `SyncLock` over `extract` (absolute outputDir); auto-pull on login + manual re-pull; progress UI; folder selection/binding. **Delivers:** org metadata in the workspace.
- **M4 — Dynamic IntelliSense (Goals 5 & 6).** `MetadataIndex` + `SyncLock`-gated watcher; provider factories merging static + dynamic. Standalone-function completion/signature/hover (param source per §6.1). Module completion + **field completion gated behind member-access/call-arg context detection** (cases 1–2; case 3 deferred). **Delivers:** org-aware IntelliSense.
- **M4.5 — Conflict safety (resolves C4).** `ConflictGuard`: base-snapshot hashing on pull; pre-push divergence block with diff; pre-overwrite dirty/hash check + mandatory backup; auto-pull guard. **Delivers:** no silent lost-update of production code. **Ships before any write feature.**
- **M5 — Run/Pull/Push buttons (Goal 3).** `FunctionOps` + editor-title buttons + standalone/org-match gating + `apiClientNoRetry` for executing/mutating paths (§7.6) + confirmation UX (no unverified figures) + argument UI + re-authored Run renderer + re-authored `FN_ERROR_HINTS` + Create-on-missing + test-artifact cleanup. **Depends on M4.5.** **Delivers:** in-editor execute/sync of standalone functions, conflict-safe.
- **M6 — Core extraction (`@wanas/zcrm-core`).** Refactor CLI to packages; publish core; both consumers depend on it; remove the M1 bridge; esbuild `external:['vscode']`. **Delivers:** clean versioned shared core; unblocks true multi-org (per-connection clients).
- **M7 — Hardening & polish.** PKCE (only if Zoho confirms), Remote/web `UriHandler` redirect, Self-Client/paste-refresh fallbacks, record-variable field detection (case 3), picklist hovers from `fields-meta.json`, **large-org load test + memory budget/eviction**, retention/limits UX, multi-org concurrency. **Delivers:** production readiness.

---

## 12. Residual open risks (carried, with mitigations)

| Risk | Severity | Mitigation / status |
|---|---|---|
| `null == zero-args` invariant from one org snapshot | Med | Validate against a 2nd org; meanwhile cross-check `.ds` line 1 when `null` (§6.1). |
| True concurrent multi-org (two windows, two orgs) | Med | Single-session lock + org-match assertion (§4.7); full support deferred to post-M6. |
| Live-fetch-before-push race window (no etag) | Low | Seconds-long window, single-user interactive; documented (§7.5). |
| Large-org scale unmeasured | Med | Lazy per-module field materialization + soft caps; load test in M7 (§5.5). |
| Reverse-engineered v7 test endpoint / credit-timeout figures | Med | Marked **(unverified)**; defensive guards; no unverified copy in UI (§7.2–7.4). |
| Zoho rejects `code_challenge` for confidential client | Low | PKCE optional; baseline = state + loopback hardening (§4.1). |
| (b)-bridge drags CLI deps into VSIX | Med | **Hard gate** in M1; if it fails, M6 precedes M3 (§3.5). |

---

## Open decisions for you

1. **Auth model commitment.** *Recommended default:* ship **BYO Server-based credentials** (no embedded secret). Optionally allow the CLI's shared default app for **internal/personal builds only, never published**.
2. **Reuse trajectory & CLI refactor.** *Recommended default:* **(b)-bridge → (a)-core**, and **yes, refactor the CLI into `@wanas/zcrm-core`** at M6. If you won't refactor the CLI, we stay on the more fragile direct-`src/` import and accept drift.
3. **Roadmap ordering acceptance.** *Recommended default:* accept the re-ordered roadmap where **auth-instancing, bundle gate, and conflict safety (M4.5) precede Run/Push (M5)**. (The review's strongest recommendation.)
4. **Conflict-safety strictness.** *Recommended default:* **hard-block push on true divergence** (both sides changed) with a diff and explicit override; always write a pre-overwrite backup. Softer "warn-only" is available but not recommended.
5. **Run safety posture.** *Recommended default:* **single modal confirmation per Run**, plus org-match assertion and no auto-retry. A per-session "I understand this hits production" gate is available if you want it stricter; a dry-run-only default is **not** offered (the only log-returning endpoint executes live).
6. **Field-completion aggressiveness.** *Recommended default:* **gate field completion behind member-access + call-arg context (cases 1–2)** in M4; defer record-variable tracking (case 3) to M7. Accepts fewer completions initially in exchange for no field explosion.
7. **Multi-org / multi-root UX.** *Recommended default:* **one org ↔ one workspace folder ↔ one host session** with explicit folder pick; defer concurrent multi-org to post-M6.
8. **Non-standalone & plain `.ds`.** *Recommended default:* **Pull-only for non-standalone tree functions; all buttons hidden for plain/untitled/non-tree `.ds`** (IntelliSense static-only). Read/diff tooling for automation/button/etc. is a possible follow-up.
9. **Store directory.** *Recommended default:* **keep `.zcrm`, single constant, no `.zdk` rename** (would require a CLI fork).
10. **Test-artifact & backup retention.** *Recommended default:* **keep latest 20 per function**, prune older, via `zohoDeluge.cleanupTestArtifacts` + a retention setting. Alternatives: age-based prune, or off-by-default.

---

## Recommended first milestone (M1)

**Goal:** prove the CLI services can run safely inside the extension host — with per-connection auth, no `process.cwd()` file scatter, no console/inquirer/exit leakage, and a measured bundle — **before** any user-facing feature is built on top. This is the foundation every token-touching feature depends on, and it directly retires critical issues C2, C3, and C5.

**Why this slice:** it is the smallest piece that de-risks the entire rebuild. It ships no UI, but without it M2–M5 would be built on unsafe singleton/uncontrolled-cwd/unmeasured-bundle ground (the review's central warning).

**Concrete tasks:**
1. **Auth-instancing (C2).** In the CLI repo (or a thin imported fork), convert `authService` from `module.exports = new AuthService()` to **exporting the `AuthService` class/factory**. Add a smoke test constructing two independent instances with distinct token bundles and asserting no shared mutable state.
2. **`StoragePort` → SecretStorage.** Implement `SecretStorageStore` (tokens + `client_secret` JSON bundle) and `WorkspaceConfigStore` (dc, client_id, scopes, concurrency). Inject into `AuthService` **before any auth call**; verify `saveTokens`/`loadTokens` round-trip through `context.secrets`.
3. **`LogPort` / logger shim (C3).** Either inject a `LogPort` or monkeypatch the CLI logger module at activation so output goes to an `OutputChannel` and **nothing is written to `process.cwd()/storage/logs`**. Assert no files appear outside the workspace after a dummy operation.
4. **Absolute `outputDir` (C3).** Wire `MetadataSync` to always pass the chosen workspace folder as an **absolute** `outputDir` to `extract`/`pullOne`/`pushCode`/`createFunction`/`executeTest`. Add a test that runs a no-network code path and asserts no `.zcrm` is created under `process.cwd()`.
5. **`RefreshMutex` (gap fix).** Add single-flight refresh to `getAccessToken()`; test that N concurrent expired-token calls trigger exactly one `refreshAccessToken`.
6. **Bundle gate (C5).** Run `esbuild --metafile` against the (b) bridge; inspect the metafile for `express`, `inquirer`, `commander`, `archiver`, `dotenv`. **Decision artifact:** a short note recording the measured bundle and a go/no-go on the (b) bridge. If they leak and can't be tree-shaken, record that **M6 (core split) must precede M3**.
7. **No-side-effect verification.** Confirm the reused service modules contain no top-level `process.exit`, `inquirer` prompt, or `console.*` on the import path used by the extension; list any that do for taming.

**Definition of done:** an automated test (or scripted manual run) loads the bridged services in an extension-host context, performs a token save/load and a no-network `resolveTarget`/`parseSignature` call, and verifies: (a) two `AuthService` instances don't clobber each other; (b) refresh is single-flight; (c) no files are written outside the chosen workspace folder; (d) no stdout/inquirer/exit side effects fire; (e) a recorded bundle-metafile go/no-go decision exists. No login UI, no pull, no buttons — just a proven, safe foundation.

**Key file references (absolute paths):**
- Extension entry: `D:/Projects/Zoho Deluge Extention/src/extension.ts`
- Providers to refactor: `D:/Projects/Zoho Deluge Extention/src/providers/{completionProvider,signatureHelpProvider,hoverProvider,diagnosticsProvider}.ts`
- Canonical symbol type: `D:/Projects/Zoho Deluge Extention/src/data/delugeData.ts` (`DelugeSymbol {label, detail, documentation, insertText?}`)
- Reuse targets (CLI): `D:/Projects/Zoho CRM V8 Metadata Extractor/src/services/{functionService.js, metadata/crmMetadataService.js, authService.js}`, `src/utils/{apiClient,delugeSignature,delugeFormatter,configStore,concurrency}.js`, `bin/cli.js` (`runOAuthServer`, `FN_ERROR_HINTS`, `renderTestResult` — **re-author, do not import**)
- Metadata contract samples (verified this session): `D:/Projects/Zoho CRM V8 Metadata Extractor/test_metadata/.zcrm/.store/{index,field_map,functions,modules_raw}.json` (73 functions / 51 standalone / 19 null-args / 47 non-empty-args; 125 modules with no `custom` flag; `field_map` covering 73/125 modules), `crm/functions/standalone/*.ds`

---

## Appendix A — Adversarial Review (principal-engineer pass)

**Overall assessment:** This is an unusually thorough, well-structured design that gets the big calls right: BYO-credentials (no embedded secret), static-catalog-as-floor with dynamic overlay, standalone-only write gating, reading compact .store JSON rather than walking the per-field tree, and a phased roadmap. The author also correctly flagged several real risks (field explosion, watcher storms, port 3000 collision, undocumented endpoints). However, the document systematically UNDERSTATES how CLI-shaped the reuse target actually is, and several "confirmed/verified" claims do not survive inspection of the source. The single biggest structural risk is that the entire reuse strategy depends on `authService` and `configStore` being process-global singletons with mutable in-memory token state and pervasive `ZCRM_CLI_MODE`/`process.cwd()`/`console` coupling — none of which the proposed StoragePort/LogPort seams actually remove without the M6 fork, yet M1-M5 ship features on top of that un-refactored code. The sync-conflict story is the weakest functional area: there is genuinely NO conflict detection anywhere in the pipeline, and the design's mitigations are advisory ("recommended pre-push diff") rather than enforced. Verdict: architecturally sound direction, but the milestone ordering hides serious foundational coupling risk behind early feature delivery, and at least four load-bearing factual claims are wrong or overstated. Do not approve M1-M5 on the import-bridge (option b) without first proving the singleton token state can be made per-window safe.

### Critical issues

1. **Issue** — {"issue":"FALSE CLAIM: 'arguments: null consistently means zero params, fallback rarely exercised.' The sample functions.json has 47 of 73 functions (and 32 of 51 standalone) with NON-EMPTY arguments arrays. The null-args claim only holds for the 19 standalone functions that have null arguments AND I verified all 19 genuinely have empty () in their .ds. The design's phrasing implies arguments is usually null and the .ds fallback is the safety net; in reality functions.json.arguments is the PRIMARY and populated source for the majority of functions, and the .ds-line-1 parser is the rarely-used fallback. This inverts the data-source priority the providers should implement.","impact":"If Goal-5 signature help is built assuming arguments is usually null and leaning on the parser, it will be both slower and less correct (the parser only handles single-line, strictly `<type> <name>` params and silently drops anything else). Argument prompts for Run could be built from the wrong source.","fix":"Restate: functions.json.arguments is the authoritative, usually-populated param source; treat null as zero-args; use the .ds parser ONLY when arguments is null AND the .ds signature shows a non-empty parameter list (a rare divergence). Verify the null==zero-args invariant against a SECOND org before relying on it — one snapshot is not a contract."}
2. **Issue** — {"issue":"Process-global singleton token state defeats the multi-org goal and is unsafe in a long-lived host. `authService` is `module.exports = new AuthService()` with a single mutable `this.tokens`; `configStore` is likewise a singleton bound to ~/.zcrm. The design asserts 'AuthenticationProvider can support multiple accounts' and 'one org per workspace folder', but a single imported authService instance can hold exactly ONE token set at a time. Two workspace folders bound to two orgs, or two VS Code windows, will clobber each other's in-memory tokens and api_domain.","impact":"Multi-org (a stated edge case) and even two simultaneous windows are broken with the option-(b) import bridge. A Push/Run in window B could execute against window A's org after a token swap — a production-safety hazard, not just a correctness bug.","fix":"The seam must instantiate authService PER connection/window, not import the singleton. This requires the core to export a CLASS/factory, not a pre-constructed instance — a refactor the design defers to M6 but which M2-M5 actually depend on. Either pull M6's auth-instancing forward, or scope the extension to strictly one org per host until then and say so."}
3. **Issue** — {"issue":"extract() hardcodes `.zcrm` and writes to process.cwd()-derived defaults; the StoragePort/LogPort/STORE_DIR abstractions are largely fictional against today's code. Verified: crmMetadataService uses STORAGE_DIR = path.join(process.cwd(),'storage/metadata') as default outputDir, hardcodes `.zcrm/.store`, `.zcrm/.org`, `.zcrm/.logs`, and writes `.zcrmignore` containing `.zcrm/`. The logger writes to process.cwd()/storage/logs/errors.log and calls console.error/console.log directly, imported by every module (not injected). authService reads/writes via ZCRM_CLI_MODE branches and a TOKENS_PATH under process.cwd().","impact":"In the extension host, process.cwd() is unpredictable (often the VS Code install dir or /), so an un-refactored extract() could scatter files outside the workspace, and logger output goes to the debug console, not an OutputChannel. The design presents StoragePort/LogPort as 'seams to introduce' but M1 ships features on top of code that still has none of them. The `.zdk` forward-compat and read-both story is unworkable until the CLI is forked, because extract() always writes `.zcrm`.","fix":"Be explicit that M1's 'import bridge' requires either (a) passing an absolute outputDir on every extract() call AND monkeypatching the logger, or (b) doing the LogPort/StoragePort extraction FIRST. Do not claim STORE_DIR abstraction works on read+write until extract() is parameterized. Drop the `.zdk` rename from scope unless the CLI is being forked in the same effort."}
4. **Issue** — {"issue":"No sync-conflict detection exists, and the design's mitigations are advisory only. pullOne/materializeDs unconditionally fs.outputFile (overwrite) the .ds; pushCode unconditionally PUTs local code with NO base-version check and NO retry; a full re-pull rewrites every .ds and runs a stale-sweep. There is no etag/modified_time/hash comparison anywhere. The design says 'warn before overwriting a dirty local .ds' and 'recommended pre-push pull/diff' but never specifies an enforced mechanism.","impact":"Classic lost-update: User A edits locally, User B edits in the Zoho web editor, User A pushes -> B's change silently overwritten with no backup (design itself notes 'no automatic backup'). Conversely an auto-pull-on-login or manual re-pull silently overwrites the user's unsaved/uncommitted local .ds edits. This is the highest-severity functional gap because it destroys user/production code with no recovery path.","fix":"Make conflict handling a first-class, ENFORCED feature, not a 'recommended' toast: (1) before push, fetch live code and 3-way/2-way diff against a stored base snapshot; block or require explicit override on divergence; (2) before any pull that would overwrite, check VS Code dirty state AND compare hash to the last-pulled snapshot, prompting on conflict; (3) keep a pre-overwrite backup of the .ds. Store a per-function base hash at pull time to detect drift. None of this exists in the reused service and must be built in the extension."}
5. **Issue** — {"issue":"Bundling/packaging risk is understated and partly mischaracterized. Option (b) imports from `wanas-zcrm-extractor` whose package.json `main` is server.js and which depends on express, inquirer, commander, archiver, dotenv. The design claims esbuild with external:['vscode'] suffices and 'core deps (axios, fs-extra) are pure-JS and bundle cleanly' — but until the M6 core split, importing src/services/* transitively pulls the CLI's module graph. archiver has optional native/zlib-adjacent deps and a large transitive tree; inquirer/commander/express are dead weight in the VSIX. The whoami/login also depend on bin/cli.js helpers (runOAuthServer, FN_ERROR_HINTS, renderTestResult) that live in the CLI entrypoint, not in reusable services.","impact":"Risk of a bloated or broken VSIX, slow activation, and accidental inclusion of express/inquirer in the extension host. The reuse of bin/cli.js helpers (FN_ERROR_HINTS, renderTestResult) is not 'service reuse' — those are CLI-coupled: FN_ERROR_HINTS messages literally say 'create it first with `zcrm fn create`' and reference '.ds' CLI flows, which would leak CLI command strings into extension UI.","fix":"Acknowledge that anything from bin/cli.js must be re-authored for the extension, not imported (CLI command strings, terminal rendering). Verify the actual transitive bundle with esbuild --metafile BEFORE committing to option (b); if archiver/express leak in, the import bridge is not viable and M6 must precede M3+. Rewrite FN_ERROR_HINTS for extension context (commands, not zcrm CLI invocations)."}
6. **Issue** — {"issue":"Run credit/rate-limit and timeout claims rest on an unverified internal v7 endpoint with weak guarantees. executeTest POSTs to /crm/v7/settings/functions/{name}/actions/test (the ONLY v7 path, design admits it's reverse-engineered) and goes through apiClient.post which inherits the 429 backoff AND the 401-refresh-retry. The design's '1 credit / 10s sync timeout' figures are stated as fact but I find no source for them in the code (the only timeout in code is axios's 30s client timeout). Push goes through putForm which explicitly does NOT retry and does NOT enforce concurrency slot.","impact":"The '1 credit, 10s timeout' safety-UX copy may be wrong, misleading users about cost/risk of executing live production Deluge. A 429-retry on a code-EXECUTING test endpoint means a function with side effects (create record, send mail) could be retried and run MULTIPLE times on transient 429 — a duplicate-execution hazard the design's loud-writes principle does not cover. putForm bypassing the concurrency gate is a minor inconsistency.","fix":"Cite a real source for credit cost and timeout, or label them (unverified) like other honest gaps. Critically: disable automatic retry for the test/execute path (executeTest) and any side-effecting write — a 429 on Run must surface, not silently re-execute. Confirm idempotency assumptions before allowing any retry on /actions/test."}

### Gaps

- Token revocation/refresh-cap handling is thin. Zoho caps refresh tokens per user (the design even cites a '20-refresh-token cap' as a reason to avoid option c) but provides no plan for detecting/handling a server-side revoked refresh token beyond 'prompt re-login'. No mention of the access-token-per-minute (~10/min historically) refresh throttle that can lock out a too-eager getAccessToken().
- The single-getAccessToken() concurrency claim is unproven against the singleton. Multiple simultaneous calls hitting an expired token will each call refreshAccessToken() (no in-flight de-dup/mutex in authService), producing concurrent refreshes — wasteful and can trip Zoho's refresh throttle. The design asserts centralized refresh but the code has no refresh lock.
- Non-standalone .ds handling is underspecified for the COMMON case. The user's prompt highlights 'ordinary non-standalone Deluge files'. Many real Deluge files users author are NOT pulled-from-org standalone functions at all (workflow snippets, scratch buffers, Creator scripts, untitled buffers). For these there is no api_name, no namespace folder, no live counterpart — yet the DELUGE_SELECTOR matches them. The design only addresses non-standalone files that live under crm/functions/automation etc.; it does not address a plain my_script.ds outside the metadata tree, where isStandaloneFn context derivation (path-based) silently fails and buttons' visibility is undefined.
- Module-context detection for field completion is hand-waved. Goal 6 says 'detect the active module from context' and gates field completion behind it 'until robust module detection lands' — but provides no design for that detection. Without it, the headline feature (per-module field completion) effectively does not ship in M4. This should be called out as a likely-deferred sub-goal, not implied as delivered.
- Large-org performance numbers are based on a tiny sample (125 modules, 1299 fields, 73 functions). The design extrapolates to 'thousands of fields-meta.json files' but never load-tests. field_map covered only 73 of 125 modules in the sample. No memory budget for holding all module field arrays in the MetadataIndex, no eviction strategy, no measured pull time. The watcher-storm mitigation (pause during extract) is described but extract() emits no 'in progress' lock the watcher can observe — needs a concrete coordination mechanism.
- index.json modules entries do NOT include a `custom` flag in the sample ({api_name, singular_label, plural_label} only), contradicting the design's stated module DelugeSymbol fields ('documentation notes custom vs standard'). Either a different file (modules_raw.json) is needed for custom-vs-standard, or that documentation detail can't be populated.
- Offline/error UX gap: apiClient treats Zoho's 200-with-status:error bodies by THROWING, and login confirmation does two extra calls (users + org). If those whoami calls fail post-token-exchange (scope missing, transient), the user is left in an ambiguous state — logged in (tokens saved) but flagged logged-out. No defined recovery.
- PKCE feasibility is (unverified) by the author's own admission AND likely moot: for a confidential client Zoho's value from PKCE is marginal, and the design correctly hedges, but it still lists PKCE in security requirements (9.3) as if planned. The security posture should not depend on an unverified control.
- No threat model for the loopback secret-entry step: the user pastes client_secret into a webview; the design stores it in SecretStorage (good) but does not address webview CSP, message-passing trust, or the secret transiting the webview->extension boundary.

### Recommendations

- Re-order the roadmap: do the auth-instancing and Storage/Log port extraction (currently M6) BEFORE shipping Run/Push (M5) and ideally before pull (M3). The features that touch tokens and production writes are exactly the ones that must not run on the singleton/import-bridge. The current ordering ships the riskiest features on the least-refactored foundation.
- Promote sync-conflict handling to a named, enforced milestone with a concrete mechanism: store a per-function base snapshot (hash + code) at pull time; block push on divergence unless explicitly overridden; check editor dirty-state and snapshot hash before any overwrite-pull; always write a pre-overwrite backup. Treat 'recommended diff' language as insufficient.
- Disable automatic retry on any code-EXECUTING or mutating path (executeTest/Run, and confirm push). A 429-driven retry of a side-effecting function is a duplicate-execution hazard. Route reads through the retrying client and writes/executes through a no-retry path with surfaced errors.
- Correct the data-source priority for Goal 5: functions.json.arguments is primary and usually populated (verified 47/73 non-empty); the .ds line-1 parser is the rare fallback. Validate the 'null==zero args' invariant against at least one more org before depending on it.
- Drop or explicitly defer the `.zdk`/STORE_DIR rename and the `custom`-flag module documentation until verified — extract() hardcodes `.zcrm` and index.json lacks `custom`. Keeping these in scope as 'confirmed' is misleading.
- Run a real esbuild --metafile against the option-(b) import to measure what the CLI module graph actually drags in (express, inquirer, commander, archiver, dotenv). If they leak, the import bridge is non-viable and the core split must come first. Re-author FN_ERROR_HINTS and renderTestResult for the extension — do not import CLI-coupled, command-string-laden helpers.
- Add a refresh mutex / in-flight de-dup to getAccessToken() before relying on the 'one token accessor, centralized refresh' principle; the current singleton has none and will issue concurrent refreshes.
- Define behavior for plain/untitled/non-tree .ds files (scratch Deluge, Creator scripts): these have no live counterpart and must have Run/Push/Pull HIDDEN and IntelliSense degrade to static-only, with the standalone context defaulting to false when path/namespace can't be derived.
- Stop labeling reverse-engineered figures ('1 credit', '10s timeout', v7 endpoint behavior) as fact. Mark them (unverified) consistently with the rest of the document's honest hedging, and cite Zoho docs where a real limit exists.
- Add an explicit refresh-token-revoked and refresh-throttle recovery flow (detect invalid_grant/invalid_code, clear session, surface a single actionable re-login), and consider the per-minute refresh cap in the auto-pull-on-login burst of calls.

---

## Appendix B — Implementation status (live)

**Decisions locked with the user (2026-06-09):**
- Auth model: **BYO credentials, project-scoped** (one folder ↔ one org ↔ one connection; secrets folder-keyed in SecretStorage, non-secrets in workspace settings).
- Code reuse: **(b) import bridge now → (a) `@wanas/zcrm-core` later (M6).**
- Start: **M1 foundation first.**
- Conflict safety: **hard-block Push on true divergence + mandatory pre-overwrite backup.**
- Lower-stakes decisions: recommended defaults accepted (field completion gated to member-access/call-arg context; one org per folder; keep `.zcrm`; hide buttons on plain/untitled `.ds`; keep latest-20 test artifacts).

**M1 progress:**
**M1 is COMPLETE and verified.** Foundation proven: the CLI services run in the extension host with project-scoped per-host auth, controlled storage/logging, a measured bundle, and no `process.cwd()` scatter.

- ✅ **Bundle gate (C5) — GREEN (real `esbuild --metafile`).** Bundling `src/extension.ts` (which imports the CLI `authService` via the `file:` dep) → **131 inputs, ~680 KB, zero heavy-dep leakage** (no express/inquirer/commander/archiver/dotenv/chalk/ora). The bridge is viable; the build asserts this on every run (`esbuild.js` exits non-zero if a heavy dep ever leaks).
- ✅ **CLI `authService` refactor (C2 + mutex).** Backward-compatible: `configure({credentials,store,logger,http})` + async `hydrate()`, per-getter credential delegation (truthy-fallthrough so unset scopes use the CLI default), injected token store / logger / http, **single-flight refresh mutex** in `refreshAccessToken()`, `AuthService` class exported alongside the singleton.
- ✅ **Extension bridge scaffold.** `file:` dep on the CLI; esbuild build (`external:['vscode']`, ships `dist/extension.js`, `out/` kept only for tests); ambient types (`src/zoho/zcrm-core.d.ts`); ports/adapters — `SecretStorageStore` (folder-keyed, caches `client_secret` for sync reads), `WorkspaceConfigStore` (resource-scoped `zohoDeluge.*`), `OutputChannelLog`, `CredentialProvider`, `connectionKey` (sha256 of folder path); `initZohoConnection()` configures the shared singleton + hydrates at activation (non-blocking) and exposes `outputDir` (absolute bound-folder path) for M3/M5.
- ✅ **`zohoDeluge.*` settings** (`clientId`, `dc`, `scopes`, `concurrency`) declared `resource`-scoped → settable per-folder.
- ✅ **Verification:** extension **44/44** (22 original + 22 new `test/zoho-foundation.test.js`: SecretStorage round-trip/folder-keying/secret-cache, config defaults/overrides, credential wiring, end-to-end bridge single-flight refresh persisting to the keychain, no-cwd-scatter) + CLI **112/112** (98 + 14). `tsc` and esbuild both clean.

**M2 (Login UI) — COMPLETE & verified.** Native sign-in/out wired end-to-end (interactive paths need a real org in an Extension Dev Host; all testable logic is covered).
- `src/zoho/oauth.ts` — re-authored loopback: `generateState`/`validateState` (timing-safe), `firstFreePort` over [3000,3737,8980] bound to 127.0.0.1, `createLoopbackServer({expectedState})` → `{port, redirectUri, waitForCode(timeout), dispose}`, styled success/error pages with `Connection: close`. Pure Node, integration-tested over real HTTP.
- `src/zoho/loginWebview.ts` — hardened-CSP (nonce, `default-src 'none'`) webview collecting DC + client_id + client_secret with inline app-registration steps (lists all three redirect URIs to register); secret only transits postMessage → `SecretStorageStore.setClientSecret`.
- `src/zoho/whoami.ts` — re-authored `fetchWhoAmI` (GET /crm/v8/users?type=CurrentUser + /crm/v8/org) + pure `parseWhoAmI`. `src/zoho/sessionLock.ts` — `SessionLock` over workspaceState (one active `{org,orgId,apiDomain,dc,email,folder}`).
- `src/zoho/zohoAuthProvider.ts` — `vscode.AuthenticationProvider` (id `zoho`): `getSessions`/`createSession`/`removeSession` + `signIn`/`signOut`; orchestrates webview→loopback→`handleCallback`→whoami→lock→`setContext('zohoDeluge.loggedIn')`→status bar; switch-org prompt (single-session lock); **ambiguous-state recovery** (tokens saved but whoami failed → keep session, warn); **refresh-failure recovery** (revoked token → clear + re-login prompt). Logout = `revokeRefreshToken()` + `clearTokens()` (keeps BYO app creds for easy re-login).
- `src/zoho/statusBar.ts`, `src/zoho/activate.ts` (provider+commands+status registration), `connection.ts` (mutable `setRedirectUri`, `secretKey`), `configStore.ts` (`setClientId`/`setDc` writing to the folder's settings), `secretStore.ts` (`clearTokens`/`invalidate`). CLI `authService.js` gained `revokeRefreshToken()`.
- `package.json` — `contributes.authentication` (`zoho`), `commands` (login/logout/showAccount/showOutput), `activationEvents` += `onStartupFinished`.
- **Verified:** extension 62/62 (added `test/zoho-login.test.js` — 18: state, free-port, loopback over real HTTP incl. CSRF/error rejects, whoami parse, session lock), CLI 115/115 (+3 revoke). Bundle gate GREEN (708 KB, no leak). tsc clean.

**M3 (Metadata pull, Goals 2 & 4) — COMPLETE & verified.**
- `src/zoho/syncLock.ts` — pure mutex (`runExclusive`, `isLocked`, `onChange`) so the M4 watcher can pause during a pull; rejects overlapping pulls, releases on success/failure.
- `src/zoho/metadataSync.ts` — `MetadataSync.pull()` guards (auth + open folder), then runs the bridged `crmMetadataService.extract(onProgress, ABSOLUTE connection.outputDir, {concurrency, withCounts})` under the lock; maps the engine's staged callbacks (`MODULE_PROGRESS`/`FUNCTION_PROGRESS` `{completed,total}`) to a `PullProgress` stream; returns `{stats, outputDir, errorCount}`. Extractor injectable for tests. **C3 fix made real for the pull path** — the absolute outputDir is always passed, never the CLI's `process.cwd()` default. Ambient types added for `crmMetadataService`.
- `src/zoho/activate.ts` — `zohoDeluge.pullMetadata` command runs the pull inside `vscode.window.withProgress` (live per-module/function message) + status-bar working state; **auto-pull after sign-in** via the new `ZohoAuthProvider` `onSignedIn` hook (gated by `zohoDeluge.autoPullOnSignIn`); "Pull metadata" added to the account quick-pick.
- Settings: `zohoDeluge.autoPullOnSignIn` (default true), `zohoDeluge.pullRecordCounts` (default false → `withCounts`; counts cost ~50 credits/module). Command declared in `package.json`.
- Output → `<folder>/.zcrm/.store/{index,field_map,functions,…}.json` + `crm/functions/**/*.ds` + `crm/meta/**` (§5.2 contract), ready for M4.
- **Verified:** extension 84/84 (added `test/zoho-sync.test.js` — 22). Bundle gate GREEN (767 KB, no leak). tsc clean. (Live-org pull needs an Extension Dev Host.)

**M4 (Dynamic IntelliSense, Goals 5 & 6) — COMPLETE & verified.**
- `src/zoho/metadataIndex.ts` — `MetadataIndex implements DynamicSymbolSource`. `load(folder)` reads `.zcrm/.store/{functions.json,index.json,field_map.json}` (tolerant of missing files): standalone DelugeSymbols (`category==='standalone'`, label `standalone.<api>`, params from `arguments[]` PRIMARY, `.ds` line-1 `parseSignature` fallback only when `arguments===null`), module symbols (`index.json.modules`), lazy per-module field symbols (`field_map.json`), hover map. Pure Node (fs) → unit-tested against the real `test_metadata` sample.
- `src/data/dynamicSource.ts` — `DynamicSymbolSource` interface + `EMPTY_DYNAMIC_SOURCE` (the providers' default → static-only when no org data).
- `src/providers/orgContext.ts` — pure `analyzeOrgContext(linePrefix, source)`: `standalone.<partial>` → standalone fns; `<Module>.<partial>` (known module) → fields; `zoho.crm.X("<partial>` (1st arg) → module names; later string arg with known-module arg 1 → fields. Unit-tested (incl. "does not hijack normal member access").
- Providers extended (additive, optional `DynamicSymbolSource`, default empty): **completion** (range-replacing org branches), **signature help** (`resolveSymbol ?? source.getStandaloneSignature`), **hover** (`standalone.<api>` + module token). `src/extension.ts` creates one `MetadataIndex`, passes it to all three providers + `activateZoho`.
- `src/zoho/activate.ts` — loads the index from `connection.outputDir` at startup; re-loads after a pull (`SyncLock.onChange` unlock) and on `.zcrm/.store/*.json` changes via a `FileSystemWatcher` (skipped while the lock is held; loads serialized). Static catalog stays the floor; org data is purely additive (offline still works).
- **Verified:** extension 114/114 (added `test/zoho-index.test.js` — 30: real-sample load asserts 51 standalone / `ataya(string crmAPIRequest)` from `arguments` / `testing` null→zero-params / 125 modules / `isModule` / Leads fields + Cases empty / hover; empty-folder tolerance; full context-analyzer matrix). Bundle gate GREEN (780 KB, no leak). tsc clean. (Live org-aware completion needs an Extension Dev Host.)

**M4.5 + M5 + M7-doable — COMPLETE & verified** (executed from `docs/REMAINING-ROADMAP-PLAN.md`, the multi-agent synthesized plan). Renamed to **Zoho CRM IDE Extension** (v0.3.0); the `deluge` language id + internal `zohoDeluge.*` command/setting namespace are unchanged.

- **M4.5 ConflictGuard (C4 resolved):** CLI `functionService.getRemoteCode` (read-only live fetch, no write). Ext `conflictGuard.ts` (pure: hash + `decidePush` SAFE/CONFLICT/LIVE_AHEAD/NO_BASE + `decideOverwritePull` + path helpers), `snapshotStore.ts` (org-scoped base hashes in `workspaceState`), `remoteCode.ts`, `conflictGuard.vscode.ts` (push divergence block + live diff + mandatory pre-overwrite backup under `.zcrm/.backups`). Base snapshots recorded on every pull; cleared on sign-out.
- **M5 Run/Pull/Push:** CLI `apiClient.postNoRetry` (parameterized `request(retry)`) + `executeTest`/`createStub` routed through it (no double-execution); `(postNoRetry||post)` fallback keeps the CLI suite green (test aliases `postNoRetry`→`post`). Ext `functionOps.ts` (pure: standalone-path detection, name/arg derivation, `coerceArg`, `assertOrgMatch` fail-closed, re-authored `FN_ERROR_HINTS` — no `zcrm` strings, `FunctionOps` orchestrator), `runRenderer.ts` (plain-text result), `functionServiceBridge.ts`, `functionCommands.ts` (Run modal + live; Pull conflict-guarded + backup; Push guard→confirm→record; Create + Create-on-missing; `updateStandaloneContext`). `package.json`: 5 commands, `editor/title` + `commandPalette` menus gated `resourceLangId==deluge && zohoDeluge.loggedIn && zohoDeluge.isStandaloneFn`, `onCommand` activations.
- **M7-doable:** `retention.ts` (+ `cleanupTestArtifacts` command + `testArtifacts.retention` setting), `fieldMeta.ts` (picklist hovers → async `hoverProvider` `<Module>.<field>` branch + `MetadataIndex.getFieldHoverDetail`), `refreshError.ts` (classify → `handleRefreshFailure`: revoked re-login vs throttle/transient back-off), `uriCallback.ts` + `selfClientFallback.ts` (pure helpers for remote/Self-Client; interactive wiring is a liveOrgItem).
- **Verified:** extension **202** tests (8 suites incl. new `zoho-conflict` 33, `zoho-functionops` 31, `zoho-hardening` 29), CLI **117** (`run.js` 100 + `auth-instancing` 17). Bundle gate GREEN (825 KB, no leak). tsc clean.
- **M6 — DONE (extract + publish + repoint extension).** Built **`@wanasapps/zcrm-core@0.1.0`** at `D:/Projects/zcrm-core` from the exact 12-module require-graph (`authService`, `functionService`, `apiClient`, `configStore`, `logger`, `concurrency`, `fsSync`, `delugeFormatter`, `delugeSignature`, `crmMetadataService`, `baseMetadataService`, `readmeTemplate`); own `package.json` (deps `axios` + `fs-extra`), `index.js` aggregate + subpath imports, README, LICENSE. **Published public to npm.** Extension repointed off the `wanas-zcrm-extractor` `file:` bridge onto `@wanasapps/zcrm-core` (imports `@wanasapps/zcrm-core/src/...`; dependency `^0.1.0` from the registry). 202/202 tests + bundle (784 KB) + VSIX green on the published core. **The production CLI was left untouched** (per the chosen scope) — core is a versioned snapshot of its reusable services; a future step can repoint the CLI onto core too.
- **NOT done — liveOrgItems** (need a live org / Zoho console): PKCE acceptance, real Remote/Codespaces `asExternalUri` round-trip, Self-Client/paste-refresh E2E, real-429 no-retry confirmation, large-org load test, true multi-org. See `docs/REMAINING-ROADMAP-PLAN.md` §5 for the full list.

**Files added/changed in M1:**
- CLI: `src/services/authService.js` (seams + mutex + class export), `test/auth-instancing.test.js` (new).
- Extension: `src/zoho/{zcrm-core.d.ts, secretStore.ts, configStore.ts, log.ts, connectionKey.ts, credentialProvider.ts, connection.ts}` (new), `src/extension.ts` (+connection init), `esbuild.js` (new), `package.json` (file: dep, esbuild, scripts, `main`→dist, `zohoDeluge.*` settings), `tsconfig.json` (+skipLibCheck), `.vscodeignore` (ship dist/), `test/zoho-foundation.test.js` (new).

