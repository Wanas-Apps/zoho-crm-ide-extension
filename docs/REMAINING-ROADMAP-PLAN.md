I now have everything grounded in the real codebase. The picklist shape is confirmed (`pick_list_values[].display_value`, including `-None-` and `Under $1,000`), the test harness pattern is confirmed, the CLI's 99-assertion suite and its `apiClient.post` reassignment stubbing are confirmed, and all wiring seams (`connection.auth.getApiBaseUrl()`, `connection.outputDir`, `sessionLock.get()?.apiDomain/orgId`, `context.workspaceState`) are verified. Here is the integrated plan.

---

# Zoho CRM IDE Extension — Integrated Implementation Plan (M4.5 → M5 → M7-doable)

**Source of truth** for sequential execution. The extension repo (`D:/Projects/Zoho Deluge Extention`) is NOT git; the CLI repo (`D:/Projects/Zoho CRM V8 Metadata Extractor`) IS git-tracked and its `node test/run.js` suite (**99 assertions**, not "98"/"115" as the blueprints loosely state) MUST stay green after every CLI edit. Verified against live source: `functionService.js`, `apiClient.js`, `test/run.js`, `connection.ts`, `sessionLock.ts`, `activate.ts`, `zcrm-core.d.ts`, `metadataIndex.ts`, `hoverProvider.ts`, `dynamicSource.ts`, `configStore.ts`, and the `test_metadata` sample.

---

## 1. Build Order (keeps compile + tests green at every step)

