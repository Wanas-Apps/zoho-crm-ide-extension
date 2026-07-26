/**
 * The shared-session file: how the VS Code extension hands the current Zoho
 * session to the standalone stdio MCP server (which runs as a subprocess under
 * an external agent like Antigravity and so cannot read VS Code SecretStorage).
 *
 * Security shape: the file holds a refresh token + the proxy coordinates, but
 * NO client secret — so it is inert without the user's OAuth proxy (which
 * enforces its own shared secret). Refresh is routed through that proxy exactly
 * as the extension does it. Pure (no vscode / no MCP SDK) so it is unit-testable.
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

export const SESSION_FILE_VERSION = 1;

export interface SessionTokens {
    refresh_token?: string;
    access_token?: string;
    api_domain?: string;
    expiry_time?: number;
    expires_in?: number;
}

export interface SessionFile {
    v: number;
    dc: string;
    /** Present in proxy mode (the supported external-MCP path). */
    proxy?: { url: string; token?: string };
    /** Org the session was exported from — the claim the stdio server's
     *  wrong-org guard (orgGuard.ts) checks against. */
    org?: { id: string; name?: string };
    tokens: SessionTokens;
    exported_at?: string;
}

/** Default location of the shared-session file (override with $ZOHO_MCP_SESSION). */
export function defaultSessionPath(home: string = os.homedir()): string {
    return path.join(home, '.zoho-crm-ide', 'session.json');
}

/** Filename-safe segment: org ids are digits and dcs are like "com.cn", but
 *  never trust either as a path component (no dots → no traversal). */
function fileSafe(segment: string): string {
    return String(segment).replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Org-keyed session location: ~/.zoho-crm-ide/sessions/<dc>-<orgId>.json.
 *  One file per org so exporting org B never clobbers org A's session. */
export function orgSessionPath(dc: string, orgId: string, home: string = os.homedir()): string {
    return path.join(home, '.zoho-crm-ide', 'sessions', `${fileSafe(dc)}-${fileSafe(orgId)}.json`);
}

/** Resolve the session path: explicit arg → $ZOHO_MCP_SESSION → default. */
export function resolveSessionPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = (explicit || env.ZOHO_MCP_SESSION || '').trim();
    if (fromEnv) {
        return fromEnv.startsWith('~')
            ? path.join(os.homedir(), fromEnv.slice(1))
            : path.resolve(fromEnv);
    }
    return defaultSessionPath();
}

/** Validate the parsed shape, throwing a clear error on anything unusable. */
export function assertUsableSession(s: SessionFile | undefined | null): asserts s is SessionFile {
    if (!s || typeof s !== 'object') {
        throw new Error('Session file is empty or malformed.');
    }
    if (!s.tokens || !s.tokens.refresh_token) {
        throw new Error('Session file has no refresh_token — re-export from VS Code while signed in.');
    }
    if (!s.proxy || !s.proxy.url) {
        throw new Error(
            'Session file has no proxy URL. External MCP access requires proxy mode ' +
                '(set zohoDeluge.authProxyUrl, sign in, then re-export).'
        );
    }
}

/** Build the file body from the live session pieces. */
export function buildSessionFile(input: {
    dc: string;
    proxy?: { url: string; token?: string };
    org?: { id: string; name?: string };
    tokens: SessionTokens;
    now: string;
}): SessionFile {
    return {
        v: SESSION_FILE_VERSION,
        dc: input.dc,
        proxy: input.proxy,
        org: input.org,
        tokens: {
            refresh_token: input.tokens.refresh_token,
            access_token: input.tokens.access_token,
            api_domain: input.tokens.api_domain,
            expiry_time: input.tokens.expiry_time,
            expires_in: input.tokens.expires_in
        },
        exported_at: input.now
    };
}

/** Write the session file with owner-only permissions, creating its directory. */
export async function writeSessionFile(filePath: string, data: SessionFile): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    // mkdir/writeFile mode is a no-op on some platforms; tighten best-effort.
    await fs.chmod(filePath, 0o600).catch(() => undefined);
}

/** Read + parse the session file. Throws if missing or malformed. */
export async function readSessionFile(filePath: string): Promise<SessionFile> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch {
        throw new Error(`No session file at ${filePath}. Run "Enable External MCP Access" in VS Code first.`);
    }
    let parsed: SessionFile;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Session file at ${filePath} is not valid JSON.`);
    }
    assertUsableSession(parsed);
    return parsed;
}

/** Persist refreshed tokens back into the file, preserving dc/proxy. */
export async function updateSessionTokens(filePath: string, tokens: SessionTokens): Promise<void> {
    const current = await readSessionFile(filePath);
    current.tokens = { ...current.tokens, ...tokens };
    await writeSessionFile(filePath, current);
}
