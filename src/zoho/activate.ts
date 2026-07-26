import * as vscode from 'vscode';
import * as path from 'path';
import { initZohoConnection, getZohoConnection } from './connection';
import { pruneDir } from './retention';
import { SessionLock } from './sessionLock';
import { ZohoStatusBar } from './statusBar';
import { ZohoAuthProvider, PROVIDER_ID, PROVIDER_LABEL } from './zohoAuthProvider';
import { SyncLock } from './syncLock';
import { MetadataSync } from './metadataSync';
import { MetadataIndex } from './metadataIndex';
import { SnapshotStore } from './snapshotStore';
import { ConflictGuard } from './conflictGuard.vscode';
import { fetchRemoteCode } from './remoteCode';
import { formatDeluge } from 'wanas-zcrm-extractor/src/utils/delugeFormatter';
import { FunctionOps } from './functionOps';
import { functionServicePort } from './functionServiceBridge';
import { registerFunctionCommands, updateStandaloneContext } from './functionCommands';
import { registerZohoTreeViews } from './treeViews';
import { registerZohoSourceControl } from './sourceControl';
import { activateMcp } from './mcp/mcpActivate';
import { CustomizationBridge } from './customizationBridge';
import { registerCustomizationCommands } from './customizationCommands';
import { registerApiCommands } from './apiCommands';

/**
 * Wire up the Zoho connection, the AuthenticationProvider (native Accounts
 * menu), the status bar, metadata sync (pull / auto-pull), dynamic-IntelliSense
 * indexing, and commands. Non-blocking: language features keep working
 * regardless of connection state.
 */
