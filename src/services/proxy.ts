import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ConfigManager } from '@/config';
import { Logger } from '@/utils/logger';
import { CacheManager } from '@/cache';
import { HTTPClient } from '@/client';
import { JSONRPCRequest, JSONRPCResponse, ProxyStats, HealthCheckResponse } from '@/types';
import { CACHEABLE_METHODS, HTTP_STATUS, JSONRPC_ERRORS } from '@/config/constants';
import { createRequestLogger, createRPCLogger, createErrorLogger, createPerformanceLogger } from '@/middleware/logging';
import { validateContentType, validateJSONRPCRequest, validateParameters, validateRequestSize } from '@/middleware/validation';
import { PrometheusMetrics } from '@/telemetry/metrics';
import { ConnectionPoolManager } from '@/utils/connection-pool';
import { RequestQueueManager } from '@/utils/request-queue';
import { SimpleRequestOptimizer } from '@/utils/request-optimizer';
import { AdvancedMetrics } from '@/telemetry/advanced-metrics';

export class RPCProxy {
	private readonly app = express();
	private server?: http.Server;
	private readonly config = ConfigManager.getInstance().getConfig();
	private readonly logger = Logger.getInstance(this.config);
	private readonly cacheManager = new CacheManager(this.config, this.logger);
	private readonly httpClient: HTTPClient;
	private readonly metrics = PrometheusMetrics.getInstance();
	private readonly startedAt = Date.now();
	private readonly inflight: Map<string, Promise<JSONRPCResponse>> = new Map();
	private readonly networkMap: Record<string, string> = {};
	
	// New optimization components
	private readonly connectionPool: ConnectionPoolManager;
	private readonly requestQueues: RequestQueueManager;
	
	// Request optimization components
	private readonly requestOptimizer: SimpleRequestOptimizer;
	private readonly advancedMetrics: AdvancedMetrics;
	
	private stats: ProxyStats = {
		httpRequestsProcessed: 0,
		httpUpstreamResponses: 0,
		httpCachedResponses: 0,
		websocketConnections: 0,
		cacheHits: 0,
		cacheMisses: 0,
		uptime: 0,
	};

	constructor() {
		// Initialize optimization components
		this.connectionPool = new ConnectionPoolManager({
			maxSockets: 50,
			keepAlive: true
		});

		this.requestQueues = new RequestQueueManager({
			concurrency: 20,
			timeout: 30000
		});

		// Initialize request optimization components
		this.requestOptimizer = new SimpleRequestOptimizer();
		this.advancedMetrics = AdvancedMetrics.getInstance();

		this.httpClient = new HTTPClient(this.config, this.logger, this.connectionPool);

		// Load network map from config
		this.loadNetworkMap();
	}

	private loadNetworkMap(): void {
		// Load networks from config (YAML or environment variables)
		const networks = this.config.rpc.networks;
		
		this.logger.debug('Loading networks from config', { 
			networks: networks,
			type: typeof networks,
			keys: networks ? Object.keys(networks) : []
		});
		
		if (networks && typeof networks === 'object') {
			for (const [key, config] of Object.entries(networks)) {
				if (typeof config === 'object' && config !== null && 'primary' in config) {
					this.networkMap[key] = config.primary.url;
				} else if (typeof config === 'string') {
					this.networkMap[key] = config;
				}
			}
			this.logger.info('Loaded RPC networks from config', { 
				count: Object.keys(this.networkMap).length,
				networks: Object.keys(this.networkMap)
			});
		}
	}

	async start(): Promise<void> {
		this.metrics.init();
		this.advancedMetrics.init();
		this.setupMiddleware();
		this.setupRoutes();

		await new Promise<void>((resolve) => {
			this.server = this.app.listen(this.config.server.port, this.config.server.host, () => {
				this.logger.info('HTTP server listening', {
					host: this.config.server.host,
					port: this.config.server.port,
				});
				
				// Start cache warmer
				// Circuit breakers removed
				
				resolve();
			});
		});
	}

	private getNetworkUrl(key: string): string | undefined {
		return this.networkMap[key];
	}

	private generateInflightKey(keyPrefix: string, request: JSONRPCRequest): string {
		const method = request.method;
		const params = request.params || [];
		
		// Fast path for common methods
		if (params.length === 0) {
			return `${keyPrefix}${method}`;
		}
		
		if (params.length === 1) {
			return `${keyPrefix}${method}:${params[0]}`;
		}
		
		// Fallback to JSON for complex cases
		return `${keyPrefix}${method}:${JSON.stringify(params)}`;
	}

