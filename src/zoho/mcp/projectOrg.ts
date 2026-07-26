/**
 * The project org pointer: a small, NON-SECRET file (`.zoho-crm-ide.json`) at
 * the workspace root that declares which Zoho org the project belongs to:
 *
 *     { "v": 1, "org_id": "700500…", "dc": "com", "org_name": "Acme" }
 *
 * The extension writes it on sign-in; the standalone stdio MCP server reads it
 * (via the client's MCP roots, or a cwd walk-up) to pick the right per-org
 * session file and bind the wrong-org guard — so one generic agent-config
 * entry follows whatever project the agent is working in. Safe to commit: it
 * holds an org id, never tokens (see sessionFile.ts for the secret half).
 * Pure (no vscode / no MCP SDK) so it is unit-testable.
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

export const PROJECT_ORG_FILE = '.zoho-crm-ide.json';

export interface ProjectOrg {
    orgId: string;
    dc: string;
    name?: string;
}

/** Parse a pointer-file body; undefined on anything unusable (never throws). */
export function parseProjectOrg(raw: string): ProjectOrg | undefined {
    let parsed: { org_id?: unknown; dc?: unknown; org_name?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object') {
        return undefined;
    }
    const orgId = parsed.org_id == null ? '' : String(parsed.org_id).trim();
    if (!orgId) {
        return undefined;
    }
    const dc = typeof parsed.dc === 'string' && parsed.dc.trim() ? parsed.dc.trim() : 'com';
    const name = typeof parsed.org_name === 'string' && parsed.org_name ? parsed.org_name : undefined;
    return { orgId, dc, name };
}

/** Pointer-file body for a ProjectOrg (stable shape, trailing newline). */
export function buildProjectOrgJson(org: ProjectOrg): string {
    return (
        JSON.stringify(
            { v: 1, org_id: org.orgId, dc: org.dc, ...(org.name ? { org_name: org.name } : {}) },
            null,
            2
        ) + '\n'
    );
}

/** Read + parse the pointer in one directory; undefined when absent/unusable. */
export async function readProjectOrg(dir: string): Promise<ProjectOrg | undefined> {
    try {
        const raw = await fs.readFile(path.join(dir, PROJECT_ORG_FILE), 'utf8');
        return parseProjectOrg(raw);
    } catch {
        return undefined;
    }
}

/**
 * Walk up from a directory to the nearest enclosing project pointer (like git
 * discovering .git). Bounded so a weird fs can't loop forever.
 */
export async function findProjectOrg(startDir: string): Promise<{ org: ProjectOrg; dir: string } | undefined> {
    let dir = path.resolve(startDir);
    for (let depth = 0; depth < 40; depth++) {
        const org = await readProjectOrg(dir);
        if (org) {
            return { org, dir };
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
    return undefined;
}

/** MCP `roots` (file:// URIs) → local directories, skipping anything else. */
export function rootsToDirs(roots: Array<{ uri?: unknown }> | undefined | null): string[] {
    const dirs: string[] = [];
    for (const root of roots || []) {
        const uri = root && typeof root.uri === 'string' ? root.uri : '';
        if (!uri.startsWith('file:')) {
            continue;
        }
        try {
            dirs.push(fileURLToPath(uri));
        } catch {
            /* malformed URI — skip */
        }
    }
    return dirs;
}

/** Write the pointer into a workspace folder; no-op when already current. */
export async function writeProjectOrgFile(dir: string, org: ProjectOrg): Promise<void> {
    const file = path.join(dir, PROJECT_ORG_FILE);
    const body = buildProjectOrgJson(org);
    const current = await fs.readFile(file, 'utf8').catch(() => '');
    if (current === body) {
        return;
    }
    await fs.writeFile(file, body, 'utf8');
}
