import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotStore } from './snapshotStore';
import { apiNameFromDsPath, isStandaloneDsPath, normalizeAndHash } from './conflictGuard';
import { fetchRemoteCode } from './remoteCode';

/**
 * Source Control integration for Zoho standalone functions. Surfaces a
 * "Zoho CRM" source-control section listing standalone `.ds` files whose
 * current content diverges from the base snapshot recorded at the last
 * pull/push — the exact set a Push would change.
 *
 * Detection is LOCAL ONLY (hash vs. recorded base), so opening files never
 * triggers Zoho API calls. Live code is fetched lazily, only when the user
 * explicitly opens a diff, and shown read-only via a `zoho-remote:` document.
 */

const REMOTE_SCHEME = 'zoho-remote';

export interface ZohoSourceControlDeps {
    snapshots: SnapshotStore;
    getOutputDir: () => string | undefined;
    isAuthenticated: () => boolean;
    format: (code: string) => string;
    output: vscode.OutputChannel;
}

export interface ZohoSourceControl {
    /** Recompute the modified-functions list. */
    refresh(): void;
}

export function registerZohoSourceControl(
    context: vscode.ExtensionContext,
    deps: ZohoSourceControlDeps
): ZohoSourceControl {
    const scm = vscode.scm.createSourceControl('zohoDeluge', 'Zoho CRM');
    scm.inputBox.visible = false; // no commit-message box — Push is per-function
    const group = scm.createResourceGroup('modified', 'Modified Functions');
    group.hideWhenEmpty = true;

    // Live code fetched for diffs, keyed by the `zoho-remote:` document path.
    const remoteContent = new Map<string, string>();
    const onDidChange = new vscode.EventEmitter<vscode.Uri>();
    const contentProvider: vscode.TextDocumentContentProvider = {
        onDidChange: onDidChange.event,
        provideTextDocumentContent: (uri) => remoteContent.get(uri.path) ?? ''
    };

    let running = false;
    let queued = false;
    const refresh = (): void => {
        void doRefresh();
    };
    async function doRefresh(): Promise<void> {
        if (running) {
            queued = true;
            return;
        }
        running = true;
        try {
            group.resourceStates = await computeModified(deps);
            scm.count = group.resourceStates.length;
        } catch (e) {
            deps.output.appendLine(`[scm] refresh failed: ${msg(e)}`);
        } finally {
            running = false;
            if (queued) {
                queued = false;
                void doRefresh();
            }
        }
    }

    context.subscriptions.push(
        scm,
        onDidChange,
        vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, contentProvider),
        vscode.commands.registerCommand('zohoDeluge.refreshSourceControl', refresh),
        vscode.commands.registerCommand('zohoDeluge.openFunctionDiff', (arg?: DiffArg) =>
            openFunctionDiff(arg, { deps, remoteContent, onDidChange })
        ),
        // A save to a standalone `.ds` may add/remove it from the modified list.
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (isStandaloneDsPath(doc.uri.fsPath)) {
                refresh();
            }
        })
    );

    refresh();
    return { refresh };
}

// ---------------------------------------------------------------------------
// Modified-set computation (local hashes only — no network).
// ---------------------------------------------------------------------------

async function computeModified(deps: ZohoSourceControlDeps): Promise<vscode.SourceControlResourceState[]> {
    const dir = deps.getOutputDir();
    if (!dir || !deps.isAuthenticated()) {
        return [];
    }
    const standaloneDir = path.join(dir, 'crm', 'functions', 'standalone');
    let files: string[];
    try {
        files = (await fs.promises.readdir(standaloneDir)).filter((f) => f.toLowerCase().endsWith('.ds'));
    } catch {
        return []; // nothing pulled yet
    }

    const states: vscode.SourceControlResourceState[] = [];
    for (const f of files) {
        const full = path.join(standaloneDir, f);
        if (!isStandaloneDsPath(full)) {
            continue;
        }
        const base = deps.snapshots.getByDsPath(full);
        if (!base) {
            continue; // untracked (never pulled/pushed) — no base to compare against
        }
        let local: string;
        try {
            local = await fs.promises.readFile(full, 'utf8');
        } catch {
            continue;
        }
        if (normalizeAndHash(local, deps.format) === base.hash) {
            continue; // unchanged since last pull/push
        }
        const uri = vscode.Uri.file(full);
        states.push({
            resourceUri: uri,
            command: { command: 'zohoDeluge.openFunctionDiff', title: 'Open Changes', arguments: [uri] },
            decorations: { tooltip: `Modified since last pull/push (base from ${base.pulledAt})` }
        });
    }
    return states;
}

// ---------------------------------------------------------------------------
// Diff: local `.ds` vs. live Zoho code (fetched on demand, read-only).
// ---------------------------------------------------------------------------

type DiffArg = vscode.Uri | { resourceUri?: vscode.Uri };

interface DiffCtx {
    deps: ZohoSourceControlDeps;
    remoteContent: Map<string, string>;
    onDidChange: vscode.EventEmitter<vscode.Uri>;
}

async function openFunctionDiff(arg: DiffArg | undefined, ctx: DiffCtx): Promise<void> {
    const local = toUri(arg) ?? activeDsUri();
    if (!local) {
        return;
    }
    const api = apiNameFromDsPath(local.fsPath);
    if (!api) {
        void vscode.window.showWarningMessage('This file is not a standalone Zoho function.');
        return;
    }
    try {
        const remote = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Fetching live standalone.${api}…` },
            () => fetchRemoteCode(api)
        );
        if (!remote) {
            void vscode.window.showInformationMessage(
                `standalone.${api} doesn't exist in this org yet — nothing to diff against.`
            );
            return;
        }
        const docPath = `/standalone.${api}.ds`; // `.ds` → Deluge highlighting in the diff
        ctx.remoteContent.set(docPath, safeFormat(remote.code, ctx.deps.format));
        const remoteUri = vscode.Uri.from({ scheme: REMOTE_SCHEME, path: docPath });
        ctx.onDidChange.fire(remoteUri); // refresh content if reopened with newer live code
        await vscode.commands.executeCommand(
            'vscode.diff',
            remoteUri,
            local,
            `standalone.${api} (Live ↔ Local)`
        );
    } catch (e) {
        ctx.deps.output.appendLine(`[scm] diff failed for ${api}: ${msg(e)}`);
        void vscode.window.showErrorMessage(`Could not fetch live code for standalone.${api}: ${msg(e)}`);
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toUri(arg?: DiffArg): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    const c = arg as { scheme?: unknown; fsPath?: unknown; resourceUri?: vscode.Uri };
    if (typeof c.scheme === 'string' && typeof c.fsPath === 'string') {
        return arg as vscode.Uri;
    }
    return c.resourceUri;
}

function activeDsUri(): vscode.Uri | undefined {
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.languageId === 'deluge' && ed.document.uri.scheme === 'file'
        ? ed.document.uri
        : undefined;
}

function safeFormat(code: string, format: (c: string) => string): string {
    try {
        return format(code);
    } catch {
        return code;
    }
}

function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
