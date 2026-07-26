import { RunResult } from './functionOps';

/**
 * Render a `fn test` result to a plain-text block for the OutputChannel
 * (re-authored from the CLI's ANSI renderer — NO escape codes). Shows status,
 * return value, info logs, network/integration calls, metrics, and the saved
 * artifact path.
 */
export function renderTestResult(result: RunResult): string {
    const { resolved, fnResult, savedPath, success } = result;
    const bar = '─'.repeat(60);
    const lines: string[] = [];

    const ns = resolved.namespace || 'standalone';
    lines.push('');
    lines.push(`${success ? '✓ SUCCESS' : '✗ FAILED'}  🧪 ${ns}.${resolved.apiName}`);
    lines.push(bar);

    // Compile / runtime errors (Zoho reports these under response.functions[].error).
    // Surface them up front — on a COMPILE_ERROR the return value is empty, so the
    // error is the only useful signal.
    const errors = collectErrors(result);
    if (errors.length) {
        lines.push(`Errors (${errors.length}):`);
        for (const e of errors) {
            lines.push(fmtError(e));
        }
        lines.push(bar);
    }

    // Return value (unwrap Zoho's {value,...} envelope; pretty-print JSON).
    let out = fnResult?.output;
    if (out && typeof out === 'object' && 'value' in out) {
        out = out.value;
    }
    if (out === null || out === undefined || out === '') {
        lines.push('Return: (empty)');
    } else {
        lines.push(`Return: ${fmt(out)}`);
    }

    const logs: any[] = fnResult?.logs || [];
    if (logs.length) {
        lines.push('');
        lines.push(`Logs (${logs.length}):`);
        for (const l of logs) {
            const loc = l.line_number != null ? `L${l.line_number} ` : '';
            const cat = l.category && l.category !== 'info' ? `[${l.category}] ` : '';
            lines.push(`  ${loc}${cat}${fmt(l.value)}`);
        }
    }

    const net: any[] = fnResult?.network_logs || [];
    if (net.length) {
        lines.push('');
        lines.push(`Network / integration calls (${net.length}):`);
        for (const n of net) {
            const method = String(n.http_method || (n.details && n.details.task ? 'TASK' : '—')).toUpperCase();
            const where = (n.details && (n.details.url || n.details.task)) || n.function_name || '';
            lines.push(`  ${method} ${n.status_code ?? ''} ${where} ${n.time_taken_in_ms ?? 0}ms`);
        }
    }

    const m = fnResult?.metrics || {};
    lines.push(bar);
    lines.push(
        `${m.statements_executed || 0} statements · ${m.integration_task || 0} integration · ` +
            `${m.send_mail || 0} mail · ${m.send_sms || 0} sms · ${m.time_taken_in_ms || 0}ms`
    );
    if (savedPath) {
        lines.push(`Saved → ${savedPath}`);
    }
    return lines.join('\n');
}

/**
 * Gather error objects from a run result. Prefers the full `response.functions[]`
 * array (catches errors across every executed function); falls back to the single
 * `fnResult.error`. Each entry is typically `{ line_number, function_name, type,
 * message }` but may be a bare string.
 */
function collectErrors(result: RunResult): unknown[] {
    const fns = result.response && Array.isArray(result.response.functions) ? result.response.functions : undefined;
    if (fns) {
        return fns.map((f: any) => f && f.error).filter(Boolean);
    }
    return result.fnResult?.error ? [result.fnResult.error] : [];
}

/** `[COMPILE_ERROR] L7 in ataya: The syntax is incorrect.` (tolerant of shape). */
function fmtError(e: any): string {
    if (e == null) {
        return '  (unknown error)';
    }
    if (typeof e === 'string') {
        return `  ${e}`;
    }
    const type = e.type ? `[${e.type}] ` : '';
    const loc = e.line_number != null ? `L${e.line_number} ` : '';
    const fn = e.function_name ? `in ${e.function_name}: ` : '';
    const msg = e.message != null ? String(e.message) : fmt(e);
    return `  ${type}${loc}${fn}${msg}`.replace(/\s+$/, '');
}

/** Plain-text block for a successful Pull (colorized by the output grammar). */
export function renderPullResult(p: { apiName: string; filePath: string; namespace?: string }): string {
    const bar = '─'.repeat(60);
    const ns = p.namespace || 'function';
    return ['', `✓ Pulled  📥 ${ns}.${p.apiName}`, bar, `Saved → ${p.filePath}`].join('\n');
}

/** Plain-text block for a successful Push (colorized by the output grammar). */
export function renderPushResult(p: { apiName: string; filePath: string; namespace?: string }): string {
    const bar = '─'.repeat(60);
    const ns = p.namespace || 'function';
    return ['', `✓ Pushed  📤 ${ns}.${p.apiName}`, bar, `From → ${p.filePath}`, 'Live org updated.'].join('\n');
}

function fmt(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }
    const s = String(value);
    if (/^\s*[{[]/.test(s)) {
        try {
            return JSON.stringify(JSON.parse(s), null, 2);
        } catch {
            /* not JSON → plain */
        }
    }
    return s;
}
