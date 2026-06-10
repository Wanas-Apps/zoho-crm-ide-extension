import * as vscode from 'vscode';

/**
 * A left status-bar item reflecting the Zoho connection state. Clicking it runs
 * sign-in when logged out, or shows the account menu when signed in.
 */
export class ZohoStatusBar {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.showLoggedOut();
        this.item.show();
    }

    showLoggedOut(): void {
        this.item.text = '$(sign-in) Zoho: Sign in';
        this.item.tooltip = 'Sign in to Zoho CRM';
        this.item.command = 'zohoDeluge.login';
    }

    showWorking(message: string): void {
        this.item.text = `$(sync~spin) ${message}`;
        this.item.tooltip = message;
        this.item.command = undefined;
    }

    showLoggedIn(org: string): void {
        this.item.text = `$(account) Zoho: ${org}`;
        this.item.tooltip = `Signed in to ${org} — click for account options`;
        this.item.command = 'zohoDeluge.showAccount';
    }

    dispose(): void {
        this.item.dispose();
    }
}
