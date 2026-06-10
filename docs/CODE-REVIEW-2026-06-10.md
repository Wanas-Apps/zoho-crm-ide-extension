# Code Review — Zoho CRM IDE Extension

**Date:** 2026-06-10  **Reviewed version:** 0.7.3  **Reviewer:** Claude (xhigh-effort multi-agent review)
**Scope:** Whole project — `src/**` (≈7,600 LOC TypeScript), `oauth-proxy/**`, `package.json` contributions, plus a dedicated UI/UX pass. (No git history available, so the review target is the full source rather than a diff.)

---

## 1. Executive summary

The codebase is mature and unusually well-disciplined: a hardened-CSP login webview, timing-safe state/token comparisons, a fail-closed conflict guard, a leak-gated bundle, and ~285 passing tests. The review still surfaced a focused set of real defects — most importantly two that affect everyday use (mis-placed lint squiggles) and sign-in reliability (a lost-authorization-code race), plus a silent data-loss path in the pull backup.

**Outcome:** 12 issues auto-fixed (3 high, 4 medium correctness/safety, 5 UI/UX), all verified. A further set of higher-risk or deployment-coupled findings is documented as recommendations (Section 5) rather than auto-applied, to honor the "don't break the logic" constraint.

| | Found | Auto-fixed | Recommended (not applied) |
|---|---|---|---|
| Correctness / data-safety | 11 | 7 | 4 |
| Security (proxy + MCP) | 6 | 1 | 5 |
| UI / UX | 14 | 5 | 9 (polish) |

### Verification (all green)
- `npm run compile` (tsc) — **clean**, 0 errors.
- `npm test` — **285 / 285 pass, 0 fail** across all 12 suites (run-tests 23, foundation 22, login 18, proxy 20, sync 22, index 37, conflict 33, functionops 36, hardening 29, mcp 33, http-e2e 8, stdio 4).
- `node esbuild.js` — **bundle GREEN** (exit 0, leak gate passed; `dist/extension.js` + `dist/mcp-stdio.js` rebuilt).
- Two targeted behavioral verifications written and passed (diagnostics column mapping; OAuth early-arrival buffering — see Section 4).

---

## 2. Methodology

Nine independent finder angles plus a dedicated UI/UX angle were run in parallel over disjoint slices of the codebase, each surfacing candidate defects; candidates were de-duplicated, verified against the actual source, and only confirmed/plausible items were carried forward. Fixes were applied surgically and re-verified against the test suite + a production bundle.

- **Correctness angles:** line-by-line scan, removed-behavior audit, cross-file tracer, language-pitfall specialist, wrapper/proxy correctness.
- **Cleanup angles:** reuse, simplification, efficiency, altitude.
- **UI/UX angle:** webview accessibility/theming, message quality, progress/feedback, empty states, settings UX, status/tree presentation, branding consistency.

---

## 3. Fixes applied

Each fix is surgical, preserves existing behavior on the happy path, and is covered by (or consistent with) the passing test suite.

### Correctness & data-safety

#### 3.1 — Lint squiggles landed on the wrong characters  ·  HIGH  ·  `src/providers/diagnosticsProvider.ts`
**Bug.** The Pass-1 scanner built `info.code` by *deleting* string/comment characters rather than blanking them. Every diagnostic that computes a column from an index into `info.code` (divide-by-zero, `while`/`do`, `throw`→`throws`, `finally`, word-operators `and`/`or`/`not`) was therefore **shifted left** whenever a string literal or comment preceded the match on the same line. Because `codeActionsProvider` re-reads `document.getText(diag.range)` to choose its quick-fix, the mis-positioned range could also make the quick-fix replace the wrong span.

