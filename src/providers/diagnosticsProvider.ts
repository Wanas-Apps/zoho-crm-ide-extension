import * as vscode from 'vscode';
import { scanLine, stripComments } from '../util/scan';

const OPEN_TO_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

// A line beginning with one of these is a block header / clause and does not
// itself need a terminating semicolon.
const CONTROL_HEADER = /^(if|else if|else|for each|try|catch|finally)\b/;

// If a code line ends with one of these characters it is a continuation, a
// block delimiter, or already terminated — so no semicolon is expected.
const CONTINUATION_END = /[;{}\[\(,:+\-*/%=<>&|!?.]$/;

// If the NEXT meaningful line starts with one of these, the current line is a
// continuation (operator/member chain) or is followed by a block.
const CONTINUATION_NEXT = /^([{}\[\(.,?:]|&&|\|\||==|!=|<=|>=|[+\-*/%<>=&|]|else\b|catch\b|finally\b)/;

interface LineInfo {
    /** Strings + comments removed (for bracket matching & header detection). */
    code: string;
    /** Only comments removed, strings kept (for the terminating-char check). */
    display: string;
    /** Bracket/paren nesting depth at the START of this line. */
    depthAtStart: number;
}

export function computeDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
    if (document.languageId !== 'deluge') {
        return [];
    }

    // ---- Settings gating (safe defaults so it works before package.json declares them) ----
    const config = vscode.workspace.getConfiguration('deluge');
    if (!config.get<boolean>('lint.enable', true)) {
        return [];
    }
    const lintMissingSemicolon = config.get<boolean>('lint.missingSemicolon', true);
    const lintInvalidKeywords = config.get<boolean>('lint.invalidKeywords', true);
    const lintDivideByZero = config.get<boolean>('lint.divideByZero', true);

    const diagnostics: vscode.Diagnostic[] = [];
    const lineInfos: LineInfo[] = [];

    // Stack of unmatched openers with their source positions.
    const stack: { ch: string; pos: vscode.Position }[] = [];
    let inBlockComment = false;
    let blockCommentStart: vscode.Position | null = null;
    let stringChar: string | null = null;

    // ---- Pass 1: char-level scan for brackets, comments, per-line info ----
    for (let i = 0; i < document.lineCount; i++) {
        const raw = document.lineAt(i).text;
        // Only `(` and `[` imply a statement continuation / task block; `{` is
        // block scope, where inner statements still require their own semicolons.
        const depthAtStart = stack.reduce((n, s) => (s.ch === '(' || s.ch === '[' ? n + 1 : n), 0);
        let code = '';

        // String literals and comments are BLANKED to spaces (not dropped), so
        // every index into `code` maps 1:1 to a real document column — the
        // diagnostic ranges below rely on this alignment.
        for (let c = 0; c < raw.length; c++) {
            const ch = raw[c];
            const next = raw[c + 1];

            if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    code += '  ';
                    c++;
                } else {
                    code += ' ';
                }
                continue;
            }
            if (stringChar) {
                if (ch === '\\' && next !== undefined) {
                    code += '  ';
                    c++;
                } else {
                    if (ch === stringChar) {
                        stringChar = null;
                    }
                    code += ' ';
                }
                continue;
            }
            if (ch === '/' && next === '/') {
                break; // rest of the line is a comment — no later column to map
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                blockCommentStart = new vscode.Position(i, c);
                code += '  ';
                c++;
                continue;
            }
            if (ch === '"' || ch === "'") {
                stringChar = ch;
                code += ' ';
                continue;
            }

            code += ch;

            if (OPEN_TO_CLOSE[ch]) {
                stack.push({ ch, pos: new vscode.Position(i, c) });
            } else if (CLOSE_TO_OPEN[ch]) {
                const top = stack[stack.length - 1];
                if (!top || top.ch !== CLOSE_TO_OPEN[ch]) {
                    diagnostics.push(makeDiag(
                        new vscode.Range(i, c, i, c + 1),
                        `Unexpected '${ch}' — no matching '${CLOSE_TO_OPEN[ch]}'.`,
                        vscode.DiagnosticSeverity.Error
                    ));
                } else {
                    stack.pop();
                }
            }
        }

        lineInfos.push({
            code,
            display: stripComments(raw, false).code, // strings kept; block-comment interior handled below
            depthAtStart
        });
    }

    // Unclosed block comment.
    if (inBlockComment && blockCommentStart) {
        diagnostics.push(makeDiag(
            new vscode.Range(blockCommentStart, blockCommentStart.translate(0, 2)),
            'Block comment is never closed (missing "*/").',
            vscode.DiagnosticSeverity.Error
        ));
    }

    // Any openers left on the stack were never closed.
    for (const open of stack) {
        diagnostics.push(makeDiag(
            new vscode.Range(open.pos, open.pos.translate(0, 1)),
            `'${open.ch}' is never closed — expected '${OPEN_TO_CLOSE[open.ch]}'.`,
            vscode.DiagnosticSeverity.Error
        ));
    }

    // ---- Pass 2: conservative missing-semicolon + divide-by-zero ----
    for (let i = 0; i < document.lineCount; i++) {
        const info = lineInfos[i];
        const codeTrim = info.code.trim();
        const displayTrim = info.display.trim();

        // Divide by a literal zero, e.g. `x / 0`.
        if (lintDivideByZero) {
            const dz = info.code.match(/\/\s*0(?![.\d])/);
            if (dz) {
                const col = info.code.indexOf(dz[0]);
                const lineStart = document.lineAt(i).firstNonWhitespaceCharacterIndex;
                diagnostics.push(makeDiag(
                    new vscode.Range(i, Math.max(col, lineStart), i, info.code.length),
                    'Division by zero.',
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }

        // ---- Deluge-specific invalid-keyword / operator checks ----
        // All run against the string- and comment-stripped `info.code`, so they
        // never match inside string literals or comments.
        if (lintInvalidKeywords) {
            // `while` / `do` loops do not exist in Deluge.
            for (const m of info.code.matchAll(/\b(?:while|do)\b/g)) {
                const col = m.index ?? 0;
                diagnostics.push(makeDiag(
                    new vscode.Range(i, col, i, col + m[0].length),
                    'Deluge has no while/do loops — use `for each … in …`.',
                    vscode.DiagnosticSeverity.Error,
                    'deluge.whileDo'
                ));
            }

            // `throw` should be `throws` (not followed by `s`).
            for (const m of info.code.matchAll(/\bthrow\b(?!s)/g)) {
                const col = m.index ?? 0;
                diagnostics.push(makeDiag(
                    new vscode.Range(i, col, i, col + m[0].length),
                    'Deluge uses `throws`, not `throw`.',
                    vscode.DiagnosticSeverity.Warning,
                    'deluge.throw'
                ));
            }

            // Deluge try/catch has no `finally`.
            for (const m of info.code.matchAll(/\bfinally\b/g)) {
                const col = m.index ?? 0;
                diagnostics.push(makeDiag(
                    new vscode.Range(i, col, i, col + m[0].length),
                    'Deluge try/catch has no `finally` block.',
                    vscode.DiagnosticSeverity.Error,
                    'deluge.finally'
                ));
            }

            // Word operators `and` / `or` / `not` are not valid in Deluge.
            for (const m of info.code.matchAll(/\b(?:and|or|not)\b/g)) {
                const col = m.index ?? 0;
                diagnostics.push(makeDiag(
                    new vscode.Range(i, col, i, col + m[0].length),
                    'Use `&&`, `||`, or `!` — word operators are not valid in Deluge.',
                    vscode.DiagnosticSeverity.Warning,
                    'deluge.wordOperator'
                ));
            }
        }

        // Missing-semicolon heuristic — deliberately conservative.
        if (!lintMissingSemicolon) { continue; }            // gated off
        if (codeTrim.length === 0) { continue; }            // blank / comment-only
        if (info.depthAtStart > 0) { continue; }            // inside (...) or [...] block
        if (CONTROL_HEADER.test(codeTrim)) { continue; }    // if / else / for each / try ...
        if (CONTINUATION_END.test(displayTrim)) { continue; } // ends with ; { } , operator etc.

        // Look at the next meaningful line — if it continues the statement or
        // opens a block, the current line needs no semicolon.
        let nextTrim = '';
        for (let j = i + 1; j < document.lineCount; j++) {
            const t = lineInfos[j].display.trim();
            if (t.length > 0) { nextTrim = t; break; }
        }
        if (nextTrim && CONTINUATION_NEXT.test(nextTrim)) { continue; }

        const line = document.lineAt(i);
        const start = line.firstNonWhitespaceCharacterIndex;
        const end = line.text.replace(/\s+$/, '').length;
        diagnostics.push(makeDiag(
            new vscode.Range(i, start, i, Math.max(end, start + 1)),
            "Statement may be missing a terminating ';'.",
            vscode.DiagnosticSeverity.Warning,
            'deluge.missingSemicolon'
        ));
    }

    return diagnostics;
}

function makeDiag(
    range: vscode.Range,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code?: string
): vscode.Diagnostic {
    const d = new vscode.Diagnostic(range, message, severity);
    d.source = 'deluge';
    if (code !== undefined) {
        d.code = code;
    }
    return d;
}

/**
 * Wires the diagnostics provider to document open/change/close events with a
 * short debounce so it stays responsive while typing.
 */
export function registerDiagnostics(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection('deluge');
    context.subscriptions.push(collection);

    const timers = new Map<string, NodeJS.Timeout>();

    const refresh = (document: vscode.TextDocument, immediate = false) => {
        if (document.languageId !== 'deluge') { return; }
        const key = document.uri.toString();
        const existing = timers.get(key);
        if (existing) { clearTimeout(existing); }
        const run = () => {
            timers.delete(key);
            collection.set(document.uri, computeDiagnostics(document));
        };
        if (immediate) { run(); } else { timers.set(key, setTimeout(run, 400)); }
    };

    vscode.workspace.textDocuments.forEach(doc => refresh(doc, true));

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => refresh(doc, true)),
        vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const t = timers.get(key);
            if (t) { clearTimeout(t); timers.delete(key); }
            collection.delete(doc.uri);
        })
    );
}
