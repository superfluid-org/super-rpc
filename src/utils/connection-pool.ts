import http from 'http';
import https from 'https';
import { Logger } from './logger';

export interface ConnectionPoolConfig {
	maxSockets: number;
	maxFreeSockets: number;
	keepAlive: boolean;
	keepAliveMsecs: number;
	timeout: number;
}

export interface NetworkAgent {
	httpAgent: http.Agent;
	httpsAgent: https.Agent;
	networkKey: string;
	lastUsed: number;
}

export class ConnectionPoolManager {
	private pools: Map<string, NetworkAgent> = new Map();
	private config: ConnectionPoolConfig;
	private logger: Logger;
	private cleanupInterval?: NodeJS.Timeout;

	constructor(config: ConnectionPoolConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
		this.startCleanup();
	}

	private createAgent(networkKey: string): NetworkAgent {
		const httpAgent = new http.Agent({
			keepAlive: this.config.keepAlive,
			maxSockets: this.config.maxSockets,
			maxFreeSockets: this.config.maxFreeSockets,
			keepAliveMsecs: this.config.keepAliveMsecs,
			timeout: this.config.timeout,
		});

		const httpsAgent = new https.Agent({
			keepAlive: this.config.keepAlive,
			maxSockets: this.config.maxSockets,
			maxFreeSockets: this.config.maxFreeSockets,
			keepAliveMsecs: this.config.keepAliveMsecs,
			timeout: this.config.timeout,
		});

		return {
			httpAgent,
			httpsAgent,
			networkKey,
			lastUsed: Date.now()
		};
	}

	getAgentForNetwork(networkKey: string): NetworkAgent {
		if (!this.pools.has(networkKey)) {
			const agent = this.createAgent(networkKey);
			this.pools.set(networkKey, agent);
			this.logger.debug('Created new connection pool', { 
				networkKey, 
				maxSockets: this.config.maxSockets,
				maxFreeSockets: this.config.maxFreeSockets
			});
		}

		const agent = this.pools.get(networkKey)!;
		agent.lastUsed = Date.now();
		return agent;
	}

	private startCleanup(): void {
		// Clean up unused pools every 5 minutes
		this.cleanupInterval = setInterval(() => {
			this.cleanupUnusedPools();
		}, 5 * 60 * 1000);
	}

	private cleanupUnusedPools(): void {
		const now = Date.now();
		const unusedThreshold = 10 * 60 * 1000; // 10 minutes

		for (const [networkKey, agent] of this.pools.entries()) {
			if (now - agent.lastUsed > unusedThreshold) {
				// Destroy the agents
				agent.httpAgent.destroy();
				agent.httpsAgent.destroy();
				this.pools.delete(networkKey);
				
				this.logger.debug('Cleaned up unused connection pool', { 
					networkKey,
					unusedFor: now - agent.lastUsed
				});
			}
		}
	}

	getStats(): { totalPools: number; pools: Array<{ networkKey: string; lastUsed: number; sockets: number; freeSockets: number }> } {
		const pools = Array.from(this.pools.entries()).map(([networkKey, agent]) => ({
			networkKey,
			lastUsed: agent.lastUsed,
			sockets: agent.httpAgent.sockets ? Object.keys(agent.httpAgent.sockets).length : 0,
			freeSockets: agent.httpAgent.freeSockets ? Object.keys(agent.httpAgent.freeSockets).length : 0
		}));

		return {
			totalPools: this.pools.size,
			pools
		};
	}

	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		for (const agent of this.pools.values()) {
			agent.httpAgent.destroy();
			agent.httpsAgent.destroy();
		}
		this.pools.clear();
		this.logger.info('Destroyed all connection pools');
	}
}