	async stop(): Promise<void> {
		await this.cacheManager.close();
		this.connectionPool.destroy();
		this.requestQueues.destroy();
		// Cache warmer removed
		
		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server!.close((err) => (err ? reject(err) : resolve()));
			});
		}
	}

	private setupMiddleware(): void {
		if (this.config.helmet.enabled) {
			this.app.use(helmet({ contentSecurityPolicy: this.config.helmet.contentSecurityPolicy }));
		}
		if (this.config.cors.enabled) {
			this.app.use(cors({ origin: this.config.cors.origin, credentials: this.config.cors.credentials }));
		}
		
		// Compression will be added when dependency is available
		
		this.app.use(express.json({ limit: '2mb' }));
		this.app.use(createRequestLogger(this.logger));
		this.app.use(createPerformanceLogger(this.logger));
	}

	private setupRoutes(): void {
		this.app.get('/health', async (_req: Request, res: Response) => {
			const upstream = await this.httpClient.healthCheck();
			const body: HealthCheckResponse = {
				status: upstream ? 'healthy' : 'degraded',
				timestamp: new Date().toISOString(),
				uptime: Math.floor(process.uptime()),
				memory: process.memoryUsage(),
				version: process.env.npm_package_version || '1.0.0',
				upstream: upstream ? 'connected' : 'disconnected',
			};
			res.status(HTTP_STATUS.OK).json(body);
		});

		this.app.get('/metrics', async (_req: Request, res: Response) => {
			res.setHeader('Content-Type', this.metrics.getRegister().contentType);
			res.end(await this.metrics.getRegister().metrics());
		});

		this.app.get('/stats', async (_req: Request, res: Response) => {
			this.stats.uptime = Math.floor((Date.now() - this.startedAt) / 1000);
			const cacheStats = await this.cacheManager.getStats();
			const connectionStats = this.connectionPool.getStats();
			const queueStats = this.requestQueues.getQueueStats();
			res.status(HTTP_STATUS.OK).json({
				stats: this.stats,
				cache: cacheStats,
				client: this.httpClient.getClientInfo(),
				optimizations: {
					connectionPools: connectionStats,
					requestQueues: queueStats
				}
			});
		});

		this.app.get('/cache/stats', async (_req: Request, res: Response) => {
			const cacheStats = await this.cacheManager.getStats();
			res.status(HTTP_STATUS.OK).json(cacheStats);
		});

		this.app.post('/cache/clear', async (_req: Request, res: Response) => {
			await this.cacheManager.clearCache();
			res.status(HTTP_STATUS.OK).json({ cleared: true });
		});

		// Multi-network JSON-RPC route
		this.app.post(
			'/:network',
			validateContentType,
			validateRequestSize(),
			createRPCLogger(this.logger),
			validateJSONRPCRequest,
			validateParameters,
			async (req: Request, res: Response) => {
				const network = req.params.network;
				const targetUrl = this.getNetworkUrl(network);
				if (!targetUrl) {
					res.status(HTTP_STATUS.NOT_FOUND).json({ error: `Unknown network '${network}'` });
					return;
				}
				await this.handleRPCRequestWithTarget(req, res, network);
			}
		);

		// Default route uses single RPC_URL or first available network
		this.app.post(
			'/',
			validateContentType,
			validateRequestSize(),
			createRPCLogger(this.logger),
			validateJSONRPCRequest,
			validateParameters,
			(req, res) => {
				// Use RPC_URL if available, otherwise use first network as default
				const defaultUrl = this.config.rpc.url || Object.values(this.networkMap)[0];
				if (!defaultUrl) {
					res.status(HTTP_STATUS.BAD_REQUEST).json({ 
						error: 'No RPC URL configured. Please set RPC_URL environment variable or configure networks in config.yaml' 
					});
					return;
				}
				this.handleRPCRequestWithTarget(req, res, 'default');
			}
		);

		this.app.use(createErrorLogger(this.logger));
		this.app.use(this.errorResponder);
	}

	private async handleRPCRequestWithTarget(req: Request, res: Response, networkKey?: string): Promise<void> {
		const body = req.body as JSONRPCRequest | JSONRPCRequest[];
		const start = Date.now();

		try {
			if (Array.isArray(body)) {
				// Process batch requests in parallel with concurrency limit
				const responses = await this.processBatchRequests(req, body, start, networkKey);
				res.status(HTTP_STATUS.OK).json(responses);
				return;
			}

			const response = await this.processSingleRequest(req, body, start, networkKey);
			res.status(HTTP_STATUS.OK).json(response);
		} catch (err: any) {
			const id = Array.isArray(body) ? null : (body as JSONRPCRequest).id ?? null;
			const errorResponse: JSONRPCResponse = {
				jsonrpc: '2.0',
				id,
				error: {
					code: -32000,
					message: 'Upstream error',
					data: err?.message || 'Unknown error',
				},
			};
			res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse);
		}
	}

	private async processBatchRequests(
		req: Request,
		requests: JSONRPCRequest[], 
		startTs: number, 
		networkKey?: string
	): Promise<JSONRPCResponse[]> {
		// Apply request optimizations
		const optimizedRequests = this.requestOptimizer.optimizeRequests(requests);
		
		const concurrencyLimit = parseInt(process.env.BATCH_CONCURRENCY_LIMIT || '10');
		const responses: JSONRPCResponse[] = [];
		
		// Process requests in chunks to limit concurrency
		for (let i = 0; i < optimizedRequests.length; i += concurrencyLimit) {
			const chunk = optimizedRequests.slice(i, i + concurrencyLimit);
			const chunkPromises = chunk.map((request: JSONRPCRequest) => 
				this.processSingleRequest(req, request, startTs, networkKey)
			);
			
			const chunkResults = await Promise.allSettled(chunkPromises);
			
			for (const result of chunkResults) {
				if (result.status === 'fulfilled') {
					responses.push(result.value);
				} else {
					// Handle failed requests
					const errorResponse: JSONRPCResponse = {
						jsonrpc: '2.0',
						id: null,
						error: {
							code: -32000,
							message: 'Request failed',
							data: result.reason?.message || 'Unknown error',
						},
					};
					responses.push(errorResponse);
				}
			}
		}
		
		// Record optimization metrics
		if (optimizedRequests.length !== requests.length) {
			this.advancedMetrics.recordDuplicateReduction(
				networkKey || 'default', 
				'batch', 
				requests.length - optimizedRequests.length
			);
		}
		
		return responses;
	}

	private async processSingleRequest(req: Request, request: JSONRPCRequest, startTs: number, networkKey?: string): Promise<JSONRPCResponse> {
		const keyPrefix = networkKey ? `${networkKey}:` : '';
		const cacheKey = keyPrefix + this.cacheManager.getCacheKey(request);

		const { isCacheable, maxAgeMs } = this.resolveCachePolicy(request);
		
		// Optimize inflight key generation for common methods
		const inflightKey = this.generateInflightKey(keyPrefix, request);
		
		if (this.inflight.has(inflightKey)) {
			return this.inflight.get(inflightKey)!;
		}

		const promise = (async (): Promise<JSONRPCResponse> => {
			// Check cache first - bypass queue and duplicate delay for cache hits
			if (isCacheable) {
				const cached = await this.cacheManager.getFromCache(cacheKey, maxAgeMs, request.id);
				if (cached) {
					const duration = Date.now() - startTs;
					
					// Batch stats updates for better performance
					this.stats.httpCachedResponses++;
					this.stats.cacheHits++;
					this.stats.httpRequestsProcessed++;
					
					// Batch metrics updates
					const methodLabel = request.method;
					this.metrics.cachedResponsesTotal.labels(methodLabel).inc();
					this.metrics.cacheHitsTotal.labels(methodLabel).inc();
					this.metrics.requestsTotal.labels(methodLabel, 'HIT', 'success').inc();
					this.metrics.requestDurationMs.labels(methodLabel, 'HIT').observe(duration);
					this.logger.info('RPC served from cache', {
						requestId: (req as any).requestId,
						network: networkKey || 'default',
						method: request.method,
						id: request.id,
						duration,
						cacheStatus: 'HIT',
					});
					return cached;
				}
			}

			// Only apply duplicate request delay for upstream requests
			await this.cacheManager.handleDuplicateRequest(cacheKey);

			// Use request queue for rate limiting (only for upstream requests)
			const queueKey = networkKey || 'default';
			
			return this.requestQueues.addToQueue(queueKey, async () => {
				const executeRequest = async (): Promise<JSONRPCResponse> => {

					// Get connection pool for this network
					// const agent = this.connectionPool.getAgentForNetwork(queueKey);
					
					// Make upstream request with network-specific logic
					const upstreamResponse = await this.httpClient.makeRequest(request, undefined, undefined, undefined, networkKey);
					const duration = Date.now() - startTs;
					
					// Record response size metrics
					const responseSize = JSON.stringify(upstreamResponse.data).length;
					this.metrics.responseSizeBytes.labels(request.method).observe(responseSize);
					
					this.stats.httpUpstreamResponses++;
					this.stats.cacheMisses++;
					this.metrics.upstreamResponsesTotal.labels(String(upstreamResponse.status)).inc();
					this.metrics.cacheMissesTotal.labels(request.method).inc();
					this.metrics.requestsTotal.labels(request.method, 'MISS', 'success').inc();
					this.metrics.requestDurationMs.labels(request.method, 'MISS').observe(duration);

					// Log cache miss
					this.logger.info('RPC served from upstream', {
						method: request.method,
						requestId: request.id,
						networkKey: networkKey || 'default',
						cacheStatus: 'MISS',
						duration,
						cacheable: isCacheable
					});


					const rpcData = upstreamResponse.data as JSONRPCResponse;
					// Only cache successful responses with actual results (not null, undefined, or errors)
					if (isCacheable && rpcData && rpcData.result !== undefined && rpcData.result !== null && !rpcData.error) {
						await this.cacheManager.writeToCache(cacheKey, rpcData.result);
					}

					return rpcData;
				};

				return executeRequest();
			});
		})();

		const wrapped = promise.finally(() => {
			this.inflight.delete(inflightKey);
			this.stats.httpRequestsProcessed++;
		});

		this.inflight.set(inflightKey, wrapped);
		return wrapped;
	}

	private resolveCachePolicy(request: JSONRPCRequest): { isCacheable: boolean; maxAgeMs: number } {
		if (CACHEABLE_METHODS.INFINITELY_CACHEABLE.includes(request.method as any)) {
			return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY };
		}
		if (CACHEABLE_METHODS.TIME_CACHEABLE.includes(request.method as any)) {
			return { isCacheable: true, maxAgeMs: this.config.cache.maxAge * 1000 };
		}
		if (CACHEABLE_METHODS.HISTORICAL_CACHEABLE.includes(request.method as any)) {
			// Check if it's a historical call (not "latest")
			const params = Array.isArray(request.params) ? request.params : [];
			
			// For eth_call, check the block parameter
			if (request.method === 'eth_call') {
				const blockParam = params[1];
				if (blockParam && typeof blockParam === 'string' && blockParam !== 'latest') {
					return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY }; // Historical = forever
				}
				return { isCacheable: true, maxAgeMs: 30000 }; // Latest = 30 seconds
			}
			
			// For eth_getBlockByNumber, check if it's not "latest"
			if (request.method === 'eth_getBlockByNumber') {
				const blockParam = params[0];
				if (blockParam && typeof blockParam === 'string' && blockParam !== 'latest') {
					return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY }; // Historical = forever
				}
				return { isCacheable: false, maxAgeMs: 0 }; // Latest = not cacheable
			}
			
			// For eth_getLogs, eth_getStorageAt, eth_getBalance - check for specific blocks
			if (['eth_getLogs', 'eth_getStorageAt', 'eth_getBalance'].includes(request.method)) {
				// Check if any parameter contains a specific block number (not "latest")
				const hasSpecificBlock = params.some(param => 
					typeof param === 'string' && param.startsWith('0x') && param !== 'latest'
				);
				if (hasSpecificBlock) {
					return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY }; // Historical = forever
				}
				return { isCacheable: false, maxAgeMs: 0 }; // Latest = not cacheable
			}
			
			// Default for other historical methods
			return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY };
		}
		return { isCacheable: false, maxAgeMs: 0 };
	}

	private errorResponder = (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
		const errorResponse: JSONRPCResponse = {
			jsonrpc: '2.0',
			id: null,
			error: {
				...JSONRPC_ERRORS.INTERNAL_ERROR,
				data: err.message,
			},
		};
		res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse);
	};
} 