import { JSONRPCRequest } from '@/types';

export interface SubgraphCacheStrategy {
  shouldCache(request: JSONRPCRequest): boolean;
  getCacheKey(request: JSONRPCRequest): string;
  getCacheTTL(request: JSONRPCRequest): number;
}

export class SimpleSubgraphCacheStrategy implements SubgraphCacheStrategy {
  shouldCache(request: JSONRPCRequest): boolean {
    const cacheableMethods = [
      'eth_blockNumber',
      'eth_chainId', 
      'net_version',
      'eth_getTransactionReceipt',
      'eth_getTransactionByHash'
    ];
    
    return cacheableMethods.includes(request.method);
  }

  getCacheKey(request: JSONRPCRequest): string {
    return `${request.method}:${JSON.stringify(request.params)}`;
  }

  getCacheTTL(): number {
    // 5 minutes for most methods
    return 5 * 60 * 1000;
  }

  optimizeForSubgraph(requests: JSONRPCRequest[]): JSONRPCRequest[] {
    // Simple optimization - just return the requests as-is
    return requests;
  }
}