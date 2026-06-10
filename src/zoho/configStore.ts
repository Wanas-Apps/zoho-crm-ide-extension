import * as vscode from 'vscode';

/**
 * Reads the non-secret connection settings (`zohoDeluge.*`) from VS Code
 * configuration. These are resource-scoped, so they can be set per workspace
 * folder in `.vscode/settings.json` — the project-level half of the
 * "one folder ↔ one org ↔ one connection" model. Secrets are NEVER read from
 * here (they live in SecretStorage); this only handles client_id / dc / scopes
 * / concurrency.
 */
export class WorkspaceConfigStore {
    constructor(
        private readonly section = 'zohoDeluge',
        private readonly scope?: vscode.ConfigurationScope
    ) {}

    private cfg(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(this.section, this.scope);
    }

    getClientId(): string | undefined {
        const v = this.cfg().get<string>('clientId');
        return v && v.trim() ? v.trim() : undefined;
    }

    getDc(): string {
        const v = this.cfg().get<string>('dc');
        return v && v.trim() ? v.trim() : 'com';
    }

    /** URL of the backend OAuth proxy. Non-empty → sign-in runs in proxy mode
     *  (no BYO client_secret). Undefined when blank → BYO-credentials mode. */
    getAuthProxyUrl(): string | undefined {
        const v = this.cfg().get<string>('authProxyUrl');
        return v && v.trim() ? v.trim() : undefined;
    }

    /** Optional `x-proxy-token` shared secret for the OAuth proxy. */
    getAuthProxyToken(): string | undefined {
        const v = this.cfg().get<string>('authProxyToken');
        return v && v.trim() ? v.trim() : undefined;
    }

    /** Loopback ports the sign-in server may bind, in order. Each must be a
     *  registered redirect URI in the Zoho app. Falls back to the default trio
     *  when unset/invalid. */
    getLoopbackPorts(): number[] {
        const v = this.cfg().get<number[]>('loopbackPorts');
        const ports = Array.isArray(v)
            ? v.filter((p) => typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536)
            : [];
        return ports.length ? ports : [3000, 3737, 8980];
    }

    /** Returns undefined when unset so the CLI AuthService falls back to its
     *  documented default ZohoCRM scope set. */
    getScopes(): string | undefined {
        const v = this.cfg().get<string>('scopes');
        return v && v.trim() ? v.trim() : undefined;
    }

    getConcurrency(): number {
        const v = this.cfg().get<number>('concurrency');
        return typeof v === 'number' && v > 0 ? v : 5;
    }

    /** How many recent test artifacts / backups to keep per function (0 = all). */
    getRetention(): number {
        const v = this.cfg().get<number>('testArtifacts.retention');
        return typeof v === 'number' && v >= 0 ? v : 20;
    }

    async setClientId(clientId: string): Promise<void> {
        await this.update('clientId', clientId);
    }

    async setDc(dc: string): Promise<void> {
        await this.update('dc', dc);
    }

    /** Write to the bound workspace folder's settings when one exists, else
     *  the workspace, else user (global) settings. */
    private async update(key: string, value: unknown): Promise<void> {
        const target = this.scope
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
        await this.cfg().update(key, value, target);
    }
}
