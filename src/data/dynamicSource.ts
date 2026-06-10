import { DelugeSymbol } from './delugeData';

/**
 * The read interface the language providers use to fold org-specific metadata
 * (pulled from Zoho) into completion / signature help / hover. Implemented by
 * `MetadataIndex`. Providers hold a reference to a single instance whose
 * internal data is swapped on (re)load, so they never re-register.
 *
 * When no org data is loaded, every method returns empty / undefined and the
 * providers behave exactly as the static-catalog-only extension did.
 */
export interface DynamicSymbolSource {
    /** Standalone-function completion symbols (label `standalone.<api_name>`). */
    getStandaloneCompletions(): DelugeSymbol[];
    /** Resolve a standalone signature by `standalone.<api_name>` or bare `<api_name>`. */
    getStandaloneSignature(name: string): DelugeSymbol | undefined;
    /** Module completion symbols (label = module api_name). */
    getModuleCompletions(): DelugeSymbol[];
    /** Whether `name` is a known module api_name. */
    isModule(name: string): boolean;
    /** Field completion symbols for a module (label = field api_name). */
    getFieldSymbols(module: string): DelugeSymbol[];
    /** Hover lookup for a bare token (standalone api_name, `standalone.<api>`, module). */
    getHoverSymbol(token: string): DelugeSymbol | undefined;
    /** Rich field hover (data type + picklist) for `<Module>.<field>`, lazily read. */
    getFieldHoverDetail?(module: string, field: string): Promise<string | undefined>;
}

/** A source that yields nothing — the default before any org pull. */
export const EMPTY_DYNAMIC_SOURCE: DynamicSymbolSource = {
    getStandaloneCompletions: () => [],
    getStandaloneSignature: () => undefined,
    getModuleCompletions: () => [],
    isModule: () => false,
    getFieldSymbols: () => [],
    getHoverSymbol: () => undefined,
    getFieldHoverDetail: async () => undefined
};
