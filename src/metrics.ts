import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export class Metrics {
    public readonly registry: Registry;

    // RPC Traffic
    public readonly rpcRequests: Counter;
    public readonly rpcErrors: Counter;

    // Latency
    public readonly rpcLatency: Histogram;

    // Cache
    public readonly rpcCacheHits: Counter;
    public readonly rpcCacheMisses: Counter;

    // Fallback
    public readonly rpcFallback: Counter;

    // Upstream
    public readonly upstreamRetries: Counter;

    constructor() {
        this.registry = new Registry();

        // Add default nodejs metrics (CPU, memory, etc.)
        collectDefaultMetrics({ register: this.registry, prefix: 'super_rpc_' });

        this.rpcRequests = new Counter({
            name: 'rpc_requests_total',
            help: 'Total number of RPC requests',
            labelNames: ['network', 'method', 'status'],
            registers: [this.registry]
        });

        this.rpcErrors = new Counter({
            name: 'rpc_errors_total',
            help: 'Total number of RPC errors',
            labelNames: ['network', 'method', 'error_type'],
            registers: [this.registry]
        });

        this.rpcLatency = new Histogram({
            name: 'rpc_latency_seconds',
            help: 'Latency of RPC requests in seconds',
            labelNames: ['network', 'method', 'source'], // source: cache, primary, fallback
            buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
            registers: [this.registry]
        });

        this.rpcCacheHits = new Counter({
            name: 'rpc_cache_hits_total',
            help: 'Total number of cache hits',
            labelNames: ['network', 'method'],
            registers: [this.registry]
        });

        this.rpcCacheMisses = new Counter({
            name: 'rpc_cache_misses_total',
            help: 'Total number of cache misses',
            labelNames: ['network', 'method'],
            registers: [this.registry]
        });

        this.rpcFallback = new Counter({
            name: 'rpc_fallback_events_total',
            help: 'Total number of fallback events triggered',
            labelNames: ['network', 'method', 'reason'],
            registers: [this.registry]
        });

        this.upstreamRetries = new Counter({
            name: 'rpc_upstream_retries_total',
            help: 'Total number of upstream retries',
            labelNames: ['network', 'upstream'],
            registers: [this.registry]
        });
    }
}
