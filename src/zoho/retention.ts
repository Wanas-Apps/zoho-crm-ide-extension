import * as fs from 'fs';
import * as path from 'path';

/**
 * Retention pruning for test-run artifacts (`crm/function_tests/<api>-<ts>.json`)
 * and pre-overwrite backups (`.zcrm/.backups/<api>-<ts>.ds`). Pure helpers +
 * a tolerant directory pruner. Keeps the newest `keep` per function; `keep <= 0`
 * keeps everything. Files whose name can't be parsed are left untouched (safe).
 */

// The writer stamps `new Date().toISOString().replace(/[:.]/g,'-')`, so the ts
// itself contains dashes: 2026-06-09T12-30-45-123Z.
const TS_RE = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{1,}Z)$/;

export function parseArtifactName(name: string, ext: string): { apiName: string; ts: string } | null {
    if (!name.toLowerCase().endsWith(ext.toLowerCase())) {
        return null;
    }
    const stem = name.slice(0, name.length - ext.length);
    const m = stem.match(TS_RE);
    if (!m) {
        return null;
    }
    const apiName = stem.slice(0, stem.length - m[0].length);
    if (!apiName) {
        return null;
    }
    return { apiName, ts: m[1] };
}

/** Returns the file names to DELETE (keep newest `keep` per api_name). */
export function planRetention(names: string[], ext: string, keep: number): string[] {
    if (keep <= 0) {
        return [];
    }
    const byApi = new Map<string, { name: string; ts: string }[]>();
    for (const n of names) {
        const p = parseArtifactName(n, ext);
        if (!p) {
            continue; // unparseable → leave alone
        }
        const list = byApi.get(p.apiName) ?? [];
        list.push({ name: n, ts: p.ts });
        byApi.set(p.apiName, list);
    }
    const toDelete: string[] = [];
    for (const list of byApi.values()) {
        list.sort((a, b) => b.ts.localeCompare(a.ts)); // newest first
        for (const item of list.slice(keep)) {
            toDelete.push(item.name);
        }
    }
    return toDelete;
}

/** Prune `dir`, keeping the newest `keep` per function. Tolerant of a missing dir. */
export async function pruneDir(dir: string, ext: string, keep: number): Promise<{ scanned: number; deleted: number }> {
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith(ext.toLowerCase()));
    } catch {
        return { scanned: 0, deleted: 0 };
    }
    const toDelete = planRetention(names, ext, keep);
    let deleted = 0;
    for (const n of toDelete) {
        try {
            await fs.promises.unlink(path.join(dir, n));
            deleted++;
        } catch {
            /* best-effort */
        }
    }
    return { scanned: names.length, deleted };
}
