import * as fs from 'fs';
import * as path from 'path';

/**
 * Lazily reads per-field metadata (`crm/meta/modules/<Module>/fields/<Field>.fields-meta.json`)
 * to enrich field hovers with the data type + picklist values. Pure Node + a
 * small cache; never eagerly loaded (preserves the lazy-field rule).
 */
export interface FieldMeta {
    dataType: string;
    label?: string;
    picklist: string[];
    systemMandatory?: boolean;
    length?: number;
}

export function extractFieldMeta(raw: any): FieldMeta {
    const picklist = Array.isArray(raw?.pick_list_values)
        ? raw.pick_list_values
              .map((p: any) => String(p?.display_value ?? ''))
              .filter((v: string) => v && v !== '-None-')
        : [];
    return {
        dataType: String(raw?.data_type ?? 'unknown'),
        label: raw?.field_label ? String(raw.field_label) : undefined,
        picklist,
        systemMandatory: !!raw?.system_mandatory,
        length: typeof raw?.length === 'number' ? raw.length : undefined
    };
}

export function renderFieldHover(module: string, field: string, meta: FieldMeta, maxValues = 15): string {
    const labelSuffix = meta.label && meta.label !== field ? ` · ${meta.label}` : '';
    const mandatory = meta.systemMandatory ? ' · required' : '';
    const lines = [`**${field}** — \`${meta.dataType}\`${labelSuffix} on \`${module}\`${mandatory}`];
    if (meta.picklist.length) {
        const shown = meta.picklist.slice(0, maxValues).map((v) => `\`${v}\``).join(', ');
        const more = meta.picklist.length > maxValues ? ` …and ${meta.picklist.length - maxValues} more` : '';
        lines.push(`Values: ${shown}${more}`);
    }
    return lines.join('  \n');
}

export class FieldMetaReader {
    private readonly cache = new Map<string, FieldMeta | undefined>();

    constructor(private readonly folder: string | undefined) {}

    async read(module: string, field: string): Promise<FieldMeta | undefined> {
        if (!this.folder) {
            return undefined;
        }
        const key = `${module}::${field}`;
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }
        const file = path.join(this.folder, 'crm', 'meta', 'modules', module, 'fields', `${field}.fields-meta.json`);
        let meta: FieldMeta | undefined;
        try {
            const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            meta = extractFieldMeta(raw);
        } catch {
            meta = undefined;
        }
        this.cache.set(key, meta);
        return meta;
    }
}
