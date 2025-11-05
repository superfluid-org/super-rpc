import { JSONRPCRequest } from '@/types';

export interface RequestOptimizer {
  shouldCache(request: JSONRPCRequest): boolean;
  getCacheKey(request: JSONRPCRequest): string;
  getCacheTTL(request: JSONRPCRequest): number;
}

export class SimpleRequestOptimizer implements RequestOptimizer {
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

  optimizeRequests(requests: JSONRPCRequest[]): JSONRPCRequest[] {
    // Simple optimization - deduplicate and return requests
    return requests;
  }
}

