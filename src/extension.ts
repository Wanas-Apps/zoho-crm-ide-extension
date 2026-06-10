import * as vscode from 'vscode';
import { getCompletionProvider } from './providers/completionProvider';
import { getHoverProvider } from './providers/hoverProvider';
import { getDocumentFormattingEditProvider } from './providers/formattingProvider';
import { registerDiagnostics } from './providers/diagnosticsProvider';
import { getSignatureHelpProvider } from './providers/signatureHelpProvider';
import { getCodeActionsProvider, CODE_ACTION_KINDS } from './providers/codeActionsProvider';
import { activateZoho } from './zoho/activate';
import { MetadataIndex } from './zoho/metadataIndex';

// Match `deluge` documents regardless of scheme so IntelliSense also works in
// untitled buffers and diff views, not just saved files.
const DELUGE_SELECTOR: vscode.DocumentSelector = { language: 'deluge' };

export function activate(context: vscode.ExtensionContext) {
    // One shared, initially-empty index of org-specific symbols. It is populated
    // after a Zoho pull; the providers hold this stable reference and read it
    // live, so org data lights up IntelliSense without re-registering anything.
    const metadataIndex = new MetadataIndex();

    // Completion: `.` triggers member/namespace completions; `"` opens the
    // module/field picker inside `zoho.crm.*("…")` argument strings (the
    // provider stays silent for `"` outside that context). VS Code triggers
    // identifier completions automatically, so no per-letter trigger chars.
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        DELUGE_SELECTOR,
        getCompletionProvider(metadataIndex),
        '.', '"'
    );

    const hoverProvider = vscode.languages.registerHoverProvider(
        DELUGE_SELECTOR,
        getHoverProvider(metadataIndex)
    );

    const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
        DELUGE_SELECTOR,
        getDocumentFormattingEditProvider()
    );

    // Signature help: parameter hints inside `( … )`.
    const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        DELUGE_SELECTOR,
        getSignatureHelpProvider(metadataIndex),
        '(', ','
    );

    // Quick-fixes for Deluge-specific lint diagnostics (throw→throws, and→&&, …).
    const codeActionsProvider = vscode.languages.registerCodeActionsProvider(
        DELUGE_SELECTOR,
        getCodeActionsProvider(),
        { providedCodeActionKinds: CODE_ACTION_KINDS }
    );

    context.subscriptions.push(
        completionProvider,
        hoverProvider,
        formattingProvider,
        signatureHelpProvider,
        codeActionsProvider
    );

    // Lightweight, conservative linting (unbalanced brackets, unclosed comments,
    // missing semicolons, divide-by-zero, and Deluge-invalid keywords).
    registerDiagnostics(context);

    // Zoho connection + login UI + metadata sync (M1–M4). Non-blocking. The
    // metadataIndex is loaded after a pull and re-loaded by a file watcher.
    activateZoho(context, metadataIndex);
}

export function deactivate() {}
