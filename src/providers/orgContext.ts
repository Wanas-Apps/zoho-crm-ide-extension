/**
 * Pure analysis of the line-prefix to decide whether the cursor is in a context
 * where org-specific (pulled) symbols should be offered. No vscode dependency,
 * so it is unit-testable.
 *
 * Contexts (priority order):
 *  - `standalone.<partial>`                         → standalone function names
 *  - `<Module>.<partial>` (known module)            → that module's fields
 *  - inside `zoho.crm.X("<partial>`  (1st arg)      → module names
 *  - inside `zoho.crm.X("Module", … "<partial>`     → that module's fields
 */
export type OrgContext =
    | { kind: 'standalone'; replaceLen: number }
    | { kind: 'moduleMember'; module: string; replaceLen: number }
    | { kind: 'moduleArg'; partial: string }
    | { kind: 'fieldArg'; module: string; partial: string };

export interface ModuleProbe {
    isModule(name: string): boolean;
}

export function analyzeOrgContext(linePrefix: string, source: ModuleProbe): OrgContext | null {
    // 1. standalone.<partial>
    const sa = linePrefix.match(/(?:^|[^\w.])(standalone\.[A-Za-z0-9_]*)$/);
    if (sa) {
        return { kind: 'standalone', replaceLen: sa[1].length };
    }

    // 2. <Module>.<partial> — member access on a known module api_name.
    const mm = linePrefix.match(/(?:^|[^\w.])([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
    if (mm && mm[1] !== 'standalone' && source.isModule(mm[1])) {
        return { kind: 'moduleMember', module: mm[1], replaceLen: mm[2].length };
    }

    // 3 & 4. Inside an (unclosed) zoho.crm.* call argument string. Capture the
    // whole tail (not `[^)]*`) so a nested call like `getId()` in an earlier
    // argument doesn't truncate the match — analyzeCallArg tracks paren depth.
    const call = linePrefix.match(/zoho\.crm\.[A-Za-z0-9_]+\((.*)$/);
    if (call) {
        return analyzeCallArg(call[1], source);
    }

    return null;
}

function analyzeCallArg(argsSoFar: string, source: ModuleProbe): OrgContext | null {
    let inString = false;
    let curStart = -1;
    let depth = 0;
    let commaCount = 0;
    let firstClosed: string | null = null;

    for (let i = 0; i < argsSoFar.length; i++) {
        const ch = argsSoFar[i];
        if (inString) {
            if (ch === '"' && argsSoFar[i - 1] !== '\\') {
                const s = argsSoFar.slice(curStart + 1, i);
                if (firstClosed === null) {
                    firstClosed = s;
                }
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            curStart = i;
        } else if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth > 0) {
                depth--;
            }
        } else if (ch === ',' && depth === 0) {
            commaCount++;
        }
    }

    if (!inString) {
        return null;
    }
    const partial = argsSoFar.slice(curStart + 1);
    if (commaCount === 0) {
        // First argument string → module name.
        return { kind: 'moduleArg', partial };
    }
    // Later argument string → fields, but only when arg 1 is a known module.
    if (firstClosed && source.isModule(firstClosed)) {
        return { kind: 'fieldArg', module: firstClosed, partial };
    }
    return null;
}
