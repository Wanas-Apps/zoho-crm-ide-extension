import apiClient = require('@wanasapps/zcrm-core/src/utils/apiClient');

/**
 * Identity of the signed-in Zoho user + org, used to label the session and bind
 * the single-session lock. Re-authored from the CLI `whoami` command.
 */
export interface WhoAmI {
    userName: string;
    email: string;
    org: string;
    orgId: string;
    dc: string;
}

/** Pure mapping from the raw users/org API responses to a WhoAmI. Testable. */
export function parseWhoAmI(userRes: any, orgRes: any, dc: string): WhoAmI {
    const user = userRes?.users?.[0] ?? {};
    const org = orgRes?.org?.[0] ?? {};
    return {
        userName: user.full_name || user.first_name || 'Zoho user',
        email: user.email || '',
        org: org.company_name || 'Zoho CRM',
        orgId: org.zorg_id ? String(org.zorg_id) : '',
        dc
    };
}

/**
 * Confirm the freshly-minted session by fetching the current user + org. Uses
 * the bridged apiClient (which authenticates via the configured singleton).
 */
export async function fetchWhoAmI(dc: string): Promise<WhoAmI> {
    const [userRes, orgRes] = await Promise.all([
        apiClient.get('/crm/v8/users', { type: 'CurrentUser' }),
        apiClient.get('/crm/v8/org')
    ]);
    return parseWhoAmI(userRes, orgRes, dc);
}
