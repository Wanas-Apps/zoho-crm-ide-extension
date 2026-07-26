import customizationService = require('wanas-zcrm-extractor/src/services/customizationService');

export interface CustomizationServicePort {
    createModule(singularLabel: string, pluralLabel: string, options?: Record<string, unknown>): Promise<any>;
    updateModule(moduleNameOrId: string, data: Record<string, unknown>): Promise<any>;
    createField(moduleName: string, data: Record<string, unknown>): Promise<any>;
    updateField(moduleName: string, fieldId: string, data: Record<string, unknown>): Promise<any>;
    deleteField(moduleName: string, fieldId: string): Promise<any>;
    updateLayout(moduleName: string, layoutId: string, data: Record<string, unknown>): Promise<any>;
    activateLayout(moduleName: string, layoutId: string): Promise<any>;
    deactivateLayout(moduleName: string, layoutId: string, transferTo?: string): Promise<any>;
    deleteLayout(moduleName: string, layoutId: string, transferTo?: string): Promise<any>;
}

export interface CustomizationBridgeDeps {
    isAuthenticated(): boolean;
    service?: CustomizationServicePort;
}

export class CustomizationBridge {
    private readonly service: CustomizationServicePort;

    constructor(private readonly deps: CustomizationBridgeDeps) {
        this.service = deps.service ?? customizationService;
    }

    private assertAuth(): void {
        if (!this.deps.isAuthenticated()) {
            throw new Error('Sign in to Zoho CRM before performing customization operations.');
        }
    }

    async createModule(singularLabel: string, pluralLabel: string, options?: Record<string, unknown>): Promise<any> {
        this.assertAuth();
        return this.service.createModule(singularLabel, pluralLabel, options);
    }

    async updateModule(moduleNameOrId: string, data: Record<string, unknown>): Promise<any> {
        this.assertAuth();
        return this.service.updateModule(moduleNameOrId, data);
    }

    async createField(moduleName: string, data: Record<string, unknown>): Promise<any> {
        this.assertAuth();
        return this.service.createField(moduleName, data);
    }

    async updateField(moduleName: string, fieldId: string, data: Record<string, unknown>): Promise<any> {
        this.assertAuth();
        return this.service.updateField(moduleName, fieldId, data);
    }

    async deleteField(moduleName: string, fieldId: string): Promise<any> {
        this.assertAuth();
        return this.service.deleteField(moduleName, fieldId);
    }

    async updateLayout(moduleName: string, layoutId: string, data: Record<string, unknown>): Promise<any> {
        this.assertAuth();
        return this.service.updateLayout(moduleName, layoutId, data);
    }

    async activateLayout(moduleName: string, layoutId: string): Promise<any> {
        this.assertAuth();
        return this.service.activateLayout(moduleName, layoutId);
    }

    async deactivateLayout(moduleName: string, layoutId: string, transferTo?: string): Promise<any> {
        this.assertAuth();
        return this.service.deactivateLayout(moduleName, layoutId, transferTo);
    }

    async deleteLayout(moduleName: string, layoutId: string, transferTo?: string): Promise<any> {
        this.assertAuth();
        return this.service.deleteLayout(moduleName, layoutId, transferTo);
    }
}
