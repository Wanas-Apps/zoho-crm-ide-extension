import { WorkspaceConfigStore } from './configStore';
import { SecretStorageStore } from './secretStore';

/**
 * A `credentials` port for the CLI AuthService. Combines the non-secret
 * workspace settings (client_id, dc, scopes) with the BYO `client_secret`
 * cached from SecretStorage, plus a redirect URI supplied by the loopback
 * server (wired in M2).
 *
 * All getters are synchronous because the CLI AuthService calls them
 * synchronously during the OAuth exchange/refresh. The client_secret is read
 * from the SecretStorageStore's in-memory cache, which must be primed
 * (`prime()`/`hydrate()`) before the first authenticated call.
 */
export class CredentialProvider {
    constructor(
        private readonly config: WorkspaceConfigStore,
        private readonly secrets: SecretStorageStore,
        private readonly redirectUri: () => string | undefined = () => undefined,
        /** In proxy mode, the client_id fetched from the proxy (takes precedence
         *  over the BYO `zohoDeluge.clientId` so the authorize URL matches the
         *  proxy's Zoho app). Undefined in BYO mode. */
        private readonly proxyClientId: () => string | undefined = () => undefined
    ) {}

    getClientId(): string | undefined {
        return this.proxyClientId() || this.config.getClientId();
    }

    getClientSecret(): string | undefined {
        return this.secrets.getCachedClientSecret();
    }

    getRedirectUri(): string | undefined {
        return this.redirectUri();
    }

    /** Undefined → CLI AuthService falls back to its documented default scopes. */
    getScopes(): string | undefined {
        return this.config.getScopes();
    }

    getDc(): string {
        return this.config.getDc();
    }
}
