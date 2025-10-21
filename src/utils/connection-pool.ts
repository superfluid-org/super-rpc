import http from 'http';
import https from 'https';

export interface ConnectionPoolConfig {
  maxSockets: number;
  keepAlive: boolean;
}

export interface NetworkAgent {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

export class ConnectionPoolManager {
  private pools: Map<string, NetworkAgent> = new Map();
  private config: ConnectionPoolConfig;

  constructor(config: ConnectionPoolConfig) {
    this.config = config;
  }

  getAgentForNetwork(networkKey: string): NetworkAgent {
    if (!this.pools.has(networkKey)) {
      const httpAgent = new http.Agent({
        maxSockets: this.config.maxSockets,
        keepAlive: this.config.keepAlive,
      });

      const httpsAgent = new https.Agent({
        maxSockets: this.config.maxSockets,
        keepAlive: this.config.keepAlive,
      });

      this.pools.set(networkKey, { httpAgent, httpsAgent });
    }

    return this.pools.get(networkKey)!;
  }

  getStats() {
    return {
      totalPools: this.pools.size,
      networks: Array.from(this.pools.keys())
    };
  }

  destroy() {
    for (const agent of this.pools.values()) {
      agent.httpAgent.destroy();
      agent.httpsAgent.destroy();
    }
    this.pools.clear();
  }
}