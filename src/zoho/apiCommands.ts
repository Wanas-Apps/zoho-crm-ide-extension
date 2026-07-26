import * as vscode from 'vscode';
import apiClient = require('wanas-zcrm-extractor/src/utils/apiClient');
import auditLogService = require('wanas-zcrm-extractor/src/services/auditLogService');

export interface ApiCommandDeps {
    output: vscode.OutputChannel;
    isAuthenticated(): boolean;
    getOutputDir(): string | undefined;
}

export function registerApiCommands(
    context: vscode.ExtensionContext,
    deps: ApiCommandDeps
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('zohoDeluge.executeApi', () => executeApiCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.executeCoql', () => executeCoqlCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.exportAuditLog', () => exportAuditLogCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageVariables', () => manageVariablesCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageTags', () => manageTagsCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageNotes', () => manageNotesCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageUsers', () => manageUsersCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageRecycleBin', () => manageRecycleBinCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageWorkflows', () => manageWorkflowsCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.sendMail', () => sendMailCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.manageBlueprint', () => manageBlueprintCmd(deps)),
        vscode.commands.registerCommand('zohoDeluge.executeComposite', () => executeCompositeCmd(deps))
    );
}

function assertAuth(deps: ApiCommandDeps): void {
    if (!deps.isAuthenticated()) {
        throw new Error('Sign in to Zoho CRM before performing this operation.');
    }
}

async function showResult(deps: ApiCommandDeps, title: string, data: any): Promise<void> {
    deps.output.appendLine(`=== ${title} ===`);
    deps.output.appendLine(JSON.stringify(data, null, 2));
    deps.output.show(true);
}

