import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    FunctionOps,
    FnArg,
    buildArgMap,
    deriveApiNameFromPath,
    isStandalonePath,
    needsPushBeforeRun,
    hintFor
} from './functionOps';
import { renderTestResult, renderPullResult, renderPushResult } from './runRenderer';
import { ConflictGuard } from './conflictGuard.vscode';

export interface FunctionCommandDeps {
    ops: FunctionOps;
    output: vscode.OutputChannel;
    conflictGuard?: ConflictGuard;
}

/** Maintain the `zohoDeluge.isStandaloneFn` context key driving the buttons. */
export function updateStandaloneContext(editor: vscode.TextEditor | undefined): void {
    const isStandalone =
        !!editor &&
        editor.document.languageId === 'deluge' &&
        isStandalonePath(editor.document.uri.fsPath);
    void vscode.commands.executeCommand('setContext', 'zohoDeluge.isStandaloneFn', isStandalone);
}

/**
 * What a run/pull/push command may receive: nothing (palette → active editor),
 * a `Uri` (editor-title button), or a tree node bearing a `resourceUri`
 * (the functions side-bar view's inline actions).
 */
export type FunctionCommandArg = vscode.Uri | { resourceUri?: vscode.Uri } | undefined;

export function registerFunctionCommands(context: vscode.ExtensionContext, deps: FunctionCommandDeps): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('zohoDeluge.runFunction', (arg?: FunctionCommandArg) => runFunction(arg, deps)),
        vscode.commands.registerCommand('zohoDeluge.pullFunction', (arg?: FunctionCommandArg) => pullFunction(arg, deps)),
        vscode.commands.registerCommand('zohoDeluge.pushFunction', (arg?: FunctionCommandArg) => pushFunction(arg, deps)),
        vscode.commands.registerCommand('zohoDeluge.createFunction', () => createFunctionCmd(deps))
    );
}

// --- handlers ---------------------------------------------------------------

async function runFunction(arg: FunctionCommandArg, deps: FunctionCommandDeps): Promise<void> {
    const target = resolveDsUri(arg);
    if (!target) {
        void vscode.window.showWarningMessage('Open a Deluge (.ds) function to run.');
        return;
    }
    try {
        let resolved = await deps.ops.resolveForRun(target.fsPath);

        // A function that exists locally but not yet on the org can't be tested
        // (Zoho's test endpoint requires an existing function). Offer
        // to push/create it first, then run against the now-live function.
        if (needsPushBeforeRun(resolved)) {
            const pushed = await pushBeforeRun(target, resolved.apiName, deps);
            if (!pushed) {
                return;
            }
            resolved = await deps.ops.resolveForRun(target.fsPath);
        }

        const args = await collectArgs(resolved.args);
        if (args === undefined) {
            return; // cancelled
        }
        const fnIdentifier = `${resolved.namespace || 'standalone'}.${resolved.apiName}`;
        const confirm = await vscode.window.showWarningMessage(
            `Run "${fnIdentifier}" on your LIVE Zoho org? It executes the function — it may create/update records, send email/SMS, and consume credits.`,
            { modal: true },
            'Run on live org'
        );
        if (confirm !== 'Run on live org') {
            return;
        }
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running ${fnIdentifier}…`, cancellable: false },
            () => deps.ops.run(resolved, args)
        );
        deps.output.appendLine(renderTestResult(result));
        deps.output.show(true);
        if (result.success) {
            void vscode.window.showInformationMessage(`Run succeeded: ${fnIdentifier}.`);
        } else {
            void vscode.window
                .showWarningMessage(`Run reported a failure for ${fnIdentifier}.`, 'Show Output')
                .then((pick) => {
                    if (pick === 'Show Output') {
                        deps.output.show(true);
                    }
                });
        }
    } catch (e) {
        reportFnError(e, deps.output);
    }
}

/**
 * The function isn't on the org yet — prompt to push (creating it if needed)
 * before running. Returns true when it now exists live and the run may proceed.
 */
async function pushBeforeRun(target: vscode.Uri, apiName: string, deps: FunctionCommandDeps): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
        `"standalone.${apiName}" isn't on your Zoho org yet, so it can't be run. Push it to Zoho first, then run?`,
        { modal: true, detail: 'Zoho can only test a function that already exists in the org.' },
        'Push & Run'
    );
    if (pick !== 'Push & Run') {
        return false;
    }
    try {
        // Persist the editor so the pushed code matches what you see.
        const doc = findOpenDoc(target.fsPath);
        if (doc?.isDirty) {
            await doc.save();
        }
        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Pushing standalone.${apiName}…`, cancellable: false },
            async () => {
                try {
                    return await deps.ops.push(target.fsPath);
                } catch (e) {
                    // Brand-new function → create it from this file, then it exists.
                    if ((e as { code?: string })?.code === 'FN_NOT_FOUND') {
                        return deps.ops.create(apiName, { fromFile: target.fsPath });
                    }
                    throw e;
                }
            }
        );
        if (deps.conflictGuard) {
            await deps.conflictGuard.recordPulled(target.fsPath);
        }
        deps.output.appendLine(renderPushResult({ apiName: res.apiName ?? apiName, filePath: target.fsPath }));
        deps.output.show(true);
        return true;
    } catch (e) {
        reportFnError(e, deps.output);
        return false;
    }
}

