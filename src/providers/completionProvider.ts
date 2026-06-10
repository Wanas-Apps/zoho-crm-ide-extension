import * as vscode from 'vscode';
import {
    KEYWORDS,
    DATA_TYPES,
    STATEMENT_TASKS,
    CONSTRUCTORS,
    MEMBER_FUNCTIONS,
    STRING_FUNCTIONS,
    NUMBER_FUNCTIONS,
    DATETIME_FUNCTIONS,
    LIST_FUNCTIONS,
    MAP_FUNCTIONS,
    COLLECTION_FUNCTIONS,
    FILE_FUNCTIONS,
    ZOHO_NAMESPACES,
    ZOHO_VARIABLES,
    CRM_FUNCTIONS,
    GENERIC_INTEGRATION_FUNCTIONS,
    ENCRYPTION_FUNCTIONS,
    DelugeSymbol
} from '../data/delugeData';
import { DynamicSymbolSource, EMPTY_DYNAMIC_SOURCE } from '../data/dynamicSource';
import { analyzeOrgContext } from './orgContext';

function toItem(sym: DelugeSymbol, kind: vscode.CompletionItemKind): vscode.CompletionItem {
    const item = new vscode.CompletionItem(sym.label, kind);
    item.detail = sym.detail;
    item.documentation = new vscode.MarkdownString(sym.documentation);
    if (sym.insertText) {
        item.insertText = new vscode.SnippetString(sym.insertText);
    }
    return item;
}

// The integration tasks reachable under the `zoho.` root.
const ALL_INTEGRATION_FUNCTIONS = [...CRM_FUNCTIONS, ...GENERIC_INTEGRATION_FUNCTIONS, ...ENCRYPTION_FUNCTIONS];

function keywordItems(): vscode.CompletionItem[] {
    const items = KEYWORDS.map(k => new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword));
    items.push(...DATA_TYPES.map(t => new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter)));
    return items;
}

function snippetItems(): vscode.CompletionItem[] {
    const make = (label: string, body: string, doc: string) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(body);
        item.documentation = new vscode.MarkdownString(doc);
        return item;
    };
    return [
        make('if', 'if(${1:condition})\n{\n\t$0\n}', 'If statement block'),
        make('ifelse', 'if(${1:condition})\n{\n\t$2\n}\nelse\n{\n\t$0\n}', 'If / else block'),
        make('ifexpr', 'if(${1:condition}, ${2:trueValue}, ${3:falseValue})', 'Inline conditional (ternary) expression — returns `trueValue` when the condition is met, otherwise `falseValue`.'),
        make('for each', 'for each ${1:element} in ${2:list}\n{\n\t$0\n}', 'For each loop block'),
        make('try', 'try\n{\n\t$1\n}\ncatch (${2:e})\n{\n\t$0\n}', 'Try / catch block')
    ];
}

/**
 * Completions offered while the cursor sits inside a `zoho.` chain. Every item
 * carries an explicit `range` spanning the whole chain that has been typed so
 * far, so accepting an item replaces (rather than appends to) the existing
 * `zoho.crm.` prefix and never produces `zoho.crm.zoho.crm.getRecordById`.
 */
function zohoChainItems(range: vscode.Range): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const ns of ZOHO_NAMESPACES) {
        const item = new vscode.CompletionItem(`zoho.${ns}`, vscode.CompletionItemKind.Module);
        item.detail = `Zoho ${ns} integration tasks`;
        item.insertText = `zoho.${ns}`;
        item.range = range;
        item.sortText = `0_${ns}`;
        items.push(item);
    }

    for (const v of ZOHO_VARIABLES) {
        const item = new vscode.CompletionItem(v.detail, vscode.CompletionItemKind.Variable);
        item.documentation = new vscode.MarkdownString(v.documentation);
        item.insertText = v.detail;
        item.range = range;
        item.sortText = `1_${v.label}`;
        items.push(item);
    }

    for (const f of ALL_INTEGRATION_FUNCTIONS) {
        const item = toItem(f, vscode.CompletionItemKind.Function);
        item.range = range;
        item.sortText = `2_${f.label}`;
        items.push(item);
    }

    return items;
}

/**
 * Maps a right-hand-side expression to the per-type function set it implies.
 * Returns `undefined` when no single type can be inferred confidently, so the
 * caller can fall back to the full `MEMBER_FUNCTIONS` list. The checks are
 * ordered from the most specific / unambiguous shapes to the broadest, so a
 * literal prefix wins before a looser substring match.
 */
