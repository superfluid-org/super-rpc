import { Logger } from '@/utils/logger';
import { JSONRPCRequest } from '@/types';

export interface PrefetchPattern {
  method: string;
  frequency: number; // requests per minute
  lastSeen: number;
  nextExpected: number;
}

export class SubgraphPrefetcher {
  private patterns = new Map<string, PrefetchPattern>();
  private logger: Logger;
  private prefetchQueue: JSONRPCRequest[] = [];

  constructor(logger: Logger) {
    this.logger = logger;
    this.startPrefetchScheduler();
  }

  analyzeRequest(request: JSONRPCRequest, networkKey: string): void {
    const key = `${networkKey}:${request.method}`;
    const now = Date.now();
    
    if (this.patterns.has(key)) {
      const pattern = this.patterns.get(key)!;
      const timeSinceLastSeen = now - pattern.lastSeen;
      
      // Update frequency (exponential moving average)
      const alpha = 0.1;
      pattern.frequency = alpha * (60000 / timeSinceLastSeen) + (1 - alpha) * pattern.frequency;
      pattern.lastSeen = now;
      pattern.nextExpected = now + (60000 / pattern.frequency);
    } else {
      this.patterns.set(key, {
        method: request.method,
        frequency: 1,
        lastSeen: now,
        nextExpected: now + 60000
      });
    }
  }

  private startPrefetchScheduler(): void {
    setInterval(() => {
      this.schedulePrefetch();
    }, 10000); // Check every 10 seconds
  }

  private schedulePrefetch(): void {
    const now = Date.now();
    const upcomingRequests: JSONRPCRequest[] = [];

    for (const [, pattern] of this.patterns.entries()) {
      if (pattern.frequency > 2 && now >= pattern.nextExpected - 5000) { // 5 seconds before expected
        // Generate prefetch request based on pattern
        const prefetchRequest = this.generatePrefetchRequest(pattern.method);
        if (prefetchRequest) {
          upcomingRequests.push(prefetchRequest);
        }
        
        // Update next expected time
        pattern.nextExpected = now + (60000 / pattern.frequency);
      }
    }

    if (upcomingRequests.length > 0) {
      this.prefetchQueue.push(...upcomingRequests);
      this.logger.debug('Scheduled prefetch requests', { count: upcomingRequests.length });
    }
  }

  private generatePrefetchRequest(method: string): JSONRPCRequest | null {
    const now = Date.now();
    
    switch (method) {
      case 'eth_blockNumber':
        return {
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: `prefetch_${now}`
        };
        
      case 'eth_getLogs':
        // Prefetch recent logs (last 100 blocks)
        return {
          jsonrpc: '2.0',
          method: 'eth_getLogs',
          params: [{
            fromBlock: 'latest',
            toBlock: 'latest'
          }],
          id: `prefetch_${now}`
        };
        
      case 'eth_call':
        // Prefetch common contract calls
        return {
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{
            to: '0x0000000000000000000000000000000000000000',
            data: '0x'
          }, 'latest'],
          id: `prefetch_${now}`
        };
        
      default:
        return null;
    }
  }

  getPrefetchRequests(): JSONRPCRequest[] {
    const requests = [...this.prefetchQueue];
    this.prefetchQueue = [];
    return requests;
  }

  getPatterns(): Map<string, PrefetchPattern> {
    return new Map(this.patterns);
  }
}
