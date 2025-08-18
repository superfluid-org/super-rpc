import http from 'http';
import https from 'https';
import axios from 'axios';
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
		// Enable HTTP(S) keep-alive to upstreams
		const httpAgent = new http.Agent({ keepAlive: true });
		const httpsAgent = new https.Agent({ keepAlive: true });
		this.httpClient = new HTTPClient(this.config, this.logger);
		axios.defaults.httpAgent = httpAgent as any;
		axios.defaults.httpsAgent = httpsAgent as any;

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
		this.setupMiddleware();
		this.setupRoutes();

		await new Promise<void>((resolve) => {
			this.server = this.app.listen(this.config.server.port, this.config.server.host, () => {
				this.logger.info('HTTP server listening', {
					host: this.config.server.host,
					port: this.config.server.port,
				});
				resolve();
			});
		});
	}

	private getNetworkUrl(key: string): string | undefined {
		return this.networkMap[key];
	}

	async stop(): Promise<void> {
		await this.cacheManager.close();
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
			res.status(HTTP_STATUS.OK).json({
				stats: this.stats,
				cache: cacheStats,
				client: this.httpClient.getClientInfo(),
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

		// Default route uses single RPC_URL
		this.app.post(
			'/',
			validateContentType,
			validateRequestSize(),
			createRPCLogger(this.logger),
			validateJSONRPCRequest,
			validateParameters,
			(req, res) => this.handleRPCRequestWithTarget(req, res)
		);

		this.app.use(createErrorLogger(this.logger));
		this.app.use(this.errorResponder);
	}

	private async handleRPCRequestWithTarget(req: Request, res: Response, networkKey?: string, targetUrl?: string): Promise<void> {
		const body = req.body as JSONRPCRequest | JSONRPCRequest[];
		const start = Date.now();

		try {
			if (Array.isArray(body)) {
				const responses: JSONRPCResponse[] = [];
				for (const request of body) {
					responses.push(await this.processSingleRequest(req, request, start, networkKey, targetUrl));
				}
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

	private async processSingleRequest(req: Request, request: JSONRPCRequest, startTs: number, networkKey?: string, targetUrl?: string): Promise<JSONRPCResponse> {
		const keyPrefix = networkKey ? `${networkKey}:` : '';
		const cacheKey = keyPrefix + this.cacheManager.getCacheKey(request);

		await this.cacheManager.handleDuplicateRequest(cacheKey);
		const { isCacheable, maxAgeMs } = this.resolveCachePolicyForSubgraph(request);
		const inflightKey = `${keyPrefix}${request.method}:${JSON.stringify(request.params || [])}`;
		if (this.inflight.has(inflightKey)) {
			return this.inflight.get(inflightKey)!;
		}

		const promise = (async (): Promise<JSONRPCResponse> => {
			if (isCacheable) {
				const cached = await this.cacheManager.getFromCache(cacheKey, maxAgeMs, request.id);
				if (cached) {
					const duration = Date.now() - startTs;
					this.stats.httpCachedResponses++;
					this.stats.cacheHits++;
					this.stats.httpRequestsProcessed++;
					this.metrics.cachedResponsesTotal.labels(request.method).inc();
					this.metrics.cacheHitsTotal.labels(request.method).inc();
					this.metrics.requestsTotal.labels(request.method, 'HIT', 'success').inc();
					this.metrics.requestDurationMs.labels(request.method, 'HIT').observe(duration);
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

			const upstreamResponse = await this.httpClient.makeRequest(request, undefined, undefined, targetUrl);
			const duration = Date.now() - startTs;
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
				cacheable: isCacheable,
				cacheStatus: 'MISS',
			});

			const rpcData = upstreamResponse.data as JSONRPCResponse;
			if (isCacheable && rpcData && rpcData.result !== undefined) {
				await this.cacheManager.writeToCache(cacheKey, rpcData.result);
			}

			return rpcData;
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