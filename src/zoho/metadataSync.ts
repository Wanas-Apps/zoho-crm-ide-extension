import crmMetadataService = require('@wanasapps/zcrm-core/src/services/metadata/crmMetadataService');
import { SyncLock } from './syncLock';

/** Minimal extractor contract (the bridged crmMetadataService.extract). */
export interface MetadataExtractor {
    extract(
        onProgress: (stage: string, message: string, details?: any) => void,
        outputDir: string,
        options: { concurrency?: number; withCounts?: boolean }
    ): Promise<any>;
}

export interface PullProgress {
    stage: string;
    message: string;
    completed?: number;
    total?: number;
}

export interface PullResult {
    stats: any;
    outputDir: string;
    /** Count of genuine (non-skipped) errors recorded during the pull. */
    errorCount: number;
}

export interface PullOptions {
    withCounts?: boolean;
    onProgress?: (p: PullProgress) => void;
}

export interface MetadataSyncDeps {
    isAuthenticated(): boolean;
    getOutputDir(): string | undefined;
    getConcurrency(): number;
    lock: SyncLock;
    /** Override the extractor (tests); defaults to the bridged CLI service. */
    extractor?: MetadataExtractor;
}

/**
 * Drives the reused CLI metadata engine from the extension: always passes the
 * absolute bound-folder `outputDir` (never the CLI's process.cwd() default),
 * runs under the SyncLock, and maps the engine's staged progress to a single
 * PullProgress callback.
 */
export class MetadataSync {
    constructor(private readonly deps: MetadataSyncDeps) {}

    isPulling(): boolean {
        return this.deps.lock.isLocked();
    }

    async pull(opts: PullOptions = {}): Promise<PullResult> {
        if (!this.deps.isAuthenticated()) {
            throw new Error('Sign in to Zoho CRM before pulling metadata.');
        }
        const outputDir = this.deps.getOutputDir();
        if (!outputDir) {
            throw new Error('Open a workspace folder to pull Zoho metadata into.');
        }

        const extractor = this.deps.extractor ?? crmMetadataService;

        return this.deps.lock.runExclusive(async () => {
            const stats = await extractor.extract(
                (stage, message, details) => {
                    opts.onProgress?.({
                        stage,
                        message,
                        completed: typeof details?.completed === 'number' ? details.completed : undefined,
                        total: typeof details?.total === 'number' ? details.total : undefined
                    });
                },
                outputDir,
                { concurrency: this.deps.getConcurrency(), withCounts: opts.withCounts === true }
            );
            const errorCount = Array.isArray(stats?.errors) ? stats.errors.length : 0;
            return { stats, outputDir, errorCount };
        });
    }
}
