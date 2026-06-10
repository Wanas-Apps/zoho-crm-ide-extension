/**
 * MCP tool definitions — the ~13 tools exposed to LLM agents, each a thin
 * adapter over OrgApi (records/metadata/fields) or the FunctionPort (run/push/
 * code). Pure of vscode and the MCP SDK: the server adapts these into SDK tool
 * registrations, and `runTool` enforces the human confirm-gate on writes.
 */

import { z } from 'zod';
import { OrgApi, OrgError } from './orgApi';

/** Function ops the MCP layer borrows from the extension (standalone rules +
 *  conflict guard live in FunctionOps; we don't re-implement them here). */
export interface FunctionPort {
    runStandalone(apiName: string, args: Record<string, unknown>): Promise<unknown>;
    pushFunction(apiName: string, code: string): Promise<unknown>;
    getFunctionCode(apiName: string): Promise<unknown>;
}

export interface ToolCtx {
    api: OrgApi;
    functions: FunctionPort;
    /** Human-in-the-loop gate; resolves true to proceed, false to decline. */
    confirm(summary: string): Promise<boolean>;
}

export interface ToolDef {
    name: string;
    description: string;
    kind: 'read' | 'write';
    schema: z.ZodObject<any>;
    /** Short human sentence for the confirm dialog (write tools only). */
    summarize(args: any): string;
    run(args: any, ctx: ToolCtx): Promise<unknown>;
}

const noSummary = () => '';

/** All tools. Pure — no I/O until `run` is called. */
export function buildTools(): ToolDef[] {
    return [
        // -- reads ------------------------------------------------------------
        {
            name: 'zoho_query_records',
            description: 'Run a Zoho CRM COQL SELECT query and return matching records.',
            kind: 'read',
            schema: z.object({ select_query: z.string().describe('A COQL SELECT statement, e.g. "select Last_Name, Email from Leads where Email is not null limit 10"') }),
            summarize: noSummary,
            run: (a, c) => c.api.queryRecords(a.select_query)
        },
        {
            name: 'zoho_get_record',
            description: 'Get a single record by module API name and record id.',
            kind: 'read',
            schema: z.object({ module: z.string(), id: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getRecord(a.module, a.id)
        },
        {
            name: 'zoho_list_modules',
            description: 'List the CRM modules (objects) and their metadata.',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.listModules()
        },
        {
            name: 'zoho_get_fields',
            description: 'List the fields (with data types and API names) of a module.',
            kind: 'read',
            schema: z.object({ module: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getFields(a.module)
        },
        {
            name: 'zoho_list_functions',
            description: 'List the org\'s Deluge functions (all categories).',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.listFunctions()
        },
        {
            name: 'zoho_get_function_code',
            description: 'Get the Deluge source code of a function by api_name.',
            kind: 'read',
            schema: z.object({ api_name: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.functions.getFunctionCode(a.api_name)
        },
        {
            name: 'zoho_org_info',
            description: 'Get the connected organization\'s info (name, id, edition, etc.).',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.orgInfo()
        },

        // -- writes (confirm-gated) ------------------------------------------
        {
            name: 'zoho_create_record',
            description: 'Create one record in a module. `data` is a field map.',
            kind: 'write',
            schema: z.object({ module: z.string(), data: z.record(z.string(), z.any()) }),
            summarize: (a) => `Create 1 record in ${a.module}`,
            run: (a, c) => c.api.createRecord(a.module, a.data)
        },
        {
            name: 'zoho_update_record',
            description: 'Update one record by id. `data` is the changed field map.',
            kind: 'write',
            schema: z.object({ module: z.string(), id: z.string(), data: z.record(z.string(), z.any()) }),
            summarize: (a) => `Update ${a.module} record ${a.id}`,
            run: (a, c) => c.api.updateRecord(a.module, a.id, a.data)
        },
        {
            name: 'zoho_create_field',
            description: 'Create a custom field on a module (Zoho fields schema).',
            kind: 'write',
            schema: z.object({ module: z.string(), field: z.record(z.string(), z.any()) }),
            summarize: (a) => `Create custom field on ${a.module} (${a.field && (a.field.field_label || a.field.api_name) || 'unnamed'})`,
            run: (a, c) => c.api.createField(a.module, a.field)
        },
        {
            name: 'zoho_update_field',
            description: 'Update a custom field by id on a module.',
            kind: 'write',
            schema: z.object({ module: z.string(), field_id: z.string(), changes: z.record(z.string(), z.any()) }),
            summarize: (a) => `Update field ${a.field_id} on ${a.module}`,
            run: (a, c) => c.api.updateField(a.module, a.field_id, a.changes)
        },
        {
            name: 'zoho_run_standalone',
            description: 'Execute a STANDALONE Deluge function live with the given args (only standalone functions are executable via Zoho\'s API).',
            kind: 'write',
            schema: z.object({ api_name: z.string(), args: z.record(z.string(), z.any()).optional() }),
            summarize: (a) => `Run standalone.${a.api_name} on the LIVE org`,
            run: (a, c) => c.functions.runStandalone(a.api_name, a.args || {})
        },
        {
            name: 'zoho_push_function',
            description: 'Push Deluge code to an existing function (overwrites the live code).',
            kind: 'write',
            schema: z.object({ api_name: z.string(), code: z.string() }),
            summarize: (a) => `Push code to function ${a.api_name} (overwrites live)`,
            run: (a, c) => c.functions.pushFunction(a.api_name, a.code)
        }
    ];
}

/**
 * Validate args, enforce the confirm-gate for writes, then run. Returns the raw
 * org result. Throws OrgError('USER_DECLINED') if the human declines, or
 * OrgError('BAD_INPUT') on schema mismatch.
 */
export async function runTool(tool: ToolDef, rawArgs: unknown, ctx: ToolCtx): Promise<unknown> {
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        throw new OrgError('BAD_INPUT', `Invalid arguments for ${tool.name}: ${parsed.error.message}`);
    }
    if (tool.kind === 'write') {
        const approved = await ctx.confirm(tool.summarize(parsed.data));
        if (!approved) {
            throw new OrgError('USER_DECLINED', `User declined: ${tool.summarize(parsed.data)}`);
        }
    }
    return tool.run(parsed.data, ctx);
}
