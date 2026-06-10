/**
 * A simple in-process mutex for metadata sync. Prevents overlapping pulls and
 * exposes a change signal so the M4 metadata watcher can pause re-indexing
 * while a pull is rewriting the `.store`/`crm` trees. Pure (no vscode) so it is
 * unit-testable.
 */
export type SyncLockListener = (locked: boolean) => void;

export class SyncLock {
    private locked = false;
    private readonly listeners: SyncLockListener[] = [];

    isLocked(): boolean {
        return this.locked;
    }

    /** Subscribe to lock/unlock transitions. */
    onChange(listener: SyncLockListener): { dispose(): void } {
        this.listeners.push(listener);
        return {
            dispose: () => {
                const i = this.listeners.indexOf(listener);
                if (i >= 0) {
                    this.listeners.splice(i, 1);
                }
            }
        };
    }

    private emit(): void {
        for (const l of this.listeners.slice()) {
            try {
                l(this.locked);
            } catch {
                /* listener errors must not break the lock */
            }
        }
    }

    /** Run `fn` exclusively. Throws if a sync is already in progress. */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        if (this.locked) {
            throw new Error('A metadata sync is already in progress.');
        }
        this.locked = true;
        this.emit();
        try {
            return await fn();
        } finally {
            this.locked = false;
            this.emit();
        }
    }
}
