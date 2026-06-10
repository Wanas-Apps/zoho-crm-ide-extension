/*
 * Standalone test runner for the Zoho CRM IDE Extension.
 *
 * No test framework and no npm dependencies — only Node's built-in `assert`
 * plus a minimal `vscode` module mock (installed via Module._load below).
 *
 * Run with:  node test/run-tests.js   (after `npm run compile`)
 * Exits non-zero if any case fails.
 */
'use strict';

const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------------------
// Minimal `vscode` mock. Must be installed BEFORE requiring any compiled
// module from ../out, because those modules do `require('vscode')` at load.
// ---------------------------------------------------------------------------
class Position {
    constructor(line, character) { this.line = line; this.character = character; }
    translate(dl = 0, dc = 0) { return new Position(this.line + dl, this.character + dc); }
}
class Range {
    constructor(a, b, c, d) {
        if (a instanceof Position) { this.start = a; this.end = b; }
        else { this.start = new Position(a, b); this.end = new Position(c, d); }
        this._line = (a instanceof Position) ? a.line : a;
    }
}
class Diagnostic {
    constructor(range, message, severity) {
        this.range = range; this.message = message; this.severity = severity;
    }
}
const TextEdit = { replace: (range, newText) => ({ _line: range._line, newText }) };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

const vscode = {
    Position,
    Range,
    Diagnostic,
    DiagnosticSeverity,
    TextEdit,
    // computeDiagnostics may consult configuration; return defaults so the
    // stable checks behave as if configured with their defaults.
    workspace: { getConfiguration: () => ({ get: (k, d) => d }) }
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

// ---------------------------------------------------------------------------
// Tiny test harness: each `test(name, fn)` runs fn in a try/catch so one
// failure never aborts the whole run.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (err) {
        failed++;
        console.log('FAIL  ' + name);
        console.log('        ' + (err && err.message ? err.message : String(err)));
    }
}

// ---------------------------------------------------------------------------
// Shared helpers: fake TextDocument + edit application.
// ---------------------------------------------------------------------------
function makeDoc(lines) {
    return {
        languageId: 'deluge',
        lineCount: lines.length,
        getText() { return lines.join('\n'); },
        lineAt(i) {
            const text = lines[i];
            const firstNonWhitespaceCharacterIndex =
                text.length - text.replace(/^\s+/, '').length;
            return { text, range: new Range(i), firstNonWhitespaceCharacterIndex };
        }
    };
}

