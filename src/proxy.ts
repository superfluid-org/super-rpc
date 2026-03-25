import { Pool } from 'undici';
import { NetworkConfig } from './config';
import { Logger } from './logger';
import { Cache } from './cache';
import { createHash, randomBytes } from 'crypto';
import { Metrics } from './metrics';

const CACHE_MAX_AGE_SEC = process.env.CACHE_MAX_AGE ? parseInt(process.env.CACHE_MAX_AGE) : 10;
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT || '500');
const MAX_SOCKETS_PER_HOST = parseInt(process.env.MAX_SOCKETS || '50');

// Per-origin connection pools (undici manages keep-alive internally)
const pools = new Map<string, Pool>();

function getPool(url: string): Pool {
    const origin = new URL(url).origin;
    let pool = pools.get(origin);
    if (!pool) {
        pool = new Pool(origin, {
            connections: MAX_SOCKETS_PER_HOST,
            pipelining: 1,
            keepAliveTimeout: 30_000,
        });
        pools.set(origin, pool);
    }
    return pool;
}

// Known RPC methods for metrics cardinality control
const KNOWN_METHODS = new Set([
    'eth_call', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
    'eth_blockNumber', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash',
    'eth_getLogs', 'eth_getCode', 'eth_getStorageAt', 'eth_estimateGas',
    'eth_gasPrice', 'eth_getTransactionCount', 'eth_sendRawTransaction',
    'net_version', 'web3_clientVersion',
]);

// Methods whose results never change — cache forever
const IMMUTABLE_METHODS = new Set(['eth_chainId', 'net_version', 'eth_getTransactionReceipt']);

// Methods whose results are cacheable
const CACHEABLE_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'net_version']);

function normalizeMethod(method: string): string {
    return KNOWN_METHODS.has(method) ? method : 'other';
}

function shortId(): string {
    return randomBytes(4).toString('hex');
}

function getCacheKey(network: string, reqBody: any): string {
    const params = reqBody.params;
    const paramsStr = params != null ? JSON.stringify(params) : '';
    if (paramsStr.length < 128) {
        return `${network}:${reqBody.method}:${paramsStr}`;
    }
    const hash = createHash('sha1').update(paramsStr).digest('hex');
    return `${network}:${reqBody.method}:${hash}`;
}

function isValidRpcRequest(body: any): body is { jsonrpc: string; method: string; id: any; params?: any[] } {
    return (
        body != null &&
        typeof body === 'object' &&
        typeof body.method === 'string' &&
        body.method.length > 0
    );
}

export class ProxyService {
    private cache: Cache;
    private logger: Logger;
    private metrics: Metrics;
    private inflight = new Map<string, Promise<any>>();
    private _activeRequests = 0;

    constructor(cache: Cache, logger: Logger, metrics: Metrics) {
        this.cache = cache;
        this.logger = logger;
        this.metrics = metrics;
    }

    public get activeRequests(): number {
        return this._activeRequests;
    }

    public async handleRequest(network: NetworkConfig, reqBody: any): Promise<any> {
        // Input validation
        if (!isValidRpcRequest(reqBody)) {
            return { jsonrpc: "2.0", id: reqBody?.id ?? null, error: { code: -32600, message: "Invalid request" } };
        }

        // Backpressure: reject if overloaded
        if (this._activeRequests >= MAX_CONCURRENT_REQUESTS) {
            this.metrics.rpcRejected.inc({ network: network.name });
            return { jsonrpc: "2.0", id: reqBody.id, error: { code: -32000, message: "Server overloaded" } };
        }

        this._activeRequests++;
        this.metrics.rpcActiveRequests.inc({ network: network.name });
        try {
            return await this._handleRequest(network, reqBody);
        } finally {
            this._activeRequests--;
            this.metrics.rpcActiveRequests.dec({ network: network.name });
        }
    }

    private async _handleRequest(network: NetworkConfig, reqBody: any): Promise<any> {
        const startTime = Date.now();
        const internalId = shortId();
        const reqId = reqBody.id;
        const method = reqBody.method;
        const metricMethod = normalizeMethod(method);
        const cacheKey = getCacheKey(network.name, reqBody);

        this.metrics.rpcRequests.inc({ network: network.name, method: metricMethod, status: 'received' });

        const logPrefix = `[${network.name}] [${internalId}] ${method}${reqId !== undefined ? ` (id:${reqId})` : ''}`;

        // 1. Check Cache
        const cacheMaxAgeMs = IMMUTABLE_METHODS.has(method) ? Infinity : CACHE_MAX_AGE_SEC * 1000;

        const cachedEntry = await this.cache.get(cacheKey);
        if (cachedEntry) {
            if (Date.now() - cachedEntry.ts <= cacheMaxAgeMs) {
                const duration = Date.now() - startTime;
                this.logger.debug(`${logPrefix} - Cache HIT (${duration}ms)`);
                this.metrics.rpcCacheHits.inc({ network: network.name, method: metricMethod });
                this.metrics.rpcLatency.observe({ network: network.name, method: metricMethod, source: 'cache' }, duration / 1000);
                return {
                    jsonrpc: "2.0",
                    id: reqId,
                    result: cachedEntry.val
                };
            }
        }
        this.metrics.rpcCacheMisses.inc({ network: network.name, method: metricMethod });

        // 2. Request coalescing: if an identical request is already in-flight, piggyback on it
        const existingFlight = this.inflight.get(cacheKey);
        if (existingFlight) {
            this.logger.debug(`${logPrefix} - Coalescing with in-flight request`);
            this.metrics.rpcCoalesced.inc({ network: network.name, method: metricMethod });
            const result = await existingFlight;
            return { ...result, id: reqId };
        }

        // 3. Create the upstream work as a shared promise
        const flightPromise = this.doUpstream(network, reqBody, logPrefix, startTime);
        this.inflight.set(cacheKey, flightPromise);

        try {
            const result = await flightPromise;
            return result;
        } finally {
            this.inflight.delete(cacheKey);
        }
    }

