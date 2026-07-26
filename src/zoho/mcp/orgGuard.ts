/**
 * Wrong-org protection for the standalone stdio MCP server.
 *
 * The agent config pins which org a server entry serves ($ZOHO_MCP_EXPECTED_ORG);
 * the session file carries an org claim written at export time; the live org is
 * whatever the tokens actually resolve to. Three checks, two moments:
 *
 *  - at boot (pure, no network): pin vs claim — a clobbered or wrong session
 *    file is refused before the server ever advertises tools (assertOrgPin).
 *  - at first tool call (lazy, one /crm/v8/org fetch): pin vs LIVE org — even a
 *    hand-edited claim cannot point tools at the wrong org (createLiveOrgGuard).
 *
 * Boot stays network-free on purpose: agents launch MCP servers at IDE startup,
 * and the e2e probe boots the binary with a dummy session offline.
 * Pure (no vscode / no MCP SDK) so it is unit-testable.
 */

export class OrgMismatchError extends Error {
    readonly code = 'ORG_MISMATCH';
    constructor(message: string) {
        super(message);
        this.name = 'OrgMismatchError';
    }
}

/**
 * Boot-time check: when the agent config pins an org, the session file must
 * claim that same org. No pin → nothing to enforce (legacy configs).
 */
export function assertOrgPin(claimedOrgId: string | undefined, expectedOrgId: string | undefined): void {
    const expected = (expectedOrgId || '').trim();
    if (!expected) {
        return;
    }
    const claimed = (claimedOrgId || '').trim();
    if (!claimed) {
        throw new OrgMismatchError(
            `This server entry is pinned to org ${expected} but the session file has no org claim — ` +
                're-export it ("Enable External MCP Access") and refresh the agent config.'
        );
    }
    if (claimed !== expected) {
        throw new OrgMismatchError(
            `Session file belongs to org ${claimed} but this server entry is pinned to org ${expected} — ` +
                'refusing to start. Re-run "Copy Antigravity Config" in the IDE signed in to the org you intend to use.'
        );
    }
}

/** Org id from a /crm/v8/org response, normalized to a string ('' if absent). */
export function extractOrgId(orgRes: unknown): string {
    const org = (orgRes as { org?: Array<{ zorg_id?: unknown }> } | undefined)?.org?.[0];
    return org && org.zorg_id != null ? String(org.zorg_id) : '';
}

/**
 * Lazy verification before the first real tool call:
 *
 *  1. resolve the expected org (env pin, project pointer via MCP roots/cwd —
 *     whatever the caller wires in; '' when nothing binds),
 *  2. expected vs the session file's claim (pure — catches "wrong session
 *     file loaded for this project" without a network call),
 *  3. live org fetch vs the binding (expected, or the claim when unpinned).
 *
 * Fully unbound (no expected, no claim — a legacy v1 session) passes with a
 * warning and no live fetch. Success is memoized (one resolution per process);
 * failure is not, so a transient network error retries on the next call while
 * a genuine mismatch keeps refusing.
 */
export function createOrgGuard(opts: {
    claimedOrgId: string | undefined;
    resolveExpectedOrgId: () => Promise<string>;
    fetchLiveOrgId: () => Promise<string>;
    log?: (msg: string) => void;
}): () => Promise<void> {
    let verified: Promise<void> | undefined;
    const verify = async (): Promise<void> => {
        const expected = (await opts.resolveExpectedOrgId()).trim();
        if (expected) {
            assertOrgPin(opts.claimedOrgId, expected);
        }
        const bound = expected || (opts.claimedOrgId || '').trim();
        if (!bound) {
            opts.log?.('warning: no org binding (no pin, project pointer, or session claim) — wrong-org protection is OFF.');
            return;
        }
        const live = (await opts.fetchLiveOrgId()).trim();
        if (live !== bound) {
            throw new OrgMismatchError(
                `Live Zoho org is ${live || 'unknown'} but this session is bound to org ${bound} — ` +
                    'refusing to run tools. Re-export the session from the IDE signed in to the org you intend to use.'
            );
        }
        opts.log?.(`org identity verified (org ${live})`);
    };
    return () => {
        if (!verified) {
            verified = verify();
            verified.catch(() => {
                verified = undefined;
            });
        }
        return verified;
    };
}
