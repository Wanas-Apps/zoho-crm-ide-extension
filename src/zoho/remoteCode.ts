import functionService = require('wanas-zcrm-extractor/src/services/functionService');

export interface RemoteCode {
    apiName: string;
    id: string;
    code: string;
}

/**
 * Sole owner of the read-only live-code dependency. Fetches the current saved
 * Deluge for a standalone function WITHOUT writing anything (used by the
 * conflict guard). Returns null when no such function exists in the org.
 */
export async function fetchRemoteCode(apiName: string): Promise<RemoteCode | null> {
    return functionService.getRemoteCode(apiName);
}
