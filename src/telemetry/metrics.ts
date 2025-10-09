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
	responseSizeBytes!: client.Histogram<string>;
	activeConnections!: client.Gauge<string>;
	circuitBreakerState!: client.Gauge<string>;
	queueSize!: client.Gauge<string>;
	queuePending!: client.Gauge<string>;
	
	// Compression metrics
	compressionRatio!: client.Histogram<string>;
	compressionSavings!: client.Counter<string>;
	compressionOperations!: client.Counter<string>;

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

		this.responseSizeBytes = new client.Histogram({
			name: 'rpc_response_size_bytes',
			help: 'Size of RPC responses in bytes',
			labelNames: ['method'],
			buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
		});

		this.activeConnections = new client.Gauge({
			name: 'rpc_active_connections',
			help: 'Number of active connections',
			labelNames: ['network'],
		});

		this.circuitBreakerState = new client.Gauge({
			name: 'rpc_circuit_breaker_state',
			help: 'Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
			labelNames: ['network'],
		});

		this.queueSize = new client.Gauge({
			name: 'rpc_queue_size',
			help: 'Number of requests in queue',
			labelNames: ['network'],
		});

		this.queuePending = new client.Gauge({
			name: 'rpc_queue_pending',
			help: 'Number of pending requests in queue',
			labelNames: ['network'],
		});

		// Compression metrics
		this.compressionRatio = new client.Histogram({
			name: 'rpc_compression_ratio',
			help: 'Compression ratio (compressed/original size)',
			buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
		});

		this.compressionSavings = new client.Counter({
			name: 'rpc_compression_savings_bytes',
			help: 'Total bytes saved through compression',
		});

		this.compressionOperations = new client.Counter({
			name: 'rpc_compression_operations_total',
			help: 'Total compression operations',
			labelNames: ['operation'], // 'compress', 'decompress'
		});

		this.initialized = true;
	}

	getRegister(): typeof client.register {
		return client.register;
	}
} 