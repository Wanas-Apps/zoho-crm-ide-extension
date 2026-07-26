<div align="center">
  <img src="images/WanasApps-logo.png" alt="Wanas Apps Logo" width="120" />

  # Zoho CRM IDE Extension

  **Turn VS Code & AI Coding Agents into a Connected Zoho CRM IDE**

  [![Open VSX Version](https://img.shields.io/openvsx/v/wanas-apps/zoho-crm-ide-extension?color=blue&label=Open%20VSX)](https://open-vsx.org/extension/wanas-apps/zoho-crm-ide-extension)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.txt)
  [![Publisher](https://img.shields.io/badge/Publisher-Wanas%20Apps-orange.svg)](https://www.wanasapps.com)

  *Deluge IntelliSense · In-Editor Zoho Sign-In · Org Metadata Sync · Live Run/Pull/Push Across All Function Categories · Built-in MCP AI Server*

  [Website](https://www.wanasapps.com) · [Support](mailto:support@wanasapps.com) · [Open VSX Registry](https://open-vsx.org/extension/wanas-apps/zoho-crm-ide-extension)

  ---
</div>

## 🌟 Overview

The **Zoho CRM IDE Extension** transforms VS Code, Cursor, Windsurf, and Google Antigravity into a full-featured development environment for Zoho CRM. Edit Deluge scripts with full autocompletion, pull and sync metadata from your live org, test and push code directly from your editor, and let AI coding agents safely execute operations on your CRM via the embedded **Model Context Protocol (MCP)** server.

---

## ⚡ What's New

### 🚀 1.6.x — Universal Function Category Runner & `zcrm token` AI Access
- **All Function Categories Supported**: Live execution, testing, pulling, and pushing now work seamlessly across **all** Zoho Deluge function categories:
  - 🔄 `Schedule` functions
  - ⚡ `Automation` workflows
  - 🔘 `Button` actions
  - 🔗 `Related_List` functions
  - 📡 `Signals` listeners
  - 🛠️ `Standalone` functions
- **Dynamic Namespace Display**: Output log channels, run statistics, and status bar progress now accurately display actual function namespaces (e.g., `schedule.YesterdayTransactions`, `automation.lead_assignment`, `standalone.my_fn`).
- **Direct AI Token Access**: Built-in CLI `zcrm token` command lets AI agents and background scripts retrieve active OAuth access tokens and exact expiration timestamps directly (`--json` or `--raw`).

### 🛠️ 1.5.0 — Unified `zcrm` CLI Engine
- **Single Source of Truth**: The extension bundles metadata and function execution services directly from the [`wanas-zcrm-extractor`](https://www.npmjs.com/package/wanas-zcrm-extractor) core. File structures, sync rules, and pull outputs match the CLI byte-for-byte.
- **Cross-Process Sync Lock**: Concurrent pulls from the extension and CLI coordinate safely through `.zcrm/.store/.sync-in-progress` to prevent race conditions.

---

## 🔥 Key Features

### 🧠 Deluge Language & Org-Aware IntelliSense
- **Smart Autocompletion**: Overload-aware completions and parameter signatures for all standard Deluge functions and built-in methods.
- **Org Metadata Integration**: Once you pull your org's metadata, module API names and field names autocomplete directly inside `zoho.crm.getRecordById(...)`, `zoho.crm.searchRecords(...)`, and COQL queries.
- **Diagnostics & Linting**: Real-time error detection for unbalanced syntax, unclosed strings/comments, missing semicolons, and invalid reserved keywords.

### ⚡ Universal Function Manager (Run / Test / Push / Pull)
- **Live Test Execution**: Run Deluge scripts directly against your live Zoho CRM org with real input arguments. Results display formatted return values, execution times, statement counts, network logs, and `info` printouts.
- **Conflict Guard**: Detects divergence between local `.ds` files and live org code before pushing to prevent accidental overwrites.
- **Run History**: Automatically logs and persists structured JSON test artifacts under `crm/function_tests/` for full auditability.

### 🤖 Embedded Model Context Protocol (MCP) Server
Exposes your authenticated Zoho CRM org to AI coding agents (VS Code Agent Mode, Cursor, Windsurf, Google Antigravity, Claude Desktop) with a secure, audited tool surface:
- **Read-Only Queries**: Execute freely without prompt fatigue.
- **Write/Mutate Actions**: Strictly gated by your IDE's interactive user approval prompt.

#### Exposed MCP Tools Matrix:

| Category | Read Tools (Automatic) | Write Tools (Approval Required) |
| :--- | :--- | :--- |
| **Records & COQL** | `zoho_query_records`, `zoho_get_record`, `zoho_list_records`, `zoho_search_records`, `zoho_count_records` | `zoho_create_record`, `zoho_update_record`, `zoho_upsert_record`, `zoho_delete_record` |
| **Modules & Fields** | `zoho_list_modules`, `zoho_get_fields` | `zoho_create_field`, `zoho_update_field` |
| **Functions** | `zoho_list_functions`, `zoho_get_function_code` | `zoho_run_standalone`, `zoho_push_function` |
| **Variables & Tags** | `zoho_list_variables`, `zoho_get_variable`, `zoho_list_variable_groups`, `zoho_list_tags` | `zoho_set_variable`, `zoho_delete_variable`, `zoho_create_tag`, `zoho_delete_tag`, `zoho_add_tags`, `zoho_remove_tags` |
| **Workflows & Blueprint**| `zoho_list_workflows`, `zoho_get_workflow`, `zoho_blueprint_get`, `zoho_blueprint_config`, `zoho_blueprint_transitions` | `zoho_create_workflow`, `zoho_update_workflow`, `zoho_delete_workflow`, `zoho_blueprint_update` |
| **Notes & Users & Org** | `zoho_list_notes`, `zoho_get_note`, `zoho_list_users`, `zoho_get_user`, `zoho_org_info`, `zoho_raw_api` | `zoho_create_note`, `zoho_delete_note`, `zoho_send_mail`, `zoho_composite` |

---

## 🔌 Connecting Your AI Agent (Per-IDE Setup)

> [!TIP]
> **One-Time External MCP Setup**:
> 1. Sign in to Zoho CRM in VS Code (using **Proxy Mode**).
> 2. Run command: `Zoho CRM IDE: Enable External MCP Access (Export Session)`.
> 3. Run command: `Zoho CRM IDE: Copy Antigravity (stdio) MCP Config` to copy your pre-filled, org-pinned configuration block.

### Config Snippet (Cursor / Windsurf / Antigravity / Claude Desktop)
Paste the generated configuration into your IDE's MCP settings file (`mcp_config.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "zoho-crm-ide": {
      "command": "node",
      "args": ["<extension_path>/dist/mcp-stdio.js"],
      "env": {
        "ZOHO_MCP_SESSION": "~/.zoho-crm-ide/sessions/<dc>-<orgId>.json",
        "ZOHO_MCP_EXPECTED_ORG": "<orgId>"
      }
    }
  }
}
```

---

## 🛠️ Commands Reference

| Command Palette ID | Description |
| :--- | :--- |
| `zohoDeluge.signIn` | Sign in to Zoho CRM via OAuth backend proxy or custom credentials |
| `zohoDeluge.signOut` | Sign out of active Zoho CRM session |
| `zohoDeluge.pullMetadata` | Pull all CRM modules, custom fields, layouts, and Deluge scripts |
| `zohoDeluge.runFunction` | Run/Test live Deluge function with arguments on live org |
| `zohoDeluge.pullFunction` | Pull latest code for a target function into a local `.ds` file |
| `zohoDeluge.pushFunction` | Push local `.ds` Deluge function edits to live Zoho CRM org |
| `zohoDeluge.createFunction` | Create a new Deluge function on live org from editor |
| `zohoDeluge.exportSession` | Export per-org session for external AI Agents (Cursor/Antigravity) |
| `zohoDeluge.copyMcpConfig` | Copy pre-filled stdio MCP server configuration block to clipboard |

---

## ⚙️ Key Settings Reference

All configuration settings are available under `zohoDeluge.*` in VS Code Settings:

- `zohoDeluge.authProxyUrl`: Backend OAuth proxy URL (prevents storing Client Secrets locally).
- `zohoDeluge.dc`: Zoho Data Center location (`com`, `eu`, `in`, `com.au`, `ca`, `sa`).
- `zohoDeluge.autoPullOnSignIn`: Automatically pull org metadata upon successful sign-in (`default: true`).
- `zohoDeluge.testArtifacts.retention`: Number of historical test run logs to retain per function (`default: 20`).

---

## 📬 Support & Contact

- **Website**: [www.wanasapps.com](https://www.wanasapps.com)
- **Email Support**: [support@wanasapps.com](mailto:support@wanasapps.com)
- **Open VSX Marketplace**: [wanas-apps.zoho-crm-ide-extension](https://open-vsx.org/extension/wanas-apps/zoho-crm-ide-extension)

*Developed with ❤️ by Wanas Apps · Released under the MIT License*
