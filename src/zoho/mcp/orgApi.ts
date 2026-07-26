/**
 * OrgApi — the typed capability layer over the authenticated Zoho CRM org.
 *
 * This is the single source of truth for "what can be done to the org", reused
 * by the MCP tools (and, later, a CLI). It is pure of vscode and of the MCP SDK
 * so it can be unit-tested with a mock `fetch` + a fake auth.
 *
 * It talks to the CRM REST API directly (records / metadata / fields) using the
 * extension's existing `authService` for the bearer token + api_domain — that
 * gives us token-refresh for free and full CRUD (the bundled apiClient only
 * exposes GET/POST/putForm). Function run/push are NOT here — those reuse the
 * extension's existing FunctionOps (standalone-only rules, conflict guard).
 */

export interface OrgAuth {
    isAuthenticated(): boolean;
    getAccessToken(): Promise<string>;
    getApiBaseUrl(): string;
}

export type FetchLike = (input: string, init?: any) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;

export class OrgError extends Error {
    constructor(readonly code: string, message: string, readonly details?: unknown) {
        super(message);
        this.name = 'OrgError';
    }
}

/** Minimal authed HTTP client for the CRM API (GET/POST/PUT/DELETE + JSON). */
export class OrgHttp {
    constructor(private readonly auth: OrgAuth, private readonly fetchImpl: FetchLike) {}

