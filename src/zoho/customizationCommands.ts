import * as vscode from 'vscode';
import { CustomizationBridge } from './customizationBridge';
import { MetadataIndex } from './metadataIndex';

export interface CustomizationCommandDeps {
    bridge: CustomizationBridge;
    output: vscode.OutputChannel;
    index?: MetadataIndex;
}

export function registerCustomizationCommands(
    context: vscode.ExtensionContext,
    deps: CustomizationCommandDeps
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('zohoDeluge.createModule', (item?: any) => createModuleCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.updateModule', (item?: any) => updateModuleCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.createField', (item?: any) => createFieldCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.updateField', (item?: any) => updateFieldCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.deleteField', (item?: any) => deleteFieldCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.updateLayout', (item?: any) => updateLayoutCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.activateLayout', (item?: any) => activateLayoutCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.deactivateLayout', (item?: any) => deactivateLayoutCmd(item, deps)),
        vscode.commands.registerCommand('zohoDeluge.deleteLayout', (item?: any) => deleteLayoutCmd(item, deps))
    );
}

async function createModuleCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const singular = await vscode.window.showInputBox({
        prompt: 'Enter Singular Label for the new module (e.g. Project)',
        placeHolder: 'Singular Label'
    });
    if (!singular) return;

    const plural = await vscode.window.showInputBox({
        prompt: 'Enter Plural Label for the new module (e.g. Projects)',
        placeHolder: 'Plural Label',
        value: `${singular}s`
    });
    if (!plural) return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating custom module "${singular}"…` },
            () => deps.bridge.createModule(singular, plural)
        );
        deps.output.appendLine(`Created module ${singular} (${plural}): ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Module "${singular}" created successfully!`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Create Module failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Create Module failed: ${e?.message || e}`);
    }
}

async function updateModuleCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({
        prompt: 'Enter Module API Name to update',
        placeHolder: 'e.g. Custom_Module'
    });
    if (!moduleName) return;

    const newLabel = await vscode.window.showInputBox({
        prompt: `Enter new Plural Display Label for module "${moduleName}"`,
        placeHolder: 'New Plural Label'
    });
    if (!newLabel) return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Updating module "${moduleName}"…` },
            () => deps.bridge.updateModule(moduleName, { plural_label: newLabel })
        );
        deps.output.appendLine(`Updated module ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Module "${moduleName}" updated successfully!`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Update Module failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Update Module failed: ${e?.message || e}`);
    }
}

async function createFieldCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({
        prompt: 'Enter target Module API Name',
        placeHolder: 'e.g. Leads, Contacts, Custom_Module'
    });
    if (!moduleName) return;

    const fieldLabel = await vscode.window.showInputBox({
        prompt: `Enter Field Display Label for module "${moduleName}"`,
        placeHolder: 'e.g. Custom Score'
    });
    if (!fieldLabel) return;

    const dataType = await vscode.window.showQuickPick(
        ['text', 'integer', 'double', 'boolean', 'date', 'picklist', 'email', 'phone', 'url'],
        { placeHolder: 'Select Data Type for the field' }
    );
    if (!dataType) return;

    const fieldDef: Record<string, any> = {
        field_label: fieldLabel,
        data_type: dataType
    };

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating field "${fieldLabel}" on ${moduleName}…` },
            () => deps.bridge.createField(moduleName, fieldDef)
        );
        deps.output.appendLine(`Created field ${fieldLabel} on ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Field "${fieldLabel}" created successfully on ${moduleName}!`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Create Field failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Create Field failed: ${e?.message || e}`);
    }
}

async function updateFieldCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({ prompt: 'Enter Module API Name' });
    if (!moduleName) return;

    const fieldId = item?.fieldId || await vscode.window.showInputBox({ prompt: 'Enter Field ID or API Name to update' });
    if (!fieldId) return;

    const newLabel = await vscode.window.showInputBox({ prompt: 'Enter new Field Display Label' });
    if (!newLabel) return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Updating field ${fieldId}…` },
            () => deps.bridge.updateField(moduleName, fieldId, { field_label: newLabel })
        );
        deps.output.appendLine(`Updated field ${fieldId} on ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Field ${fieldId} updated successfully.`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Update Field failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Update Field failed: ${e?.message || e}`);
    }
}

