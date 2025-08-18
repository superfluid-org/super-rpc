import client from 'prom-client';

export class PrometheusMetrics {
	private static instance: PrometheusMetrics | undefined;
	private initialized = false;

	// Instruments
	requestsTotal!: client.Counter<string>;
	upstreamResponsesTotal!: client.Counter<string>;
	cachedResponsesTotal!: client.Counter<string>;
	cacheHitsTotal!: client.Counter<string>;
	cacheMissesTotal!: client.Counter<string>;
	requestDurationMs!: client.Histogram<string>;

	static getInstance(): PrometheusMetrics {
		if (!this.instance) {
			this.instance = new PrometheusMetrics();
		}
		return this.instance;
	}

	init(): void {
		if (this.initialized) return;

		// Default process metrics
		client.collectDefaultMetrics({
			prefix: 'rpc_',
		});

		this.requestsTotal = new client.Counter({
			name: 'rpc_http_requests_total',
			help: 'Total HTTP JSON-RPC requests processed',
			labelNames: ['method', 'cache_status', 'outcome'],
		});

		this.upstreamResponsesTotal = new client.Counter({
			name: 'rpc_http_upstream_responses_total',
			help: 'Total upstream responses received',
			labelNames: ['status_code'],
		});

		this.cachedResponsesTotal = new client.Counter({
			name: 'rpc_http_cached_responses_total',
			help: 'Total cached responses served',
			labelNames: ['method'],
		});

		this.cacheHitsTotal = new client.Counter({
			name: 'rpc_cache_hits_total',
			help: 'Total cache hits',
			labelNames: ['method'],
		});

		this.cacheMissesTotal = new client.Counter({
			name: 'rpc_cache_misses_total',
			help: 'Total cache misses',
			labelNames: ['method'],
		});

		this.requestDurationMs = new client.Histogram({
			name: 'rpc_request_duration_ms',
			help: 'Duration of handling a JSON-RPC request in milliseconds',
			labelNames: ['method', 'cache_status'],
			buckets: [5, 10, 20, 50, 100, 250, 500, 1000, 2500, 5000],
		});

		this.initialized = true;
	}

	getRegister(): typeof client.register {
		return client.register;
	}
} 