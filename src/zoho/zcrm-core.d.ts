/*
 * Ambient type declarations for the reused Zoho CRM CLI service modules
 * (`wanas-zcrm-extractor`, imported as a local `file:` dependency).
 *
 * The CLI is plain JavaScript with no shipped types. These declarations cover
 * ONLY the surface the extension consumes through the dependency-injection
 * seams added in M1. All modules resolve to the single `wanas-zcrm-extractor`
 * package (the CLI itself) — the former `@wanasapps/zcrm-core` snapshot fork
 * was retired so both tools share one source of truth.
 */
declare module 'wanas-zcrm-extractor/src/services/authService' {
  /** Shape of the token bundle the AuthService loads/saves/holds. */
  interface ZcrmTokens {
    access_token?: string;
    refresh_token?: string;
    api_domain?: string;
    expires_in?: number;
    expiry_time?: number;
  }

  /** Dependency ports injected via the constructor or `configure()`. */
  interface AuthServiceDeps {
    credentials?: {
      getClientId?(): string | undefined;
      getClientSecret?(): string | undefined;
      getRedirectUri?(): string | undefined;
      getScopes?(): string | undefined;
      getDc?(): string | undefined;
    };
    store?: {
      loadTokens(): Promise<ZcrmTokens | null> | ZcrmTokens | null;
      saveTokens(tokens: ZcrmTokens): Promise<void> | void;
      loadTokensSync?(): ZcrmTokens | null;
    };
    logger?: {
      logInfo(message: string, context?: string): void;
      logError(error: unknown, context?: string): void;
    };
    http?: {
      post(url: string, body: string, opts?: unknown): Promise<{ data: any }>;
    };
  }

  class AuthService {
    constructor(deps?: AuthServiceDeps);
    /** Inject/override ports on an existing instance (e.g. the singleton). */
    configure(deps?: AuthServiceDeps): AuthService;
    /** Async-load tokens from the injected store. Call once after configure(). */
    hydrate(): Promise<ZcrmTokens | null>;
    getAuthorizationUrl(): string;
    handleCallback(code: string): Promise<ZcrmTokens>;
    refreshAccessToken(): Promise<string>;
    revokeRefreshToken(): Promise<void>;
    getAccessToken(): Promise<string>;
    isAuthenticated(): boolean;
    isAccessTokenExpired(): boolean;
    getApiBaseUrl(): string;
    getDc(): string;
    getAccountsDomain(): string;
    tokens: ZcrmTokens | null;
    /** The injected (axios-like) HTTP port used for token-endpoint calls. */
    http: { post(url: string, body: string, opts?: unknown): Promise<{ data: any }> };
  }

  /** The default export is the shared singleton, with the class attached. */
  const authService: AuthService & { AuthService: typeof AuthService };
  export = authService;
}

declare module 'wanas-zcrm-extractor/src/services/metadata/crmMetadataService' {
  interface ExtractOptions {
    concurrency?: number;
    /** Per-module record counts cost ~50 credits each — opt-in only. */
    withCounts?: boolean;
  }
  interface ExtractStats {
    modulesCount?: number;
    crm_org?: string;
    completedAt?: string;
    logFile?: string;
    skipped?: number;
    removedStale?: number;
    errors?: Array<{ endpoint?: string; message?: string }>;
    [key: string]: unknown;
  }
  type OnProgress = (stage: string, message: string, details?: any) => void;

  interface CrmMetadataService {
    extract(onProgress: OnProgress, outputDir: string, options?: ExtractOptions): Promise<ExtractStats>;
  }

  const service: CrmMetadataService;
  export = service;
}

declare module 'wanas-zcrm-extractor/src/utils/delugeFormatter' {
  export function formatDeluge(code: string): string;
}

declare module 'wanas-zcrm-extractor/src/services/functionService' {
  interface FnArg { type: string; name: string; }
  interface ResolvedTarget {
    mode: string;
    script: string;
    apiName: string;
    namespace: string;
    category: string | null;
    args: FnArg[];
  }
  interface RunResult {
    resolved: ResolvedTarget;
    args: Record<string, unknown>;
    response: any;
    fnResult: any;
    savedPath: string;
    success: boolean;
  }
  interface RemoteCode { apiName: string; id: string; code: string; }

  /** Read-only: fetch live code without writing. null when the fn doesn't exist. */
  export function getRemoteCode(apiName: string): Promise<RemoteCode | null>;
  export function resolveTarget(target: string): Promise<ResolvedTarget>;
  export function executeTest(params: { resolved: ResolvedTarget; args?: Record<string, unknown>; outputDir?: string }): Promise<RunResult>;
  export function runTest(params: { target: string; args?: Record<string, unknown>; outputDir?: string }): Promise<RunResult>;
  export function pullOne(params: { apiName: string; outputDir?: string }): Promise<{ apiName: string; category: string | null; namespace: string; filePath: string }>;
  export function pushCode(params: { file: string; outputDir?: string }): Promise<{ apiName: string; id: string; category: string | null; filePath: string }>;
  export function createFunction(params: { apiName: string; returnType?: string; fromFile?: string; outputDir?: string }): Promise<{ apiName: string; id: string; pushed: boolean; filePath: string }>;
  export function buildDescriptor(params: { apiName: string; returnType?: string }): Record<string, unknown>;
  export function isStandalone(resolved: any): boolean;
  export function assertStandalone(resolved: any): void;
}

declare module 'wanas-zcrm-extractor/src/utils/delugeSignature' {
  interface ParsedSignature {
    namespace: string | null;
    apiName: string | null;
    returnType: string | null;
    args: Array<{ type: string; name: string }>;
  }
  export function parseSignature(src: string): ParsedSignature;
}

declare module 'wanas-zcrm-extractor/src/utils/apiClient' {
  /** GET with automatic token refresh + rate-limit retries. */
  export function get(endpoint: string, params?: Record<string, unknown>): Promise<any>;
  /** POST (JSON). Inherits the retry/refresh behaviour of the read path. */
  export function post(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<any>;
  /** POST (JSON) with NO automatic retry — for executing/mutating paths. */
  export function postNoRetry(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<any>;
  /** PUT (JSON). Does NOT retry. */
  export function put(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<any>;
  /** PATCH (JSON). Does NOT retry. */
  export function patch(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<any>;
  /** DELETE. Does NOT retry. */
  export function del(endpoint: string, params?: Record<string, unknown>): Promise<any>;
  /** Multipart PUT (function code push). Does NOT retry. */
  export function putForm(
    endpoint: string,
    opts: { fieldName?: string; content: string; filename: string; contentType?: string }
  ): Promise<any>;
  /** Set the global concurrency cap for in-flight requests. */
  export function setConcurrency(n: number): void;
}

declare module 'wanas-zcrm-extractor/src/services/customizationService' {
  interface CustomizationService {
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

  const service: CustomizationService;
  export = service;
}

declare module 'wanas-zcrm-extractor/src/services/auditLogService' {
  export function exportAuditLog(filterPath?: string | null, outputDir?: string): Promise<string>;
}


