import * as vscode from 'vscode';
import {
    MEMBER_FUNCTIONS,
    CRM_FUNCTIONS,
    GENERIC_INTEGRATION_FUNCTIONS,
    STATEMENT_TASKS,
    CONSTRUCTORS,
    DelugeSymbol,
    allSignatures
} from '../data/delugeData';
import { DynamicSymbolSource, EMPTY_DYNAMIC_SOURCE } from '../data/dynamicSource';

// ---------------------------------------------------------------------------
// Lookup tables — built once at module load (mirrors hoverProvider's approach).
// ---------------------------------------------------------------------------

/** Fully-qualified `zoho.*` integration tasks, keyed by their full label. */
const QUALIFIED_FUNCS: Map<string, DelugeSymbol> = (() => {
    const map = new Map<string, DelugeSymbol>();
    [...CRM_FUNCTIONS, ...GENERIC_INTEGRATION_FUNCTIONS].forEach((sym) => {
        if (!map.has(sym.label)) {
            map.set(sym.label, sym);
        }
    });
    return map;
})();

/** Plain (bare-name) callables: member functions, statement tasks, constructors. */
const BARE_FUNCS: Map<string, DelugeSymbol> = (() => {
    const map = new Map<string, DelugeSymbol>();
    // First match wins, so add in priority order: member functions, then
    // statement tasks, then constructors.
    [...MEMBER_FUNCTIONS, ...STATEMENT_TASKS, ...CONSTRUCTORS].forEach((sym) => {
        if (!map.has(sym.label)) {
            map.set(sym.label, sym);
        }
    });
    return map;
})();

// ---------------------------------------------------------------------------
// Text-scanning helpers
// ---------------------------------------------------------------------------

/**
 * Walks `text` backwards looking for the innermost `(` that has not yet been
 * closed at the end of the string. Parentheses inside single- or double-quoted
 * string literals are ignored. Returns the index of that open paren, or -1.
 *
 * The scan runs forward (so quote state is tracked correctly) while keeping a
 * stack of the positions of currently-open parens; whatever remains on top of
 * the stack at the end is the innermost unclosed `(`.
 */
function findInnermostOpenParen(text: string): number {
    const openStack: number[] = [];
    let inString = false;
    let quoteChar = '';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            // Inside a string literal: only the matching, unescaped quote ends it.
            if (ch === quoteChar && text[i - 1] !== '\\') {
                inString = false;
                quoteChar = '';
            }
            continue;
        }

        if (ch === '"' || ch === '\'') {
            inString = true;
            quoteChar = ch;
        } else if (ch === '(') {
            openStack.push(i);
        } else if (ch === ')') {
            openStack.pop();
        }
    }

    return openStack.length > 0 ? openStack[openStack.length - 1] : -1;
}

/**
 * Counts the number of top-level commas in `text` — commas inside nested
 * parentheses or string literals do not count. Used to derive the active
 * parameter index from the text between the open paren and the cursor.
 */
function countTopLevelCommas(text: string): number {
    let count = 0;
    let depth = 0;
    let inString = false;
    let quoteChar = '';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (ch === quoteChar && text[i - 1] !== '\\') {
                inString = false;
                quoteChar = '';
            }
            continue;
        }

        if (ch === '"' || ch === '\'') {
            inString = true;
            quoteChar = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            if (depth > 0) {
                depth--;
            }
        } else if (ch === ',' && depth === 0) {
            count++;
        }
    }

    return count;
}

/**
 * Extracts the callee identifier ending immediately before `openIndex`.
 * Matches a token of the form `[A-Za-z_][A-Za-z0-9_.]*`, e.g. `replaceAll`
 * or `zoho.crm.getRecordById`. Returns the token, or null if none precedes
 * the paren.
 */
function extractCallee(text: string, openIndex: number): string | null {
    const before = text.slice(0, openIndex);
    const match = before.match(/([A-Za-z_][A-Za-z0-9_.]*)$/);
    return match ? match[1] : null;
}

/**
 * Resolves a callee token to a DelugeSymbol following the spec:
 *  - `zoho.`-prefixed dotted tokens resolve against the fully-qualified maps.
 *  - everything else resolves on the part after the last `.` (or the whole
 *    token) against the bare-name map.
 */
function resolveSymbol(callee: string): DelugeSymbol | undefined {
    if (callee.includes('.') && callee.startsWith('zoho.')) {
        return QUALIFIED_FUNCS.get(callee);
    }
    const lastDot = callee.lastIndexOf('.');
    const name = lastDot >= 0 ? callee.slice(lastDot + 1) : callee;
    return BARE_FUNCS.get(name);
}