async function pullFunction(arg: FunctionCommandArg, deps: FunctionCommandDeps): Promise<void> {
    const target = resolveDsUri(arg);
    if (!target) {
        return;
    }
    const apiName = deriveApiNameFromPath(target.fsPath);
    if (!apiName) {
        void vscode.window.showWarningMessage('Could not determine the function name from this file.');
        return;
    }
    try {
        if (deps.conflictGuard) {
            const doc = findOpenDoc(target.fsPath);
            const g = await deps.conflictGuard.guardOverwritePull(target.fsPath, { isDirty: !!doc?.isDirty });
            if (!g.proceed) {
                return;
            }
        }
        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Pulling standalone.${apiName}…`, cancellable: false },
            () => deps.ops.pull(apiName)
        );
        if (deps.conflictGuard) {
            await deps.conflictGuard.recordPulled(res.filePath);
        }
        deps.output.appendLine(renderPullResult({ apiName: res.apiName ?? apiName, filePath: res.filePath }));
        deps.output.show(true);
        const doc = await vscode.workspace.openTextDocument(res.filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        void vscode.window.showInformationMessage(`Pulled standalone.${apiName} from Zoho.`);
    } catch (e) {
        reportFnError(e, deps.output);
    }
}

async function pushFunction(arg: FunctionCommandArg, deps: FunctionCommandDeps): Promise<void> {
    const target = resolveDsUri(arg);
    if (!target) {
        return;
    }
    try {
        const doc = findOpenDoc(target.fsPath);
        if (doc?.isDirty) {
            await doc.save();
        }
        const localCode = fs.readFileSync(target.fsPath, 'utf8');

        let alreadyConfirmed = false;
        if (deps.conflictGuard) {
            const g = await deps.conflictGuard.guardPush(target.fsPath, localCode);
            if (!g.proceed) {
                return;
            }
            alreadyConfirmed = !!g.prompted;
        }
        if (!alreadyConfirmed) {
            const confirm = await vscode.window.showWarningMessage(
                `Push your local "${path.basename(target.fsPath)}" to the LIVE Zoho org, overwriting the saved function?`,
                { modal: true },
                'Push to live org'
            );
            if (confirm !== 'Push to live org') {
                return;
            }
        }
        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Pushing ${path.basename(target.fsPath)}…`, cancellable: false },
            () => deps.ops.push(target.fsPath)
        );
        if (deps.conflictGuard) {
            await deps.conflictGuard.recordPulled(target.fsPath);
        }
        deps.output.appendLine(renderPushResult({ apiName: res.apiName, filePath: target.fsPath }));
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Pushed standalone.${res.apiName} to Zoho.`);
    } catch (e) {
        if ((e as { code?: string })?.code === 'FN_NOT_FOUND') {
            await offerCreate(target, deps);
            return;
        }
        reportFnError(e, deps.output);
    }
}

async function createFunctionCmd(deps: FunctionCommandDeps): Promise<void> {
    const active = vscode.window.activeTextEditor;
    const activePath =
        active && active.document.languageId === 'deluge' && isStandalonePath(active.document.uri.fsPath)
            ? active.document.uri.fsPath
            : undefined;
    const suggested = activePath ? deriveApiNameFromPath(activePath) : undefined;

    const apiName = await vscode.window.showInputBox({
        title: 'Create Standalone Function',
        prompt: 'New function api_name',
        value: suggested,
        ignoreFocusOut: true,
        validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(v.trim()) ? undefined : 'Use letters, digits and underscores; start with a letter.')
    });
    if (!apiName) {
        return;
    }
    const name = apiName.trim();
    const fromFile = activePath && suggested && suggested.toLowerCase() === name.toLowerCase() ? activePath : undefined;
    try {
        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating standalone.${name}…`, cancellable: false },
            () => deps.ops.create(name, fromFile ? { fromFile } : {})
        );
        if (deps.conflictGuard) {
            await deps.conflictGuard.recordPulled(res.filePath);
        }
        const doc = await vscode.workspace.openTextDocument(res.filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        void vscode.window.showInformationMessage(`Created standalone.${res.apiName} in Zoho${res.pushed ? ' (code pushed)' : ''}.`);
    } catch (e) {
        reportFnError(e, deps.output);
    }
}

