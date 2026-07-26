import * as fs from 'fs';
import * as path from 'path';
import { parseSignature } from 'wanas-zcrm-extractor/src/utils/delugeSignature';
import { DelugeSymbol } from '../data/delugeData';
import { DynamicSymbolSource } from '../data/dynamicSource';
import { FieldMetaReader, renderFieldHover } from './fieldMeta';

interface FnArg {
    type: string;
    name: string;
}

/** One function of any category, with the path to its pulled `.ds` (if present). */
export interface FunctionEntry {
    apiName: string;
    name: string;
    category: string;
    dsPath?: string;
}

/** Functions of one category (scope), e.g. Standalone / Automation / Button. */
export interface FunctionGroup {
    category: string;
    functions: FunctionEntry[];
}

/**
 * In-memory index of org-specific Zoho metadata, built from the compact
 * `.zcrm/.store/*.json` produced by a pull. Implements DynamicSymbolSource so
 * the language providers can fold these symbols into completion / signature /
 * hover. `load()` swaps the internal data; the providers hold a stable
 * reference, so a re-pull never re-registers anything.
 *
 * Pure Node (fs only) → unit-testable against a real pulled folder.
 */
export class MetadataIndex implements DynamicSymbolSource {
    private folder: string | undefined;
    private standalone: DelugeSymbol[] = [];
    private standaloneByKey = new Map<string, DelugeSymbol>();
    private modules: DelugeSymbol[] = [];
    private moduleSet = new Set<string>();
    private fieldMap: Record<string, Record<string, string>> = {};
    private layoutsByModule: Record<string, Array<{ id: string; name: string; status?: string }>> = {};
    private fieldSymbolCache = new Map<string, DelugeSymbol[]>();
    private hover = new Map<string, DelugeSymbol>();
    private fieldMetaReader?: FieldMetaReader;
    private functionGroups: FunctionGroup[] = [];
    private loaded = false;

    /** Whether any org data is currently loaded. */
    hasData(): boolean {
        return this.loaded && (this.standalone.length > 0 || this.modules.length > 0);
    }

    /** The folder this index was last loaded from. */
    getFolder(): string | undefined {
        return this.folder;
    }

    private clear(): void {
        this.standalone = [];
        this.standaloneByKey.clear();
        this.modules = [];
        this.moduleSet.clear();
        this.fieldMap = {};
        this.layoutsByModule = {};
        this.fieldSymbolCache.clear();
        this.hover.clear();
        this.fieldMetaReader = undefined;
        this.functionGroups = [];
        this.loaded = false;
    }

    /**
     * (Re)load the index from `<folderPath>/.zcrm/.store`. Tolerant of missing
     * files — a folder without a pull simply yields an empty index. Never
     * throws for I/O reasons.
     */
    async load(folderPath: string): Promise<void> {
        this.clear();
        this.folder = folderPath;
        this.fieldMetaReader = new FieldMetaReader(folderPath);
        const storeDir = path.join(folderPath, '.zcrm', '.store');

        await this.loadStandalone(folderPath, storeDir);
        await this.loadModules(storeDir);
        await this.loadFieldMap(storeDir);
        await this.loadLayouts(storeDir);
        await this.loadFunctionGroups(folderPath, storeDir);

        this.loaded = true;
    }

    getLayouts(moduleName: string): Array<{ id: string; name: string; status?: string }> {
        return this.layoutsByModule[moduleName] || [];
    }

    private async loadLayouts(storeDir: string): Promise<void> {
        const data = await readJsonSafe(path.join(storeDir, 'layouts.json'));
        if (!data) return;
        const list = Array.isArray(data.layouts) ? data.layouts : (Array.isArray(data) ? data : []);
        for (const item of list) {
            if (!item || !item.module?.api_name) continue;
            const mod = String(item.module.api_name);
            const entry = {
                id: String(item.id || ''),
                name: String(item.name || item.label || 'Default Layout'),
                status: item.status !== undefined ? String(item.status) : undefined
            };
            if (!this.layoutsByModule[mod]) {
                this.layoutsByModule[mod] = [];
            }
            this.layoutsByModule[mod].push(entry);
        }
    }

