import type * as vscode from 'vscode';

/**
 * The one active Zoho session bound to this host (design §4.7). Until the M6
 * core split enables true per-connection clients, exactly one org is active at
 * a time. Run/Push/Create assert against `apiDomain` before executing to
 * eliminate the wrong-org hazard.
 */
export interface ActiveSession {
    org: string;
    orgId: string;
    apiDomain: string;
    dc: string;
    email?: string;
    folder?: string;
    /** ms epoch when the session was established (stamped by the caller). */
    since?: number;
}

const KEY = 'zohoDeluge.activeSession';

/** Persists the single active session in workspaceState. */
export class SessionLock {
    constructor(private readonly state: vscode.Memento) {}

    get(): ActiveSession | undefined {
        return this.state.get<ActiveSession>(KEY);
    }

    isActive(): boolean {
        return !!this.get();
    }

    async set(session: ActiveSession): Promise<void> {
        await this.state.update(KEY, session);
    }

    async clear(): Promise<void> {
        await this.state.update(KEY, undefined);
    }
}