    private async doUpstream(network: NetworkConfig, reqBody: any, logPrefix: string, startTime: number): Promise<any> {
        const method = reqBody.method;
        const metricMethod = normalizeMethod(method);
        const cacheKey = getCacheKey(network.name, reqBody);

        let result: any;
        let outcome: string;
        const upstreamStart = Date.now();

        result = await this.upstreamRequest(network.name, 'primary', network.primary, reqBody);

        if (this.shouldFallback(result)) {
            this.logger.warn(`${logPrefix} - Primary FAILED, switching to Fallback`);
            this.metrics.rpcFallback.inc({ network: network.name, method: metricMethod, reason: 'missing_state' });

            const fallbackResult = await this.upstreamRequest(network.name, 'fallback', network.fallback, reqBody);
            result = fallbackResult;
            outcome = result?.error ? "Fallback FAILED" : "Fallback SUCCESS";
            if (!result?.error) {
                this.metrics.rpcLatency.observe({ network: network.name, method: metricMethod, source: 'fallback' }, (Date.now() - upstreamStart) / 1000);
            }
        } else if (result && result.error) {
            outcome = "Primary RPC ERROR";
            this.metrics.rpcErrors.inc({ network: network.name, method: metricMethod, error_type: 'rpc_error' });
        } else {
            outcome = "Primary SUCCESS";
            this.metrics.rpcLatency.observe({ network: network.name, method: metricMethod, source: 'primary' }, (Date.now() - upstreamStart) / 1000);
        }

        const duration = Date.now() - startTime;
        const completionStatus = (result && !result.error) ? 'completed' : 'failed';
        this.metrics.rpcRequests.inc({ network: network.name, method: metricMethod, status: completionStatus });
        this.logger.info(`${logPrefix} - ${outcome!} (${duration}ms)`);

        // 4. Update Cache
        if (result && !result.error) {
            const shouldCache =
                CACHEABLE_METHODS.has(method) ||
                (method === "eth_call" && Array.isArray(reqBody.params) &&
                    reqBody.params.some((param: any) => typeof param === 'object' && param !== null && 'blockHash' in param));

            if (shouldCache) {
                this.cache.set(cacheKey, result.result, IMMUTABLE_METHODS.has(method));
            }
        }

        return result;
    }

    private async upstreamRequest(networkName: string, upstream: string, url: string, reqBody: any): Promise<any> {
        try {
            const pool = getPool(url);
            const { pathname, search } = new URL(url);
            const path = search ? `${pathname}${search}` : pathname;
            const body = JSON.stringify(reqBody);

            const { statusCode, body: resBody } = await pool.request({
                path,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                headersTimeout: 10_000,
                bodyTimeout: 10_000,
            });

            let data = '';
            for await (const chunk of resBody) {
                data += chunk;
            }

            if (statusCode !== 200) {
                this.metrics.upstreamHttpErrors.inc({ network: networkName, upstream, status_code: String(statusCode) });
            }

            return JSON.parse(data);
        } catch (err: any) {
            const isTimeout = err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'UND_ERR_BODY_TIMEOUT';
            const safeMessage = isTimeout ? 'Upstream timeout' : 'Upstream request failed';
            this.logger.error(`Upstream error for ${url}: ${err.message}`);
            return { error: { code: -32000, message: safeMessage } };
        }
    }

    private shouldFallback(res: any): boolean {
        if (res?.error?.message === 'Upstream timeout' || res?.error?.message === 'Upstream request failed') return true;

        if (res?.error?.message) {
            const msg = res.error.message.toLowerCase();
            return (
                msg.includes("missing trie node") ||
                msg.includes("header not found") ||
                msg.includes("unknown block") ||
                msg.includes("state not available") ||
                msg.includes("historical state") ||
                msg.includes("is not available") ||
                msg.includes("exceed max addresses")
            );
        }

        return false;
    }
}
