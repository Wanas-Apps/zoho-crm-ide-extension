import * as vscode from 'vscode';
import {
    MEMBER_FUNCTIONS,
    CRM_FUNCTIONS,
    GENERIC_INTEGRATION_FUNCTIONS,
    ENCRYPTION_FUNCTIONS,
    STATEMENT_TASKS,
    ZOHO_VARIABLES,
    DelugeSymbol,
    allSignatures
} from '../data/delugeData';
import { DynamicSymbolSource, EMPTY_DYNAMIC_SOURCE } from '../data/dynamicSource';

// Build a lookup table keyed by the symbol label so hovers resolve in O(1).
const HOVER_DOCS: Map<string, DelugeSymbol> = (() => {
    const map = new Map<string, DelugeSymbol>();
    const add = (sym: DelugeSymbol) => {
        if (!map.has(sym.label)) {
            map.set(sym.label, sym);
        }
    };
    [...CRM_FUNCTIONS, ...GENERIC_INTEGRATION_FUNCTIONS, ...ENCRYPTION_FUNCTIONS, ...ZOHO_VARIABLES, ...STATEMENT_TASKS, ...MEMBER_FUNCTIONS]
        .forEach(add);
    return map;
})();

/** Hover markdown = the symbol's docs, plus an "Overloads" list when present. */
function hoverMarkdown(sym: DelugeSymbol): vscode.MarkdownString {
    const sigs = allSignatures(sym);
    let md = sym.documentation;
    if (sigs.length > 1) {
        md += `\n\n**Overloads (${sigs.length}):**\n` + sigs.map((s) => '- `' + s + '`').join('\n');
    }
    return new vscode.MarkdownString(md);
}

export function getHoverProvider(
    source: DynamicSymbolSource = EMPTY_DYNAMIC_SOURCE
): vscode.HoverProvider {
    return {
        async provideHover(document: vscode.TextDocument, position: vscode.Position) {
            // First try a fully-qualified namespace token, e.g. `zoho.crm.getRecordById`
            // or an org standalone call `standalone.my_function`.
            const nsRange = document.getWordRangeAtPosition(position, /(?:zoho|standalone)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*/);
            if (nsRange) {
                const token = document.getText(nsRange);
                const sym = HOVER_DOCS.get(token) ?? source.getHoverSymbol(token);
                if (sym) {
                    return new vscode.Hover(hoverMarkdown(sym), nsRange);
                }
            }

            // Otherwise resolve a plain identifier (built-in member function,
            // statement task, or an org standalone/module name).
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
            if (!wordRange) {
                return null;
            }
            const word = document.getText(wordRange);

            // `<Module>.<field>` → rich field hover (data type + picklist).
            if (source.getFieldHoverDetail) {
                const before = document.lineAt(position.line).text.slice(0, wordRange.start.character);
                const mm = before.match(/([A-Za-z][A-Za-z0-9_]*)\.$/);
                if (mm && mm[1] !== 'standalone' && source.isModule(mm[1])) {
                    const detail = await source.getFieldHoverDetail(mm[1], word);
                    if (detail) {
                        return new vscode.Hover(new vscode.MarkdownString(detail), wordRange);
                    }
                }
            }

            const sym = HOVER_DOCS.get(word) ?? source.getHoverSymbol(word);
            if (sym) {
                return new vscode.Hover(hoverMarkdown(sym), wordRange);
            }

            return null;
        }
    };
}