async function executeApiCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const method = await vscode.window.showQuickPick(
            ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            { placeHolder: 'Select HTTP Method' }
        );
        if (!method) return;

        const endpoint = await vscode.window.showInputBox({
            prompt: 'Enter API endpoint path (e.g. /crm/v8/Leads or /crm/v8/settings/variables)',
            placeHolder: '/crm/v8/Leads'
        });
        if (!endpoint) return;

        let body: any = undefined;
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
            const bodyStr = await vscode.window.showInputBox({
                prompt: 'Enter JSON payload (optional, leave empty for none)',
                placeHolder: '{"data":[{"Last_Name":"Test"}]}'
            });
            if (bodyStr) {
                body = JSON.parse(bodyStr);
            }
        }

        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Executing ${method} ${endpoint}…` },
            async () => {
                const ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
                if (method === 'GET') return apiClient.get(ep);
                if (method === 'POST') return apiClient.post(ep, body || {});
                if (method === 'PUT') return apiClient.put(ep, body || {});
                if (method === 'PATCH') return apiClient.patch(ep, body || {});
                if (method === 'DELETE') return apiClient.del(ep);
            }
        );

        await showResult(deps, `${method} ${endpoint} Response`, res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] API call failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`API Call Failed: ${e?.message || e}`);
    }
}

async function executeCoqlCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const query = await vscode.window.showInputBox({
            prompt: 'Enter COQL SELECT query (WHERE is auto-added if missing; aggregates need UPPERCASE names + a limit)',
            placeHolder: 'select Last_Name, Email from Leads limit 10'
        });
        if (!query) return;

        // Same auto-WHERE behavior as the zcrm CLI and the MCP query tool:
        // Zoho rejects any COQL query without a WHERE clause.
        let fixedQuery = query;
        if (!/\bwhere\b/i.test(fixedQuery)) {
            const m = fixedQuery.match(/\b(order\s+by|group\s+by|limit|offset)\b/i);
            const where = ' where id is not null ';
            fixedQuery = m ? fixedQuery.slice(0, m.index) + where + fixedQuery.slice(m.index) : fixedQuery.trimEnd() + where.trimEnd();
        }

        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Executing COQL query…' },
            () => apiClient.post('/crm/v8/coql', { select_query: fixedQuery })
        );

        // 204 (zero rows) normalizes to an empty object — show an honest result.
        const empty = !res || (typeof res === 'object' && !Array.isArray((res as any).data) && Object.keys(res).length === 0);
        await showResult(deps, 'COQL Query Results', empty ? { data: [], info: { count: 0, more_records: false } } : res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] COQL query failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`COQL Query Failed: ${e?.message || e}`);
    }
}

async function sendMailCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const moduleName = await vscode.window.showInputBox({ prompt: 'Module API Name', placeHolder: 'Leads' });
        if (!moduleName) return;
        const recordId = await vscode.window.showInputBox({ prompt: 'Record ID the email is sent from' });
        if (!recordId) return;
        const to = await vscode.window.showInputBox({ prompt: 'To (comma-separated email addresses)', placeHolder: 'a@example.com,b@example.com' });
        if (!to) return;
        const subject = await vscode.window.showInputBox({ prompt: 'Subject' });
        if (subject === undefined) return;
        const content = await vscode.window.showInputBox({ prompt: 'Body (HTML allowed)' });
        if (content === undefined) return;

        const ok = await vscode.window.showWarningMessage(
            `Send a REAL email from ${moduleName}/${recordId} to ${to}?`,
            { modal: true, detail: 'This sends mail from your LIVE Zoho CRM org.' },
            'Send'
        );
        if (ok !== 'Send') return;

        const payload = {
            data: [{
                to: to.split(',').map((e) => ({ email: e.trim() })).filter((r) => r.email),
                subject,
                content,
                mail_format: 'html'
            }]
        };
        // postNoRetry: a retry on a flaky connection could double-send the email.
        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Sending mail from ${moduleName}/${recordId}…` },
            () => apiClient.postNoRetry(`/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(recordId)}/actions/send_mail`, payload)
        );
        await showResult(deps, `Mail sent from ${moduleName}/${recordId}`, res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Send Mail failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Send Mail Failed: ${e?.message || e}`);
    }
}

async function manageBlueprintCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const action = await vscode.window.showQuickPick(
            [
                { label: 'Get record state & transitions', value: 'get' },
                { label: 'Execute a transition (WRITES to CRM)', value: 'update' },
                { label: 'List process configurations', value: 'config' }
            ],
            { placeHolder: 'Blueprint action' }
        );
        if (!action) return;

        if (action.value === 'config') {
            const res = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Fetching Blueprint configurations…' },
                () => apiClient.get('/crm/v8/settings/blueprints/process_configurations')
            );
            await showResult(deps, 'Blueprint Process Configurations', res);
            return;
        }

        const moduleName = await vscode.window.showInputBox({ prompt: 'Module API Name', placeHolder: 'Deals' });
        if (!moduleName) return;
        const recordId = await vscode.window.showInputBox({ prompt: 'Record ID' });
        if (!recordId) return;
        const endpoint = `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(recordId)}/actions/blueprint`;

        if (action.value === 'get') {
            const res = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Fetching Blueprint state…' },
                () => apiClient.get(endpoint)
            );
            await showResult(deps, `Blueprint state — ${moduleName}/${recordId}`, res);
            return;
        }

        const transitionId = await vscode.window.showInputBox({ prompt: 'Transition ID (from "Get record state & transitions")' });
        if (!transitionId) return;
        const dataStr = await vscode.window.showInputBox({ prompt: 'Transition data JSON (optional)', placeHolder: '{"Field_API":"value"}' });
        const data = dataStr ? JSON.parse(dataStr) : {};

        const ok = await vscode.window.showWarningMessage(
            `Execute Blueprint transition ${transitionId} on ${moduleName}/${recordId}?`,
            { modal: true, detail: 'This moves the record to its next Blueprint state in your LIVE org.' },
            'Execute'
        );
        if (ok !== 'Execute') return;

        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Executing Blueprint transition…' },
            () => apiClient.put(endpoint, { blueprint: [{ transition_id: transitionId, data }] })
        );
        await showResult(deps, `Blueprint transition executed — ${moduleName}/${recordId}`, res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Blueprint operation failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Blueprint Operation Failed: ${e?.message || e}`);
    }
}

async function executeCompositeCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const requestsStr = await vscode.window.showInputBox({
            prompt: 'Composite sub-requests JSON array (max 5). Reference earlier results with @{sub_request_id:$.json.path}',
            placeHolder: '[{"sub_request_id":"1","method":"GET","uri":"/crm/v8/settings/variables"}]'
        });
        if (!requestsStr) return;
        const requests = JSON.parse(requestsStr);
        if (!Array.isArray(requests) || requests.length === 0 || requests.length > 5) {
            void vscode.window.showErrorMessage('Composite needs a JSON array of 1-5 sub-requests.');
            return;
        }

        const hasWrite = requests.some((r: any) => String(r.method || 'GET').toUpperCase() !== 'GET');
        if (hasWrite) {
            const ok = await vscode.window.showWarningMessage(
                'This composite request contains WRITE sub-requests that execute in your LIVE org. Proceed?',
                { modal: true, detail: requests.map((r: any) => `${r.method} ${r.uri}`).join('\n') },
                'Execute'
            );
            if (ok !== 'Execute') return;
        }

        const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Executing composite request (${requests.length} sub-requests)…` },
            () => apiClient.postNoRetry('/crm/v8/__composite_requests', { __composite_requests: requests })
        );
        await showResult(deps, 'Composite Request Results', res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Composite request failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Composite Request Failed: ${e?.message || e}`);
    }
}

