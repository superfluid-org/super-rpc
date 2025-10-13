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
	private warmingStats = {
		requestsWarmed: 0,
		lastWarming: 0,
		isActive: false
	};

	constructor(config: CacheWarmingConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	start(): void {
		if (!this.config.enabled) {
			this.logger.debug('Cache warming disabled');
			return;
		}

		this.logger.info('Cache warmer initialized', {
			methods: this.config.methods,
			networks: this.config.networks
		});
	}

	stop(): void {
		this.warmingStats.isActive = false;
		this.logger.info('Cache warmer stopped');
	}

	getStats() {
		return {
			...this.warmingStats,
			config: this.config
		};
	}
}