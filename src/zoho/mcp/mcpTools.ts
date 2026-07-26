/**
 * MCP tool definitions — exposed to LLM agents, each a thin
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
        // -- original reads ---------------------------------------------------
        {
            name: 'zoho_query_records',
            description: 'Run a Zoho CRM COQL SELECT query and return matching records. A missing WHERE clause is auto-filled with "where id is not null". LIMIT max 2000/call; aggregates must be UPPERCASE (COUNT not count) and need an explicit limit; empty result returns {}.',
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

        // -- original writes (confirm-gated) ----------------------------------
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
        },

        // -- CLI Universal API Proxy ------------------------------------------
        {
            name: 'zoho_raw_api',
            description: 'Execute ANY raw Zoho CRM V8/V9 API request (Universal API Proxy).',
            kind: 'read', // Confirm-gate evaluated inside run if writing
            schema: z.object({
                method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
                endpoint: z.string().describe('API path e.g. /settings/variables or /crm/v8/Leads'),
                params: z.record(z.string(), z.any()).optional(),
                body: z.any().optional()
            }),
            summarize: (a) => `${a.method} ${a.endpoint}`,
            run: async (a, c) => {
                if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((a.method || '').toUpperCase())) {
                    const approved = await c.confirm(`Execute raw ${a.method} request to ${a.endpoint}`);
                    if (!approved) throw new OrgError('USER_DECLINED', `User declined: ${a.method} ${a.endpoint}`);
                }
                return c.api.rawRequest(a.method, a.endpoint, a.params, a.body);
            }
        },

        // -- CLI records extensions -------------------------------------------
        {
            name: 'zoho_list_records',
            description: 'List records from a module with pagination/sorting.',
            kind: 'read',
            schema: z.object({ module: z.string(), params: z.record(z.string(), z.any()).optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.listRecords(a.module, a.params)
        },
        {
            name: 'zoho_search_records',
            description: 'Search records in a module by criteria, email, phone, or word.',
            kind: 'read',
            schema: z.object({ module: z.string(), criteria: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), word: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.searchRecords(a.module, a)
        },
        {
            name: 'zoho_upsert_record',
            description: 'Upsert record(s) in a module (insert or update on duplicate match).',
            kind: 'write',
            schema: z.object({ module: z.string(), data: z.array(z.record(z.string(), z.any())) }),
            summarize: (a) => `Upsert ${a.data?.length || 1} record(s) in ${a.module}`,
            run: (a, c) => c.api.upsertRecords(a.module, a.data)
        },
        {
            name: 'zoho_delete_record',
            description: 'Delete a record by ID from a module.',
            kind: 'write',
            schema: z.object({ module: z.string(), id: z.string() }),
            summarize: (a) => `Delete record ${a.id} from ${a.module}`,
            run: (a, c) => c.api.deleteRecord(a.module, a.id)
        },
        {
            name: 'zoho_count_records',
            description: 'Get total record count for a module.',
            kind: 'read',
            schema: z.object({ module: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.countRecords(a.module)
        },

        // -- CLI org variables ------------------------------------------------
        {
            name: 'zoho_list_variables',
            description: 'List organization variables.',
            kind: 'read',
            schema: z.object({ group_id: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.listVariables(a.group_id)
        },
        {
            name: 'zoho_get_variable',
            description: 'Get a single variable by ID.',
            kind: 'read',
            schema: z.object({ id: z.string(), group_id: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.getVariable(a.id, a.group_id)
        },
        {
            name: 'zoho_set_variable',
            description: 'Create or update an organization variable.',
            kind: 'write',
            schema: z.object({ api_name: z.string(), value: z.any(), group_id: z.string().optional(), id: z.string().optional(), type: z.string().optional(), description: z.string().optional() }),
            summarize: (a) => `Set org variable ${a.api_name}`,
            run: (a, c) => c.api.setVariable(a.api_name, a.value, { group: a.group_id, id: a.id, type: a.type, description: a.description })
        },
        {
            name: 'zoho_delete_variable',
            description: 'Delete an organization variable by ID.',
            kind: 'write',
            schema: z.object({ id: z.string() }),
            summarize: (a) => `Delete org variable ${a.id}`,
            run: (a, c) => c.api.deleteVariable(a.id)
        },
        {
            name: 'zoho_list_variable_groups',
            description: 'List variable groups.',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.listVariableGroups()
        },

        // -- CLI tags ---------------------------------------------------------
        {
            name: 'zoho_list_tags',
            description: 'List tags in a module.',
            kind: 'read',
            schema: z.object({ module: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.listTags(a.module)
        },
        {
            name: 'zoho_create_tag',
            description: 'Create a tag in a module.',
            kind: 'write',
            schema: z.object({ module: z.string(), name: z.string(), color_code: z.string().optional() }),
            summarize: (a) => `Create tag "${a.name}" on ${a.module}`,
            run: (a, c) => c.api.createTag(a.module, a.name, a.color_code)
        },
        {
            name: 'zoho_delete_tag',
            description: 'Delete a tag by ID.',
            kind: 'write',
            schema: z.object({ id: z.string() }),
            summarize: (a) => `Delete tag ${a.id}`,
            run: (a, c) => c.api.deleteTag(a.id)
        },
        {
            name: 'zoho_add_tags',
            description: 'Add tag(s) to a record.',
            kind: 'write',
            schema: z.object({ module: z.string(), record_id: z.string(), tags: z.array(z.string()) }),
            summarize: (a) => `Add tag(s) [${a.tags.join(', ')}] to ${a.module} record ${a.record_id}`,
            run: (a, c) => c.api.addTags(a.module, a.record_id, a.tags)
        },
        {
            name: 'zoho_remove_tags',
            description: 'Remove tag(s) from a record.',
            kind: 'write',
            schema: z.object({ module: z.string(), record_id: z.string(), tags: z.array(z.string()) }),
            summarize: (a) => `Remove tag(s) [${a.tags.join(', ')}] from ${a.module} record ${a.record_id}`,
            run: (a, c) => c.api.removeTags(a.module, a.record_id, a.tags)
        },

        // -- CLI notes --------------------------------------------------------
        {
            name: 'zoho_list_notes',
            description: 'List notes.',
            kind: 'read',
            schema: z.object({ per_page: z.string().optional(), page: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.listNotes(a)
        },
        {
            name: 'zoho_get_note',
            description: 'Get a note by ID.',
            kind: 'read',
            schema: z.object({ id: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getNote(a.id)
        },
        {
            name: 'zoho_create_note',
            description: 'Create a note attached to a record.',
            kind: 'write',
            schema: z.object({ body: z.record(z.string(), z.any()) }),
            summarize: () => `Create note`,
            run: (a, c) => c.api.createNote(a.body)
        },
        {
            name: 'zoho_delete_note',
            description: 'Delete a note by ID.',
            kind: 'write',
            schema: z.object({ id: z.string() }),
            summarize: (a) => `Delete note ${a.id}`,
            run: (a, c) => c.api.deleteNote(a.id)
        },

        // -- CLI users --------------------------------------------------------
        {
            name: 'zoho_list_users',
            description: 'List CRM users (AllUsers, ActiveUsers, CurrentUser, etc.).',
            kind: 'read',
            schema: z.object({ type: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.listUsers(a.type || 'AllUsers')
        },
        {
            name: 'zoho_get_user',
            description: 'Get a CRM user details by ID.',
            kind: 'read',
            schema: z.object({ id: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getUser(a.id)
        },

        // -- CLI bulk ---------------------------------------------------------
        {
            name: 'zoho_bulk_read',
            description: 'Create a bulk read job for a module (async export of up to 200,000 records).',
            // A bulk-read job READS data but CREATES server-side job state, so it
            // must respect read-only mode like any other mutation.
            kind: 'write',
            schema: z.object({ module: z.string(), body: z.record(z.string(), z.any()).optional() }),
            summarize: (a) => `Create bulk read (export) job for ${a.module}`,
            run: (a, c) => c.api.createBulkRead(a.module, a.body)
        },
        {
            name: 'zoho_bulk_write',
            description: 'Create a bulk write job.',
            kind: 'write',
            schema: z.object({ body: z.record(z.string(), z.any()) }),
            summarize: () => `Create bulk write job`,
            run: (a, c) => c.api.createBulkWrite(a.body)
        },
        {
            name: 'zoho_bulk_status',
            description: 'Check status of a bulk read/write job.',
            kind: 'read',
            schema: z.object({ type: z.enum(['read', 'write']), job_id: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getBulkStatus(a.type, a.job_id)
        },

        // -- CLI notifications / webhooks -------------------------------------
        {
            name: 'zoho_list_notifications',
            description: 'List active data change webhooks/notifications.',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.listNotifications()
        },
        {
            name: 'zoho_create_notification',
            description: 'Create a webhook notification subscription.',
            kind: 'write',
            schema: z.object({ body: z.record(z.string(), z.any()) }),
            summarize: () => `Create notification subscription`,
            run: (a, c) => c.api.createNotification(a.body)
        },
        {
            name: 'zoho_delete_notification',
            description: 'Delete webhook notification subscription(s).',
            kind: 'write',
            schema: z.object({ body: z.record(z.string(), z.any()).optional() }),
            summarize: () => `Disable notification subscription(s)`,
            run: (a, c) => c.api.deleteNotification(a.body)
        },

        // -- CLI recycle bin --------------------------------------------------
        {
            name: 'zoho_list_recycle_bin',
            description: 'List deleted records in the recycle bin.',
            kind: 'read',
            schema: z.object({ per_page: z.string().optional(), page: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.listRecycleBin(a)
        },
        {
            name: 'zoho_count_recycle_bin',
            description: 'Get record count in the recycle bin.',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.countRecycleBin()
        },
        {
            name: 'zoho_restore_recycle_bin',
            description: 'Restore a record from the recycle bin.',
            kind: 'write',
            schema: z.object({ record_id: z.string() }),
            summarize: (a) => `Restore record ${a.record_id} from recycle bin`,
            run: (a, c) => c.api.restoreRecycleBin(a.record_id)
        },
        {
            name: 'zoho_empty_recycle_bin',
            description: 'Empty the recycle bin PERMANENTLY.',
            kind: 'write',
            schema: z.object({}),
            summarize: () => `EMPTY the entire Recycle Bin permanently`,
            run: (_a, c) => c.api.emptyRecycleBin()
        },

        // -- CLI workflows & automation ---------------------------------------
        {
            name: 'zoho_list_workflows',
            description: 'List workflow rules.',
            kind: 'read',
            schema: z.object({ module: z.string().optional() }),
            summarize: noSummary,
            run: (a, c) => c.api.listWorkflows(a.module)
        },
        {
            name: 'zoho_get_workflow',
            description: 'Get a workflow rule details by ID.',
            kind: 'read',
            schema: z.object({ id: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getWorkflow(a.id)
        },
        {
            name: 'zoho_create_workflow',
            description: 'Create a workflow rule and attach automation actions.',
            kind: 'write',
            schema: z.object({ body: z.record(z.string(), z.any()) }),
            summarize: () => `Create workflow rule`,
            run: (a, c) => c.api.createWorkflow(a.body)
        },
        {
            name: 'zoho_update_workflow',
            description: 'Update a workflow rule by ID.',
            kind: 'write',
            schema: z.object({ id: z.string(), body: z.record(z.string(), z.any()) }),
            summarize: (a) => `Update workflow rule ${a.id}`,
            run: (a, c) => c.api.updateWorkflow(a.id, a.body)
        },
        {
            name: 'zoho_delete_workflow',
            description: 'Delete a workflow rule by ID.',
            kind: 'write',
            schema: z.object({ id: z.string() }),
            summarize: (a) => `Delete workflow rule ${a.id}`,
            run: (a, c) => c.api.deleteWorkflow(a.id)
        },

        // -- mail ---------------------------------------------------------------
        {
            name: 'zoho_send_mail',
            description: 'Send an email from a CRM record (Leads/Contacts/Accounts/Deals/…). SENDS A REAL EMAIL.',
            kind: 'write',
            schema: z.object({
                module: z.string(),
                record_id: z.string(),
                to: z.array(z.string()).describe('Recipient email addresses'),
                subject: z.string().optional(),
                content: z.string().optional().describe('Email body (HTML unless mail_format is text)'),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
                from: z.string().optional().describe('Sender email; defaults to the logged-in user'),
                mail_format: z.enum(['html', 'text']).optional(),
                org_email: z.boolean().optional()
            }),
            summarize: (a) => `SEND EMAIL from ${a.module}/${a.record_id} to ${(a.to || []).join(', ')}`,
            run: async (a, c) => {
                const mail: Record<string, unknown> = {
                    to: a.to.map((e: string) => ({ email: e.trim() })),
                    subject: a.subject,
                    content: a.content
                };
                if (a.cc) mail.cc = a.cc.map((e: string) => ({ email: e.trim() }));
                if (a.bcc) mail.bcc = a.bcc.map((e: string) => ({ email: e.trim() }));
                if (a.from) mail.from = { email: a.from };
                if (a.mail_format) mail.mail_format = a.mail_format;
                if (a.org_email !== undefined) mail.org_email = a.org_email;
                return c.api.sendMail(a.module, a.record_id, mail);
            }
        },

        // -- blueprint ------------------------------------------------------------
        {
            name: 'zoho_blueprint_get',
            description: 'Get a record\'s Blueprint state and available next transitions.',
            kind: 'read',
            schema: z.object({ module: z.string(), record_id: z.string() }),
            summarize: noSummary,
            run: (a, c) => c.api.getBlueprint(a.module, a.record_id)
        },
        {
            name: 'zoho_blueprint_update',
            description: 'Execute a Blueprint transition on a record (moves it to the next state).',
            kind: 'write',
            schema: z.object({
                module: z.string(),
                record_id: z.string(),
                transition_id: z.string(),
                data: z.record(z.string(), z.any()).optional().describe('Field values the transition requires')
            }),
            summarize: (a) => `Execute Blueprint transition ${a.transition_id} on ${a.module}/${a.record_id}`,
            run: (a, c) => c.api.updateBlueprint(a.module, a.record_id, {
                blueprint: [{ transition_id: a.transition_id, data: a.data || {} }]
            })
        },
        {
            name: 'zoho_blueprint_config',
            description: 'List the org\'s Blueprint process configurations.',
            kind: 'read',
            schema: z.object({}),
            summarize: noSummary,
            run: (_a, c) => c.api.blueprintConfig()
        },
        {
            name: 'zoho_blueprint_transitions',
            description: 'Get Blueprint transition details by transition ID(s).',
            kind: 'read',
            schema: z.object({ ids: z.array(z.string()).min(1) }),
            summarize: noSummary,
            run: (a, c) => c.api.blueprintTransitions(a.ids)
        },

        // -- composite ------------------------------------------------------------
        {
            name: 'zoho_composite',
            description: 'Execute up to 5 Zoho CRM API sub-requests in ONE call (Composite API). Reference earlier results with @{sub_request_id:$.json.path}. Requires the ZohoCRM.composite_requests.CUSTOM scope.',
            kind: 'read', // self-gated below: confirms when any sub-request mutates
            schema: z.object({
                requests: z.array(z.object({
                    sub_request_id: z.string().optional(),
                    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
                    uri: z.string().describe('Full versioned path, e.g. /crm/v8/Leads/{id}'),
                    params: z.record(z.string(), z.any()).optional(),
                    body: z.any().optional(),
                    headers: z.record(z.string(), z.string()).optional()
                })).min(1).max(5),
                rollback_on_fail: z.boolean().optional().describe('Revert everything if any sub-request fails (forces sequential execution)'),
                sequential: z.boolean().optional().describe('Run in order instead of parallel')
            }),
            summarize: (a) => `Composite: ${a.requests.map((r: any) => `${r.method} ${r.uri}`).join(' | ')}`,
            run: async (a, c) => {
                const hasWrite = a.requests.some((r: any) => String(r.method).toUpperCase() !== 'GET');
                if (hasWrite) {
                    const approved = await c.confirm(`Execute composite request with WRITE sub-requests: ${a.requests.map((r: any) => `${r.method} ${r.uri}`).join(', ')}`);
                    if (!approved) throw new OrgError('USER_DECLINED', 'User declined composite request');
                }
                return c.api.composite(a.requests, { rollbackOnFail: a.rollback_on_fail, sequential: a.sequential });
            }
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
