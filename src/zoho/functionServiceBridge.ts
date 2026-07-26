import functionService = require('wanas-zcrm-extractor/src/services/functionService');
import { FunctionServicePort } from './functionOps';

/**
 * Sole owner of the functionService import. Exposes it as the typed
 * FunctionServicePort the extension drives.
 */
export const functionServicePort: FunctionServicePort = functionService;

/**
 * The fuller typed functionService surface (live run / read-code / push) the
 * MCP layer borrows. Same singleton — just the methods FunctionOps doesn't wrap.
 */
export const fnService = functionService;
