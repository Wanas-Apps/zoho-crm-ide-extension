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

    // -- records --------------------------------------------------------------

    /** Run a COQL `SELECT` query (read records). */
    queryRecords(selectQuery: string): Promise<any> {
        return this.http.post('/crm/v8/coql', { select_query: selectQuery });
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

    // -- metadata -------------------------------------------------------------

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