export function activateZoho(context: vscode.ExtensionContext, metadataIndex: MetadataIndex): void {
    const statusBar = new ZohoStatusBar();
    context.subscriptions.push(statusBar);
    const sessionLock = new SessionLock(context.workspaceState);
    const syncLock = new SyncLock();

    // Activity-bar container + side-bar views (Connection / Functions / Modules).
    // They read live from the shared index + session; we refresh them on sign-in/
    // out and after every index (re)load below.
    const treeViews = registerZohoTreeViews(context, { index: metadataIndex, sessionLock });

    let provider: ZohoAuthProvider | undefined;
    let metadataSync: MetadataSync | undefined;
    let conflictGuard: ConflictGuard | undefined;

    const ready = initZohoConnection(context).then((connection) => {
        metadataSync = new MetadataSync({
            isAuthenticated: () => connection.isAuthenticated(),
            getOutputDir: () => connection.outputDir,
            getConcurrency: () => connection.config.getConcurrency(),
            lock: syncLock
        });

        // --- Conflict safety (M4.5): base snapshots in workspaceState ----------
        const snapshots = new SnapshotStore(context.workspaceState, () => sessionLock.get()?.orgId);
        conflictGuard = new ConflictGuard({
            store: snapshots,
            fetchRemote: fetchRemoteCode,
            format: formatDeluge,
            output: connection.output,
            getOutputDir: () => connection.outputDir
        });

        // --- Source Control: modified standalone functions (M5 UI) -------------
        const sourceControl = registerZohoSourceControl(context, {
            snapshots,
            getOutputDir: () => connection.outputDir,
            isAuthenticated: () => connection.isAuthenticated(),
            format: formatDeluge,
            output: connection.output
        });

        // --- Run / Pull / Push (M5) -------------------------------------------
        const functionOps = new FunctionOps({
            svc: functionServicePort,
            getOutputDir: () => connection.outputDir,
            isAuthenticated: () => connection.isAuthenticated(),
            getCurrentApiDomain: () => connection.auth.getApiBaseUrl(),
            getSessionApiDomain: () => sessionLock.get()?.apiDomain
        });
        registerFunctionCommands(context, { ops: functionOps, output: connection.output, conflictGuard });
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => updateStandaloneContext(ed)));
        updateStandaloneContext(vscode.window.activeTextEditor);

        // --- Customization operations (Modules, Fields, Layouts) -------------
        const customizationBridge = new CustomizationBridge({
            isAuthenticated: () => connection.isAuthenticated()
        });
        registerCustomizationCommands(context, {
            bridge: customizationBridge,
            output: connection.output,
            index: metadataIndex
        });

        // --- CLI parity API commands (Universal API, COQL, Audit Log, etc.) ----
        registerApiCommands(context, {
            output: connection.output,
            isAuthenticated: () => connection.isAuthenticated(),
            getOutputDir: () => connection.outputDir
        });

        // --- Embedded MCP server (M11): expose org tools to LLM agents ----------
        activateMcp(context, { connection, functionOps });

        const onSignedIn = () => {
            if (!getConfig().get<boolean>('autoPullOnSignIn', true)) {
                return;
            }
            void runPull(metadataSync!, statusBar, sessionLock, conflictGuard);
        };

        provider = new ZohoAuthProvider(connection, sessionLock, statusBar, onSignedIn);
        context.subscriptions.push(
            vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, PROVIDER_LABEL, provider, {
                supportsMultipleAccounts: false
            }),
            provider,
            // Drop base snapshots when the session ends (they're org-scoped).
            provider.onDidChangeSessions((e) => {
                if (e.removed && e.removed.length) {
                    void snapshots.clearAll();
                }
            }),
            // Reflect sign-in / sign-out / switch-org in the side-bar views + SCM.
            provider.onDidChangeSessions(() => {
                treeViews.refreshAll();
                sourceControl.refresh();
            })
        );

        // --- Dynamic IntelliSense indexing (M4) ---------------------------------
        // Serialize index loads so concurrent triggers can't interleave.
        let chain: Promise<void> = Promise.resolve();
        const reloadIndex = (): Promise<void> => {
            chain = chain.then(async () => {
                const dir = connection.outputDir;
                if (!dir) {
                    return;
                }
                try {
                    await metadataIndex.load(dir);
                    treeViews.refreshAll();
                } catch (e) {
                    connection.output.appendLine(`[WARN] metadata index load failed: ${errMsg(e)}`);
                }
            });
            return chain;
        };

        // Load any already-pulled store so IntelliSense works before a new pull.
        void reloadIndex();

        // Re-index when a pull finishes (the lock releases) and when the store
        // changes on disk — but never while a pull is actively rewriting it.
        context.subscriptions.push(
            syncLock.onChange((locked) => {
                if (!locked) {
                    void reloadIndex();
                }
            })
        );
        if (connection.folder) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(connection.folder, '.zcrm/.store/*.json')
            );
            const onStoreChange = () => {
                if (!syncLock.isLocked()) {
                    void reloadIndex();
                }
            };
            watcher.onDidChange(onStoreChange);
            watcher.onDidCreate(onStoreChange);
            watcher.onDidDelete(onStoreChange);
            context.subscriptions.push(watcher);

            // Keep the panel's Run History in sync as test runs are written/pruned.
            const runsWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(connection.folder, 'crm/function_tests/*.json')
            );
            const refreshViews = () => treeViews.refreshAll();
            runsWatcher.onDidChange(refreshViews);
            runsWatcher.onDidCreate(refreshViews);
            runsWatcher.onDidDelete(refreshViews);
            context.subscriptions.push(runsWatcher);
        }

        return provider;
    });
    ready.catch((err) => console.error('[Zoho CRM IDE] connection init failed:', err));

    const withProvider = async (fn: (p: ZohoAuthProvider) => Promise<void> | void): Promise<void> => {
        const p = provider ?? (await ready);
        await fn(p);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('zohoDeluge.login', () =>
            withProvider((p) => p.signIn().then(() => undefined)).catch((e) =>
                vscode.window.showErrorMessage(`Zoho sign-in failed: ${errMsg(e)}`)
            )
        ),
        vscode.commands.registerCommand('zohoDeluge.logout', () =>
            withProvider((p) => p.signOut()).catch((e) =>
                vscode.window.showErrorMessage(`Zoho sign-out failed: ${errMsg(e)}`)
            )
        ),
        vscode.commands.registerCommand('zohoDeluge.showAccount', () =>
            withProvider((p) => showAccount(p, sessionLock)).catch(() => undefined)
        ),
        vscode.commands.registerCommand('zohoDeluge.pullMetadata', async () => {
            await ready;
            if (metadataSync) {
                await runPull(metadataSync, statusBar, sessionLock, conflictGuard);
            }
        }),
        vscode.commands.registerCommand('zohoDeluge.showOutput', () => {
            void ready.then(() => getZohoConnection()?.output.show());
        }),
        vscode.commands.registerCommand('zohoDeluge.cleanupTestArtifacts', async () => {
            await ready;
            const connection = getZohoConnection();
            const dir = connection?.outputDir;
            if (!dir) {
                void vscode.window.showWarningMessage('Open the workspace folder bound to your org first.');
                return;
            }
            const keep = connection!.config.getRetention();
            const tests = await pruneDir(path.join(dir, 'crm', 'function_tests'), '.json', keep);
            const backups = await pruneDir(path.join(dir, '.zcrm', '.backups'), '.ds', keep);
            void vscode.window.showInformationMessage(
                `Cleanup complete — removed ${tests.deleted + backups.deleted} old artifact(s) (kept newest ${keep} per function).`
            );
        })
    );
}

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('zohoDeluge');
}

