
 __        __                         _                    
 \ \      / /_ _ _ __   __ _ ___     / \   _ __  _ __  ___ 
  \ \ /\ / / _` | '_ \ / _` / __|   / _ \ | '_ \| '_ \/ __|
   \ V  V / (_| | | | | (_| \__ \  / ___ \| |_) | |_) \__ \
    \_/\_/ \__,_|_| |_|\__,_|___/ /_/   \_\ .__/| .__/|___/
                                          |_|   |_|        
      For Support Contact us on support@wanasapps.com
                     www.wanasapps.com

# Zoho CRM IDE Extension

Turn VS Code into a connected **Zoho CRM** development environment — Deluge IntelliSense,
in-editor Zoho sign-in, org metadata sync, Run/Pull/Push for functions, and an embedded
**MCP server** that lets AI agents work on your org safely.

*By [Wanas Apps](https://www.wanasapps.com)*

---

## What's new

### 1.5.0 — unified with the `zcrm` CLI
- **One code source** — the extension now bundles its metadata/function services directly from the [`wanas-zcrm-extractor`](https://www.npmjs.com/package/wanas-zcrm-extractor) CLI package (the former `@wanasapps/zcrm-core` snapshot fork is retired). Pull output, function file naming, and push/pull semantics are the CLI's own code, byte for byte — the two tools can never drift apart again.
- **One metadata tree** — running `zcrm pull` (v2.3+) inside a workspace this extension manages detects the existing extraction root and refreshes it in place instead of creating a second `./metadata` folder. All function categories are now testable from the CLI-shared core, matching the CLI.
- **Cross-process sync lock** — pulls from the CLI and the extension into the same folder now coordinate through `.zcrm/.store/.sync-in-progress`; a concurrent second pull aborts cleanly instead of racing the stale-file sweep.
- **Layouts in the tree view** — the CLI-shared core now writes `.zcrm/.store/layouts.json`, so the Layouts nodes populate after the next pull.

### 1.2.0 — project-bound orgs (zero-config)
- **Project org pointer** — signing in (or exporting a session) writes a small, **non-secret** `.zoho-crm-ide.json` into the workspace (`{ org_id, dc, org_name }`). Commit it: the project itself now declares which Zoho org it belongs to.
- **The stdio MCP server resolves the org from the project** — no more manual pinning. Resolution order: explicit `ZOHO_MCP_EXPECTED_ORG` env → the client's MCP roots → a walk-up from the server's working directory (start it elsewhere with `ZOHO_MCP_PROJECT`). The matching per-org session file is picked automatically too, so one generic config entry can serve every project.

### 1.1.0 — multi-org safety

- **Per-org sessions** — "Enable External MCP Access" now writes one session file per org (`~/.zoho-crm-ide/sessions/<dc>-<orgId>.json`), so exporting from a second org no longer overwrites the first. The legacy `~/.zoho-crm-ide/session.json` is still written so existing configs keep working.
- **Org-pinned agent configs** — "Copy Antigravity Config" pins the copied entry to the org you're signed in to (`ZOHO_MCP_EXPECTED_ORG`).
- **Wrong-org guard** — a pinned stdio server refuses to start on a session file claiming a different org, and verifies the **live** org against the pin before the first tool call. An agent can never silently read or write the wrong org.
- The session export now confirms your org identity with Zoho before writing the file.

---

## Features

### 🧠 Deluge language support
- **IntelliSense** — completions, hovers, and signature help for Deluge built-ins, with overload-aware signatures.
- **Org-aware completions** — once you pull your org's metadata, module and field names autocomplete inside `zoho.crm.*("…")` calls.
- **Linting** — conservative diagnostics (unbalanced brackets, unclosed comments, missing semicolons, Deluge-invalid keywords like `throw`/`and`/`while`) with quick-fixes.
- **Formatting** and syntax highlighting for `.dg` / `.deluge` / `.ds` files.

### 🔐 Connected to your org
- **Sign in to Zoho CRM** from the editor (native Accounts menu).
- Two auth modes:
  - **Proxy mode (recommended)** — point `zohoDeluge.authProxyUrl` at a backend OAuth proxy that holds your app's Client Secret server-side. You only pick a data center; nothing secret is stored locally.
  - **Bring-your-own-credentials** — set `zohoDeluge.clientId` and enter the Client Secret at sign-in (stored in the OS keychain).
- **Metadata sync** — pull your org's modules, fields, and functions into the workspace, powering org-aware IntelliSense and the side-bar views.

### ⚡ Functions: Run / Pull / Push
- **Run (Live)** a standalone function with arguments — results render in a colorized output channel with parsed error details, and every run is saved to a browsable **Run History**. Run a function that isn't on the org yet and you're prompted to **push it first, then run** (Zoho can only test a function that already exists).
- **Pull** any function's code into a local `.ds` (all categories).
- **Push** local changes back to the org, with a conflict guard that detects divergence from the live version before overwriting.
- A **Source Control** view surfaces locally-modified functions with live ↔ local diffs.

### 🤖 Embedded MCP server (for AI agents)
The extension exposes your authenticated org to AI coding agents through the **Model Context Protocol**, with a safe, audited tool surface: **reads run freely; every write requires explicit approval** before it touches the live org.

It works in **every MCP-capable, VS Code–based IDE** — VS Code 1.101+ (native agent mode), **Cursor**, **Windsurf**, **Google Antigravity**, plus other MCP clients like Claude Desktop — via two transports (an in-VS-Code HTTP server and a standalone stdio server). See [Connecting your AI agent](#connecting-your-ai-agent-per-ide) for per-IDE setup.

**Tools exposed:**

| Read (no prompt) | Write (approval-gated) |
| --- | --- |
| `zoho_query_records` (COQL) | `zoho_create_record` |
| `zoho_get_record` | `zoho_update_record` |
| `zoho_list_modules` | `zoho_create_field` |
| `zoho_get_fields` | `zoho_update_field` |
| `zoho_list_functions` | `zoho_run_standalone` |
| `zoho_get_function_code` | `zoho_push_function` |
| `zoho_org_info` | |

> Note: per Zoho's API, only **standalone** functions are executable via `zoho_run_standalone`. Pull and push work across all function categories.

The server ships in **two transports**:

- **HTTP** — a loopback server (`127.0.0.1`, random port, per-launch Bearer token) for the agent running *inside* VS Code. Discovered automatically by VS Code 1.101+ agent mode; writes prompt with a VS Code modal.
- **stdio** — a standalone server (`dist/mcp-stdio.js`) that an external IDE launches as a subprocess, so it works even with VS Code closed.

---

## Connecting your AI agent (per-IDE)

> **One-time setup (for the stdio transport — Cursor, Windsurf, Antigravity, Claude Desktop):**
> 1. Sign in to Zoho CRM in VS Code (**proxy mode is required** for external access).
> 2. Run **“Zoho CRM IDE: Enable External MCP Access (Export Session)”** — writes your session (refresh token + proxy coordinates, **never a client secret**) to `~/.zoho-crm-ide/sessions/<dc>-<orgId>.json` (owner-only, one file per org).
> 3. Run **“Zoho CRM IDE: Copy Antigravity (stdio) MCP Config”** to copy a ready-to-paste block with the real absolute paths filled in — **pinned to the org you're signed in to** via `ZOHO_MCP_EXPECTED_ORG`.
>
> Writes are enabled by default and gated by **your IDE's own per-tool approval**. Add `"ZOHO_MCP_READONLY": "1"` to the `env` block for a read-only session. Requires `node` on your `PATH`.

**Wrong-org protection:** every project carries a non-secret `.zoho-crm-ide.json` org pointer (written at sign-in), sessions are stored per org, and the server binds itself to one org — from the `ZOHO_MCP_EXPECTED_ORG` pin, the client's MCP roots, or its working directory's project pointer. It refuses to start on a session file claiming a different org and verifies the **live** org before the first tool call — so working with multiple Zoho orgs never silently points an agent at the wrong one.

**The simplest config** — when your IDE exposes MCP roots or launches stdio servers in the project directory (per-project configs like `.vscode/mcp.json` / `.cursor/mcp.json` do), a single generic entry serves **all** your projects; the server reads the org from each project's pointer and picks the right per-org session:
```json
{
  "mcpServers": {
    "zoho-crm-ide": { "command": "node", "args": ["<extension>/dist/mcp-stdio.js"] }
  }
}
```
For global configs where the server starts outside any project (so neither roots nor cwd identify one), use the **explicitly pinned** form below — "Copy Antigravity Config" generates it with everything filled in. One pinned entry per org (e.g. `zoho-crm-prod`, `zoho-crm-sandbox`).

In the snippets below, replace `<extension>` with the extension's install folder and `<dc>-<orgId>` with your data center + org id — **or skip the hand-editing entirely: the copied config fills everything in automatically.** The extension folder is typically `~/.vscode/extensions/wanas-apps.zoho-crm-ide-extension-<version>` (VS Code) or `~/.antigravity-ide/extensions/wanas-apps.zoho-crm-ide-extension-<version>-universal` (Antigravity).

### VS Code (1.101+) — nothing to configure
VS Code discovers the server automatically through the extension's MCP provider. Just open **agent mode** and the `zoho-crm-ide` tools appear. To add it manually instead, create `.vscode/mcp.json`:
```json
{
  "servers": {
    "zoho-crm-ide": {
      "type": "stdio",
      "command": "node",
      "args": ["<extension>/dist/mcp-stdio.js"],
      "env": {
        "ZOHO_MCP_SESSION": "~/.zoho-crm-ide/sessions/<dc>-<orgId>.json",
        "ZOHO_MCP_EXPECTED_ORG": "<orgId>"
      }
    }
  }
}
```
> Note: VS Code's `mcp.json` uses the top-level key **`servers`** with an explicit **`"type": "stdio"`**, unlike the `mcpServers` shape used by the other IDEs below.

### Cursor
Edit `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json`, or use **Settings → MCP → Add new server**:
```json
{
  "mcpServers": {
    "zoho-crm-ide": {
      "command": "node",
      "args": ["<extension>/dist/mcp-stdio.js"],
      "env": {
        "ZOHO_MCP_SESSION": "~/.zoho-crm-ide/sessions/<dc>-<orgId>.json",
        "ZOHO_MCP_EXPECTED_ORG": "<orgId>"
      }
    }
  }
}
```

### Windsurf
Open **Cascade → MCP servers → Manage → View raw config** (or edit `~/.codeium/windsurf/mcp_config.json`) and add the same `mcpServers` block as Cursor (identical stdio shape).

### Google Antigravity
Open Antigravity's **MCP / tools settings** (Agent panel → manage MCP servers) and add a server, or paste the `mcpServers` block into its `mcp_config.json`. The config shape is identical to Cursor's above.

### Claude Desktop / other MCP clients
Add the same `mcpServers` stdio block to the client's MCP config (Claude Desktop: `claude_desktop_config.json`). Any MCP client that supports `command`/`args` stdio servers will work.

---

## Getting started

1. Install the extension (published on [Open VSX](https://open-vsx.org/extension/wanas-apps/zoho-crm-ide-extension) — the marketplace used by Antigravity, Cursor, and Windsurf) and open the folder you want bound to your org.
2. Run **“Zoho CRM IDE: Sign in to Zoho CRM”** (or use the status-bar item / Accounts menu).
3. Metadata pulls automatically after sign-in (toggle with `zohoDeluge.autoPullOnSignIn`).
4. Open a `.ds` function and use the editor-title **Run / Pull / Push** actions, or browse the **Zoho CRM IDE** activity-bar views.
5. (Optional) Use VS Code agent mode directly, or wire an external agent via **Enable External MCP Access** → **Copy Antigravity Config**.

## Commands

- **Sign in / Sign out of Zoho CRM**, **Account…**
- **Pull Metadata from Zoho CRM**
- **Run Function (Live)**, **Pull Function**, **Push Function**, **Create Standalone Function**
- **Open Changes (Live ↔ Local)**, **Refresh Modified Functions**
- **Copy MCP Server Config**, **Restart MCP Server**
- **Enable External MCP Access (Export Session)**, **Copy Antigravity (stdio) MCP Config**
- **Clean Up Test Artifacts & Backups**

## Settings

Key settings (all under `zohoDeluge.*`): `authProxyUrl`, `authProxyToken`, `clientId`, `dc`, `scopes`, `loopbackPorts`, `concurrency`, `autoPullOnSignIn`, `pullRecordCounts`, `testArtifacts.retention`. See each setting's description in the Settings UI.

## Requirements

- VS Code **1.101.0** or newer (required for native MCP agent discovery).
- A Zoho CRM org and either an OAuth proxy URL or your own Zoho **Server-based** app credentials.
- External-agent (stdio) MCP access requires **proxy mode** and `node` on your PATH.

---

🌐 [wanasapps.com](https://www.wanasapps.com) · ✉️ [support@wanasapps.com](mailto:support@wanasapps.com)

© Wanas Apps · Released under the MIT License