// Apply formatter edits ({_line, newText}) to the input line array.
function applyEdits(lines, edits) {
    const out = lines.slice();
    for (const e of edits) {
        out[e._line] = e.newText;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Load the compiled modules under test (after the vscode mock is in place).
// ---------------------------------------------------------------------------
const formattingProvider = require('../out/providers/formattingProvider.js');
const scan = require('../out/util/scan.js');
const diagnosticsProvider = require('../out/providers/diagnosticsProvider.js');
const delugeData = require('../out/data/delugeData.js');

const E = DiagnosticSeverity.Error;
const W = DiagnosticSeverity.Warning;

function format(lines, options) {
    const provider = formattingProvider.getDocumentFormattingEditProvider();
    const opts = options || { insertSpaces: false, tabSize: 4 };
    const edits = provider.provideDocumentFormattingEdits(makeDoc(lines), opts);
    return applyEdits(lines, edits);
}

function diagnostics(lines) {
    return diagnosticsProvider.computeDiagnostics(makeDoc(lines));
}

function countSeverity(diags, severity) {
    return diags.filter(d => d.severity === severity).length;
}

// ===========================================================================
// 1. Formatter
// ===========================================================================
console.log('\n-- Formatter --');

test('invokeapi [...] block indents inner lines one level (tabs)', () => {
    const input = [
        'response = invokeapi [',
        'url: "https://example.com"',
        'type: GET',
        '];'
    ];
    const expected = [
        'response = invokeapi [',
        '\turl: "https://example.com"',
        '\ttype: GET',
        '];'
    ];
    assert.deepStrictEqual(format(input), expected);
});

test('simple if(x) { ... } indents the body', () => {
    const input = [
        'if(x)',
        '{',
        'info "hi";',
        '}'
    ];
    const expected = [
        'if(x)',
        '{',
        '\tinfo "hi";',
        '}'
    ];
    assert.deepStrictEqual(format(input), expected);
});

test('nested if containing invokeapi block indents to two levels', () => {
    const input = [
        'if(y)',
        '{',
        'if(x)',
        '{',
        'response = invokeapi [',
        'url: "https://example.com"',
        '];',
        '}',
        '}'
    ];
    const expected = [
        'if(y)',
        '{',
        '\tif(x)',
        '\t{',
        '\t\tresponse = invokeapi [',
        '\t\t\turl: "https://example.com"',
        '\t\t];',
        '\t}',
        '}'
    ];
    assert.deepStrictEqual(format(input), expected);
});

// ===========================================================================
// 2. Scan util
// ===========================================================================
console.log('\n-- Scan util --');

test('scanLine blanks string contents and comment (net braces 0)', () => {
    const { code } = scan.scanLine('x = "a{b}"; // c', false);
    const opens = (code.match(/{/g) || []).length;
    const closes = (code.match(/}/g) || []).length;
    assert.strictEqual(opens - closes, 0, 'expected net braces 0, code=' + JSON.stringify(code));
    assert.ok(!/[{}]/.test(code), 'braces inside the string should be removed: ' + JSON.stringify(code));
    assert.ok(!/c/.test(code), 'line comment should be removed: ' + JSON.stringify(code));
});

test('stripComments keeps string literals intact', () => {
    const { code } = scan.stripComments('x = "a{b}"; // c', false);
    assert.ok(code.includes('"a{b}"'), 'string literal should be kept: ' + JSON.stringify(code));
    assert.ok(!code.includes('// c'), 'comment should be stripped: ' + JSON.stringify(code));
});

// ===========================================================================
// 3. Diagnostics core (STABLE checks only)
// ===========================================================================
console.log('\n-- Diagnostics core --');

test('valid multi-line invokeurl produces zero diagnostics', () => {
    const diags = diagnostics([
        'response = invokeurl',
        '[',
        'url: "https://example.com"',
        'type: GET',
        '];'
    ]);
    assert.strictEqual(diags.length, 0, 'unexpected diagnostics: ' + JSON.stringify(diags.map(d => d.message)));
});

test('valid multi-line sendmail produces zero diagnostics', () => {
    const diags = diagnostics([
        'sendmail',
        '[',
        'from: zoho.loginuserid',
        'to: "a@b.com"',
        'subject: "Hi"',
        'message: "Body"',
        '];'
    ]);
    assert.strictEqual(diags.length, 0, 'unexpected diagnostics: ' + JSON.stringify(diags.map(d => d.message)));
});

test('valid if/else produces zero diagnostics', () => {
    const diags = diagnostics([
        'if(x)',
        '{',
        'info "a";',
        '}',
        'else',
        '{',
        'info "b";',
        '}'
    ]);
    assert.strictEqual(diags.length, 0, 'unexpected diagnostics: ' + JSON.stringify(diags.map(d => d.message)));
});

test('unbalanced { produces at least one Error', () => {
    const diags = diagnostics([
        'if(x)',
        '{',
        'info "a";'
    ]);
    assert.ok(countSeverity(diags, E) >= 1, 'expected >=1 Error, got: ' + JSON.stringify(diags.map(d => d.message)));
});

test('extra ) produces at least one Error', () => {
    const diags = diagnostics(['x = (1 + 2));']);
    assert.ok(countSeverity(diags, E) >= 1, 'expected >=1 Error, got: ' + JSON.stringify(diags.map(d => d.message)));
});

test('unclosed /* produces at least one Error', () => {
    const diags = diagnostics([
        'x = 5;',
        '/* never closed'
    ]);
    assert.ok(countSeverity(diags, E) >= 1, 'expected >=1 Error, got: ' + JSON.stringify(diags.map(d => d.message)));
});

test('missing semicolon produces a Warning', () => {
    const diags = diagnostics([
        'x = 5',
        'info "hi";'
    ]);
    assert.ok(countSeverity(diags, W) >= 1, 'expected >=1 Warning, got: ' + JSON.stringify(diags.map(d => d.message)));
});

// ===========================================================================
// 4. Data integrity
// ===========================================================================
console.log('\n-- Data integrity --');

function assertEntriesComplete(name, entries) {
    assert.ok(Array.isArray(entries) && entries.length > 0, name + ' should be a non-empty array');
    entries.forEach((entry, idx) => {
        for (const field of ['label', 'detail', 'documentation']) {
            const value = entry[field];
            const str = typeof value === 'string' ? value : (value && value.value);
            assert.ok(
                typeof str === 'string' && str.trim().length > 0,
                `${name}[${idx}] (label=${JSON.stringify(entry.label)}) has empty/missing '${field}'`
            );
        }
    });
}

test('MEMBER_FUNCTIONS entries have non-empty label/detail/documentation', () => {
    assertEntriesComplete('MEMBER_FUNCTIONS', delugeData.MEMBER_FUNCTIONS);
});

test('CRM_FUNCTIONS entries have non-empty label/detail/documentation', () => {
    assertEntriesComplete('CRM_FUNCTIONS', delugeData.CRM_FUNCTIONS);
});

test('STATEMENT_TASKS entries have non-empty label/detail/documentation', () => {
    assertEntriesComplete('STATEMENT_TASKS', delugeData.STATEMENT_TASKS);
});

test('KEYWORDS excludes non-Deluge keywords and includes "throws"', () => {
    const kw = delugeData.KEYWORDS;
    assert.ok(Array.isArray(kw), 'KEYWORDS should be an array');
    const forbidden = ['while', 'do', 'throw', 'finally', 'and', 'or', 'not'];
    for (const word of forbidden) {
        assert.ok(!kw.includes(word), `KEYWORDS should NOT contain '${word}'`);
    }
    assert.ok(kw.includes('throws'), "KEYWORDS should contain 'throws'");
});

test('ZOHO_NAMESPACES is non-empty', () => {
    assert.ok(Array.isArray(delugeData.ZOHO_NAMESPACES) && delugeData.ZOHO_NAMESPACES.length > 0,
        'ZOHO_NAMESPACES should be a non-empty array');
});

// ===========================================================================
// Overloads framework (signature help)
// ===========================================================================
console.log('\n-- Overloads --');
const sigProvider = require('../out/providers/signatureHelpProvider.js');

test('allSignatures: detail only when no overloads', () => {
    const sigs = delugeData.allSignatures({ label: 'f', detail: 'x f()', documentation: '' });
    assert.deepStrictEqual(sigs, ['x f()']);
});

test('allSignatures: detail first, then overloads', () => {
    const sigs = delugeData.allSignatures({
        label: 'getRecords', detail: 'list getRecords(text module)', documentation: '',
        overloads: ['list getRecords(text module, int page, int perPage)']
    });
    assert.deepStrictEqual(sigs, [
        'list getRecords(text module)',
        'list getRecords(text module, int page, int perPage)'
    ]);
});

test('pickSignature: 0 args → smallest overload', () => {
    const sigs = [{ parameters: [{}] }, { parameters: [{}, {}, {}] }];
    assert.strictEqual(sigProvider.pickSignature(sigs, 0), 0);
});

test('pickSignature: typing 3rd arg → the larger overload', () => {
    const sigs = [{ parameters: [{}] }, { parameters: [{}, {}, {}] }];
    assert.strictEqual(sigProvider.pickSignature(sigs, 2), 1);
});

test('pickSignature: past every overload → largest', () => {
    const sigs = [{ parameters: [{}] }, { parameters: [{}, {}] }];
    assert.strictEqual(sigProvider.pickSignature(sigs, 9), 1);
});

test('every DelugeSymbol overload entry is a non-empty string with parens', () => {
    const groups = ['MEMBER_FUNCTIONS', 'CRM_FUNCTIONS', 'GENERIC_INTEGRATION_FUNCTIONS'];
    for (const g of groups) {
        for (const sym of delugeData[g] || []) {
            if (!sym.overloads) { continue; }
            assert.ok(Array.isArray(sym.overloads), `${g}/${sym.label}: overloads must be an array`);
            for (const o of sym.overloads) {
                assert.ok(typeof o === 'string' && o.includes('(') && o.includes(')'),
                    `${g}/${sym.label}: overload '${o}' must be a signature string`);
            }
        }
    }
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n----------------------------------------');
console.log(`Total: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
console.log('----------------------------------------');

// Restore the original loader (tidy; not strictly required for a CLI run).
Module._load = originalLoad;

if (failed > 0) {
    process.exit(1);
}