/** Run a metadata pull with a progress notification + status-bar working state. */
async function runPull(sync: MetadataSync, statusBar: ZohoStatusBar, sessionLock: SessionLock, guard?: ConflictGuard): Promise<void> {
    const restore = () => {
        const active = sessionLock.get();
        if (active) {
            statusBar.showLoggedIn(active.org);
        } else {
            statusBar.showLoggedOut();
        }
    };
    const withCounts = getConfig().get<boolean>('pullRecordCounts', false);
    try {
        statusBar.showWorking('Pulling Zoho metadata…');
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Pulling Zoho CRM metadata…',
                cancellable: false
            },
            async (progress) =>
                sync.pull({
                    withCounts,
                    onProgress: (p) => progress.report({ message: p.message })
                })
        );
        // Record per-function base snapshots from the freshly-pulled .ds files
        // so the conflict guard can detect divergence on a later Push.
        if (guard) {
            try {
                await guard.recordManyFromFolder(result.outputDir);
            } catch {
                /* snapshotting is best-effort */
            }
        }
        // New base snapshots → recompute the Source Control "modified" list.
        void vscode.commands.executeCommand('zohoDeluge.refreshSourceControl');
        const mods = typeof result.stats?.modulesCount === 'number' ? result.stats.modulesCount : undefined;
        const summary =
            `Zoho metadata synced to ${result.outputDir}` +
            (mods !== undefined ? ` — ${mods} modules` : '') +
            (result.errorCount ? `, ${result.errorCount} item(s) had errors (see Zoho output).` : '.');
        if (result.errorCount) {
            void vscode.window.showWarningMessage(summary);
        } else {
            void vscode.window.showInformationMessage(summary);
        }
    } catch (e) {
        void vscode.window.showErrorMessage(`Zoho metadata pull failed: ${errMsg(e)}`);
    } finally {
        restore();
    }
}

interface AccountAction extends vscode.QuickPickItem {
    action?: 'logout' | 'output' | 'switch' | 'pull' | 'cleanup';
}

async function showAccount(provider: ZohoAuthProvider, sessionLock: SessionLock): Promise<void> {
    const active = sessionLock.get();
    if (!active) {
        await provider.signIn();
        return;
    }
    const items: AccountAction[] = [
        { label: `$(account) ${active.org}`, description: active.email, detail: `Data center: ${active.dc} · ${active.apiDomain}` },
        { label: '$(sync) Pull metadata', action: 'pull' },
        { label: '$(arrow-swap) Switch org…', action: 'switch' },
        { label: '$(trash) Clean up test artifacts & backups', action: 'cleanup' },
        { label: '$(output) Show Zoho output', action: 'output' },
        { label: '$(sign-out) Sign out', action: 'logout' }
    ];
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Zoho CRM account',
        placeHolder: `${active.org}${active.email ? ` (${active.email})` : ''}`
    });
    if (!pick) {
        return;
    }
    if (pick.action === 'logout') {
        await provider.signOut();
    } else if (pick.action === 'switch') {
        await provider.signIn();
    } else if (pick.action === 'pull') {
        await vscode.commands.executeCommand('zohoDeluge.pullMetadata');
    } else if (pick.action === 'cleanup') {
        await vscode.commands.executeCommand('zohoDeluge.cleanupTestArtifacts');
    } else if (pick.action === 'output') {
        getZohoConnection()?.output.show();
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
