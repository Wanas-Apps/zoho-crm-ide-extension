import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MetadataIndex, FunctionGroup, FunctionEntry } from './metadataIndex';
import { SessionLock } from './sessionLock';
import { parseArtifactName } from './retention';

/**
 * Side-bar tree views for the "Zoho CRM IDE" activity-bar container. Three
 * views surface what the (otherwise invisible) connection + metadata machinery
 * already knows:
 *
 *  - Connection         — the signed-in org + quick account actions
 *  - Standalone Functions — the pulled functions, with inline Run/Pull/Push
 *  - Modules & Fields   — modules expanding to their fields
 *
 * The providers read live from the shared `MetadataIndex` and `SessionLock`;
 * `registerZohoTreeViews` returns a `refreshAll()` the host calls after sign-in/
 * out and after the index reloads. All items use theme icons/colors so they
 * adapt to the user's color theme.
 */

export interface ZohoTreeViews {
    refreshAll(): void;
}

const FUNCTION_CONTEXT = 'zohoFunction';

export function registerZohoTreeViews(
    context: vscode.ExtensionContext,
    deps: { index: MetadataIndex; sessionLock: SessionLock }
): ZohoTreeViews {
    const connection = new ConnectionTreeProvider(deps.sessionLock);
    const functions = new FunctionsTreeProvider(deps.index);
    const modules = new ModulesTreeProvider(deps.index);
    const runHistory = new RunHistoryProvider(deps.index);

    const refreshAll = (): void => {
        connection.refresh();
        functions.refresh();
        modules.refresh();
        runHistory.refresh();
    };

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('zohoDeluge.connectionView', connection),
        vscode.window.registerTreeDataProvider('zohoDeluge.functionsView', functions),
        vscode.window.registerTreeDataProvider('zohoDeluge.modulesView', modules),
        vscode.window.registerTreeDataProvider('zohoDeluge.runHistoryView', runHistory),
        vscode.commands.registerCommand('zohoDeluge.refreshViews', refreshAll)
    );

    return { refreshAll };
}

// ---------------------------------------------------------------------------
// Connection view — flat list of the active session + quick actions.
// ---------------------------------------------------------------------------

class ConnectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly sessionLock: SessionLock) {}

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const active = this.sessionLock.get();
        if (!active) {
            // Signed-out state is handled by the view's welcome content.
            return [];
        }
        const org = leaf(active.org, new vscode.ThemeIcon('account'));
        org.description = active.email;
        org.tooltip = 'Signed-in Zoho CRM organization';

        const dc = leaf('Data center', new vscode.ThemeIcon('globe'));
        dc.description = `${active.dc} · ${active.apiDomain}`;

        return [
            org,
            dc,
            action('Pull metadata', 'cloud-download', 'zohoDeluge.pullMetadata'),
            action('Account…', 'gear', 'zohoDeluge.showAccount'),
            action('Show output log', 'output', 'zohoDeluge.showOutput'),
            action('Sign out', 'sign-out', 'zohoDeluge.logout')
        ];
    }
}

// ---------------------------------------------------------------------------
// Functions view — ALL functions, collapsible groups by category (scope).
// Standalone items get inline Run/Pull/Push; other categories get Pull + open
// (only standalone functions are executable via Zoho's API).
// ---------------------------------------------------------------------------

class FnCategoryItem extends vscode.TreeItem {
    constructor(public readonly group: FunctionGroup) {
        super(
            `${group.category} (${group.functions.length})`,
            group.category === 'Standalone'
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        this.contextValue = 'zohoFnCategory';
    }
}

class FunctionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly index: MetadataIndex) {}

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element instanceof FnCategoryItem) {
            return element.group.functions.map(buildFunctionItem);
        }
        if (element) {
            return [];
        }
        // Top level: one collapsible node per category (Standalone first).
        return this.index.getFunctionGroups().map((g) => new FnCategoryItem(g));
    }
}

function buildFunctionItem(entry: FunctionEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.apiName, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('symbol-function');
    if (entry.name && entry.name !== entry.apiName) {
        item.description = entry.name;
    }
    // All function categories (standalone, automation, button, schedule, related_list, signals) support Run/Pull/Push/Diff.
    item.contextValue = FUNCTION_CONTEXT;
    if (entry.dsPath) {
        item.resourceUri = vscode.Uri.file(entry.dsPath);
        item.command = { command: 'vscode.open', title: 'Open Function', arguments: [item.resourceUri] };
        item.tooltip = `${entry.category} function`;
    } else {
        item.tooltip = `${entry.category} function — not pulled yet`;
    }
    return item;
}