async function exportAuditLogCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const outputDir = deps.getOutputDir() || './metadata';
        const savedPath = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Exporting Zoho CRM Audit Log…' },
            () => auditLogService.exportAuditLog(null, outputDir)
        );

        deps.output.appendLine(`Audit log exported to: ${savedPath}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Audit log exported successfully to ${savedPath}`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Export Audit Log failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Export Audit Log Failed: ${e?.message || e}`);
    }
}

async function manageVariablesCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const action = await vscode.window.showQuickPick(
            ['List Variables', 'Get Variable Details', 'List Variable Groups'],
            { placeHolder: 'Select Variable Action' }
        );
        if (!action) return;

        if (action === 'List Variables') {
            const res = await apiClient.get('/crm/v8/settings/variables');
            await showResult(deps, 'Org Variables', res);
        } else if (action === 'Get Variable Details') {
            const varId = await vscode.window.showInputBox({ prompt: 'Enter Variable ID' });
            if (!varId) return;
            const res = await apiClient.get(`/crm/v8/settings/variables/${varId}`);
            await showResult(deps, `Variable ${varId}`, res);
        } else if (action === 'List Variable Groups') {
            const res = await apiClient.get('/crm/v8/settings/variable_groups');
            await showResult(deps, 'Variable Groups', res);
        }
    } catch (e: any) {
        deps.output.appendLine(`[Error] Manage Variables failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Manage Variables Failed: ${e?.message || e}`);
    }
}

async function manageTagsCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const moduleName = await vscode.window.showInputBox({ prompt: 'Enter Module API Name (e.g. Leads)' });
        if (!moduleName) return;

        const res = await apiClient.get(`/crm/v8/settings/tags?module=${encodeURIComponent(moduleName)}`);
        await showResult(deps, `Tags for ${moduleName}`, res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Manage Tags failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Manage Tags Failed: ${e?.message || e}`);
    }
}

async function manageNotesCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const res = await apiClient.get('/crm/v8/Notes?per_page=20');
        await showResult(deps, 'Recent Notes', res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Manage Notes failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Manage Notes Failed: ${e?.message || e}`);
    }
}

async function manageUsersCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const type = await vscode.window.showQuickPick(
            ['AllUsers', 'ActiveUsers', 'DeactiveUsers', 'AdminUsers', 'CurrentUser'],
            { placeHolder: 'Select User Filter Type' }
        ) || 'AllUsers';

        const res = await apiClient.get(`/crm/v8/users?type=${encodeURIComponent(type)}`);
        await showResult(deps, `CRM Users (${type})`, res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Manage Users failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Manage Users Failed: ${e?.message || e}`);
    }
}

async function manageRecycleBinCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const action = await vscode.window.showQuickPick(
            ['List Recycle Bin', 'Count Recycle Bin'],
            { placeHolder: 'Select Recycle Bin Action' }
        );
        if (!action) return;

        if (action === 'List Recycle Bin') {
            const res = await apiClient.get('/crm/v8/settings/recycle_bin');
            await showResult(deps, 'Recycle Bin Items', res);
        } else if (action === 'Count Recycle Bin') {
            const res = await apiClient.get('/crm/v8/settings/recycle_bin/actions/count');
            await showResult(deps, 'Recycle Bin Count', res);
        }
    } catch (e: any) {
        deps.output.appendLine(`[Error] Recycle Bin operation failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Recycle Bin Operation Failed: ${e?.message || e}`);
    }
}

async function manageWorkflowsCmd(deps: ApiCommandDeps): Promise<void> {
    try {
        assertAuth(deps);
        const res = await apiClient.get('/crm/v8/settings/automation/workflow_rules');
        await showResult(deps, 'Workflow Rules', res);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Manage Workflows failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Manage Workflows Failed: ${e?.message || e}`);
    }
}
