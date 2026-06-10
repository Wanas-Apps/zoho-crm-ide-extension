import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from './snapshotStore';
import {
    normalizeAndHash,
    decidePush,
    decideOverwritePull,
    apiNameFromDsPath,
    isStandaloneDsPath
} from './conflictGuard';

export type RemoteFetcher = (apiName: string) => Promise<{ apiName: string; id: string; code: string } | null>;
export type Formatter = (code: string) => string;

export interface GuardResult {
    /** Whether the caller should proceed with the push/overwrite. After a
     *  successful push the caller records the new base via `recordPulled`. */
    proceed: boolean;
    /** True when a confirmation modal was already shown (so the caller can skip
     *  a redundant "push to live?" prompt). */
    prompted?: boolean;
}

export interface ConflictGuardDeps {
    store: SnapshotStore;
    fetchRemote: RemoteFetcher;
    format: Formatter;
    output: vscode.OutputChannel;
    /** Absolute bound-folder path (backups live under <outputDir>/.zcrm/.backups). */
    getOutputDir: () => string | undefined;
}

/**
 * Enforced conflict safety (design §7.5). Pushes are blocked on true divergence
 * unless explicitly overridden; overwrite-pulls always back up an existing file
 * first. All decision math is delegated to the pure `conflictGuard.ts`.
 */
export class ConflictGuard {
    constructor(private readonly deps: ConflictGuardDeps) {}

    /** Gate a push of `localCode` for the function at `dsPath`. */
    async guardPush(dsPath: string, localCode: string): Promise<GuardResult> {
        const apiName = apiNameFromDsPath(dsPath);
        if (!apiName) {
            return { proceed: true };
        }
        const remote = await this.deps.fetchRemote(apiName);
        if (!remote) {
            // No live counterpart — not a conflict; the push/create path validates.
            return { proceed: true, prompted: false };
        }
        const localHash = normalizeAndHash(localCode, this.deps.format);
        const liveHash = normalizeAndHash(remote.code, this.deps.format);
        const base = this.deps.store.get(apiName);
        const verdict = decidePush({ baseHash: base?.hash, localHash, liveHash });

        if (verdict === 'SAFE') {
            return { proceed: true, prompted: false };
        }
        if (verdict === 'NO_BASE') {
            const pick = await vscode.window.showWarningMessage(
                `There's no local baseline for "${apiName}" yet. Push your version and overwrite whatever is live in Zoho?`,
                { modal: true },
                'Push (overwrite live)'
            );
            return { proceed: pick === 'Push (overwrite live)', prompted: true };
        }
        if (verdict === 'LIVE_AHEAD') {
            const pick = await vscode.window.showWarningMessage(
                `"${apiName}" changed in Zoho since your last pull, but your local copy is unchanged. Pushing would overwrite the newer live version.`,
                { modal: true },
                'Show live diff',
                'Push anyway (overwrite live)'
            );
            if (pick === 'Show live diff') {
                await this.showDiff(apiName, remote.code, dsPath);
                return { proceed: false, prompted: true };
            }
            return { proceed: pick === 'Push anyway (overwrite live)', prompted: true };
        }
        // CONFLICT
        const pick = await vscode.window.showWarningMessage(
            `Conflict: both your local "${apiName}" AND the live version in Zoho changed since your last pull. Pushing overwrites the live changes.`,
            { modal: true },
            'Show live diff',
            'Overwrite live with my version'
        );
        if (pick === 'Show live diff') {
            await this.showDiff(apiName, remote.code, dsPath);
            return { proceed: false, prompted: true };
        }
        return { proceed: pick === 'Overwrite live with my version', prompted: true };
    }

