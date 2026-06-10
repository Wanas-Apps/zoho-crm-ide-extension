/**
 * Pure helpers for the firewalled/no-loopback fallbacks (design §4.2):
 *  - Self Client: the user pastes a grant code generated in the Zoho API Console.
 *  - Paste refresh token: the user pastes a long-lived refresh token directly.
 * The interactive QuickInput orchestration lives in the auth provider; these
 * pure pieces are unit-tested.
 */

/** Validate a pasted Self-Client grant code (Zoho codes are long opaque tokens). */
export function validateGrantCode(input: string): string | undefined {
    const v = String(input ?? '').trim();
    return /^[A-Za-z0-9._-]{10,}$/.test(v) ? v : undefined;
}

/**
 * Build a token bundle seeded only with a pasted refresh token, with the access
 * token marked already-expired so the next getAccessToken() forces a refresh —
 * which validates the pasted token against Zoho.
 */
export function seedTokensFromRefresh(refreshToken: string, now: number): { refresh_token: string; expiry_time: number } {
    return { refresh_token: String(refreshToken).trim(), expiry_time: now - 1000 };
}
