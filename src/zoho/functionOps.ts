/**
 * Pure (no-vscode) function operations: standalone-path detection, name/arg
 * derivation, type coercion, org-match assertion, extension-appropriate error
 * hints (re-authored from the CLI — no `zcrm` command strings), and the
 * FunctionOps orchestrator over the bridged functionService. All guards run
 * BEFORE any service call so a misconfigured state never hits the network.
 */

export interface FnArg {
    type: string;
    name: string;
}
export interface ResolvedTarget {
    mode: string;
    script: string;
    apiName: string;
    namespace: string;
    category: string | null;
    args: FnArg[];
}
export interface RunResult {
    resolved: ResolvedTarget;
    args: Record<string, unknown>;
    response: any;
    fnResult: any;
    savedPath: string;
    success: boolean;
}

/** The subset of the CLI functionService the extension drives. */
export interface FunctionServicePort {
    resolveTarget(target: string): Promise<ResolvedTarget>;
    executeTest(p: { resolved: ResolvedTarget; args?: Record<string, unknown>; outputDir?: string }): Promise<RunResult>;
    pullOne(p: { apiName: string; outputDir?: string }): Promise<{ apiName: string; category: string | null; namespace: string; filePath: string }>;
    pushCode(p: { file: string; outputDir?: string }): Promise<{ apiName: string; id: string; category: string | null; filePath: string }>;
    createFunction(p: { apiName: string; returnType?: string; fromFile?: string; outputDir?: string }): Promise<{ apiName: string; id: string; pushed: boolean; filePath: string }>;
    assertStandalone(resolved: unknown): void;
    isStandalone(resolved: unknown): boolean;
}

export interface FnCodedError extends Error {
    code?: string;
}

export function fnError(message: string, code: string): FnCodedError {
    const e = new Error(message) as FnCodedError;
    e.code = code;
    return e;
}

/** Extension-facing hints (NO CLI command strings). */
export const FN_ERROR_HINTS: Record<string, string> = {
    NOT_AUTHENTICATED: 'Sign in to Zoho CRM first (status bar → "Zoho: Sign in").',
    NO_FOLDER: 'Open the workspace folder bound to your org, then pull metadata.',
    WRONG_ORG: 'This file belongs to a different Zoho org than the one you are signed in to. Switch org or open the matching folder.',
    DS_NOT_FOUND: 'Check the path to your .ds file.',
    NO_API_NAME: 'Ensure the .ds starts with a signature like `string standalone.My_Fn()`.',
    FN_NOT_FOUND: 'No such standalone function in this org — use “Create Standalone Function” to add it first.',
    NAME_INVALID: 'Create the standalone function first, then run it.',
    NOT_STANDALONE: 'Run / Push / Pull work on Standalone functions only.',
    NAME_MISMATCH: 'Rename the function or the .ds so the signature name matches.',
    EMPTY_CODE: 'The function exists but Zoho returned no code for it.',
    CREATE_FAILED: 'The name may already exist, or a field was rejected. Try a different name.',
    PUSH_FAILED: 'Open the .ds and check it compiles (the Zoho editor shows compile errors).'
};

export function hintFor(err: unknown): string | undefined {
    const code = (err as FnCodedError)?.code;
    return code ? FN_ERROR_HINTS[code] : undefined;
}

/**
 * True when a resolved standalone target exists locally but not yet on the org:
 * CRM returned no category for it (`findByApiName` found nothing), so the live
 * test endpoint would reject it with NAME_INVALID. The caller should offer to
 * push/create it before running.
 */
export function needsPushBeforeRun(resolved: { category: string | null }): boolean {
    return resolved.category === null || resolved.category === undefined;
}

/** True for any Deluge function path under `.../crm/functions/...` across all categories. */
export function isFunctionPath(fsPath: string): boolean {
    const norm = String(fsPath).replace(/\\/g, '/').toLowerCase();
    return /\/crm\/functions\/[^/]+\/[^/]+\.ds$/.test(norm);
}

/** Backward-compatible alias for function path detection. */
export const isStandalonePath = isFunctionPath;


/** Parse `<ns>.<api>.ds` → api_name (multi-dot api preserved). */
export function deriveApiNameFromPath(fsPath: string): string | undefined {
    const base = String(fsPath).replace(/\\/g, '/').split('/').pop() || '';
    const m = base.match(/^([A-Za-z0-9_]+)\.(.+)\.ds$/i);
    if (m) {
        return m[2];
    }
    const plain = base.match(/^(.+)\.ds$/i);
    return plain ? plain[1] : undefined;
}

