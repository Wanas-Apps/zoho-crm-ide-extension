import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Pure conflict-safety core (no vscode). Hashing + the divergence decisions +
 * snapshot key/path helpers. All three code versions (base/local/live) pass
 * through the SAME formatter funnel before hashing, so whitespace-only
 * formatter differences never read as divergence.
 */

export interface BaseSnapshot {
    apiName: string;
    hash: string;
    pulledAt: string;
}

export type PushVerdict = 'SAFE' | 'CONFLICT' | 'LIVE_AHEAD' | 'NO_BASE';
export type PullVerdict = 'CLEAN' | 'DIRTY';

/** sha256 hex of the exact string. */
export function hashCode(code: string): string {
    return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Format then hash — the canonical comparison funnel. */
export function normalizeAndHash(raw: string, format: (code: string) => string): string {
    let normalized: string;
    try {
        normalized = format(raw);
    } catch {
        normalized = raw;
    }
    return hashCode(normalized);
}

/**
 * Decide whether pushing the local version is safe.
 *  - identical local/live           → SAFE (nothing meaningful to overwrite)
 *  - no recorded base               → NO_BASE (caller confirms once)
 *  - only local changed             → SAFE (normal push)
 *  - only live changed              → LIVE_AHEAD (push would clobber newer live)
 *  - both changed and differ        → CONFLICT
 */
export function decidePush(p: { baseHash?: string; localHash: string; liveHash: string }): PushVerdict {
    if (p.localHash === p.liveHash) {
        return 'SAFE';
    }
    if (p.baseHash === undefined) {
        return 'NO_BASE';
    }
    const localChanged = p.localHash !== p.baseHash;
    const liveChanged = p.liveHash !== p.baseHash;
    if (liveChanged && localChanged) {
        return 'CONFLICT';
    }
    if (liveChanged && !localChanged) {
        return 'LIVE_AHEAD';
    }
    return 'SAFE';
}

/**
 * Decide whether overwriting a local `.ds` during a pull is clean or needs a
 * prompt. A backup is ALWAYS written before overwrite regardless of verdict.
 *  - no local file                  → CLEAN
 *  - editor has unsaved edits       → DIRTY
 *  - local differs from base        → DIRTY
 *  - otherwise                      → CLEAN
 */
export function decideOverwritePull(p: {
    hasLocalFile: boolean;
    isDirty: boolean;
    localHash?: string;
    baseHash?: string;
}): PullVerdict {
    if (!p.hasLocalFile) {
        return 'CLEAN';
    }
    if (p.isDirty) {
        return 'DIRTY';
    }
    if (p.baseHash !== undefined && p.localHash !== undefined && p.localHash !== p.baseHash) {
        return 'DIRTY';
    }
    return 'CLEAN';
}

/** Org-scoped, case-insensitive snapshot key. */
export function snapshotKey(orgId: string, apiName: string): string {
    return `${orgId}::${String(apiName).toLowerCase()}`;
}

/** Normalize a `.ds` path for use as a stable index key (case-insensitive on win). */
export function normDsPath(p: string): string {
    let r = path.resolve(p).replace(/\\/g, '/');
    if (process.platform === 'win32') {
        r = r.toLowerCase();
    }
    return r;
}

/** Parse the api_name from a `standalone.<api>.ds` path. */
export function apiNameFromDsPath(p: string): string | undefined {
    const base = path.basename(p);
    const m = base.match(/^standalone\.(.+)\.ds$/i);
    return m ? m[1] : undefined;
}

/** True only for a `.../crm/functions/standalone/standalone.<api>.ds` path. */
export function isStandaloneDsPath(p: string): boolean {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    return /\/crm\/functions\/standalone\/standalone\.[^/]+\.ds$/.test(norm);
}
