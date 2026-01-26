import axios, { AxiosError } from 'axios';
import http from 'http';
import https from 'https';
import { NetworkConfig } from './config';
import { Logger } from './logger';
import { Cache } from './cache';
import { randomUUID } from 'crypto';

const DUPLICATE_DELAY_TRIGGER_THRESHOLD_MS = 1000;
const DUPLICATE_MIN_DELAY_MS = 100;
const DUPLICATE_RANDOM_MAX_EXTRA_DELAY_MS = 200;
const CACHE_MAX_AGE_SEC = process.env.CACHE_MAX_AGE ? parseInt(process.env.CACHE_MAX_AGE) : 10;

// HTTP Agents for Keep-Alive
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// duplicate detector map: key -> timestamp
const duplicateDetector = new Map<string, number>();

function getCacheKey(network: string, reqBody: any): string {
    return `${network}:${reqBody.method}${JSON.stringify(reqBody.params)}`;
}

export class ProxyService {
    private cache: Cache;
    private logger: Logger;

    constructor(cache: Cache, logger: Logger) {
        this.cache = cache;
        this.logger = logger;
    }

    public async handleRequest(network: NetworkConfig, reqBody: any): Promise<any> {
        const startTime = Date.now();
        const internalId = randomUUID().split('-')[0]; // Short ID for readability
        const reqId = reqBody.id;
        const method = reqBody.method;
        const cacheKey = getCacheKey(network.name, reqBody);

        const logPrefix = `[${network.name}] [${internalId}] ${method}${reqId !== undefined ? ` (id:${reqId})` : ''}`;

        // 1. Duplicate Detection & Throttling
        if (duplicateDetector.has(cacheKey)) {
            const prevCallTs = duplicateDetector.get(cacheKey)!;
            if (Date.now() - prevCallTs < DUPLICATE_DELAY_TRIGGER_THRESHOLD_MS) {
                const delayMs = DUPLICATE_MIN_DELAY_MS + Math.floor(Math.random() * DUPLICATE_RANDOM_MAX_EXTRA_DELAY_MS);
                this.logger.debug(`${logPrefix} - Delaying duplicate request for ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        duplicateDetector.set(cacheKey, Date.now());

        // 2. Check Cache
        const isImmutableEthCall = method === "eth_call" && (() => {
            const blockTag = reqBody.params[1];
            if (typeof blockTag === 'string' && !["latest", "pending", "earliest", "safe", "finalized"].includes(blockTag)) return true;
            if (typeof blockTag === 'object' && (blockTag.blockHash || blockTag.blockNumber)) return true;
            return false;
        })();

        const cacheMaxAgeMs = (
            ["eth_chainId", "net_version", "eth_getTransactionReceipt"].includes(method) ||
            isImmutableEthCall
        ) ? Infinity : CACHE_MAX_AGE_SEC * 1000;

        const cachedEntry = await this.cache.get(cacheKey);
        if (cachedEntry) {
            if (Date.now() - cachedEntry.ts <= cacheMaxAgeMs) {
                const duration = Date.now() - startTime;
                this.logger.info(`${logPrefix} - Cache HIT (${duration}ms)`);
                return {
                    jsonrpc: "2.0",
                    id: reqId,
                    result: cachedEntry.val
                };
            } else {
                this.logger.debug(`${logPrefix} - Cache expired`);
            }
        }

        // 3. Upstream Request (Primary -> Fallback)
        let result = await this.upstreamRequest(network.primary, reqBody);

        let outcome = "Primary SUCCESS";

        if (this.shouldFallback(result)) {
            this.logger.warn(`${logPrefix} - Primary FAILED (missing state), switching to Fallback: ${network.fallback}`);
            try {
                const fallbackResult = await this.upstreamRequest(network.fallback, reqBody);
                result = fallbackResult;
                outcome = "Fallback SUCCESS";
            } catch (fallbackErr) {
                this.logger.error(`${logPrefix} - Fallback also failed.`);
                outcome = "Fallback FAILED";
            }
        } else if (result && result.error) {
            outcome = "Primary RPC ERROR";
        }

        const duration = Date.now() - startTime;
        this.logger.info(`${logPrefix} - ${outcome} (${duration}ms)`);

        // 4. Update Cache
        if (result && !result.error) {
            const isCacheableMethod = ["eth_chainId", "net_version"].includes(method);
            const isImmutableEthCall = method === "eth_call" && (() => {
                const blockTag = reqBody.params[1];
                if (typeof blockTag === 'string' && !["latest", "pending", "earliest", "safe", "finalized"].includes(blockTag)) return true;
                if (typeof blockTag === 'object' && (blockTag.blockHash || blockTag.blockNumber)) return true;
                return false;
            })();
            // eth_blockNumber is volatile, cache for short duration (handled by CACHE_MAX_AGE_SEC check in #2)
            // But here we set it.
            if (isCacheableMethod || method === "eth_blockNumber" || isImmutableEthCall) {
                this.cache.set(cacheKey, result.result);
            }
        }

        return result;
    }

    private async upstreamRequest(url: string, reqBody: any): Promise<any> {
        try {
            const res = await axios.post(url, reqBody, {
                timeout: 10000,
                httpAgent: httpAgent,
                httpsAgent: httpsAgent
            });
            return res.data;
        } catch (err: any) {
            // If network error, return error object so we can fallback.
            return { error: { code: -32000, message: `Network error: ${err.message}` } };
        }
    }

    private shouldFallback(res: any): boolean {
        // Condition 1: Network error (we constructed a fake error object above)
        if (res && res.error && res.error.message && res.error.message.includes("Network error")) return true;

        // Condition 2: RPC Error indicating missing state
        // Common errors: "header not found", "missing trie node", "execution reverted", "unknown block"
        if (res && res.error) {
            const msg = res.error.message.toLowerCase();
            return (
                msg.includes("missing trie node") ||
                msg.includes("header not found") ||
                msg.includes("unknown block") ||
                msg.includes("state not available") ||
                msg.includes("historical state") ||
                msg.includes("is not available")
            );
        }

        return false;
    }
}
