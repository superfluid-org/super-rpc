import { JSONRPCRequest } from '@/types';
import { Logger } from './logger';

export interface CacheWarmingConfig {
	enabled: boolean;
	interval: number; // milliseconds
	methods: string[];
	networks: string[];
}

export class CacheWarmer {
	private config: CacheWarmingConfig;
	private logger: Logger;
	private warmingInterval?: NodeJS.Timeout;
	private isWarming = false;

	constructor(config: CacheWarmingConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	start(): void {
		if (!this.config.enabled) {
			this.logger.debug('Cache warming disabled');
			return;
		}

		this.logger.info('Starting cache warmer', {
			interval: this.config.interval,
			methods: this.config.methods,
			networks: this.config.networks
		});

		// Initial warmup
		this.warmCache().catch(error => {
			this.logger.error('Initial cache warmup failed', { error: error.message });
		});

		// Periodic warmup
		this.warmingInterval = setInterval(() => {
			this.warmCache().catch(error => {
				this.logger.error('Periodic cache warmup failed', { error: error.message });
			});
		}, this.config.interval);
	}

	stop(): void {
		if (this.warmingInterval) {
			clearInterval(this.warmingInterval);
			this.warmingInterval = undefined;
		}
		this.logger.info('Stopped cache warmer');
	}

	private async warmCache(): Promise<void> {
		if (this.isWarming) {
			this.logger.debug('Cache warming already in progress, skipping');
			return;
		}

		this.isWarming = true;
		const startTime = Date.now();

		try {
			const warmupPromises: Promise<void>[] = [];

			for (const networkKey of this.config.networks) {
				for (const method of this.config.methods) {
					const request: JSONRPCRequest = {
						jsonrpc: '2.0',
						method,
						id: `warmup-${networkKey}-${method}-${Date.now()}`,
						params: this.getDefaultParams(method)
					};

					warmupPromises.push(
						this.warmSingleRequest(networkKey, request).catch(error => {
							this.logger.debug('Cache warmup request failed', {
								networkKey,
								method,
								error: error.message
							});
						})
					);
				}
			}

			await Promise.allSettled(warmupPromises);
			
			const duration = Date.now() - startTime;
			this.logger.info('Cache warming completed', {
				duration,
				requests: warmupPromises.length
			});
		} finally {
			this.isWarming = false;
		}
	}

	private getDefaultParams(method: string): any[] {
		switch (method) {
			case 'eth_blockNumber':
			case 'eth_chainId':
			case 'net_version':
			case 'eth_gasPrice':
				return [];
			case 'eth_getBalance':
				return ['0x0000000000000000000000000000000000000000', 'latest'];
			case 'eth_getTransactionCount':
				return ['0x0000000000000000000000000000000000000000', 'latest'];
			case 'eth_getCode':
				return ['0x0000000000000000000000000000000000000000', 'latest'];
			default:
				return [];
		}
	}

	private async warmSingleRequest(networkKey: string, request: JSONRPCRequest): Promise<void> {
		// This would be called by the RPC proxy to actually make the request
		// For now, we'll just log the warmup attempt
		this.logger.debug('Cache warmup request', {
			networkKey,
			method: request.method,
			id: request.id
		});
	}

	isWarmingInProgress(): boolean {
		return this.isWarming;
	}

	getStats(): { enabled: boolean; isWarming: boolean; config: CacheWarmingConfig } {
		return {
			enabled: this.config.enabled,
			isWarming: this.isWarming,
			config: this.config
		};
	}
}