async function deleteFieldCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({ prompt: 'Enter Module API Name' });
    if (!moduleName) return;

    const fieldId = item?.fieldId || await vscode.window.showInputBox({ prompt: 'Enter Field ID to delete' });
    if (!fieldId) return;

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to DELETE custom field "${fieldId}" from module "${moduleName}"? This action cannot be undone.`,
        { modal: true },
        'Delete Field'
    );
    if (confirm !== 'Delete Field') return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting field ${fieldId}…` },
            () => deps.bridge.deleteField(moduleName, fieldId)
        );
        deps.output.appendLine(`Deleted field ${fieldId} from ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Field "${fieldId}" deleted successfully.`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Delete Field failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Delete Field failed: ${e?.message || e}`);
    }
}

async function updateLayoutCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({ prompt: 'Enter Module API Name' });
    if (!moduleName) return;

    const layoutId = item?.layoutId || await vscode.window.showInputBox({ prompt: 'Enter Layout ID' });
    if (!layoutId) return;

    const newName = await vscode.window.showInputBox({ prompt: 'Enter new Layout Name' });
    if (!newName) return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Updating layout ${layoutId}…` },
            () => deps.bridge.updateLayout(moduleName, layoutId, { name: newName })
        );
        deps.output.appendLine(`Updated layout ${layoutId} on ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Layout "${layoutId}" updated successfully.`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Update Layout failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Update Layout failed: ${e?.message || e}`);
    }
}

async function activateLayoutCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({ prompt: 'Enter Module API Name' });
    if (!moduleName) return;

    const layoutId = item?.layoutId || await vscode.window.showInputBox({ prompt: 'Enter Layout ID to activate' });
    if (!layoutId) return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Activating layout ${layoutId}…` },
            () => deps.bridge.activateLayout(moduleName, layoutId)
        );
        deps.output.appendLine(`Activated layout ${layoutId} on ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Layout "${layoutId}" activated.`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Activate Layout failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Activate Layout failed: ${e?.message || e}`);
    }
}

async function deactivateLayoutCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({ prompt: 'Enter Module API Name' });
    if (!moduleName) return;

    const layoutId = item?.layoutId || await vscode.window.showInputBox({ prompt: 'Enter Layout ID to deactivate' });
    if (!layoutId) return;

    const transferTo = await vscode.window.showInputBox({
        prompt: 'Enter target Layout ID to transfer existing records to (optional)'
    });

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deactivating layout ${layoutId}…` },
            () => deps.bridge.deactivateLayout(moduleName, layoutId, transferTo || undefined)
        );
        deps.output.appendLine(`Deactivated layout ${layoutId} on ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Layout "${layoutId}" deactivated.`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Deactivate Layout failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Deactivate Layout failed: ${e?.message || e}`);
    }
}

async function deleteLayoutCmd(item: any, deps: CustomizationCommandDeps): Promise<void> {
    const moduleName = item?.moduleName || await vscode.window.showInputBox({ prompt: 'Enter Module API Name' });
    if (!moduleName) return;

    const layoutId = item?.layoutId || await vscode.window.showInputBox({ prompt: 'Enter Layout ID to delete' });
    if (!layoutId) return;

    const transferTo = await vscode.window.showInputBox({
        prompt: 'Enter target Layout ID to transfer existing records to'
    });
    if (!transferTo) return;

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to DELETE layout "${layoutId}" in module "${moduleName}"? Records will be transferred to "${transferTo}".`,
        { modal: true },
        'Delete Layout'
    );
    if (confirm !== 'Delete Layout') return;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting layout ${layoutId}…` },
            () => deps.bridge.deleteLayout(moduleName, layoutId, transferTo)
        );
        deps.output.appendLine(`Deleted layout ${layoutId} from ${moduleName}: ${JSON.stringify(result)}`);
        deps.output.show(true);
        void vscode.window.showInformationMessage(`Layout "${layoutId}" deleted.`);
    } catch (e: any) {
        deps.output.appendLine(`[Error] Delete Layout failed: ${e?.message || e}`);
        deps.output.show(true);
        void vscode.window.showErrorMessage(`Delete Layout failed: ${e?.message || e}`);
    }
}
