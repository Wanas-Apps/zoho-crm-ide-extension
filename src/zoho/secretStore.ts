import type * as vscode from 'vscode';

/**
 * The single secret bundle persisted per connection (per workspace folder).
 * Tokens and the user's BYO `client_secret` live together so one keychain
 * entry holds everything sensitive — and nothing sensitive ever touches the
 * project tree.
 */
export interface SecretBundle {
    tokens?: ZcrmTokensLike | null;
    client_secret?: string;
}

/** Minimal token shape (mirrors the CLI AuthService token bundle). */
export interface ZcrmTokensLike {
    access_token?: string;
    refresh_token?: string;
    api_domain?: string;
    expires_in?: number;
    expiry_time?: number;
}

/**
 * A `TokenStorePort` implementation backed by VS Code SecretStorage (the OS
 * keychain), keyed per workspace folder. Satisfies the CLI AuthService store
 * contract (`loadTokens`/`saveTokens`) and additionally caches the BYO
 * `client_secret` in memory so the synchronous `getClientSecret()` credential
 * getter can read it after a one-time async `prime()`/`load()`.
 */
export class SecretStorageStore {
    private cache: SecretBundle | null = null;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly key: string
    ) {}

    /** Read the bundle from the keychain into the in-memory cache (once). */
    private async read(): Promise<SecretBundle> {
        if (this.cache) {
            return this.cache;
        }
        const raw = await this.secrets.get(this.key);
        this.cache = raw ? safeParse(raw) : {};
        return this.cache;
    }

    private async write(bundle: SecretBundle): Promise<void> {
        this.cache = bundle;
        await this.secrets.store(this.key, JSON.stringify(bundle));
    }

    /** Populate the in-memory cache. Call once at activation before using the
     *  synchronous credential getters. */
    async prime(): Promise<void> {
        await this.read();
    }

    /** Drop the in-memory cache so the next read re-fetches from the keychain
     *  (used when another window changed this connection's secret). */
    invalidate(): void {
        this.cache = null;
    }

    /** TokenStorePort: load just the token portion of the bundle. */
    async loadTokens(): Promise<ZcrmTokensLike | null> {
        const bundle = await this.read();
        return bundle.tokens ?? null;
    }

    /** TokenStorePort: persist tokens, preserving the stored client_secret. */
    async saveTokens(tokens: ZcrmTokensLike): Promise<void> {
        const bundle = await this.read();
        await this.write({ ...bundle, tokens });
    }

    /** Persist the user's BYO client_secret (used by the login flow, M2). */
    async setClientSecret(secret: string): Promise<void> {
        const bundle = await this.read();
        await this.write({ ...bundle, client_secret: secret });
    }

    /** Synchronous read of the cached client_secret (valid after prime/load). */
    getCachedClientSecret(): string | undefined {
        return this.cache?.client_secret;
    }

    /** Whether a token bundle is currently present (cached). */
    hasTokens(): boolean {
        return !!this.cache?.tokens?.access_token;
    }

    /** Clear only the session tokens, keeping the BYO app credentials so the
     *  next sign-in does not re-prompt for the client secret. */
    async clearTokens(): Promise<void> {
        const bundle = await this.read();
        await this.write({ ...bundle, tokens: null });
    }

    /** Remove all secrets for this connection (full disconnect). */
    async clear(): Promise<void> {
        this.cache = {};
        await this.secrets.delete(this.key);
    }
}

function safeParse(raw: string): SecretBundle {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as SecretBundle) : {};
    } catch {
        return {};
    }
}