    private async loadStandalone(folderPath: string, storeDir: string): Promise<void> {
        const data = await readJsonSafe(path.join(storeDir, 'functions.json'));
        const fns: any[] = Array.isArray(data?.functions) ? data.functions : [];
        for (const fn of fns) {
            if (!fn || !fn.api_name) {
                continue;
            }
            if (String(fn.category || '').toLowerCase() !== 'standalone') {
                continue;
            }
            let args = normalizeArgs(fn.arguments);
            // §6.1: arguments is PRIMARY. The .ds line-1 parser is a rare fallback
            // used ONLY when arguments === null and the .ds shows non-empty params.
            if (args.length === 0 && fn.arguments === null) {
                const dsArgs = await readDsArgs(folderPath, fn.api_name);
                if (dsArgs.length) {
                    args = dsArgs;
                }
            }
            const sym = buildStandaloneSymbol(String(fn.api_name), fn.return_type, fn.name, fn.description, args);
            this.standalone.push(sym);
            this.standaloneByKey.set(`standalone.${fn.api_name}`, sym);
            this.standaloneByKey.set(String(fn.api_name), sym);
            this.hover.set(`standalone.${fn.api_name}`, sym);
            this.hover.set(String(fn.api_name), sym);
        }
        this.standalone.sort((a, b) => a.label.localeCompare(b.label));
    }

    private async loadModules(storeDir: string): Promise<void> {
        const idx = await readJsonSafe(path.join(storeDir, 'index.json'));
        const mods: any[] = Array.isArray(idx?.modules) ? idx.modules : [];
        for (const m of mods) {
            if (!m || !m.api_name) {
                continue;
            }
            const sym = buildModuleSymbol(m);
            this.modules.push(sym);
            this.moduleSet.add(String(m.api_name));
            if (!this.hover.has(String(m.api_name))) {
                this.hover.set(String(m.api_name), sym);
            }
        }
        this.modules.sort((a, b) => a.label.localeCompare(b.label));
    }

    /** Build the category-grouped function list (all scopes), each entry linked
     *  to its pulled `.ds` file when present. */
    private async loadFunctionGroups(folderPath: string, storeDir: string): Promise<void> {
        const data = await readJsonSafe(path.join(storeDir, 'functions.json'));
        const fns: any[] = Array.isArray(data?.functions) ? data.functions : [];
        const dsByApi = await scanDsPaths(folderPath);
        this.functionGroups = buildFunctionGroups(fns, dsByApi);
    }

    /** All functions grouped by category (Standalone first, then alphabetical). */
    getFunctionGroups(): FunctionGroup[] {
        return this.functionGroups;
    }

    private async loadFieldMap(storeDir: string): Promise<void> {
        const fm = await readJsonSafe(path.join(storeDir, 'field_map.json'));
        if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
            this.fieldMap = fm as Record<string, Record<string, string>>;
        }
    }

    // -- DynamicSymbolSource --------------------------------------------------

    getStandaloneCompletions(): DelugeSymbol[] {
        return this.standalone;
    }

    getStandaloneSignature(name: string): DelugeSymbol | undefined {
        return this.standaloneByKey.get(name);
    }

    getModuleCompletions(): DelugeSymbol[] {
        return this.modules;
    }

    isModule(name: string): boolean {
        return this.moduleSet.has(name);
    }

    getFieldSymbols(module: string): DelugeSymbol[] {
        const cached = this.fieldSymbolCache.get(module);
        if (cached) {
            return cached;
        }
        const fields = this.fieldMap[module];
        const syms: DelugeSymbol[] =
            fields && typeof fields === 'object'
                ? Object.keys(fields)
                      .sort((a, b) => a.localeCompare(b))
                      .map((f) => buildFieldSymbol(module, f, String(fields[f])))
                : [];
        this.fieldSymbolCache.set(module, syms);
        return syms;
    }

    getHoverSymbol(token: string): DelugeSymbol | undefined {
        return this.hover.get(token);
    }

    /** Rich hover for `<Module>.<field>` — lazily reads fields-meta.json for the
     *  data type + picklist, falling back to the field_map data type. */
    async getFieldHoverDetail(module: string, field: string): Promise<string | undefined> {
        if (!this.moduleSet.has(module)) {
            return undefined;
        }
        const meta = this.fieldMetaReader ? await this.fieldMetaReader.read(module, field) : undefined;
        if (meta) {
            return renderFieldHover(module, field, meta);
        }
        const dataType = this.fieldMap[module]?.[field];
        return dataType ? renderFieldHover(module, field, { dataType, picklist: [] }) : undefined;
    }
}

// ---------------------------------------------------------------------------
// Function grouping (all categories — for the side-bar view)
// ---------------------------------------------------------------------------

/**
 * Group raw functions.json entries by category and attach each one's pulled
 * `.ds` path (looked up by api_name). Standalone is sorted first, then the rest
 * alphabetically; functions within a group are sorted by api_name. Pure.
 */