/**
 * Splits the parameter list found inside the outermost `( … )` of a `detail`
 * string into trimmed, non-empty parameter tokens. Commas inside nested
 * parens are kept with their parameter (top-level split only).
 */
function parseParameters(detail: string): string[] {
    const open = detail.indexOf('(');
    if (open < 0) {
        return [];
    }
    // Find the matching close paren for the outermost open paren.
    let depth = 0;
    let close = -1;
    for (let i = open; i < detail.length; i++) {
        if (detail[i] === '(') {
            depth++;
        } else if (detail[i] === ')') {
            depth--;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close < 0) {
        return [];
    }

    const inner = detail.slice(open + 1, close);
    if (inner.trim() === '') {
        return [];
    }

    // Split on top-level commas only.
    const params: string[] = [];
    let current = '';
    let nest = 0;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '(' || ch === '[') {
            nest++;
            current += ch;
        } else if (ch === ')' || ch === ']') {
            nest--;
            current += ch;
        } else if (ch === ',' && nest === 0) {
            params.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    params.push(current);

    return params.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Pick which overload to highlight given the 0-based index of the argument
 * being typed. Prefers the SMALLEST signature that still has a slot for the
 * current argument (the most specific fit); if the user has typed past every
 * overload, returns the LARGEST signature. Pure → unit-testable.
 */
export function pickSignature(signatures: ReadonlyArray<{ parameters: ReadonlyArray<unknown> }>, typedArgIndex: number): number {
    const want = typedArgIndex + 1; // number of args being entered (1-based)
    let best = 0;
    let bestScore = Infinity;
    signatures.forEach((si, i) => {
        const pc = si.parameters.length;
        const score = pc >= want ? pc - want : 1000 + (want - pc);
        if (score < bestScore) {
            bestScore = score;
            best = i;
        }
    });
    return best;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function getSignatureHelpProvider(
    source: DynamicSymbolSource = EMPTY_DYNAMIC_SOURCE
): vscode.SignatureHelpProvider {
    return {
        provideSignatureHelp(
            document: vscode.TextDocument,
            position: vscode.Position
        ): vscode.SignatureHelp | null {
            // Defensive: never crash on malformed input — any failure returns null.
            try {
                // Text on the current line up to (but not including) the cursor.
                const lineText = document.lineAt(position.line).text;
                const linePrefix = lineText.slice(0, position.character);

                // 1. Find the innermost open paren we are currently inside.
                const openIndex = findInnermostOpenParen(linePrefix);
                if (openIndex < 0) {
                    return null;
                }

                // 2. Identify the callee immediately before that paren.
                const callee = extractCallee(linePrefix, openIndex);
                if (!callee) {
                    return null;
                }

                // 3. Resolve to a known DelugeSymbol — static catalog first, then
                //    org-specific standalone functions (`standalone.<api>`/`<api>`).
                const sym = resolveSymbol(callee) ?? source.getStandaloneSignature(callee);
                if (!sym) {
                    return null;
                }

                // 4. Build one SignatureInformation per overload (detail first).
                const sigStrings = allSignatures(sym);
                const doc = new vscode.MarkdownString(sym.documentation);
                const signatures = sigStrings.map((sigStr) => {
                    const si = new vscode.SignatureInformation(sigStr);
                    si.documentation = doc;
                    si.parameters = parseParameters(sigStr).map((p) => new vscode.ParameterInformation(p));
                    return si;
                });

                // 5. The argument currently being typed (0-based) = top-level
                //    commas between the open paren and the cursor.
                const argsText = linePrefix.slice(openIndex + 1);
                const typedArgIndex = countTopLevelCommas(argsText);

                // 6. Default to the overload that best fits the arg count: the
                //    smallest signature that still has a slot for the current arg;
                //    if the user typed past every overload, the largest one.
                const activeSignature = pickSignature(signatures, typedArgIndex);
                const activeCount = signatures[activeSignature].parameters.length;
                const activeParameter = activeCount > 0 ? Math.min(typedArgIndex, activeCount - 1) : 0;

                // 7. Assemble the SignatureHelp.
                const help = new vscode.SignatureHelp();
                help.signatures = signatures;
                help.activeSignature = activeSignature;
                help.activeParameter = activeParameter;
                return help;
            } catch {
                return null;
            }
        }
    };
}
