import { Logger } from '@/utils/logger';
import { JSONRPCRequest } from '@/types';

export interface PrefetchPattern {
  method: string;
  frequency: number; // requests per minute
  lastSeen: number;
}

export class SubgraphPrefetcher {
  private patterns = new Map<string, PrefetchPattern>();

  constructor(_logger: Logger) {
    // Logger available for future use
  }

  analyzeRequest(request: JSONRPCRequest, networkKey: string): void {
    const key = `${networkKey}:${request.method}`;
    const now = Date.now();
    
    const existing = this.patterns.get(key);
    if (existing) {
      existing.frequency = Math.min(existing.frequency + 1, 60); // Cap at 60/min
      existing.lastSeen = now;
    } else {
      this.patterns.set(key, {
        method: request.method,
        frequency: 1,
        lastSeen: now
      });
    }
  }

  getStats(): { patterns: number; topMethods: string[] } {
    const topMethods = Array.from(this.patterns.entries())
      .sort(([,a], [,b]) => b.frequency - a.frequency)
      .slice(0, 5)
      .map(([key]) => key);

    return {
      patterns: this.patterns.size,
      topMethods
    };
  }
}