function inferFromExpression(rhs: string): DelugeSymbol[] | undefined {
    const expr = rhs.trim();
    if (!expr) {
        return undefined;
    }

    // A literal piped into a type-converting call (`"a,b".toList()`,
    // `"5".toLong()`, `"2024-01-01".toDate()`) changes type — let the
    // conversion-call checks below win instead of the literal prefix.
    const convertsType = /\.to(?:List|Map|JSONList|Collection|XmlList|File|Long|Decimal|Number|Date|Time)\s*\(/.test(expr);

    // String — a double-quoted literal (`"..."`).
    if (expr.startsWith('"') && !convertsType) {
        return STRING_FUNCTIONS;
    }

    // Date-time — a single-quoted date-time literal (`'2024-01-01'`).
    if (expr.startsWith("'") && !convertsType) {
        return DATETIME_FUNCTIONS;
    }

    // Map — a `{ ... }` literal, a `Map()` constructor, or a `.toMap()` call.
    if (expr.startsWith('{') || /\bMap\s*\(/.test(expr) || /\.toMap\s*\(/.test(expr)) {
        return MAP_FUNCTIONS;
    }

    // List — a `[ ... ]` literal, a `List()` constructor, or a list-producing call.
    if (expr.startsWith('[') ||
        /\bList\s*\(/.test(expr) ||
        /\.toList\s*\(/.test(expr) ||
        /\.toJSONList\s*\(/.test(expr) ||
        /\.sort\s*\(/.test(expr) ||
        /\.distinct\s*\(/.test(expr)) {
        return LIST_FUNCTIONS;
    }

    // Collection — created via the `Collection(...)` constructor.
    if (/\bCollection\s*\(/.test(expr)) {
        return COLLECTION_FUNCTIONS;
    }

    // File — file content / blob / attachment producing expressions.
    if (/getFileContent/.test(expr) ||
        /\.toFile\s*\(/.test(expr) ||
        /downloadFile/.test(expr) ||
        /attachment/i.test(expr)) {
        return FILE_FUNCTIONS;
    }

    // CRM record — a CRM read/create/update returns a record, which is a map.
    if (/zoho\.crm\.getRecordById\s*\(/.test(expr) ||
        /zoho\.crm\.getRecords\s*\(/.test(expr) ||
        /zoho\.crm\.(?:create|update)Record\s*\(/.test(expr) ||
        /\.get\s*\(/.test(expr)) {
        return MAP_FUNCTIONS;
    }

    // Number — a bare integer/decimal literal or a numeric conversion call.
    if (/^\d+(?:\.\d+)?$/.test(expr) ||
        /\.toLong\s*\(/.test(expr) ||
        /\.toDecimal\s*\(/.test(expr) ||
        /\.toNumber\s*\(/.test(expr)) {
        return NUMBER_FUNCTIONS;
    }

    // Date-time — current date/time system variables or date conversions / arithmetic.
    if (/zoho\.currentdate/.test(expr) ||
        /zoho\.currenttime/.test(expr) ||
        /\.toDate\s*\(/.test(expr) ||
        /\.toTime\s*\(/.test(expr) ||
        /\.addDay\s*\(/.test(expr) ||
        /\.addMonth\s*\(/.test(expr)) {
        return DATETIME_FUNCTIONS;
    }

    return undefined;
}

/**
 * Infers which per-type function set to offer after a member-access `.`.
 *
 * First it looks at the literal sitting immediately before the `.` (so
 * `"abc".`, `'2024-01-01'.` and `42.` resolve directly). Failing that it scans
 * the document UPWARD from the cursor for the nearest `^<var> = <RHS>`
 * assignment and infers the variable's type from that RHS.
 *
 * This is purely an ENHANCEMENT: when nothing can be inferred confidently it
 * returns the full `MEMBER_FUNCTIONS` list (the original behaviour), so the
 * user never sees fewer completions than they need.
 */
function inferMemberFunctions(
    document: vscode.TextDocument,
    position: vscode.Position,
    linePrefix: string
): DelugeSymbol[] {
    // The text directly before the `.` that triggered this context.
    const beforeDot = linePrefix.slice(0, -1);

    // Case 1: the token before the `.` is itself a literal.
    if (/"\s*$/.test(beforeDot)) {
        return STRING_FUNCTIONS;
    }
    if (/'\s*$/.test(beforeDot)) {
        return DATETIME_FUNCTIONS;
    }
    if (/(?:^|[^\w.])\d+(?:\.\d+)?\s*$/.test(beforeDot)) {
        return NUMBER_FUNCTIONS;
    }

    // Case 2: the token before the `.` is a plain variable — find its type by
    // scanning upward for the most recent `<var> = <RHS>` assignment.
    const varMatch = beforeDot.match(/([a-zA-Z_]\w*)\s*$/);
    if (varMatch) {
        const varName = varMatch[1];
        const assignRe = new RegExp('^\\s*' + varName + '\\s*=\\s*(.+?)\\s*;?\\s*$');
        for (let line = position.line; line >= 0; line--) {
            const text = document.lineAt(line).text;
            const m = text.match(assignRe);
            if (m) {
                const inferred = inferFromExpression(m[1]);
                if (inferred) {
                    return inferred;
                }
                // A matching assignment with an unrecognisable RHS: stop here
                // and fall back rather than risk a wrong earlier assignment.
                break;
            }
        }
    }

    // Could not infer confidently — fall back to the full member list.
    return MEMBER_FUNCTIONS;
}

function rangeFor(position: vscode.Position, replaceLen: number): vscode.Range {
    return new vscode.Range(position.line, position.character - replaceLen, position.line, position.character);
}

export function getCompletionProvider(
    source: DynamicSymbolSource = EMPTY_DYNAMIC_SOURCE
): vscode.CompletionItemProvider {
    return {
        provideCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position,
            _token: vscode.CancellationToken,
            context?: vscode.CompletionContext
        ) {
            const linePrefix = document.lineAt(position).text.slice(0, position.character);

            // Context 0: org-specific (pulled) symbols — standalone functions,
            // module names, and module fields. Each replaces the typed partial so
            // it never duplicates the `standalone.`/quote prefix.
            const org = analyzeOrgContext(linePrefix, source);
            if (org) {
                if (org.kind === 'standalone') {
                    const range = rangeFor(position, org.replaceLen);
                    return source.getStandaloneCompletions().map((s) => {
                        const it = toItem(s, vscode.CompletionItemKind.Function);
                        it.range = range;
                        return it;
                    });
                }
                if (org.kind === 'moduleMember' || org.kind === 'fieldArg') {
                    const range = rangeFor(position, org.kind === 'moduleMember' ? org.replaceLen : org.partial.length);
                    return source.getFieldSymbols(org.module).map((s) => {
                        const it = toItem(s, vscode.CompletionItemKind.Field);
                        it.range = range;
                        return it;
                    });
                }
                if (org.kind === 'moduleArg') {
                    const range = rangeFor(position, org.partial.length);
                    return source.getModuleCompletions().map((s) => {
                        const it = toItem(s, vscode.CompletionItemKind.Class);
                        it.range = range;
                        return it;
                    });
                }
            }

            // A `"` was typed but the cursor is NOT in a `zoho.crm.*` argument
            // (handled above). Stay silent rather than popping the generic list
            // inside an ordinary string literal.
            if (
                context &&
                context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
                context.triggerCharacter === '"'
            ) {
                return undefined;
            }

            // Context 1: inside a `zoho.` chain (e.g. `zoho.`, `zoho.cr`, `zoho.crm.`, `zoho.crm.get`).
            const chain = linePrefix.match(/\bzoho\.(?:[a-zA-Z0-9_]*\.)*[a-zA-Z0-9_]*$/);
            if (chain) {
                const start = position.character - chain[0].length;
                const range = new vscode.Range(position.line, start, position.line, position.character);
                return zohoChainItems(range);
            }

            // Context 2: member access on a variable — a `.` after an identifier/closing token.
            // Try to infer the receiver's type so we can offer just that type's
            // functions; otherwise this falls back to the full member list.
            if (/[a-zA-Z0-9_\)\]"']\.$/.test(linePrefix)) {
                const memberFns = inferMemberFunctions(document, position, linePrefix);
                return memberFns.map(f => toItem(f, vscode.CompletionItemKind.Method));
            }

            // Context 3 (default): keywords, data types, statement tasks, snippets,
            // the `zoho` root, and the fully-qualified integration tasks.
            const items: vscode.CompletionItem[] = [];
            items.push(...keywordItems());
            items.push(...snippetItems());
            items.push(...STATEMENT_TASKS.map(t => toItem(t, vscode.CompletionItemKind.Function)));
            items.push(...CONSTRUCTORS.map(c => toItem(c, vscode.CompletionItemKind.Constructor)));
            items.push(...ALL_INTEGRATION_FUNCTIONS.map(f => toItem(f, vscode.CompletionItemKind.Function)));

            const zohoRoot = new vscode.CompletionItem('zoho', vscode.CompletionItemKind.Module);
            zohoRoot.detail = 'Zoho integration root namespace';
            zohoRoot.documentation = new vscode.MarkdownString('Entry point for integration tasks and system variables, e.g. `zoho.crm.getRecordById(...)`.');
            items.push(zohoRoot);

            return items;
        }
    };
}