The golden rule: **CLI repo edits first** (additive, verify `node test/run.js` green before touching the extension), then extension **pure modules** (no `vscode` import → compile + unit-test in isolation), then **vscode glue**, then **`activate.ts` wiring + `package.json`** last (so nothing references a symbol that doesn't yet exist).

### Phase A — M4.5 ConflictGuard (MUST ship before any M5 write)

1. **CLI** `src/services/functionService.js` — add `getRemoteCode(apiName)` + export. *(git repo)*
2. **CLI** `test/run.js` — add `functionService.getRemoteCode` section (2 assertions). Run `node test/run.js` → expect **101 passed**. *(git repo)*
3. **Ext** `src/zoho/zcrm-core.d.ts` — add `functionService` module block + `delugeFormatter` module block; add `getRemoteCode` to the functionService surface. (Pure types; compile gate.)
4. **Ext** `src/zoho/conflictGuard.ts` — pure core (hash + 3-way decisions + key/path helpers). No vscode.
5. **Ext** `src/zoho/snapshotStore.ts` — Memento wrapper (imports only `vscode.Memento` type + node `path`).
6. **Ext** `src/zoho/remoteCode.ts` — thin adapter over `functionService.getRemoteCode`.
7. **Ext** `src/zoho/conflictGuard.vscode.ts` — vscode glue (delegates all math to #4).
8. **Tests** `test/zoho-conflict.test.js`, `test/zoho-snapshot.test.js`, `test/zoho-conflictguard.test.js`.
9. **Ext** `src/zoho/activate.ts` — construct `SnapshotStore` + `ConflictGuard`, hook `recordManyFromFolder` into `runPull` success, `clearAll()` on sign-out.
10. **Ext** `package.json` — `backups.retention` config + declare `cleanupBackups` (body wired in M7).
11. Compile, run all 4 new node scripts + existing `zoho-*.test.js`.

> M4.5 lands the guard **and** the snapshot recording but is **not yet called for Push/Pull** — those call sites arrive in M5. After a clean full pull, bases already exist.

### Phase B — M5 Run / Pull / Push buttons

12. **CLI** `src/utils/apiClient.js` — add `postNoRetry` (parameterize `request()` with a `retry` flag). *(git repo)*
13. **CLI** `src/services/functionService.js` — route `executeTest` + `createStub` through `(apiClient.postNoRetry || apiClient.post)(...)`. Run `node test/run.js` → expect **101 passed** (unchanged — see §3.1). *(git repo)*
14. **Ext** `src/zoho/zcrm-core.d.ts` — extend the functionService block with the M5 surface (`resolveTarget`/`executeTest`/`pullOne`/`pushCode`/`createFunction`/`runTest`/`buildDescriptor`) and add `postNoRetry` to the existing `apiClient` module block.
15. **Ext** `src/zoho/functionOps.ts` — pure adapter (detection, org-match, coercion, orchestration). No vscode.
16. **Ext** `src/zoho/runRenderer.ts` — pure `renderTestResult`. No vscode.
17. **Ext** `src/zoho/functionServiceBridge.ts` — isolates the `require('wanas-zcrm-extractor/src/services/functionService')` import.
18. **Tests** `test/zoho-functionops.test.js` (pure).
19. **Ext** `src/zoho/functionCommands.ts` — vscode command layer + `updateStandaloneContext`. Adapts the M4.5 `ConflictGuard` to the methods M5 needs (see §4 contradiction resolution).
20. **Tests** `test/zoho-functioncmd.test.js` (vscode mocked via `Module._load`).
21. **Ext** `src/zoho/activate.ts` — construct `FunctionOps`, `registerFunctionCommands`, register `onDidChangeActiveTextEditor` → `updateStandaloneContext`.
22. **Ext** `package.json` — commands, `editor/title` + `commandPalette` menus, `testArtifacts.retention` config, `onCommand:*` activationEvents.
23. Compile, run all extension tests + `node test/run.js`.

### Phase C — M7-doable (5 slices)

24. **Ext** pure modules (any order, all no-vscode): `src/zoho/retention.ts`, `src/zoho/fieldMeta.ts`, `src/zoho/uriCallback.ts`, `src/zoho/refreshError.ts`, `src/zoho/selfClientFallback.ts` (pure halves only).
25. **Ext** `src/data/dynamicSource.ts` — add optional `getFieldHoverDetail?` + no-op on `EMPTY_DYNAMIC_SOURCE`.
26. **Ext** `src/zoho/metadataIndex.ts` — construct `FieldMetaReader` in `load()`; add async `getFieldHoverDetail`.
27. **Ext** `src/providers/hoverProvider.ts` — make `provideHover` async; add `<Module>.<field>` enrichment branch.
28. **Ext** `src/zoho/configStore.ts` — `getRetention()`.
29. **Ext** `src/zoho/refreshError.ts` consumer: branch `zohoAuthProvider.handleRefreshFailure`; add UriHandler + Self-Client fallback wiring to `signIn`.
30. **Ext** `src/zoho/activate.ts` — register `cleanupTestArtifacts`/`cleanupBackups` command bodies; pass `context`/uriScheme to provider; add cleanup to `showAccount` quick-pick.
31. **Ext** `package.json` — `cleanupTestArtifacts` command, `onUri` activationEvent, retention setting (shared with M5), update `test` script to include `zoho-hardening.test.js`.
32. **Tests** `test/zoho-hardening.test.js`.
33. Final: `npm run compile`, full extension suite, `node test/run.js` (green), esbuild bundle gate (no `express`/`inquirer`/`archiver` leak).

---

## 2. Per-Milestone File Lists, CLI Changes, package.json, Tests

### M4.5 — ConflictGuard

**CLI changes (git-tracked, additive, keep `node test/run.js` green):**

- `D:/Projects/Zoho CRM V8 Metadata Extractor/src/services/functionService.js` — ADD:
  ```js
  async function getRemoteCode(apiName) {
    const fn = await findByApiName(apiName);
    if (!fn) return null;                       // FN_NOT_FOUND → caller decides Create
    const code = await apiClient.get(`/crm/v8/settings/functions/${fn.id}/code`);
    const script = typeof code === 'string' ? code : '';
    return { apiName: fn.api_name, id: fn.id, code: formatDeluge(script) };
  }
  ```
  Add `getRemoteCode` to `module.exports`. `formatDeluge` and `findByApiName` already exist at the top of the file (verified lines 19, 48). Reads through `apiClient.get` (retry path — fine, it's a read). Mirrors `materializeDs`'s GET+formatDeluge but returns instead of writing.
- `D:/Projects/Zoho CRM V8 Metadata Extractor/test/run.js` — ADD a `functionService.getRemoteCode` section with 2 assertions: (1) stub `apiClient.get` to return a function list for `/settings/functions` and raw code for `/code`, assert `{apiName,id,code}` with `code` formatted; (2) stub the list to `{functions:[]}`, assert `getRemoteCode('missing')` returns `null`. → **99 → 101 passed.**

**Extension files:**

| Path | Action | Key exports / signatures |
|---|---|---|
| `src/zoho/conflictGuard.ts` | create | `hashCode(code): string` (sha256 hex); `normalizeAndHash(raw, format): string`; `decidePush({baseHash?,localHash,liveHash}): PushVerdict` (`SAFE`/`CONFLICT`/`LIVE_AHEAD`/`NO_BASE`); `decideOverwritePull({hasLocalFile,isDirty,localHash?,baseHash?}): PullVerdict`; `snapshotKey(orgId,apiName): string` = `` `${orgId}::${apiName.toLowerCase()}` ``; `apiNameFromDsPath(p)`, `isStandaloneDsPath(p)` (parse `standalone.<api>.ds`); `BaseSnapshot` interface. **No vscode import; only node `crypto`/`path`.** |
| `src/zoho/snapshotStore.ts` | create | `class SnapshotStore(state: vscode.Memento, orgId: () => string\|undefined)` with `get`, `getByDsPath`, `record`, `clearAll`. Keys: `'zohoDeluge.baseSnapshots'` (Record<snapshotKey,BaseSnapshot>) + `'zohoDeluge.snapshotPathIndex'` (Record<normDsPath,snapshotKey>). `orgId` sourced from `sessionLock.get()?.orgId` (verified present on `ActiveSession`). When orgId undefined → `record` no-ops, `get` returns undefined. Normalize dsPath via `path.resolve` + lowercase drive letter on win32. |
| `src/zoho/remoteCode.ts` | create | `fetchRemoteCode(apiName): Promise<RemoteCode\|null>` over `functionService.getRemoteCode`. Single owner of the new CLI dependency. |
| `src/zoho/conflictGuard.vscode.ts` | create | `class ConflictGuard({store,fetchRemote,format,output})` with `guardPush`, `guardOverwritePull`, `recordPulled`, `recordManyFromFolder(outputDir)`, `writeBackup(dsPath): Promise<string>` (writes `.zcrm/.backups/<apiName>-<ISOts>.ds`). All decision math delegated to `conflictGuard.ts`. **See §4 for the method-name reconciliation with M5's expectations.** |
| `src/zoho/zcrm-core.d.ts` | edit | ADD `declare module '.../functionService'` (with `getRemoteCode` returning `…\|null`) + `declare module '.../utils/delugeFormatter' { export function formatDeluge(code:string):string }`. |
| `src/zoho/activate.ts` | edit | After connection ready: `const snapshots = new SnapshotStore(context.workspaceState, () => sessionLock.get()?.orgId); const guard = new ConflictGuard({store:snapshots, fetchRemote:fetchRemoteCode, format:formatDeluge, output:connection.output});` In `runPull` success branch (before `restore()`): `await guard.recordManyFromFolder(result.outputDir)`. On sign-out: hook `snapshots.clearAll()`. Pass `guard` forward for M5. |

**package.json (M4.5):** add config `zohoDeluge.backups.retention` (number, default 20, minimum 0). Declare command `zohoDeluge.cleanupBackups` (body wired in M7). No new activationEvents/menus.

**Unit tests (zero-dep node over `out/`):**
- `test/zoho-conflict.test.js` — hash determinism; whitespace-only diff normalized via format funnel → same hash; `snapshotKey` org-scoped + case-insensitive; `decidePush` matrix (SAFE when live===base; LIVE_AHEAD when live changed & local===base; CONFLICT when both changed & local!==live; SAFE/no-op when local===live; NO_BASE when baseHash undefined); `decideOverwritePull` matrix; `apiNameFromDsPath`/`isStandaloneDsPath` parse `standalone.<api>.ds` and reject plain/non-standalone paths. Add an idempotency assertion `formatDeluge(formatDeluge(x))===formatDeluge(x)` over a real pulled `.ds`.
- `test/zoho-snapshot.test.js` — fake Memento `{get,update}`; record→get round-trip; `getByDsPath` via path index; org isolation; `clearAll` empties both maps; `record` no-op when orgId undefined; `pulledAt` stamped ISO.
- `test/zoho-conflictguard.test.js` — mock vscode via `Module._load`; fake `TextDocument {getText,isDirty,save}`; injected `fetchRemote`/`format`/`store` stubs. Assert: `guardPush` → proceed:false when fetchRemote null (Create); proceed:true on SAFE; BLOCK on CONFLICT unless override modal returns "Overwrite live with my version"; LIVE_AHEAD doesn't push; afterPush updates stored base; `guardOverwritePull` ALWAYS `writeBackup` when a local file exists (even clean path) to a tmp dir; cancel → proceed:false; `recordPulled` hashes on-disk `.ds`; format funnel applied both sides.

---

### M5 — Run / Pull / Push

**CLI changes (git-tracked, additive, keep `node test/run.js` green):**

- `D:/Projects/Zoho CRM V8 Metadata Extractor/src/utils/apiClient.js` — parameterize `request(method, endpoint, params, data, retryCount, retry = true)`; guard the 401/429/5xx branches with `&& retry`. Add:
  ```js
  async function postNoRetry(endpoint, data = {}, params = {}) {
    await acquireSlot();
    try { return await request('post', endpoint, params, data, 0, false); }
    finally { releaseSlot(); }
  }
  ```
  Export `postNoRetry`. Leave `post` (retry=true default) and `putForm` (already no-retry, verified line 173) unchanged.
- `D:/Projects/Zoho CRM V8 Metadata Extractor/src/services/functionService.js` — in `executeTest` (line 187) replace `await apiClient.post(endpoint, body)` → `await (apiClient.postNoRetry || apiClient.post)(endpoint, body)`; in `createStub` (line 253) replace `await apiClient.post('/crm/v8/settings/functions', null, {metadata})` → `await (apiClient.postNoRetry || apiClient.post)('/crm/v8/settings/functions', null, {metadata})`. **No other change.** Verified: `run.js` stubs `apiClient.post` by reassignment at lines 322/344/389/430/469/476/482/486 and never sets `postNoRetry`, so the `||` fallback routes to the stubbed `post` → **101 passed, unchanged** (see §3.1).

**Extension files:**

| Path | Action | Key exports / signatures |
|---|---|---|
| `src/zoho/functionOps.ts` | create | Pure helpers: `isStandalonePath(fsPath)` (segment chain contains `crm/functions/standalone`, case-insensitive, `\`+`/`); `deriveApiNameFromPath` / `deriveNamespaceFromPath` (basename `<ns>.<api>.ds`); `coerceArg(value,type)` (re-authored from `bin/cli.js`); `buildArgMap(args,answers)`; `assertOrgMatch(currentApiDomain, sessionApiDomain)` (throws `WRONG_ORG` on mismatch/empty); `fnError(msg,code)`; `FN_ERROR_HINTS` (keys: DS_NOT_FOUND, NO_API_NAME, FN_NOT_FOUND, NAME_INVALID, NOT_STANDALONE, NAME_MISMATCH, EMPTY_CODE, CREATE_FAILED, PUSH_FAILED, WRONG_ORG — **no `zcrm` strings**); `hintFor(err)`. `class FunctionOps({svc,getOutputDir,isAuthenticated,getCurrentApiDomain,getSessionApiDomain})` with `resolveForRun`, `run`, `pull`, `push`, `create`. **No vscode import.** |
| `src/zoho/runRenderer.ts` | create | `renderTestResult(result): string` (plain, no ANSI; SUCCESS/FAILED banner; unwrap `fnResult.output.value`; logs[]; network/integration; metrics with `\|\| 0`; Saved path). **No vscode.** |
| `src/zoho/functionServiceBridge.ts` | create | `import functionService = require('wanas-zcrm-extractor/src/services/functionService'); export const functionServicePort: FunctionServicePort = functionService;` |
| `src/zoho/functionCommands.ts` | create | `registerFunctionCommands(context, {ops, output, conflictGuard, getOutputDir})`; `updateStandaloneContext(editor)` → `setContext('zohoDeluge.isStandaloneFn', isStandalonePath(...) && langId==='deluge')`; private `runFunction`/`pullFunction`/`pushFunction`/`createFunction`/`collectArgs`. Adapts the M4.5 `ConflictGuard` (see §4). Prefers passed `uri`, falls back to `activeTextEditor`. |
| `src/zoho/zcrm-core.d.ts` | edit | Extend functionService block with M5 surface; add `postNoRetry` to the existing `apiClient` module block. |
| `src/zoho/activate.ts` | edit | Construct `FunctionOps` with `getCurrentApiDomain: () => connection.auth.getApiBaseUrl()` (verified exists) and `getSessionApiDomain: () => sessionLock.get()?.apiDomain`. `registerFunctionCommands(...)`. Register `onDidChangeActiveTextEditor(updateStandaloneContext)` + an initial call. |

**package.json (M5):**
- `contributes.commands`: `zohoDeluge.runFunction` (`$(play)`), `pullFunction` (`$(cloud-download)`), `pushFunction` (`$(cloud-upload)`), `createFunction` (palette-only), `cleanupTestArtifacts`.
- `contributes.menus['editor/title']`: run/push/pull, group `navigation`, `when: resourceLangId == deluge && zohoDeluge.loggedIn && zohoDeluge.isStandaloneFn`.
- `contributes.menus['commandPalette']`: same `when` for run/push/pull; `createFunction` `when: zohoDeluge.loggedIn`.
- `contributes.configuration`: `zohoDeluge.testArtifacts.retention` (number, default 20, minimum 0, scope `resource`).
- `activationEvents`: `onCommand:zohoDeluge.runFunction`, `pullFunction`, `pushFunction`.

**Unit tests:**
- `test/zoho-functionops.test.js` (pure) — `isStandalonePath` true for `…/crm/functions/standalone/standalone.Foo.ds` on `/`+`\` and mixed case; false for automation/untitled/bare paths. `deriveApiNameFromPath` (`standalone.Get_Assistants.ds`→`Get_Assistants`; multi-dot `standalone.a.b.ds`→`a.b`; `foo.ds`→`foo`,ns undefined). `coerceArg` (int/double/bool/string/empty passthrough). `assertOrgMatch` (equal→ok; mismatch/undefined→WRONG_ORG fail-closed). `FN_ERROR_HINTS`/`hintFor` — every code has a hint, **no hint contains `zcrm`**. `FunctionOps` with mock `svc`: `run` passes absolute outputDir + coerced map; throws NOT_AUTHENTICATED / NO_FOLDER / WRONG_ORG **before** any svc call (assert `svc.executeTest` not invoked); `pull` requires auth+folder but does NOT assert org-match. `renderTestResult` — SUCCESS/FAILED, unwrap value, logs, metrics defaults `0`, Saved present, **no `\x1b`**.
- `test/zoho-functioncmd.test.js` (vscode mocked) — `updateStandaloneContext` sets key true only for deluge standalone `.ds`; `collectArgs` returns undefined on Esc; `pushFunction` aborts (no `ops.push`) when guard blocks; `runFunction` skips `ops.run` when the modal is cancelled.
- CLI regression: `node test/run.js` → **101 passed**.
- Append `&& node test/zoho-functionops.test.js && node test/zoho-functioncmd.test.js` to the `test` script.

---

### M7 — Hardening (5 doable slices)

**CLI changes:** **NONE required.** Slice (d) is implemented extension-side via a re-authored `classifyRefreshError`. (Optional, deferred: typed `err.zcrmRefreshError` on `_doRefresh` — not needed.)

**Extension files:**

| Path | Action | Key exports / signatures |
|---|---|---|
| `src/zoho/retention.ts` | create | `parseArtifactName(name, ext): {apiName,ts}\|null` (split on the LAST `-` before the ISO ts; **the writer emits `new Date().toISOString().replace(/[:.]/g,'-')`** — verified at `functionService.js:159` — so the ts itself contains `-`; parse by stripping the known ext then matching the trailing `\d{4}-\d{2}-\d{2}T…Z` ISO-with-dashes pattern, apiName = the remainder before it); `planRetention(names, ext, keep): string[]`; `pruneDir(dir, ext, keep): Promise<{scanned,deleted}>` (tolerant of missing dir, mtime fallback when ts unparseable). **No vscode.** |
| `src/zoho/fieldMeta.ts` | create | `extractFieldMeta(raw): FieldMeta` (`raw.data_type`, `raw.pick_list_values[].display_value` cap ~25, `field_label`, `length`, `system_mandatory`); `renderFieldHover(module, field, meta, maxValues=15): string` (filter `-None-`); `class FieldMetaReader(folder)` with cached `read(module, field): Promise<FieldMeta\|undefined>` reading `crm/meta/modules/<Module>/fields/<Field>.fields-meta.json`. **No vscode.** Confirmed shape against real sample. |
| `src/zoho/uriCallback.ts` | create | `callbackUriScheme(uriScheme, extensionId)`; `parseCallbackQuery(query)`; `createCallbackSink(expectedState)` (single-shot, validates via `oauth.validateState`); `buildExternalRedirect(loopbackUri)`. **No vscode** (takes strings). |
| `src/zoho/refreshError.ts` | create | `classifyRefreshError(err): 'invalid_grant'\|'throttled'\|'transient'` (reads `err.response.data.error` and `err.message`; the CLI `_doRefresh` throws `Error('Zoho OAuth Token Refresh Error: ...')` and re-throws axios errors). **Pure.** |
| `src/zoho/selfClientFallback.ts` | create | `validateGrantCode(s): string\|undefined`; `seedTokensFromRefresh(refreshToken): {refresh_token,expiry_time}` (expiry in the past → forces validating refresh); `runSelfClientFallback(connection): Promise<boolean>` (QuickInput → `handleCallback`/seed+`refreshAccessToken`). Pure halves unit-tested. |
| `src/data/dynamicSource.ts` | edit | Add optional `getFieldHoverDetail?(module,field):Promise<string\|undefined>` to the interface; `EMPTY_DYNAMIC_SOURCE.getFieldHoverDetail = async () => undefined`. |
| `src/zoho/metadataIndex.ts` | edit | Construct `private fieldMetaReader` in `load()` from `this.folder`; add `async getFieldHoverDetail(module,field)`. Do NOT eagerly read field-meta (preserve lazy rule). |
| `src/providers/hoverProvider.ts` | edit | Make `provideHover` async; add a `<Module>.<Field>` branch: if `source.isModule(mod) && source.getFieldHoverDetail`, await it and return enriched markdown, else fall back to existing field doc. Keep namespace/plain branches unchanged (VS Code supports Promise-returning `provideHover`). |
| `src/zoho/refreshError.ts` consumer — `src/zoho/zohoAuthProvider.ts` | edit | `handleRefreshFailure(err)`: `invalid_grant`/`invalid_client`/`invalid_code` → existing clear+re-login; `throttled`/`transient` → keep session+tokens, softer non-clearing toast. `signIn()`: register UriHandler (shared `createCallbackSink`), `asExternalUri(loopback.redirectUri)`; on `firstFreePort`/loopback throw → offer `runSelfClientFallback`. Constructor accepts `context` for `registerUriHandler`. |
| `src/zoho/configStore.ts` | edit | `getRetention(): number` (default 20, clamp negatives to 0). Mirror `getConcurrency`. |
| `src/zoho/activate.ts` | edit | Register `cleanupTestArtifacts` (prune `<outputDir>/crm/function_tests` `.json` + `<outputDir>/.zcrm/.backups` `.ds` with `keep=config.getRetention()`); guard no-outputDir. Add cleanup to `showAccount` quick-pick. Pass `context` to `ZohoAuthProvider`. Wire the M4.5 `cleanupBackups` command body here too (shared retention). |
| `package.json` | edit | `cleanupTestArtifacts` command; `testArtifacts.retention` config; `activationEvents += 'onUri'`; `test` script `+= && node test/zoho-hardening.test.js`. |

**Unit tests:** `test/zoho-hardening.test.js` (mirror `zoho-index.test.js`; `SAMPLE = test_metadata` path; SKIP if absent; `os.tmpdir()` for prune tests). Covers retention parse/plan/prune (keep-N, 0=keep-all, unparseable→mtime fallback), `fieldMeta` against real `Leads/Budget_Range` (data_type `picklist`, includes `Under $1,000`, excludes `-None-`, caps + `…and N more`, non-picklist renders data_type only), `uriCallback` (scheme/parse/sink state-validity/single-shot/error reject), `classifyRefreshError` matrix, `selfClientFallback.validateGrantCode`/`seedTokensFromRefresh` (past expiry), `MetadataIndex.getFieldHoverDetail`, hover routing logic, `configStore.getRetention` clamp.

---

## 3. Cross-Cutting Decisions (resolved)

### 3.1 No-auto-retry for execute/push (duplicate-execution safety)
The reused `apiClient.request()` (verified `apiClient.js:103-128`) retries 401 (×2), 429 (×5, 1/2/4/8/16s), and 5xx (×2). `executeTest` and `createStub` are **mutating/executing** POSTs → a retried Deluge run can double-execute (create record / send mail). **Resolution:** add `apiClient.postNoRetry` by parameterizing `request()` with a `retry` boolean (guard the three retry branches with `&& retry`); switch `executeTest` + `createStub` to `(apiClient.postNoRetry || apiClient.post)(...)`. `putForm` (Push) is **already** no-retry (verified `apiClient.js:173` — no `retryCount` path), so Push needs nothing. The `|| apiClient.post` fallback is load-bearing: `run.js` stubs `apiClient.post` by reassignment and never defines `postNoRetry`, so the fallback preserves all 101 CLI assertions with **zero `run.js` edits**.

### 3.2 ConflictGuard fetches live code WITHOUT writing
**No existing functionService method does this** (verified): `resolveTarget('live')` fetches code but is identity-coupled and returns a resolved-target object; `pullOne`/`materializeDs` always `fs.outputFile` a `.ds`. **Resolution:** add `functionService.getRemoteCode(apiName)` = `findByApiName` → `GET /crm/v8/settings/functions/{id}/code` → `formatDeluge` → **return** `{apiName,id,code}` (null on FN_NOT_FOUND). Reuses helpers already imported at the top of the file; writes nothing; rides the read-retry `apiClient.get` path (no no-retry concern). The extension calls it exclusively through `src/zoho/remoteCode.ts`.

### 3.3 Editor-title button when-clause + standalone `.ds` detection
Buttons show when `resourceLangId == deluge && zohoDeluge.loggedIn && zohoDeluge.isStandaloneFn`. `zohoDeluge.loggedIn` already exists (set in `zohoAuthProvider` constructor/sign-in/out — verified). `zohoDeluge.isStandaloneFn` is new, maintained by `updateStandaloneContext` on `onDidChangeActiveTextEditor`. Detection = `isStandalonePath()`: path-segment chain contains `crm/functions/standalone` (case-insensitive, separator-agnostic), defaulting to **false** for plain/untitled/non-tree `.ds` so buttons hide. This mirrors `functionService.resolveTarget`'s `<ns>.<api>.ds` convention and the on-disk layout (verified: `test_metadata/crm/functions/standalone/standalone.*.ds`). The context key is set **without reading file content** (performance); the signature-namespace fallback covers in-editor content for the pure path-detection used by FunctionOps.

### 3.4 Org-match assertion
Before any execute/push/create: `assertOrgMatch(connection.auth.getApiBaseUrl(), sessionLock.get()?.apiDomain)`. Verified: `authService.getApiBaseUrl()` returns the stored `api_domain` and `ActiveSession.apiDomain` (set at login via `connection.auth.getApiBaseUrl()` — verified `zohoAuthProvider.ts:148`) stores the same value → they match by construction. Mismatch/undefined → throw `WRONG_ORG` **before any network call** (fail-closed). **Pull does NOT assert org-match** (read-only) but still requires auth + folder.

### 3.5 Where base-snapshot hashes live
In **`context.workspaceState`** (Memento) — NEVER tracked files — under `'zohoDeluge.baseSnapshots'` (Record<snapshotKey,BaseSnapshot>) + `'zohoDeluge.snapshotPathIndex'`. Keyed by `snapshotKey(orgId, apiName)` = `` `${orgId}::${apiName.toLowerCase()}` `` (org-scoped, case-insensitive) plus a normalized-`.ds`-path index. `orgId` from `sessionLock.get()?.orgId` (verified on `ActiveSession`). All three hashes (base/live/local) pass through `normalizeAndHash` = `formatDeluge` then sha256, so whitespace-only formatter differences never read as divergence. Base = exactly what's on disk after a pull (the pulled `.ds` is already `formatDeluge` output). Pre-overwrite backups are files at `.zcrm/.backups/<apiName>-<ISOts>.ds` (retention-bounded).

---

## 4. Contradictions / Gaps Between Blueprints (resolved)

1. **ConflictGuard method names — the biggest mismatch.** M4.5 defines `guardPush` / `guardOverwritePull` / `recordPulled` / `recordManyFromFolder` returning `{proceed, afterPush?}`. M5's `functionCommands.ts` codes against a *different* interface: `checkBeforePush → 'safe'|'pull-live'|'blocked'|'overwrite-confirmed'`, `checkBeforeOverwritePull → 'proceed'|'cancel'`, `recordBaseSnapshot`. **Resolution:** M4.5's `ConflictGuard` (`conflictGuard.vscode.ts`) is the canonical implementation — implement it with the M4.5 names. In **M5 step 19**, `functionCommands.ts` calls the M4.5 methods directly and maps their return shapes inline (`guardPush().proceed` → proceed/abort; `recordPulled`/`recordManyFromFolder` for snapshot updates). Do **not** add a second `checkBeforePush`-style facade. Pin this before coding M5's command layer. (Net: one interface, M4.5's; M5 adapts.)

2. **Retention command/setting duplication.** M4.5 declares `zohoDeluge.cleanupBackups` + `zohoDeluge.backups.retention`; M5 declares `zohoDeluge.cleanupTestArtifacts` + `zohoDeluge.testArtifacts.retention`; M7 declares `zohoDeluge.cleanupTestArtifacts` + `zohoDeluge.testArtifacts.retention` again. **Resolution:** ONE setting `zohoDeluge.testArtifacts.retention` (default 20) governs **both** `crm/function_tests/*.json` and `.zcrm/.backups/*.ds`. ONE command `zohoDeluge.cleanupTestArtifacts` prunes both dirs (title "Clean Up Test Artifacts & Backups"). Drop the separate `backups.retention` and `cleanupBackups` — in M4.5 declare only the shared setting (default 20) and defer the command to M7. The retention **engine** (`retention.ts`) lands in M7; M4.5/M5 only declare config.

3. **Test-count drift.** Blueprints say "98-test"/"115/115". Actual is **99 `ok()` assertions** in `test/run.js` (verified). After getRemoteCode (+2) it's 101; the postNoRetry routing adds 0. Use these real numbers as the green gate.

4. **`postNoRetry` test strategy.** M5 blueprint offers two options (edit `run.js` stubs vs. `|| apiClient.post` fallback). **Resolution:** use the fallback only — zero `run.js` edits, zero regression risk. A future no-retry assertion can stub `postNoRetry` if desired, but it's not required now.

5. **`metadataSync.d-context` "file".** M7 lists a file `src/zoho/metadataSync.d-context` — this is a **note, not a real file**. The `FieldMetaReader` folder is picked up for free via the existing `reloadIndex` → `metadataIndex.load(dir)` flow (verified `activate.ts:51-67`). Do not create this path.

6. **`onStartupFinished` vs explicit `onCommand`.** M5 notes `onStartupFinished` already covers the context listener but recommends explicit `onCommand:*` for older VS Code. **Resolution:** add the `onCommand:*` entries (cheap, correct) and `onUri` (M7) — both harmless and required for palette/deep-link activation.

---

## 5. liveOrgItems — CANNOT be unit-verified here (flagged, not skipped)

**M4.5:**
- End-to-end CONFLICT path: pull a function, edit locally AND in the Zoho function editor, Push → confirm guardPush blocks with a live-vs-local diff and only overwrites on explicit choice (needs two divergent live edits).
- Confirm `/crm/v8/settings/functions/{id}/code` returns canonical saved code (liveHash stable across repeated fetches with no intervening edit).
- Confirm `formatDeluge(remoteCode)` byte-equals the on-disk pulled `.ds` for an unchanged function (validates "base = what's on disk", so a no-op Push reads SAFE not CONFLICT).
- Verify there is genuinely no etag/If-Match on the function-code endpoints (the only true fix for the live-fetch-before-push race window).

**M5:**
- `executeTest` against the real `/crm/v7/settings/functions/{api_name}/actions/test` — the v7 payload shape (metrics/logs/network_logs) is reverse-engineered; only a live org confirms `renderTestResult` guards match.
- No-retry behavior under an actual 429 from the test endpoint (single attempt, no re-execution) — needs a live credit-consuming run.
- INVALID_DATA / NAME_INVALID on Run of a not-yet-created function → the Create-then-Run recovery path end-to-end.
- `pushCode` multipart PUT acceptance + the divergence-fetch GET returning current live code for hashing.
- `createFunction` POST → real id + post-create `materializeDs` eventual-consistency (empty-code fallback).
- Org-match: confirm `authService.getApiBaseUrl()` and the login-captured `api_domain` are byte-identical for the same org across DCs.
- `createFunction` lowercases `api_name` (verified `functionService.js:297`) → a PascalCase buffer push could path-mismatch the lowercase created `.ds`; surface + re-open the created lowercase path.

**M7:**
- End-to-end Remote/Codespaces sign-in over `asExternalUri`-forwarded loopback (the pure scheme/parse/state/race logic is unit-tested; the forwarded-port browser→host round-trip needs a real remote host + live consent).
- PKCE S256 acceptance for a confidential client — needs a Zoho API Console app + real round-trip; until confirmed, baseline stays state + 127.0.0.1 + short listener (do NOT add PKCE).
- Self-Client grant-code exchange + paste-refresh-token validation (`handleCallback`/`refreshAccessToken` need a live org + real Self-Client grant).
- Refresh-token revocation recovery end-to-end (provoke server-side `invalid_grant` by revoking in console, then refresh) + the per-minute 429 refresh-throttle.
- Picklist-hover against a global/dependency picklist (`pick_list_values` may be empty, values in a referenced global list) — the local sample has inline values only.
- Large-org load/memory budget for `MetadataIndex` field arrays + true multi-org concurrency (deferred to post-M6 per-connection clients).

---

**Key real-source anchors for the engineer:** `functionService.js` exports `resolveTarget/executeTest/runTest/pullOne/createFunction/pushCode/isStandalone/assertStandalone/buildDescriptor` (line 414); `materializeDs` writes `crm/functions/<ns>/<ns>.<api>.ds` (line 400); `saveArtifact` writes `crm/function_tests/<api>-<ts>.json` with `ts = toISOString().replace(/[:.]/g,'-')` (line 159); `apiClient.request` retry branches at lines 103/115/123; `putForm` already no-retry (line 173); `connection.auth.getApiBaseUrl()` + `connection.outputDir` are the verified org-match and outputDir seams; `sessionLock.get()?.{orgId,apiDomain}` exist on `ActiveSession`; `context.workspaceState` is the snapshot store; the field-meta sample lives at `test_metadata/crm/meta/modules/<Module>/fields/<Field>.fields-meta.json` with `data_type` + `pick_list_values[].display_value`.