    async request(method: string, path: string, body?: unknown): Promise<any> {
        if (!this.auth.isAuthenticated()) {
            throw new OrgError('NOT_AUTHENTICATED', 'Not signed in to Zoho CRM. Sign in first.');
        }
        const token = await this.auth.getAccessToken();
        const url = this.auth.getApiBaseUrl().replace(/\/+$/, '') + path;
        const res = await this.fetchImpl(url, {
            method,
            headers: {
                Authorization: `Zoho-oauthtoken ${token}`,
                'Content-Type': 'application/json'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const raw = await res.text();
        let data: any = {};
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch {
                data = { raw };
            }
        }
        if (!res.ok || (data && data.status === 'error')) {
            const msg = (data && (data.message || data.error)) || `Zoho API HTTP ${res.status}`;
            throw new OrgError('API_ERROR', String(msg), data);
        }
        return data;
    }

    get(path: string): Promise<any> {
        return this.request('GET', path);
    }
    post(path: string, body: unknown): Promise<any> {
        return this.request('POST', path, body);
    }
    put(path: string, body: unknown): Promise<any> {
        return this.request('PUT', path, body);
    }
    del(path: string): Promise<any> {
        return this.request('DELETE', path);
    }
}

const enc = encodeURIComponent;

/** Typed Zoho CRM operations. Each returns Zoho's JSON response verbatim so the
 *  agent gets full detail (and can self-correct on errors). */
export class OrgApi {
    constructor(private readonly http: OrgHttp) {}

    // -- Universal API --------------------------------------------------------

    /** Universal API proxy: call ANY Zoho CRM endpoint. */
    rawRequest(method: string, endpoint: string, params?: Record<string, any>, body?: unknown): Promise<any> {
        let ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        if (!ep.startsWith('/crm/')) {
            ep = `/crm/v8${ep}`;
        }
        let url = ep;
        if (params && Object.keys(params).length > 0) {
            const query = new URLSearchParams(params).toString();
            url += `${url.includes('?') ? '&' : '?'}${query}`;
        }
        return this.http.request(method.toUpperCase(), url, body);
    }

    // -- records --------------------------------------------------------------

    /** Run a COQL `SELECT` query (read records). Zoho requires a WHERE clause;
     *  when the query has none, `where id is not null` is injected so bare
     *  `select ... from Module limit N` queries just work (same behavior as
     *  the zcrm CLI). Aggregates are case-sensitive (COUNT not count) and need
     *  an explicit `limit`. */
    queryRecords(selectQuery: string): Promise<any> {
        let query = String(selectQuery);
        if (!/\bwhere\b/i.test(query)) {
            const m = query.match(/\b(order\s+by|group\s+by|limit|offset)\b/i);
            const where = ' where id is not null ';
            query = m ? query.slice(0, m.index) + where + query.slice(m.index) : query.trimEnd() + where.trimEnd();
        }
        return this.http.post('/crm/v8/coql', { select_query: query });
    }

    listRecords(module: string, params?: Record<string, any>): Promise<any> {
        let url = `/crm/v8/${enc(module)}`;
        if (params && Object.keys(params).length > 0) {
            url += `?${new URLSearchParams(params).toString()}`;
        }
        return this.http.get(url);
    }

    getRecord(module: string, id: string): Promise<any> {
        return this.http.get(`/crm/v8/${enc(module)}/${enc(id)}`);
    }

    /** Create one record. `data` is the field map (e.g. `{ Last_Name: "X" }`). */
    createRecord(module: string, data: Record<string, unknown>): Promise<any> {
        return this.http.post(`/crm/v8/${enc(module)}`, { data: [data] });
    }

    updateRecord(module: string, id: string, data: Record<string, unknown>): Promise<any> {
        return this.http.put(`/crm/v8/${enc(module)}/${enc(id)}`, { data: [data] });
    }

    deleteRecord(module: string, id: string): Promise<any> {
        return this.http.del(`/crm/v8/${enc(module)}?ids=${enc(id)}`);
    }

    searchRecords(module: string, params: Record<string, any>): Promise<any> {
        const query = new URLSearchParams(params).toString();
        return this.http.get(`/crm/v8/${enc(module)}/search?${query}`);
    }

    upsertRecords(module: string, data: Record<string, unknown>[]): Promise<any> {
        return this.http.post(`/crm/v8/${enc(module)}/upsert`, { data });
    }

    countRecords(module: string): Promise<any> {
        return this.http.get(`/crm/v8/${enc(module)}/actions/count`);
    }

    // -- org variables --------------------------------------------------------

    listVariables(groupId?: string): Promise<any> {
        const url = groupId ? `/crm/v8/settings/variables?group=${enc(groupId)}` : '/crm/v8/settings/variables';
        return this.http.get(url);
    }

    getVariable(id: string, groupId?: string): Promise<any> {
        const url = groupId ? `/crm/v8/settings/variables/${enc(id)}?group=${enc(groupId)}` : `/crm/v8/settings/variables/${enc(id)}`;
        return this.http.get(url);
    }

    setVariable(apiName: string, value: any, options?: { group?: string; id?: string; type?: string; description?: string }): Promise<any> {
        const varData: Record<string, any> = { api_name: apiName, value, type: options?.type || 'text' };
        if (options?.description) varData.description = options.description;
        if (options?.group) varData.variable_group = { id: options.group };
        if (options?.id) {
            varData.id = options.id;
            return this.http.put(`/crm/v8/settings/variables/${enc(options.id)}`, { variables: [varData] });
        }
        return this.http.post('/crm/v8/settings/variables', { variables: [varData] });
    }

    deleteVariable(id: string): Promise<any> {
        return this.http.del(`/crm/v8/settings/variables/${enc(id)}`);
    }

    listVariableGroups(): Promise<any> {
        return this.http.get('/crm/v8/settings/variable_groups');
    }

    // -- tags -----------------------------------------------------------------

    listTags(module: string): Promise<any> {
        return this.http.get(`/crm/v8/settings/tags?module=${enc(module)}`);
    }

    createTag(module: string, name: string, colorCode?: string): Promise<any> {
        const tagData: Record<string, any> = { name };
        if (colorCode) tagData.color_code = colorCode;
        return this.http.post(`/crm/v8/settings/tags?module=${enc(module)}`, { tags: [tagData] });
    }

    deleteTag(id: string): Promise<any> {
        return this.http.del(`/crm/v8/settings/tags/${enc(id)}`);
    }

    addTags(module: string, recordId: string, tagNames: string[]): Promise<any> {
        const tags = tagNames.map(t => ({ name: t }));
        return this.http.post(`/crm/v8/${enc(module)}/${enc(recordId)}/actions/add_tags`, { tags });
    }

    removeTags(module: string, recordId: string, tagNames: string[]): Promise<any> {
        const tags = tagNames.map(t => ({ name: t }));
        return this.http.post(`/crm/v8/${enc(module)}/${enc(recordId)}/actions/remove_tags`, { tags });
    }

    // -- notes ----------------------------------------------------------------

    listNotes(params?: Record<string, any>): Promise<any> {
        let url = '/crm/v8/Notes';
        if (params && Object.keys(params).length > 0) {
            url += `?${new URLSearchParams(params).toString()}`;
        }
        return this.http.get(url);
    }

    getNote(id: string): Promise<any> {
        return this.http.get(`/crm/v8/Notes/${enc(id)}`);
    }

    createNote(body: Record<string, unknown>): Promise<any> {
        return this.http.post('/crm/v8/Notes', body);
    }

    deleteNote(id: string): Promise<any> {
        return this.http.del(`/crm/v8/Notes/${enc(id)}`);
    }

    // -- users ----------------------------------------------------------------

    listUsers(type: string = 'AllUsers', params?: Record<string, any>): Promise<any> {
        const q = new URLSearchParams({ type, ...(params || {}) }).toString();
        return this.http.get(`/crm/v8/users?${q}`);
    }

    getUser(userId: string): Promise<any> {
        return this.http.get(`/crm/v8/users/${enc(userId)}`);
    }

    // -- bulk -----------------------------------------------------------------
    // Bulk jobs live on the /crm/bulk/v8 base, not /crm/v8.

    createBulkRead(module: string, body?: Record<string, unknown>): Promise<any> {
        const payload = body || { query: { module: { api_name: module } } };
        return this.http.post('/crm/bulk/v8/read', payload);
    }

    createBulkWrite(body: Record<string, unknown>): Promise<any> {
        return this.http.post('/crm/bulk/v8/write', body);
    }

    getBulkStatus(type: 'read' | 'write', jobId: string): Promise<any> {
        return this.http.get(`/crm/bulk/v8/${type}/${enc(jobId)}`);
    }

    // -- notifications / webhooks ---------------------------------------------

    listNotifications(): Promise<any> {
        return this.http.get('/crm/v8/actions/watch');
    }

    createNotification(body: Record<string, unknown>): Promise<any> {
        return this.http.post('/crm/v8/actions/watch', body);
    }

    deleteNotification(body?: Record<string, unknown>): Promise<any> {
        return this.http.request('DELETE', '/crm/v8/actions/watch', body);
    }

    // -- recycle bin ----------------------------------------------------------

    listRecycleBin(params?: Record<string, any>): Promise<any> {
        let url = '/crm/v8/settings/recycle_bin';
        if (params && Object.keys(params).length > 0) {
            url += `?${new URLSearchParams(params).toString()}`;
        }
        return this.http.get(url);
    }

    countRecycleBin(): Promise<any> {
        return this.http.get('/crm/v8/settings/recycle_bin/actions/count');
    }

    restoreRecycleBin(recordId: string): Promise<any> {
        return this.http.post(`/crm/v8/settings/recycle_bin/${enc(recordId)}/actions/restore`, {});
    }

    emptyRecycleBin(): Promise<any> {
        return this.http.post('/crm/v8/settings/recycle_bin/actions/empty', {});
    }

    // -- workflows & automation -----------------------------------------------

    listWorkflows(module?: string, params?: Record<string, any>): Promise<any> {
        const qParams = { ...(params || {}) };
        if (module) qParams.module = module;
        let url = '/crm/v8/settings/automation/workflow_rules';
        if (Object.keys(qParams).length > 0) {
            url += `?${new URLSearchParams(qParams).toString()}`;
        }
        return this.http.get(url);
    }

    getWorkflow(id: string): Promise<any> {
        return this.http.get(`/crm/v8/settings/automation/workflow_rules/${enc(id)}`);
    }

    createWorkflow(body: Record<string, unknown>): Promise<any> {
        return this.http.post('/crm/v8/settings/automation/workflow_rules', body);
    }

    updateWorkflow(id: string, body: Record<string, unknown>): Promise<any> {
        return this.http.put(`/crm/v8/settings/automation/workflow_rules/${enc(id)}`, body);
    }

    deleteWorkflow(id: string): Promise<any> {
        return this.http.del(`/crm/v8/settings/automation/workflow_rules/${enc(id)}`);
    }

    // -- mail -----------------------------------------------------------------

    /** Send an email from a record. No retry — a retry could double-send. */
    sendMail(module: string, recordId: string, mail: Record<string, unknown>): Promise<any> {
        return this.http.post(`/crm/v8/${enc(module)}/${enc(recordId)}/actions/send_mail`, { data: [mail] });
    }

    // -- blueprint --------------------------------------------------------------

    /** Get a record's Blueprint state and available next transitions. */
    getBlueprint(module: string, recordId: string): Promise<any> {
        return this.http.get(`/crm/v8/${enc(module)}/${enc(recordId)}/actions/blueprint`);
    }

    /** Execute a Blueprint transition on a record. */
    updateBlueprint(module: string, recordId: string, body: Record<string, unknown>): Promise<any> {
        return this.http.put(`/crm/v8/${enc(module)}/${enc(recordId)}/actions/blueprint`, body);
    }

    blueprintConfig(): Promise<any> {
        return this.http.get('/crm/v8/settings/blueprints/process_configurations');
    }

    blueprintTransitions(ids: string[]): Promise<any> {
        if (ids.length === 1) {
            return this.http.get(`/crm/v8/settings/blueprints/transitions/${enc(ids[0])}`);
        }
        return this.http.get(`/crm/v8/settings/blueprints/transitions?ids=${enc(ids.join(','))}`);
    }

    // -- composite --------------------------------------------------------------

    /** Combine up to 5 API sub-requests in one call. rollback implies sequential
     *  execution (rollback+parallel is rejected by Zoho). */
    composite(requests: unknown[], opts?: { rollbackOnFail?: boolean; sequential?: boolean }): Promise<any> {
        const body: Record<string, unknown> = { __composite_requests: requests };
        if (opts?.rollbackOnFail) {
            body.rollback_on_fail = true;
            body.parallel_execution = false;
        } else if (opts?.sequential) {
            body.parallel_execution = false;
        }
        return this.http.post('/crm/v8/__composite_requests', body);
    }

    // -- metadata & org -------------------------------------------------------

    listModules(): Promise<any> {
        return this.http.get('/crm/v8/settings/modules');
    }

    getFields(module: string): Promise<any> {
        return this.http.get(`/crm/v8/settings/fields?module=${enc(module)}`);
    }

    /** Create a custom field on a module. `field` follows Zoho's fields schema. */
    createField(module: string, field: Record<string, unknown>): Promise<any> {
        return this.http.post(`/crm/v8/settings/fields?module=${enc(module)}`, { fields: [field] });
    }

    updateField(module: string, fieldId: string, changes: Record<string, unknown>): Promise<any> {
        return this.http.put(`/crm/v8/settings/fields/${enc(fieldId)}?module=${enc(module)}`, {
            fields: [{ id: fieldId, ...changes }]
        });
    }

    listFunctions(): Promise<any> {
        return this.http.get('/crm/v8/settings/functions');
    }

    orgInfo(): Promise<any> {
        return this.http.get('/crm/v8/org');
    }
}
