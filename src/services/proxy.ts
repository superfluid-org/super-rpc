import http from 'http';
import fs from 'fs';
import path from 'path';
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
import { CircuitBreaker } from '@/utils/circuit-breaker';
import { ConnectionPoolManager } from '@/utils/connection-pool';
import { RequestQueueManager } from '@/utils/request-queue';
import { CacheWarmer } from '@/utils/cache-warmer';
import { SubgraphPrefetcher } from '@/utils/subgraph-prefetcher';
import { AdvancedSubgraphCacheStrategy } from '@/utils/subgraph-cache-strategy';
import { SubgraphMetrics } from '@/telemetry/subgraph-metrics';

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
	private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();
	private readonly requestQueues: RequestQueueManager;
	private readonly cacheWarmer: CacheWarmer;
	
	// Subgraph-specific optimizations
	private readonly subgraphPrefetcher: SubgraphPrefetcher;
	private readonly subgraphCacheStrategy: AdvancedSubgraphCacheStrategy;
	private readonly subgraphMetrics: SubgraphMetrics;
	
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
			maxFreeSockets: 10,
			keepAlive: true,
			keepAliveMsecs: 30000,
			timeout: 60000
		}, this.logger);

		this.requestQueues = new RequestQueueManager({
			concurrency: 20,
			interval: 1000,
			intervalCap: 100,
			timeout: 30000,
			throwOnTimeout: false
		}, this.logger);

		this.cacheWarmer = new CacheWarmer({
			enabled: process.env.ENABLE_CACHE_WARMING === 'true',
			interval: parseInt(process.env.CACHE_WARMING_INTERVAL || '300000'), // 5 minutes
			methods: ['eth_blockNumber', 'eth_chainId', 'net_version'],
			networks: Object.keys(this.networkMap)
		}, this.logger);

		// Initialize subgraph-specific optimizations
		this.subgraphPrefetcher = new SubgraphPrefetcher(this.logger);
		this.subgraphCacheStrategy = new AdvancedSubgraphCacheStrategy(this.logger);
		this.subgraphMetrics = SubgraphMetrics.getInstance();

		this.httpClient = new HTTPClient(this.config, this.logger, this.connectionPool);

		// Load network map
		const mapPath = process.env.RPC_NETWORKS_FILE
			? path.resolve(process.env.RPC_NETWORKS_FILE)
			: path.resolve(process.cwd(), 'rpc.networks.json');
		if (fs.existsSync(mapPath)) {
			try {
				const raw = fs.readFileSync(mapPath, 'utf8');
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object') {
					for (const [k, v] of Object.entries(parsed)) {
						if (typeof k === 'string' && typeof v === 'string') {
							this.networkMap[k] = v;
							// Initialize circuit breaker for each network
							this.circuitBreakers.set(k, new CircuitBreaker({
								failureThreshold: 5,
								recoveryTimeout: 60000, // 1 minute
								monitoringPeriod: 300000 // 5 minutes
							}, this.logger));
						}
					}
					this.logger.info('Loaded RPC networks map', { count: Object.keys(this.networkMap).length, mapPath });
				}
			} catch (e: any) {
				this.logger.warn('Failed to load RPC networks map', { mapPath, error: e?.message });
			}
		}
	}

	async start(): Promise<void> {
		this.metrics.init();
		this.subgraphMetrics.init();
		this.setupMiddleware();
		this.setupRoutes();

		await new Promise<void>((resolve) => {
			this.server = this.app.listen(this.config.server.port, this.config.server.host, () => {
				this.logger.info('HTTP server listening', {
					host: this.config.server.host,
					port: this.config.server.port,
				});
				
				// Start cache warmer
				this.cacheWarmer.start();
				
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
		this.cacheWarmer.stop();
		
		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server!.close((err) => (err ? reject(err) : resolve()));
			});
		}
	}

	private setupMiddleware(): void {
		if (this.config.security.enableHelmet) {
			this.app.use(helmet());
		}
		if (this.config.security.enableCors) {
			this.app.use(cors({ origin: this.config.security.allowedOrigins.length > 0 ? this.config.security.allowedOrigins : undefined }));
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
			const circuitBreakerStats = Array.from(this.circuitBreakers.entries()).map(([network, cb]) => ({
				network,
				...cb.getStats()
			}));
			
			res.status(HTTP_STATUS.OK).json({
				stats: this.stats,
				cache: cacheStats,
				client: this.httpClient.getClientInfo(),
				optimizations: {
					connectionPools: connectionStats,
					requestQueues: queueStats,
					circuitBreakers: circuitBreakerStats,
					cacheWarmer: this.cacheWarmer.getStats()
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
				await this.handleRPCRequestWithTarget(req, res, network, targetUrl);
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
						error: 'No RPC URL configured. Please set RPC_URL environment variable or configure networks in rpc.networks.json' 
					});
					return;
				}
				this.handleRPCRequestWithTarget(req, res, 'default', defaultUrl);
			}
		);

		this.app.use(createErrorLogger(this.logger));
		this.app.use(this.errorResponder);
	}

	private async handleRPCRequestWithTarget(req: Request, res: Response, networkKey?: string, targetUrl?: string): Promise<void> {
		const body = req.body as JSONRPCRequest | JSONRPCRequest[];
		const start = Date.now();

		try {
			if (Array.isArray(body)) {
				// Process batch requests in parallel with concurrency limit
				const responses = await this.processBatchRequests(req, body, start, networkKey, targetUrl);
				res.status(HTTP_STATUS.OK).json(responses);
				return;
			}

			const response = await this.processSingleRequest(req, body, start, networkKey, targetUrl);
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
		networkKey?: string, 
		targetUrl?: string
	): Promise<JSONRPCResponse[]> {
		// Apply subgraph-specific optimizations
		const optimizedRequests = this.subgraphCacheStrategy.optimizeForSubgraph(requests);
		
		// Analyze request patterns for prefetching
		optimizedRequests.forEach(request => {
			this.subgraphPrefetcher.analyzeRequest(request, networkKey || 'default');
		});
		
		const concurrencyLimit = parseInt(process.env.BATCH_CONCURRENCY_LIMIT || '10');
		const responses: JSONRPCResponse[] = [];
		
		// Process requests in chunks to limit concurrency
		for (let i = 0; i < optimizedRequests.length; i += concurrencyLimit) {
			const chunk = optimizedRequests.slice(i, i + concurrencyLimit);
			const chunkPromises = chunk.map(request => 
				this.processSingleRequest(req, request, startTs, networkKey, targetUrl)
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
			this.subgraphMetrics.recordDuplicateReduction(
				networkKey || 'default', 
				'batch', 
				requests.length - optimizedRequests.length
			);
		}
		
		return responses;
	}

	private async processSingleRequest(req: Request, request: JSONRPCRequest, startTs: number, networkKey?: string, targetUrl?: string): Promise<JSONRPCResponse> {
		const keyPrefix = networkKey ? `${networkKey}:` : '';
		const cacheKey = keyPrefix + this.cacheManager.getCacheKey(request);

		const { isCacheable, maxAgeMs } = this.resolveCachePolicyForSubgraph(request);
		
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
					// Use debug level for cache hits to reduce overhead
					this.logger.debug('RPC served from cache', {
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
				// Use circuit breaker for upstream requests
				const circuitBreaker = networkKey ? this.circuitBreakers.get(networkKey) : undefined;
				
				const executeRequest = async (): Promise<JSONRPCResponse> => {

					// Get connection pool for this network
					// const agent = this.connectionPool.getAgentForNetwork(queueKey);
					
					// Make upstream request with optimized connection
					const upstreamResponse = await this.httpClient.makeRequest(request, undefined, undefined, targetUrl, networkKey);
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

					this.logger.info('RPC forwarded to upstream', {
						requestId: (req as any).requestId,
						network: networkKey || 'default',
						method: request.method,
						id: request.id,
						statusCode: upstreamResponse.status,
						duration,
						responseSize,
						cacheable: isCacheable,
						cacheStatus: 'MISS',
					});

					const rpcData = upstreamResponse.data as JSONRPCResponse;
					if (isCacheable && rpcData && rpcData.result !== undefined) {
						await this.cacheManager.writeToCache(cacheKey, rpcData.result);
					}

					return rpcData;
				};

				if (circuitBreaker) {
					return circuitBreaker.execute(executeRequest, `${networkKey}:${request.method}`);
				} else {
					return executeRequest();
				}
			});
		})();

		const wrapped = promise.finally(() => {
			this.inflight.delete(inflightKey);
			this.stats.httpRequestsProcessed++;
		});

		this.inflight.set(inflightKey, wrapped);
		return wrapped;
	}

	private resolveCachePolicyForSubgraph(request: JSONRPCRequest): { isCacheable: boolean; maxAgeMs: number } {
		if (CACHEABLE_METHODS.INFINITELY_CACHEABLE.includes(request.method as any)) {
			return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY };
		}
		if (CACHEABLE_METHODS.TIME_CACHEABLE.includes(request.method as any)) {
			return { isCacheable: true, maxAgeMs: this.config.cache.maxAge * 1000 };
		}
		if (request.method === 'eth_getLogs') {
			return { isCacheable: true, maxAgeMs: this.config.cache.maxAge * 1000 };
		}
		if (request.method === 'eth_call') {
			const params = Array.isArray(request.params) ? request.params : [];
			const callObject = params.find((p) => typeof p === 'object' && p !== null) as Record<string, unknown> | undefined;
			const hasBlockHash = !!callObject && Object.prototype.hasOwnProperty.call(callObject, 'blockHash');
			const hasBlockNumber = !!params[1] && typeof params[1] === 'string' && params[1].startsWith('0x');
			if (hasBlockHash || hasBlockNumber) {
				return { isCacheable: true, maxAgeMs: Number.POSITIVE_INFINITY };
			}
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