import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * The workspace folder the Zoho connection is bound to. M1 supports a single
 * connection per host, bound to the first workspace folder (the
 * "one folder ↔ one org" model). Multi-root folder selection is a later
 * milestone.
 */
export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

/**
 * A stable, keychain-safe SecretStorage key derived from the workspace folder's
 * filesystem path. Hashing keeps the key short and free of path separators, and
 * makes each project folder its own connection without leaking the path.
 */
export function getConnectionKey(folder?: vscode.WorkspaceFolder): string {
    const fsPath = folder?.uri.fsPath ?? '__no_workspace__';
    const hash = crypto.createHash('sha256').update(fsPath).digest('hex').slice(0, 16);
    return `zohoDeluge.connection:${hash}`;
}
