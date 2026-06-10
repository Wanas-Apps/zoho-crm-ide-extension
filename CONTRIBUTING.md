# Contributing to Zoho CRM IDE Extension

Thanks for your interest in improving this extension! Whether you're fixing a bug,
adding a missing Deluge function to autocomplete, or improving the docs, this guide
will get you set up.

Maintained by **[Wanas Apps](https://www.wanasapps.com)** · questions →
[support@wanasapps.com](mailto:support@wanasapps.com)

## Prerequisites

- **Node.js** 18 or newer (and npm)
- **VS Code** (or VSCodium / Cursor) 1.80 or newer

## Set up the project

```bash
git clone https://github.com/wanas-apps/zoho-crm-ide-extension.git
cd zoho-crm-ide-extension
npm install
npm run compile      # TypeScript build → out/ (used by tests + type-check)
npm run bundle       # esbuild bundle → dist/extension.js (the shipped artifact)
npm test             # compile + run the test suites
```

Use `npm run watch` to rebuild the bundle automatically as you edit.

## Run & debug the extension

1. Open the project folder in VS Code.
2. Press <kbd>F5</kbd> (**Run → Start Debugging**). This compiles the code and opens a
   second window — the **Extension Development Host** — with the extension loaded.
3. In that window, open or create a file ending in `.dg` (or set a file's language to
   **Deluge** via `Ctrl+K M`). Try autocomplete, hover, formatting, and the linter.
4. Edit the source, then click the **Reload** button (or `Ctrl+R` in the host window)
   to pick up your changes.

## Project structure

```
src/
  extension.ts                  # Activation — registers all providers
  data/
    delugeData.ts               # ⭐ Single source of truth for ALL IntelliSense data
  providers/
    completionProvider.ts       # Context-aware autocomplete
    hoverProvider.ts            # Hover documentation
    formattingProvider.ts       # Document formatting
    diagnosticsProvider.ts      # Linting (pure computeDiagnostics + registration)
  util/
    scan.ts                     # Shared string/comment-aware scanners
syntaxes/
  deluge.tmLanguage.json        # TextMate grammar (syntax highlighting)
language-configuration.json     # Brackets, comments, auto-closing, indentation
package.json                    # Extension manifest
```

## The most common contribution: adding to autocomplete & hover

**You almost never need to touch the providers.** All completion and hover content
lives in [`src/data/delugeData.ts`](src/data/delugeData.ts), and both the completion
and hover providers read from it automatically.

Each entry is a `DelugeSymbol`:

```ts
{
  label: 'toUpperCase',                       // shown in the list / matched on hover
  detail: 'toUpperCase()',                    // signature shown beside the label
  documentation: '**toUpperCase()**\n\n...',  // markdown shown in the details pane
  insertText: 'toUpperCase()'                 // optional snippet body ($1, $2 placeholders)
}
```

Add your entry to the **right array** for where it should appear:

| You want it to appear… | Add it to… |
|---|---|
| After `.` on a text value | `STRING_FUNCTIONS` |
| After `.` on a number / list / map / date-time / file / collection | the matching `*_FUNCTIONS` array |
| After `zoho.crm.` | `CRM_FUNCTIONS` |
| After `zoho.<otherservice>.` | `GENERIC_INTEGRATION_FUNCTIONS` |
| As a `zoho.` service namespace | `ZOHO_NAMESPACES` |
| As a `zoho.` system variable | `ZOHO_VARIABLES` |
| As a standalone task (`info`, `sendmail`, …) | `STATEMENT_TASKS` |
| As a keyword or data type | `KEYWORDS` / `DATA_TYPES` |

Member-function arrays are merged into `MEMBER_FUNCTIONS` (de-duplicated) for you — no
extra wiring needed. Run `npm run compile` and reload the host to verify.

> **Accuracy matters.** Deluge has real quirks (no `while`/`do` loops, `throws` not
> `throw`, symbol-only logical operators). Please verify new functions against the
> official docs at <https://www.zoho.com/deluge/help/> before adding them.

## Editing syntax highlighting

Highlighting rules live in
[`syntaxes/deluge.tmLanguage.json`](syntaxes/deluge.tmLanguage.json) (TextMate grammar).
To preview scopes, run **Developer: Inspect Editor Tokens and Scopes** from the Command
Palette in the Extension Development Host.

## Testing the linter

`computeDiagnostics(document)` in `diagnosticsProvider.ts` is a **pure function** — it
takes a document and returns diagnostics, so it can be tested without launching VS Code
by mocking the `vscode` module (`Position`, `Range`, `Diagnostic`, `DiagnosticSeverity`)
and passing a fake document with `lineAt`, `lineCount`, and `languageId`.

The linter is deliberately **conservative**: prefer missing an edge case over producing
a false positive. New checks should be validated against realistic multi-line Deluge
(e.g. `invokeurl` / `sendmail` blocks, map/list literals) to confirm they stay quiet.

## Coding style

- TypeScript with `strict` mode (see `tsconfig.json`) — no `any` shortcuts.
- Match the surrounding style: small focused functions, descriptive names, comments that
  explain *why* rather than *what*.
- Keep provider logic thin; put data in `delugeData.ts`.

## Submitting changes

1. Create a branch: `git checkout -b add-xyz`.
2. Make your change and run `npm run compile` (it must build with no errors).
3. Test it in the Extension Development Host.
4. Open a pull request describing **what** changed and **why**, with a short example if
   it affects editor behaviour.

## Packaging & publishing (maintainers)

```bash
npx @vscode/vsce package                 # builds a .vsix
npx ovsx publish -p <OPEN_VSX_TOKEN>     # publishes to the Open VSX Registry
```

The `publisher` field in `package.json` must match the Open VSX namespace owned by the
maintainer.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