async function offerCreate(target: vscode.Uri, deps: FunctionCommandDeps): Promise<void> {
    const apiName = deriveApiNameFromPath(target.fsPath);
    if (!apiName) {
        return;
    }
    const pick = await vscode.window.showWarningMessage(
        `"${apiName}" doesn't exist in this org yet. Create it from this file and push?`,
        { modal: true },
        'Create + push'
    );
    if (pick !== 'Create + push') {
        return;
    }
    try {
        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating standalone.${apiName}…`, cancellable: false },
            () => deps.ops.create(apiName, { fromFile: target.fsPath })
        );
        if (deps.conflictGuard) {
            await deps.conflictGuard.recordPulled(res.filePath);
        }
        const doc = await vscode.workspace.openTextDocument(res.filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        void vscode.window.showInformationMessage(`Created standalone.${res.apiName} in Zoho.`);
    } catch (e) {
        reportFnError(e, deps.output);
    }
}

// --- helpers ----------------------------------------------------------------

async function collectArgs(args: FnArg[]): Promise<Record<string, unknown> | undefined> {
    if (!args.length) {
        return {};
    }
    const answers: Record<string, string> = {};
    for (const a of args) {
        const val = await vscode.window.showInputBox({
            title: `Argument: ${a.name}`,
            prompt: `${a.name} (${a.type})`,
            ignoreFocusOut: true
        });
        if (val === undefined) {
            return undefined; // cancelled
        }
        answers[a.name] = val;
    }
    return buildArgMap(args, answers);
}

function resolveDsUri(arg?: FunctionCommandArg): vscode.Uri | undefined {
    const uri = asUri(arg);
    if (uri && uri.scheme === 'file') {
        return uri;
    }
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'deluge' && ed.document.uri.scheme === 'file') {
        return ed.document.uri;
    }
    return undefined;
}

/** Duck-type the command argument to a `Uri` — accepts a bare `Uri` (editor
 *  title / palette) or a tree node bearing a `resourceUri` (side-bar view).
 *  Avoids `instanceof vscode.Uri`, which is unreliable under the test mock. */
function asUri(arg: FunctionCommandArg): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    const candidate = arg as { scheme?: unknown; fsPath?: unknown; resourceUri?: vscode.Uri };
    if (typeof candidate.scheme === 'string' && typeof candidate.fsPath === 'string') {
        return arg as vscode.Uri;
    }
    return candidate.resourceUri;
}

function findOpenDoc(fsPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
}

function reportFnError(e: unknown, output: vscode.OutputChannel): void {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = hintFor(e);
    output.appendLine(`[error] ${msg}${hint ? ' — ' + hint : ''}`);
    void vscode.window.showErrorMessage(hint ? `${msg} ${hint}` : msg);
}
