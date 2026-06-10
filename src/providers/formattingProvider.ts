import * as vscode from 'vscode';
import { scanLine } from '../util/scan';

export function getDocumentFormattingEditProvider(): vscode.DocumentFormattingEditProvider {
    return {
        provideDocumentFormattingEdits(
            document: vscode.TextDocument,
            options: vscode.FormattingOptions
        ): vscode.TextEdit[] {
            const edits: vscode.TextEdit[] = [];
            const indentString = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';

            let currentIndentLevel = 0;
            let inBlockComment = false;

            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);

                // Never reformat the interior of a block comment — it may be
                // intentionally aligned ASCII / doc text.
                if (inBlockComment) {
                    inBlockComment = scanLine(line.text, true).endsInBlockComment;
                    continue;
                }

                const text = line.text.trim();

                // Collapse whitespace-only lines to empty.
                if (text.length === 0) {
                    if (line.text.length > 0) {
                        edits.push(vscode.TextEdit.replace(line.range, ''));
                    }
                    continue;
                }

                const { code, endsInBlockComment } = scanLine(text, false);

                // A line that begins by closing a block/bracket dedents itself.
                let indentForThisLine = currentIndentLevel;
                if (/^[}\)\]]/.test(text)) {
                    indentForThisLine = Math.max(0, currentIndentLevel - 1);
                }

                const indentedText = indentString.repeat(indentForThisLine) + text;
                if (line.text !== indentedText) {
                    edits.push(vscode.TextEdit.replace(line.range, indentedText));
                }

                // Update the running indent level from real code only. All bracket
                // kinds count, so multi-line task blocks (`invokeurl` / `invokeapi`
                // / `sendmail` `[ ... ]`) and continuations indent like `{ }` blocks.
                const opens = (code.match(/[{\[(]/g) || []).length;
                const closes = (code.match(/[}\])]/g) || []).length;
                currentIndentLevel = Math.max(0, currentIndentLevel + (opens - closes));

                inBlockComment = endsInBlockComment;
            }

            return edits;
        }
    };
}
