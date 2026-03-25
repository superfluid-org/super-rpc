import { Counter, Gauge, Histogram, register } from 'prom-client';

export class Metrics {
    public readonly registry = register;

    // RPC Traffic
    public readonly rpcRequests: Counter;
    public readonly rpcErrors: Counter;
    public readonly rpcActiveRequests: Gauge;
    public readonly rpcCoalesced: Counter;
    public readonly rpcRejected: Counter;

    // Latency
    public readonly rpcLatency: Histogram;

    // Cache
    public readonly rpcCacheHits: Counter;
    public readonly rpcCacheMisses: Counter;

    // Fallback
    public readonly rpcFallback: Counter;

    // Upstream
    public readonly upstreamHttpErrors: Counter;

    constructor() {
        this.rpcRequests = new Counter({
            name: 'rpc_requests_total',
            help: 'Total number of RPC requests',
            labelNames: ['network', 'method', 'status'],
        });

        this.rpcErrors = new Counter({
            name: 'rpc_errors_total',
            help: 'Total number of RPC errors',
            labelNames: ['network', 'method', 'error_type'],
        });

        this.rpcActiveRequests = new Gauge({
            name: 'rpc_active_requests',
            help: 'Number of in-flight requests currently being processed',
            labelNames: ['network'],
        });

        this.rpcCoalesced = new Counter({
            name: 'rpc_coalesced_total',
            help: 'Total number of requests served via in-flight coalescing',
            labelNames: ['network', 'method'],
        });

        this.rpcRejected = new Counter({
            name: 'rpc_rejected_total',
            help: 'Total number of requests rejected due to overload',
            labelNames: ['network'],
        });

        this.rpcLatency = new Histogram({
            name: 'rpc_latency_seconds',
            help: 'Latency of RPC requests in seconds',
            labelNames: ['network', 'method', 'source'],
            buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
        });

        this.rpcCacheHits = new Counter({
            name: 'rpc_cache_hits_total',
            help: 'Total number of cache hits',
            labelNames: ['network', 'method'],
        });

        this.rpcCacheMisses = new Counter({
            name: 'rpc_cache_misses_total',
            help: 'Total number of cache misses',
            labelNames: ['network', 'method'],
        });

        this.rpcFallback = new Counter({
            name: 'rpc_fallback_events_total',
            help: 'Total number of fallback events triggered',
            labelNames: ['network', 'method', 'reason'],
        });

        this.upstreamHttpErrors = new Counter({
            name: 'rpc_upstream_http_errors_total',
            help: 'Total number of non-200 HTTP responses from upstream RPCs',
            labelNames: ['network', 'upstream', 'status_code'],
        });
    }
}
