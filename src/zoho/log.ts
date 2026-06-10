import type * as vscode from 'vscode';

/**
 * A `LoggerPort` implementation that routes the CLI services' log output to a
 * VS Code OutputChannel instead of `console.*` / `process.cwd()/storage/logs`.
 * Implements the `{ logInfo, logError }` shape the CLI logger exposes.
 */
export class OutputChannelLog {
    constructor(private readonly channel: vscode.OutputChannel) {}

    logInfo(message: string, context?: string): void {
        this.channel.appendLine(`[${ts()}] [INFO] ${context ? `(${context}) ` : ''}${message}`);
    }

    logError(error: unknown, context?: string): void {
        this.channel.appendLine(`[${ts()}] [ERROR] ${context ? `(${context}) ` : ''}${describe(error)}`);
    }
}

function ts(): string {
    return new Date().toISOString();
}

/** Build a concise, keychain-safe description of an error for the channel. */
function describe(error: unknown): string {
    if (error && typeof error === 'object') {
        const e = error as {
            isAxiosError?: boolean;
            message?: string;
            response?: { status?: number; data?: unknown };
        };
        if (e.isAxiosError) {
            const status = e.response?.status ?? 'no-status';
            const body = e.response?.data;
            const bodyStr = body == null ? '' : ` ${typeof body === 'string' ? body : safeStringify(body)}`;
            return `${e.message ?? 'Request failed'} (status ${status})${bodyStr}`;
        }
        if (error instanceof Error) {
            return error.stack ? `${error.message}\n${error.stack}` : String(error.message);
        }
        return safeStringify(error);
    }
    return String(error);
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
