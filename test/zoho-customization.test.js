'use strict';

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; failures.push(name); console.log('  FAIL ' + name); }
}

const { CustomizationBridge } = require('../out/zoho/customizationBridge.js');

function mockCustomizationService() {
    const calls = [];
    return {
        calls,
        async createModule(s, p, opts) { calls.push({ method: 'createModule', s, p, opts }); return { status: 'success' }; },
        async updateModule(id, data) { calls.push({ method: 'updateModule', id, data }); return { status: 'success' }; },
        async createField(mod, data) { calls.push({ method: 'createField', mod, data }); return { status: 'success' }; },
        async updateField(mod, id, data) { calls.push({ method: 'updateField', mod, id, data }); return { status: 'success' }; },
        async deleteField(mod, id) { calls.push({ method: 'deleteField', mod, id }); return { status: 'success' }; },
        async updateLayout(mod, id, data) { calls.push({ method: 'updateLayout', mod, id, data }); return { status: 'success' }; },
        async activateLayout(mod, id) { calls.push({ method: 'activateLayout', mod, id }); return { status: 'success' }; },
        async deactivateLayout(mod, id, transferTo) { calls.push({ method: 'deactivateLayout', mod, id, transferTo }); return { status: 'success' }; },
        async deleteLayout(mod, id, transferTo) { calls.push({ method: 'deleteLayout', mod, id, transferTo }); return { status: 'success' }; }
    };
}

(async () => {
    console.log('\n-- CustomizationBridge unit tests --');

    // Test authentication assertion
    let unauthBridge = new CustomizationBridge({ isAuthenticated: () => false, service: mockCustomizationService() });
    let authError = null;
    try {
        await unauthBridge.createModule('Project', 'Projects');
    } catch (e) {
        authError = e;
    }
    ok('throws authentication error when not signed in', authError && authError.message.includes('Sign in to Zoho CRM'));

    // Test authenticated bridge delegation
    const svc = mockCustomizationService();
    const bridge = new CustomizationBridge({ isAuthenticated: () => true, service: svc });

    await bridge.createModule('Project', 'Projects');
    ok('delegates createModule', svc.calls[0].method === 'createModule' && svc.calls[0].s === 'Project' && svc.calls[0].p === 'Projects');

    await bridge.updateModule('Projects', { plural_label: 'New Projects' });
    ok('delegates updateModule', svc.calls[1].method === 'updateModule' && svc.calls[1].id === 'Projects');

    await bridge.createField('Leads', { field_label: 'Score', data_type: 'integer' });
    ok('delegates createField', svc.calls[2].method === 'createField' && svc.calls[2].mod === 'Leads');

    await bridge.updateField('Leads', '123', { field_label: 'New Score' });
    ok('delegates updateField', svc.calls[3].method === 'updateField' && svc.calls[3].id === '123');

    await bridge.deleteField('Leads', '123');
    ok('delegates deleteField', svc.calls[4].method === 'deleteField' && svc.calls[4].id === '123');

    await bridge.updateLayout('Leads', 'L1', { name: 'Standard' });
    ok('delegates updateLayout', svc.calls[5].method === 'updateLayout' && svc.calls[5].id === 'L1');

    await bridge.activateLayout('Leads', 'L1');
    ok('delegates activateLayout', svc.calls[6].method === 'activateLayout' && svc.calls[6].id === 'L1');

    await bridge.deactivateLayout('Leads', 'L1', 'L2');
    ok('delegates deactivateLayout', svc.calls[7].method === 'deactivateLayout' && svc.calls[7].transferTo === 'L2');

    await bridge.deleteLayout('Leads', 'L1', 'L2');
    ok('delegates deleteLayout', svc.calls[8].method === 'deleteLayout' && svc.calls[8].transferTo === 'L2');

    console.log(`\n----------------------------------------\nTotal: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}\n----------------------------------------\n`);
    if (failed > 0) process.exit(1);
})();