/** Parse `<ns>.<api>.ds` → namespace, or undefined when not namespaced. */
export function deriveNamespaceFromPath(fsPath: string): string | undefined {
    const base = String(fsPath).replace(/\\/g, '/').split('/').pop() || '';
    const m = base.match(/^([A-Za-z0-9_]+)\.(.+)\.ds$/i);
    return m ? m[1].toLowerCase() : undefined;
}

/** Coerce an interactively-entered (string) argument to its declared type. */
export function coerceArg(value: string, type: string): unknown {
    const t = String(type || '').toLowerCase();
    if (/^(int|integer|long|bigint)$/.test(t)) {
        const n = parseInt(value, 10);
        return Number.isNaN(n) ? value : n;
    }
    if (/^(double|float|decimal|number|percent|currency)$/.test(t)) {
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
    }
    if (/^(bool|boolean)$/.test(t)) {
        return /^(true|yes|y|1)$/i.test(String(value).trim());
    }
    return value;
}

/** Build the {name: coercedValue} argument map from answers. */
export function buildArgMap(args: FnArg[], answers: Record<string, string>): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (const a of args) {
        map[a.name] = coerceArg(answers[a.name] ?? '', a.type);
    }
    return map;
}

/** Fail-closed org match: throws WRONG_ORG on mismatch or any missing value. */
export function assertOrgMatch(currentApiDomain: string | undefined, sessionApiDomain: string | undefined): void {
    if (!currentApiDomain || !sessionApiDomain || currentApiDomain !== sessionApiDomain) {
        throw fnError(
            'The active session does not match the target org. Sign in to the correct org and try again.',
            'WRONG_ORG'
        );
    }
}

export interface FunctionOpsDeps {
    svc: FunctionServicePort;
    getOutputDir: () => string | undefined;
    isAuthenticated: () => boolean;
    getCurrentApiDomain: () => string | undefined;
    getSessionApiDomain: () => string | undefined;
}

export class FunctionOps {
    constructor(private readonly deps: FunctionOpsDeps) {}

    /** Validate prerequisites and return the absolute outputDir. */
    private requireReady(needOrgMatch: boolean): string {
        if (!this.deps.isAuthenticated()) {
            throw fnError('Sign in to Zoho CRM first.', 'NOT_AUTHENTICATED');
        }
        const outputDir = this.deps.getOutputDir();
        if (!outputDir) {
            throw fnError('Open a workspace folder bound to your org first.', 'NO_FOLDER');
        }
        if (needOrgMatch) {
            assertOrgMatch(this.deps.getCurrentApiDomain(), this.deps.getSessionApiDomain());
        }
        return outputDir;
    }

    /** Resolve a `.ds` for Run + enforce the standalone rule (throws NOT_STANDALONE). */
    async resolveForRun(filePath: string): Promise<ResolvedTarget> {
        this.requireReady(true);
        const resolved = await this.deps.svc.resolveTarget(filePath);
        this.deps.svc.assertStandalone(resolved);
        return resolved;
    }

    /** Execute (live) a resolved standalone function with the given args. */
    async run(resolved: ResolvedTarget, args: Record<string, unknown>): Promise<RunResult> {
        const outputDir = this.requireReady(true);
        return this.deps.svc.executeTest({ resolved, args, outputDir });
    }

    /** Read-only pull of one function's code into its `.ds` (no org-match needed). */
    async pull(apiName: string): Promise<{ apiName: string; filePath: string; namespace: string; category: string | null }> {
        const outputDir = this.requireReady(false);
        return this.deps.svc.pullOne({ apiName, outputDir });
    }

    /** Push a local `.ds` to its live function (mutates → org-match enforced). */
    async push(file: string): Promise<{ apiName: string; id: string; filePath: string; category: string | null }> {
        const outputDir = this.requireReady(true);
        return this.deps.svc.pushCode({ file, outputDir });
    }

    /** Create a new standalone function (mutates → org-match enforced). */
    async create(apiName: string, opts: { returnType?: string; fromFile?: string } = {}): Promise<{ apiName: string; id: string; pushed: boolean; filePath: string }> {
        const outputDir = this.requireReady(true);
        return this.deps.svc.createFunction({ apiName, outputDir, ...opts });
    }
}