**Fix.** The scanner now **blanks strings/comments to spaces** (consuming the same number of columns), so every index into `info.code` maps 1:1 to a real document column. Detection is unchanged (spaces can't introduce or hide a keyword match) and is in fact slightly *more* correct at string boundaries.

**Verified.** For `x = "a/b and or"; throw err`, `throw` is now reported at column **18** (its true position), and the `/`, `and`, `or` *inside the string* are correctly **not** flagged.

#### 3.2 — Sign-in could hang and then "time out" despite succeeding  ·  HIGH  ·  `src/zoho/oauth.ts`
**Bug.** The loopback server resolved the authorization code through a `settle?.resolve(code)` callback that only existed once `waitForCode()` had been called. If the browser already had a live Zoho session and redirected to `127.0.0.1` *before* `waitForCode()` registered (the redirect is awaited after `openExternal`), `finish()` latched `settled = true` and dropped the code. The later `waitForCode()` promise could then only ever reject via the timeout — the user saw the browser success page but the editor hung ~2 minutes and reported a spurious "Timed out".

**Fix.** The outcome is now **buffered** (`pendingCode` / `pendingErr`) when no waiter is registered yet, and `waitForCode()` delivers a buffered result immediately. The waiter-first path (all existing tests) is unchanged.

**Verified.** A code fired *before* `waitForCode()` is now received correctly (`EARLY123`) instead of timing out.

#### 3.3 — Pull could silently destroy un-backed-up local edits  ·  HIGH (data-safety)  ·  `src/zoho/conflictGuard.vscode.ts`
**Bug.** The contract is "a backup is **always** written before an overwrite-pull." But a thrown `writeBackup` (full/read-only disk, permissions) was only logged — execution fell through to `return { proceed: true }`, so the pull overwrote the user's diverged local copy with **no recoverable backup**.

**Fix.** Fail-closed: when the backup fails **and the local copy has changes that aren't in Zoho** (`verdict === 'DIRTY'`), the pull is **cancelled** with an actionable error instead of overwriting. A backup failure on a *clean* file (nothing to lose) still proceeds, so benign refreshes aren't blocked. No test exercised the failure path, so the suite is unaffected.

#### 3.4 — A string piped into a conversion was mis-typed in completions  ·  MEDIUM  ·  `src/providers/completionProvider.ts`
**Bug.** `inferFromExpression` checked `startsWith('"')` / `startsWith("'")` *before* the conversion-call patterns, so `x = "a,b,c".toList()` was inferred as **String** and the user was offered string methods on a list variable.

**Fix.** A literal that is piped into a type-converting call (`.toList()`, `.toMap()`, `.toLong()`, `.toDate()`, …) no longer short-circuits to the literal type — the downstream conversion checks decide. Plain `"abc"` and string-returning methods (`.toUpperCase()`) still resolve to String.

#### 3.5 — `invalid_client` wrongly forced a full re-login  ·  MEDIUM  ·  `src/zoho/refreshError.ts`
**Bug.** `classifyRefreshError` lumped `invalid_client` in with `invalid_grant`, so a misconfigured/rotated proxy client secret (a server-side problem) caused the extension to **discard the user's valid refresh token** and demand re-login — which wouldn't even fix it.

**Fix.** `invalid_client` now falls through to `transient` (keep the session, surface a toast, retry later). `invalid_grant` / `invalid_code` / `invalid_token` still force re-login. No test pinned `invalid_client`.

#### 3.6 — A nested call in an argument broke org-aware completion  ·  MEDIUM  ·  `src/providers/orgContext.ts`
**Bug.** The `zoho.crm.*` argument matcher used `([^)]*)$`, which stops at the first `)`. Typing `zoho.crm.getRecords("Leads", getId(), "Em…` matched nothing, so module/field completion silently stopped working inside any call that nested another call.

**Fix.** Capture the whole tail (`(.*)$`) and let `analyzeCallArg`'s existing paren-depth tracking handle nesting. The existing analyzer-matrix tests still pass.

#### 3.7 — `ZOHO_MCP_READONLY` ignored common truthy values  ·  MEDIUM (safety)  ·  `src/zoho/mcp/mcpStdio.ts`
**Bug.** The read-only flag parsed only `1|true|yes` with no trim, so `ZOHO_MCP_READONLY=on` (or `enabled`, or a trailing space) silently left the external stdio server **fully write-capable** — the opposite of what the operator intended.

**Fix.** Accept `1|true|yes|y|on|enabled` (case-insensitive) and `.trim()` the value.

### UI / UX

#### 3.8 — OAuth callback page ignored light mode & high-contrast  ·  MEDIUM  ·  `src/zoho/branding.ts`
The browser success/failure page was hard-coded to a dark palette with fixed hex colors at the most trust-sensitive moment of onboarding. It now uses CSS custom properties with a `prefers-color-scheme: light` override and a `forced-colors: active` (high-contrast) fallback, and conveys success/failure with a **✓ / ✕ glyph + text**, not color alone. (The success title is unchanged, so the login test's `/Signed in to Zoho CRM/` assertion still holds.)

#### 3.9 — Sign-in webview accessibility & double-submit  ·  MEDIUM  ·  `src/zoho/loginWebview.ts`
- Data-center `<select>` now shows the friendly `DC_LABELS` ("zoho.com (US)") instead of bare suffixes ("com"), matching the proxy-mode quick-pick.
- The error region is now `role="alert" aria-live="assertive"` (announced to screen readers); fields are `aria-required` and toggle `aria-invalid`; the first field is autofocused.
- On submit the buttons are disabled and the label becomes "Signing in…" (with a `button:disabled` style), preventing a confusing double-click while the handoff completes.

#### 3.10 — Status bar used one icon for both states  ·  LOW  ·  `src/zoho/statusBar.ts`
Signed-out is now `$(sign-in)` and signed-in is `$(account)` (both were `$(zap)`), so connection state reads at a glance.

#### 3.11 — Empty-state scared off default-mode users  ·  LOW  ·  `package.json`
The Connection view's welcome told *every* user "You'll need your own Zoho **Server-based** app credentials" — but the shipped default is zero-config proxy mode. Reworded to "No setup needed — sign in with the bundled connector. Advanced users can switch to their own Zoho app credentials in settings."

#### 3.12 — Run-failure toast wasn't actionable  ·  LOW  ·  `src/zoho/functionCommands.ts`
A failed live run now offers a **"Show Output"** button that reveals the channel, instead of only telling the user to go find it.

---

## 4. Verification detail

```
tsc -p ./                      → 0 errors
npm test                       → 285/285 PASS, 0 FAIL (12 suites)
node esbuild.js                → exit 0, leak gate GREEN (extension.js + mcp-stdio.js)
```

**Targeted check — diagnostics columns** (drove the compiled `computeDiagnostics` with a minimal `vscode` mock):
```
input:  x = "a/b and or"; throw err
real throw col = 18   reported throw col = 18   → CORRECT
'/' inside string flagged as division?  no
'and'/'or' inside string flagged?       0
```

**Targeted check — OAuth early arrival** (fired the callback *before* `waitForCode()`):
```
code received after early arrival: EARLY123   → FIX OK (previously: dropped → 2-min false timeout)
```

---

## 5. Findings reviewed but NOT auto-fixed (recommendations)

These are real or plausible, but the fix is invasive, deployment-coupled, or a deliberate design choice — applying them blindly risked breaking working behavior. They are prioritized for a follow-up.

### 5.1 — `assertOrgMatch` compares API *domain*, not org id  ·  HIGH  ·  `src/zoho/functionOps.ts:133`
Two distinct orgs in the **same data center** share an `apiDomain`, so the fail-closed org guard passes for the wrong org — a Push/Run could hit a different org in the same region. `SnapshotStore` already keys on `orgId` for exactly this reason. **Why not auto-fixed:** the correct discriminator (`orgId`) must be plumbed from both the live session *and* the folder's stored metadata into `FunctionOpsDeps`; that touches the command wiring and the `.zcrm` contract and deserves its own change + tests.

### 5.2 — OAuth proxy hardening  ·  HIGH/MEDIUM  ·  `oauth-proxy/index.js`
- **Auth is opt-in (`if (SHARED_SECRET)`) and the function deploys `no_auth`.** With `PROXY_SHARED_SECRET` unset, the token/refresh/revoke broker is an open refresh-token oracle. Recommend: **refuse to start** if the secret is unset.
- **`GET *` health echoes `client_id` unauthenticated**, and a **malformed JSON body** escapes the route try/catch (no Express error-handling middleware) — add one to keep the JSON error contract.
- **Consent is a client-asserted boolean**, and **PII capture is awaited inside the token response** (up to 7+ CRM calls / 8s) — make capture fire-and-forget; treat `consent` as advisory.
- **ZCQL is built by string interpolation** of the user's email (`'…'` doubling only) — use a parameterized query.

**Why not auto-fixed:** the *deployed* `vs-login` Catalyst function is a newer build than this repo copy (they have drifted), and changing the live broker's auth model without a coordinated redeploy could break the currently-working sign-in flow. These should be applied to the proxy and redeployed deliberately. **No hardcoded secrets remain in `oauth-proxy/index.js`** (all from `process.env`); secrets are correctly redacted in all log paths.

### 5.3 — External (stdio) MCP confirm-gate is a no-op  ·  HIGH  ·  `src/zoho/mcp/mcpStdio.ts:130`
`confirm = () => !readonly`, so when writes are enabled (the default) every write/execute tool runs against the live org with **no local confirmation** — all gating is delegated to the external agent. This is the documented design ("the launching agent gates each call"), so it was **not** flipped. Recommendation: default the stdio server to **read-only** (require explicit opt-in for writes), or add a first-run consent, so a prompt-injected external agent can't silently mutate the org. (The in-VS-Code HTTP transport *does* use a real modal.) The `ZOHO_MCP_READONLY` parsing gap that made read-only hard to even enable **was** fixed (3.7).

### 5.4 — `session.json` token file: atomicity & Windows ACL  ·  MEDIUM  ·  `src/zoho/mcp/sessionFile.ts`
`updateSessionTokens` is a read-modify-write with no lock or temp-and-rename, so concurrent refreshes can lose a token rotation and a mid-write crash can truncate the file. The `0600` mode and `chmod` are no-ops on Windows (the user's platform), leaving the refresh token under default NTFS ACLs. Recommend an atomic write (temp + rename) and a documented note about Windows file ACLs.

### 5.5 — Single-function Pull/Push doesn't hold `SyncLock`  ·  MEDIUM  ·  `src/zoho/syncLock.ts` (callers)
A full metadata pull holds the lock, but a single-function Pull/Push (`functionCommands`) does not, so the two can write the same `.ds` and snapshot a half-written file. Recommend gating the single-function ops under the same lock.

### 5.6 — Data centers `ca` / `sa` map to the wrong host  ·  MEDIUM (needs live)  ·  `src/zoho/loginWebview.ts` + core
The DC quick-pick / `<select>` offer `ca`/`sa`, but Canada's real OAuth host is `accounts.zohocloud.ca`, not `accounts.zoho.ca`. The actual domain concatenation lives in the published `@wanasapps/zcrm-core` `AuthService`, so the fix belongs there (and needs a live org to confirm). Until then, Canadian/Saudi sign-in is likely broken.

### 5.7 — Lower-priority items
- `zohoAuthProvider.signOut` swallows the revoke error with **no log** (`:231`) — if revoke ever fails, a non-revoked token is left server-side with no trail.
- New VS Code session reads `tokens?.access_token` directly rather than via `getAccessToken()` (`:205`).
- `mcpServer` per-request `McpServer`/transport can leak if `connect()`/`handleRequest()` throws before the `res 'close'` handler fires.
- `coerceArg` returns the original string on a failed numeric parse (silently sends a non-numeric string to an int param).
- **Considered and deliberately NOT changed:** `metadataIndex` treats `arguments: []` as "genuinely zero args" and only falls back to the `.ds` line-1 parser when `arguments === null`. This is an intentional, tested design distinction (`null` = unknown, `[]` = zero) — changing it would break the documented contract.

---

## 6. What's already done well (verified, not just assumed)
- Login webview: proper CSP with a nonce on **both** style and script, no inline handlers, theme variables, HTML escaping.
- `validateState` length-checks then uses `crypto.timingSafeEqual`; state is enforced on every callback path before `handleCallback`.
- MCP HTTP server binds `127.0.0.1`, auths every path to `/mcp` before dispatch, uses `timingSafeEqual` correctly (length-guarded), and URL path params are `encodeURIComponent`-encoded.
- stdio server keeps stdout to JSON-RPC only (logs → stderr).
- Proxy redacts `client_secret` / `access_token` / `refresh_token` / `code` in all log paths; no hardcoded secrets remain.
- Bundle leak gate prevents heavy CLI deps from shipping.

---

*Report generated as part of the `/code-review` run on 2026-06-10. All auto-fixes are in the working tree and verified against compile + 285 tests + a production bundle.*