// ---------------------------------------------------------------------------
// Modules, Fields & Layouts view — modules expand to Fields and Layouts.
// ---------------------------------------------------------------------------

class ModuleItem extends vscode.TreeItem {
    constructor(public readonly moduleName: string, label: string, detail?: string) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('database');
        this.contextValue = 'zohoModule';
        if (detail) {
            this.tooltip = detail;
        }
    }
}

class ModuleCategoryNode extends vscode.TreeItem {
    constructor(public readonly moduleName: string, public readonly nodeType: 'fields' | 'layouts', count: number) {
        super(nodeType === 'fields' ? `Fields (${count})` : `Layouts (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon(nodeType === 'fields' ? 'symbol-field' : 'layout');
        this.contextValue = nodeType === 'fields' ? 'zohoFieldsCategory' : 'zohoLayoutsCategory';
    }
}

class FieldItem extends vscode.TreeItem {
    constructor(public readonly moduleName: string, public readonly fieldId: string, label: string, detail?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('symbol-field');
        this.contextValue = 'zohoField';
        this.description = detail;
    }
}

class LayoutItem extends vscode.TreeItem {
    constructor(public readonly moduleName: string, public readonly layoutId: string, label: string, status?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('layout');
        this.contextValue = 'zohoLayout';
        this.description = status ? `${status} (${layoutId})` : layoutId;
    }
}

class ModulesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly index: MetadataIndex) {}

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element instanceof ModuleItem) {
            const fieldsCount = this.index.getFieldSymbols(element.moduleName).length;
            const layoutsCount = this.index.getLayouts(element.moduleName).length;
            return [
                new ModuleCategoryNode(element.moduleName, 'fields', fieldsCount),
                new ModuleCategoryNode(element.moduleName, 'layouts', layoutsCount)
            ];
        }
        if (element instanceof ModuleCategoryNode) {
            if (element.nodeType === 'fields') {
                return this.index.getFieldSymbols(element.moduleName).map((sym) => {
                    const item = new FieldItem(element.moduleName, sym.label, sym.label, sym.detail);
                    if (sym.documentation) {
                        item.tooltip = new vscode.MarkdownString(sym.documentation);
                    }
                    return item;
                });
            } else {
                return this.index.getLayouts(element.moduleName).map((lay) => {
                    return new LayoutItem(element.moduleName, lay.id, lay.name, lay.status);
                });
            }
        }
        return this.index.getModuleCompletions().map((sym) => new ModuleItem(sym.label, sym.label, sym.detail));
    }
}

// ---------------------------------------------------------------------------
// Run History view (Panel) — recent test-run artifacts, newest first.
// ---------------------------------------------------------------------------

class RunHistoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly index: MetadataIndex) {}

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<vscode.TreeItem[]> {
        const folder = this.index.getFolder();
        if (!folder) {
            return [];
        }
        const dir = path.join(folder, 'crm', 'function_tests');
        let names: string[];
        try {
            names = await fs.promises.readdir(dir);
        } catch {
            return []; // no runs yet → welcome content
        }
        const runs = names
            .map((name) => ({ name, parsed: parseArtifactName(name, '.json') }))
            .filter((r): r is { name: string; parsed: { apiName: string; ts: string } } => r.parsed !== null)
            .sort((a, b) => b.parsed.ts.localeCompare(a.parsed.ts)); // newest first

        return runs.map((r) => {
            const item = new vscode.TreeItem(r.parsed.apiName, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('history');
            item.description = formatRunTimestamp(r.parsed.ts);
            item.contextValue = 'zohoRunArtifact';
            const uri = vscode.Uri.file(path.join(dir, r.name));
            item.resourceUri = uri;
            item.tooltip = `Test run of standalone.${r.parsed.apiName}`;
            item.command = { command: 'vscode.open', title: 'Open Run Result', arguments: [uri] };
            return item;
        });
    }
}

/** `2026-06-09T12-30-45-123Z` → `2026-06-09 12:30:45` (the writer dash-escapes
 *  the `:`/`.` in the ISO stamp). Falls back to the raw stamp if it doesn't match. */
function formatRunTimestamp(ts: string): string {
    const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : ts;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

function leaf(label: string, icon: vscode.ThemeIcon): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = icon;
    return item;
}

function action(label: string, codicon: string, command: string): vscode.TreeItem {
    const item = leaf(label, new vscode.ThemeIcon(codicon));
    item.command = { command, title: label };
    return item;
}
