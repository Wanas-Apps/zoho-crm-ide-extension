import * as vscode from 'vscode';

/**
 * The kinds of code actions this provider emits. Exported so the orchestrator
 * can pass them as `providedCodeActionKinds` metadata at registration time.
 */
export const CODE_ACTION_KINDS: vscode.CodeActionKind[] = [vscode.CodeActionKind.QuickFix];

/** Diagnostic codes (set in diagnosticsProvider) that this provider can fix. */
const FIXABLE = new Set(['deluge.throw', 'deluge.wordOperator', 'deluge.missingSemicolon']);

/** Word-operator replacements for the `deluge.wordOperator` quick-fix. */
const WORD_OPERATOR_REPLACEMENT: Record<string, string> = {
    and: '&&',
    or: '||',
    not: '!'
};

export function getCodeActionsProvider(): vscode.CodeActionProvider {
    return {
        provideCodeActions(
            document: vscode.TextDocument,
            _range: vscode.Range | vscode.Selection,
            context: vscode.CodeActionContext
        ): vscode.CodeAction[] {
            const actions: vscode.CodeAction[] = [];

            for (const diag of context.diagnostics) {
                const code = typeof diag.code === 'string' ? diag.code : undefined;
                if (!code || !FIXABLE.has(code)) {
                    continue;
                }

                if (code === 'deluge.throw') {
                    const action = makeReplaceAction(
                        document,
                        diag,
                        'Change `throw` to `throws`',
                        diag.range,
                        'throws'
                    );
                    action.isPreferred = true;
                    actions.push(action);
                } else if (code === 'deluge.wordOperator') {
                    const word = document.getText(diag.range).trim();
                    const replacement = WORD_OPERATOR_REPLACEMENT[word];
                    if (replacement === undefined) {
                        continue;
                    }
                    const action = makeReplaceAction(
                        document,
                        diag,
                        `Replace \`${word}\` with \`${replacement}\``,
                        diag.range,
                        replacement
                    );
                    action.isPreferred = true;
                    actions.push(action);
                } else if (code === 'deluge.missingSemicolon') {
                    const line = document.lineAt(diag.range.end.line);
                    // Insert the `;` at the end of the (whitespace-trimmed) line.
                    const insertCol = line.text.replace(/\s+$/, '').length;
                    const insertPos = new vscode.Position(diag.range.end.line, insertCol);

                    const action = new vscode.CodeAction(
                        "Add missing ';'",
                        vscode.CodeActionKind.QuickFix
                    );
                    const edit = new vscode.WorkspaceEdit();
                    edit.insert(document.uri, insertPos, ';');
                    action.edit = edit;
                    action.diagnostics = [diag];
                    action.isPreferred = true;
                    actions.push(action);
                }
            }

            return actions;
        }
    };
}

function makeReplaceAction(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic,
    title: string,
    range: vscode.Range,
    replacement: string
): vscode.CodeAction {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, replacement);
    action.edit = edit;
    action.diagnostics = [diag];
    return action;
}
