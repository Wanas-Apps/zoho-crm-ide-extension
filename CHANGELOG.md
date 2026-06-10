# Change Log

## [0.7.3]

- **Optional account sharing (opt-in).** During proxy-mode sign-in the extension now
  asks whether to share your name, email and org so we can send news and updates about
  the extension (and to help us improve it). It's entirely optional — decline (or
  dismiss) and you still sign in normally. Nothing is shared unless you explicitly agree.

## [0.7.1]

- **Zero-config sign-in.** The extension now ships with a built-in OAuth proxy, so
  signing in only asks you to pick your data center — **no Zoho Client ID / Client
  Secret to register or enter**. The Client Secret stays server-side; nothing
  secret is stored locally. Power users can still point `zohoDeluge.authProxyUrl`
  at their own proxy, or use Bring-Your-Own-credentials mode.

## [0.7.0]

- **Embedded MCP server — let AI agents work on your org safely.** The extension now runs a
  local **Model Context Protocol** server (loopback only, guarded by a per-launch Bearer token)
  exposing 13 Zoho CRM tools: query/read records, list modules & fields, read function code,
  org info (reads, no prompt) and create/update records, create/update fields, run a standalone
  function, push function code (**writes — each one asks for your explicit approval** before
  touching the live org). VS Code 1.101+ agent mode discovers it automatically; for other
  clients use **“Copy MCP Server Config.”** New commands: **Copy MCP Server Config**,
  **Restart MCP Server**.
- **Requires VS Code 1.101+** (for native MCP agent discovery).
- **Use it from external agents (Antigravity, Cursor, Claude Desktop).** Alongside the
  in-VS-Code HTTP server, the extension now ships a standalone **stdio** MCP server that an
  external agent launches as a subprocess — so it works even with VS Code closed. Run
  **“Enable External MCP Access (Export Session)”** (proxy mode only; exports a refresh
  token + proxy coordinates, never a client secret) then **“Copy Antigravity (stdio) MCP
  Config.”** Writes are gated by the agent's own approval; set `ZOHO_MCP_READONLY=1` for a
  read-only session.

## [0.6.0]

- **All function types in the Functions view, grouped by scope.** The side bar now lists
  every function — **Standalone, Automation, Button, Related List, Schedule, Signals** — in
  collapsible groups; click any to open its code. Standalone functions keep inline
  **Run / Pull / Push**; the other types support **Pull** + open. (Only standalone functions
  can be *executed* via Zoho's API — the others run inside their trigger, so there's no Run
  for them.)
- **Overloads in help text (foundation).** Signature help can now show multiple call
  signatures per function and auto-select by argument count; hover lists them. (Catalog data
  is being populated.)

## [0.5.0]

- **Pull & Push now report in the output.** A `✓ Pulled` / `✓ Pushed` block is written to the
  (colorized) Zoho output channel, matching the Run output.
- **Module/field picker inside `zoho.crm.*("…")`.** Typing `"` in an argument now opens the
  list of your pulled modules (first arg) or that module's fields (later args) — no need to
  press Ctrl+Space. The picker stays silent for quotes in ordinary strings.
- **Branded sign-in page.** The OAuth callback (success/failure) page now carries the Wanas
  Apps logo, a link to [wanasapps.com](https://www.wanasapps.com), and a contact-for-help prompt.
- **README restored & branded.** The packaged README is once again the extension's README (with
  the Wanas Apps logo and website link); a stray metadata-snapshot README had been shipping in
  its place.

## [0.4.2]

- **Colorized Zoho output.** The "Zoho CRM IDE" output channel is now syntax-highlighted by
  your theme: `✓ SUCCESS` green, `✗ FAILED` / `[COMPILE_ERROR]` red, separators dimmed, line
  numbers and `[WARN]`/`[ERROR]` log levels highlighted. Pure theme-based coloring (no ANSI
  codes), so it matches whatever color theme you use.

## [0.4.1]

- **Run output now shows compile/runtime errors.** A failed run surfaces an **Errors**
  section (`[TYPE] L<line> in <fn>: <message>`) read from Zoho's response, instead of just
  `✗ FAILED` with an empty return — so you can see e.g. a `COMPILE_ERROR` and its line number
  directly in the output.

## [0.4.0] — Workbench UI