export function buildFunctionGroups(rawFns: any[], dsByApi: Map<string, string>): FunctionGroup[] {
    const byCategory = new Map<string, FunctionEntry[]>();
    for (const fn of Array.isArray(rawFns) ? rawFns : []) {
        if (!fn || !fn.api_name) {
            continue;
        }
        const apiName = String(fn.api_name);
        const category = String(fn.category || 'Other');
        const list = byCategory.get(category) ?? [];
        list.push({
            apiName,
            name: fn.name ? String(fn.name) : apiName,
            category,
            dsPath: dsByApi.get(apiName)
        });
        byCategory.set(category, list);
    }
    const groups: FunctionGroup[] = Array.from(byCategory.entries()).map(([category, functions]) => ({
        category,
        functions: functions.sort((a, b) => a.apiName.localeCompare(b.apiName))
    }));
    groups.sort((a, b) => {
        if (a.category === b.category) {
            return 0;
        }
        if (a.category === 'Standalone') {
            return -1;
        }
        if (b.category === 'Standalone') {
            return 1;
        }
        return a.category.localeCompare(b.category);
    });
    return groups;
}

/** Map api_name → absolute `.ds` path by scanning `crm/functions/<ns>/*.ds`. */
async function scanDsPaths(folderPath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const root = path.join(folderPath, 'crm', 'functions');
    let dirs: string[];
    try {
        dirs = await fs.promises.readdir(root);
    } catch {
        return map;
    }
    for (const d of dirs) {
        const dirPath = path.join(root, d);
        let files: string[];
        try {
            files = await fs.promises.readdir(dirPath);
        } catch {
            continue; // not a directory (e.g. functions.json)
        }
        for (const f of files) {
            if (!f.toLowerCase().endsWith('.ds')) {
                continue;
            }
            const base = f.slice(0, -3); // strip ".ds"
            const parts = base.split('.');
            const api = parts.length >= 2 ? parts.slice(1).join('.') : base; // "<ns>.<api>"
            if (api && !map.has(api)) {
                map.set(api, path.join(dirPath, f));
            }
        }
    }
    return map;
}

// ---------------------------------------------------------------------------
// Symbol builders
// ---------------------------------------------------------------------------

function normalizeArgs(raw: unknown): FnArg[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .filter((a) => a && typeof a === 'object' && (a as any).name)
        .map((a) => ({ type: String((a as any).type || 'string'), name: String((a as any).name) }));
}

function buildStandaloneSymbol(
    apiName: string,
    returnType: unknown,
    displayName: unknown,
    description: unknown,
    args: FnArg[]
): DelugeSymbol {
    const rt = (typeof returnType === 'string' && returnType) || 'void';
    const paramStr = args.map((a) => `${a.type} ${a.name}`).join(', ');
    const detail = `${rt} standalone.${apiName}(${paramStr})`;

    const docLines = [`Standalone function · returns \`${rt}\``];
    if (typeof displayName === 'string' && displayName && displayName !== apiName) {
        docLines.push(`Display name: **${displayName}**`);
    }
    if (typeof description === 'string' && description.trim()) {
        docLines.push(description.trim());
    }

    const insertText = args.length
        ? `standalone.${apiName}(${args.map((a, i) => `\${${i + 1}:${a.name}}`).join(', ')})$0`
        : `standalone.${apiName}()$0`;

    return { label: `standalone.${apiName}`, detail, documentation: docLines.join('  \n'), insertText };
}

function buildModuleSymbol(m: any): DelugeSymbol {
    const apiName = String(m.api_name);
    const singular = m.singular_label ? String(m.singular_label) : apiName;
    const plural = m.plural_label ? String(m.plural_label) : apiName;
    return {
        label: apiName,
        detail: `Zoho CRM module (${singular} / ${plural})`,
        documentation: `Module **${apiName}** — \`${singular}\` / \`${plural}\`.`,
        insertText: apiName
    };
}

function buildFieldSymbol(module: string, fieldApiName: string, dataType: string): DelugeSymbol {
    return {
        label: fieldApiName,
        detail: `${dataType} · ${module}`,
        documentation: `Field **${fieldApiName}** (\`${dataType}\`) on \`${module}\`.`,
        insertText: fieldApiName
    };
}

// ---------------------------------------------------------------------------
// File helpers (best-effort; never throw)
// ---------------------------------------------------------------------------

async function readJsonSafe(file: string): Promise<any> {
    try {
        const raw = await fs.promises.readFile(file, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** Rare fallback: parse the first line of the standalone `.ds` for params. */
async function readDsArgs(folderPath: string, apiName: string): Promise<FnArg[]> {
    const file = path.join(folderPath, 'crm', 'functions', 'standalone', `standalone.${apiName}.ds`);
    try {
        const src = await fs.promises.readFile(file, 'utf8');
        const parsed = parseSignature(src);
        if (parsed && Array.isArray(parsed.args) && parsed.args.length) {
            return parsed.args.map((a) => ({ type: String(a.type), name: String(a.name) }));
        }
    } catch {
        /* missing/unparseable .ds → no fallback args */
    }
    return [];
}
