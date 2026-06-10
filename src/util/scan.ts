// Shared, dependency-free scanning helpers for Deluge source.
// Used by both the formatter and the diagnostics provider so that strings and
// comments are treated identically everywhere.

export interface ScanResult {
    /** The line with string literals and comments blanked out. */
    code: string;
    /** Whether the line ends while still inside a block comment. */
    endsInBlockComment: boolean;
}

/**
 * Blanks out string literals (single & double quoted) and comments so that
 * braces/parentheses appearing inside them are not counted.
 */
export function scanLine(text: string, startInBlockComment: boolean): ScanResult {
    let code = '';
    let inBlockComment = startInBlockComment;
    let stringChar: string | null = null;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (stringChar) {
            if (ch === '\\') {
                i++; // skip escaped character
            } else if (ch === stringChar) {
                stringChar = null;
            }
            continue;
        }

        if (ch === '/' && next === '/') {
            break; // rest of the line is a line comment
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            stringChar = ch;
            continue;
        }
        code += ch;
    }

    return { code, endsInBlockComment: inBlockComment };
}

/**
 * Returns the line with line/block comments removed but string literals kept
 * intact, so the real terminating character of a statement can be inspected.
 */
export function stripComments(text: string, startInBlockComment: boolean): ScanResult {
    let out = '';
    let inBlockComment = startInBlockComment;
    let stringChar: string | null = null;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (stringChar) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i++;
            } else if (ch === stringChar) {
                stringChar = null;
            }
            continue;
        }

        if (ch === '/' && next === '/') {
            break;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            stringChar = ch;
        }
        out += ch;
    }

    return { code: out, endsInBlockComment: inBlockComment };
}