A dedicated user interface for everything the connected IDE already does — no more
hunting through the Command Palette.

- **Zoho CRM activity-bar container** with three side-bar views:
  - **Connection** — the signed-in org, with one-click Pull metadata / Account / Sign out
    (and a guided **Sign in** welcome when you're signed out).
  - **Standalone Functions** — your org's functions, each with inline **Run / Pull / Push**
    buttons; click to open the source.
  - **Modules & Fields** — modules that expand to their fields (api name + data type).
- **Run History panel** — recent live-run results, newest first; click to open. Includes a
  one-click **Clean Up** action.
- **Source Control integration** — a "Zoho CRM" section lists standalone functions whose
  local code has changed since the last pull/push, with a **Live ↔ Local diff** and **Push**
  from the right-click menu. Change detection is local-only, so browsing files never calls
  the Zoho API; live code is fetched only when you open a diff.
- **Theme-aware** — all icons follow your color theme.

## [0.3.0] — Zoho CRM IDE Extension (connected release)

The extension is now a **connected Zoho CRM IDE**. Renamed from "Zoho Deluge" to
**Zoho CRM IDE Extension** (the Deluge *language* support is unchanged).

- **In-editor Zoho sign-in** — connect via the native Accounts menu / status bar. Bring
  your own Zoho **Server-based** app credentials (no secret is shipped in the extension);
  the connection is scoped to the open workspace folder, with secrets stored in the OS
  keychain and never written into your project.
- **Org metadata sync** — pulls your org's modules, fields, and functions into the folder
  on sign-in (and on demand via **Pull Metadata**), reusing the `wanas-zcrm-extractor`
  engine. Off-by-default record counts keep pulls credit-free.
- **Org-aware IntelliSense** — `standalone.<fn>(…)` completion + signature help + hover for
  your real standalone functions, your module api_names inside `zoho.crm.*("…")`, and
  per-module field names + picklist hovers. The static catalog stays the floor; offline is
  unchanged.
- **Run / Pull / Push buttons** on standalone `.ds` editors — execute a function on the live
  org (with a confirmation and **no automatic retry**, so a function can't double-execute),
  pull its latest code, or push your edits.
- **Conflict safety** — pushes are blocked on true divergence (both local and live changed
  since your last pull) with a live diff and explicit override; overwrite-pulls always save
  a backup first.
- **Hardening** — token-refresh failures are classified (revoked → re-login; rate-limited →
  back off), field picklist hovers, and a **Clean Up Test Artifacts & Backups** command with
  a configurable retention.
- **Internal** — the reused Zoho CRM services are now consumed from the published
  [`@wanasapps/zcrm-core`](https://www.npmjs.com/package/@wanasapps/zcrm-core) package
  (replacing the local file-path bridge); the extension bundles it, so the `.vsix` stays
  self-contained.

## [0.1.0]

- **Signature help** — parameter hints inside `( … )` for built-in functions and
  `zoho.*` integration tasks, with the active parameter highlighted.
- **Type-aware completion** — after `.` on a variable, the suggestion list is
  narrowed to the functions for that value's inferred type (text/list/map/date-time/
  number/file), falling back to the full set when the type is unknown.
- **Deluge-specific lint rules** with quick-fixes — flags constructs that are invalid
  in Deluge: `while`/`do` loops, `throw` (→ `throws`), `finally`, and the word
  operators `and`/`or`/`not` (→ `&&`/`||`/`!`). One-click fixes where applicable.
- **Settings** — toggle the linter and individual checks via `deluge.lint.*`.
- **Snippets** — ready-made blocks for `invokeurl`/`invokeapi`/`sendmail`, CRM
  create/search/update, `for each`, `try/catch`, maps, and lists.
- **Encryption tasks** — `zoho.encryption.*` (Base64, AES, HMAC, SHA, MD5, URL
  encode/decode) added to completion and hover.
- Document formatting now indents `[ ]` and `( )` blocks (multi-line `invokeurl` /
  `invokeapi` / `sendmail` tasks), not just `{ }`.
- Automated test suite and GitHub Actions CI (build/test on push; publish to Open VSX
  on a version tag).

## [0.0.1]

- Initial release: syntax highlighting, context-aware completion, hover documentation,
  document formatting, and conservative diagnostics for Zoho Deluge.
