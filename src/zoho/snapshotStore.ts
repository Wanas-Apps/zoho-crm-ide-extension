import type * as vscode from 'vscode';
import { BaseSnapshot, snapshotKey, normDsPath } from './conflictGuard';

const SNAP_KEY = 'zohoDeluge.baseSnapshots';
const PATH_KEY = 'zohoDeluge.snapshotPathIndex';

/**
 * Persists per-function base snapshots (hash of the code as last pulled) in
 * workspaceState — NEVER tracked files. Org-scoped via the active session's
 * orgId so two orgs in the same workspace never cross-contaminate. When no org
 * is active, records no-op and lookups return undefined.
 */
export class SnapshotStore {
    constructor(
        private readonly state: vscode.Memento,
        private readonly orgId: () => string | undefined
    ) {}

    private snaps(): Record<string, BaseSnapshot> {
        return this.state.get<Record<string, BaseSnapshot>>(SNAP_KEY) ?? {};
    }

    private paths(): Record<string, string> {
        return this.state.get<Record<string, string>>(PATH_KEY) ?? {};
    }

    get(apiName: string): BaseSnapshot | undefined {
        const org = this.orgId();
        if (!org) {
            return undefined;
        }
        return this.snaps()[snapshotKey(org, apiName)];
    }

    getByDsPath(dsPath: string): BaseSnapshot | undefined {
        const key = this.paths()[normDsPath(dsPath)];
        return key ? this.snaps()[key] : undefined;
    }

    async record(apiName: string, hash: string, dsPath?: string, pulledAt?: string): Promise<void> {
        const org = this.orgId();
        if (!org) {
            return;
        }
        const key = snapshotKey(org, apiName);
        const snaps = this.snaps();
        snaps[key] = { apiName, hash, pulledAt: pulledAt ?? new Date().toISOString() };
        await this.state.update(SNAP_KEY, snaps);
        if (dsPath) {
            const paths = this.paths();
            paths[normDsPath(dsPath)] = key;
            await this.state.update(PATH_KEY, paths);
        }
    }

    async clearAll(): Promise<void> {
        await this.state.update(SNAP_KEY, undefined);
        await this.state.update(PATH_KEY, undefined);
    }
}