    /** Gate an overwrite-pull of `dsPath`. Always backs up an existing file. */
    async guardOverwritePull(dsPath: string, opts?: { isDirty?: boolean }): Promise<GuardResult> {
        const apiName = apiNameFromDsPath(dsPath) || path.basename(dsPath, '.ds');
        const hasLocalFile = fs.existsSync(dsPath);
        let localHash: string | undefined;
        if (hasLocalFile) {
            try {
                localHash = normalizeAndHash(fs.readFileSync(dsPath, 'utf8'), this.deps.format);
            } catch {
                /* unreadable → treat as no hash */
            }
        }
        const base = this.deps.store.get(apiName);
        const verdict = decideOverwritePull({ hasLocalFile, isDirty: !!opts?.isDirty, localHash, baseHash: base?.hash });
        let prompted = false;

        if (verdict === 'DIRTY') {
            prompted = true;
            const pick = await vscode.window.showWarningMessage(
                `Your local "${apiName}" has changes that aren't in Zoho. Pulling overwrites them — a backup is saved first.`,
                { modal: true },
                'Overwrite (back up first)'
            );
            if (pick !== 'Overwrite (back up first)') {
                return { proceed: false, prompted };
            }
        }
        if (hasLocalFile) {
            try {
                const bak = await this.writeBackup(dsPath);
                this.deps.output.appendLine(`[conflict] backed up ${path.basename(dsPath)} → ${bak}`);
            } catch (e) {
                this.deps.output.appendLine(`[conflict] backup failed for ${dsPath}: ${String(e)}`);
                // Fail-closed: the contract is "always back up before overwrite".
                // When the local copy has changes that aren't in Zoho, refuse to
                // overwrite without a backup rather than silently losing them.
                if (verdict === 'DIRTY') {
                    await vscode.window.showErrorMessage(
                        `Couldn't back up your local "${apiName}" before pulling, so the pull was cancelled to protect your unsaved changes. Free up disk space or check folder permissions, then try again.`
                    );
                    return { proceed: false, prompted };
                }
            }
        }
        return { proceed: true, prompted };
    }

    /** Record the current on-disk `.ds` as the new base (call after a pull writes it). */
    async recordPulled(dsPath: string): Promise<void> {
        const apiName = apiNameFromDsPath(dsPath);
        if (!apiName || !fs.existsSync(dsPath)) {
            return;
        }
        const hash = normalizeAndHash(fs.readFileSync(dsPath, 'utf8'), this.deps.format);
        await this.deps.store.record(apiName, hash, dsPath);
    }

    /** Snapshot every standalone `.ds` under a freshly-pulled folder. */
    async recordManyFromFolder(outputDir: string): Promise<void> {
        const dir = path.join(outputDir, 'crm', 'functions', 'standalone');
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ds'));
        } catch {
            return;
        }
        for (const f of entries) {
            const full = path.join(dir, f);
            if (isStandaloneDsPath(full)) {
                try {
                    await this.recordPulled(full);
                } catch {
                    /* skip unreadable file */
                }
            }
        }
    }

    /** Write a timestamped backup under <outputDir>/.zcrm/.backups (or sibling). */
    async writeBackup(dsPath: string): Promise<string> {
        const apiName = apiNameFromDsPath(dsPath) || path.basename(dsPath, '.ds');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const outputDir = this.deps.getOutputDir();
        const dir = outputDir ? path.join(outputDir, '.zcrm', '.backups') : path.dirname(dsPath);
        await fs.promises.mkdir(dir, { recursive: true });
        const dest = path.join(dir, `${apiName}-${ts}.ds`);
        await fs.promises.copyFile(dsPath, dest);
        return dest;
    }

    private async showDiff(apiName: string, liveCode: string, localDsPath: string): Promise<void> {
        try {
            const tmp = path.join(os.tmpdir(), `zoho-live-${apiName}-${Date.now()}.ds`);
            await fs.promises.writeFile(tmp, liveCode, 'utf8');
            await vscode.commands.executeCommand(
                'vscode.diff',
                vscode.Uri.file(tmp),
                vscode.Uri.file(localDsPath),
                `${apiName}: Live (Zoho) ↔ Local`
            );
        } catch (e) {
            this.deps.output.appendLine(`[conflict] could not show diff: ${String(e)}`);
        }
    }
}
