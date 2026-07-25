# CLI Feature Parity + UI/UX Polish — Design

**Date:** 2026-07-25
**Status:** Approved (pending user spec review)
**Repos involved:**
- `D:\Projects\Zoho CRM V8 Metadata Extractor` — npm `wanas-zcrm-extractor`, local v2.1.0 (npm latest 2.0.0)
- `D:\Projects\Zoho Deluge Extention` — VS Code extension `zoho-crm-ide-extension` v1.3.0

## Goal

Bring the VS Code extension to feature parity with `wanas-zcrm-extractor` 2.x, keep both products sharing one implementation so parity never drifts again, and polish the extension's existing UI surfaces (no new webviews).

## Current gap (extension lacks)

| CLI feature | CLI location | Extension status |
| :--- | :--- | :--- |
| `zcrm record` list/get/create/update/delete/search/upsert/count | inline in `bin/cli.js` (~line 1524) | Missing |
| `zcrm bulk` read/write/status | inline in `bin/cli.js` (~line 2074) | Missing |
| `zcrm notify` list/create/delete | inline in `bin/cli.js` (~line 2138) | Missing |
| `zcrm skill` AI context file generator | `src/utils/skillGenerator.js` (importable) | Missing |
| V9 API paths in universal proxy | pass-through in `apiClient` | Works but undocumented/unverified |

Already at parity (extension working tree): api proxy, COQL, audit export, variables, tags, notes, users, recycle bin, workflows, module/field/layout CRUD, function lifecycle, MCP server.

## Architecture decision

**Chosen: extract CLI services, extension bridges them** (over extension-side reimplementation). The extension already consumes CLI modules directly (`apiCommands.ts` imports `wanas-zcrm-extractor/src/utils/apiClient`; `customizationBridge.ts` imports `customizationService`). Extending that pattern keeps one source of truth.

## Part 1 — CLI refactor (v2.2.0)

Extract inline `bin/cli.js` logic into importable CommonJS service modules. Non-breaking: `cli.js` subcommand handlers become thin callers of the services. CLI output/prompt/confirm behavior unchanged.

New modules:
- `src/services/recordService.js` — `list(module, opts)`, `get(module, id)`, `create(module, records)`, `update(module, records)`, `del(module, ids)`, `search(module, criteria/email/phone/word)`, `upsert(module, records, duplicateCheckFields)`, `count(module, criteria?)`
- `src/services/bulkService.js` — `createReadJob(...)`, `createWriteJob(...)`, `getStatus(jobId, kind)`, `downloadResult(jobId, destPath)`
- `src/services/notifyService.js` — `list()`, `create(channelId, url, events, expiry?)`, `remove(channelIds)`

Rules:
- Services contain no `console.*`, no prompts, no `process.exit` — they return data or throw; CLI layer keeps all presentation and confirm gates.
- Services reuse `src/utils/apiClient.js`.
- Unit tests added to CLI `test/run.js` suite.
- Version bump 2.1.0 → 2.2.0, publish to npmjs + GitHub Packages (also fixes the extension's currently unresolvable `^2.1.0` dependency).

## Part 2 — Extension additions (v1.4.0)

### Bridges (pattern: `customizationBridge.ts` — auth-guarded thin ports with injectable service for tests)
- `src/zoho/recordBridge.ts`
- `src/zoho/bulkBridge.ts`
- `src/zoho/notifyBridge.ts`
- `src/zoho/skillBridge.ts` (wraps `skillGenerator`)

### Commands (pattern: `apiCommands.ts` QuickPick flows)
- `zohoDeluge.manageRecords` — pick module (from metadata index) → pick operation → multi-step inputs → result
- `zohoDeluge.manageBulkJobs` — start read/write job, check status, download result into workspace
- `zohoDeluge.manageNotifications` — list/create/delete webhook subscriptions
- `zohoDeluge.generateAiSkillFile` — pick assistant format (Claude Code, Cursor, Windsurf, Copilot, Cline, Gemini, Codex/AGENTS.md, Markdown) → generate context file into workspace from pulled metadata
- Modules tree: context menu item "Browse Records" on module nodes → opens `manageRecords` pre-filled with that module

### Safety
- Every write op (record create/update/delete/upsert, bulk write, notify create/delete) shows a **modal confirm** naming the target org (mirrors CLI confirm gates; reuses org identity from `orgGuard`/session).
- Delete ops additionally require typed confirmation for multi-record deletes.

### V9
- `executeApi` placeholder and docs updated to show both `/crm/v8/...` and `/crm/v9/...`; test asserts pass-through of v9 paths.

## Part 3 — MCP tools (extension `mcpTools.ts`)

New tools calling the same bridges, subject to existing org guard:
- Read: `record_list`, `record_get`, `record_search`, `record_count`, `bulk_status`, `notify_list`
- Write: `record_create`, `record_update`, `record_upsert`, `record_delete`, `bulk_read` (job creation), `bulk_write`, `notify_create`, `notify_delete`
- Skill-file generation stays UI-only (agents already read workspace files).

## Part 4 — UI/UX polish (existing surfaces only)

1. **Results as readonly JSON virtual documents** (TextDocumentContentProvider, language `json`) replacing OutputChannel dumps for all api/coql/record/manage command results; OutputChannel remains the log.
2. **Multi-step QuickPick framework** — small shared helper with back navigation, `step/totalSteps`, input validation; adopted by all manage* flows.
3. **Tree view polish** — codicons per node type, markdown tooltips (field type, API name, id), count badges on Functions/Modules views.
4. **Status bar item** — `$(zap) OrgName (dc)` with connection state; click opens account quick menu.
5. **Walkthrough** — `contributes.walkthroughs`: sign in → pull metadata → run a function → set up MCP.
6. **Actionable errors** — failure notifications carry buttons (Retry / Show Log / Sign In as relevant).
7. **Cancellable progress** — long ops (metadata pull, bulk polling) honor cancellation tokens.

## Testing

- CLI: unit tests for the three new services (mock apiClient), regression run of existing suite.
- Extension: `test/zoho-records.test.js`, `test/zoho-bulk-notify.test.js`, `test/zoho-skillgen.test.js` using injected mock service ports (existing convention); MCP tests extended for new tools; v9 pass-through test in api tests.
- Full `npm test` green in both repos before release.

## Error handling

- Services throw with Zoho's full error body attached; extension shows concise message + full body in log + action buttons.
- Auth expiry mid-flow → existing refresh path; if refresh fails, error notification offers Sign In.

## Release order

1. CLI: extract services, tests, bump 2.2.0, publish (npmjs + GitHub Packages).
2. Extension: set `wanas-zcrm-extractor` to `^2.2.0`, implement bridges/commands/MCP/polish, tests, bump 1.4.0, package VSIX.

## Out of scope

- Webview panels (record browser/dashboard) — explicitly deferred.
- Migrating existing `apiCommands.ts` families (var/tag/note/user/recycle/workflow) onto extracted services — they already work via `apiClient`; optional future refactor.
- CLI behavior changes.
