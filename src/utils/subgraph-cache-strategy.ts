import { Logger } from '@/utils/logger';
import { JSONRPCRequest } from '@/types';

export interface SubgraphCacheStrategy {
  shouldCache(request: JSONRPCRequest): boolean;
  getCacheKey(request: JSONRPCRequest): string;
  getCacheTTL(request: JSONRPCRequest): number;
  shouldInvalidate(request: JSONRPCRequest): boolean;
}

export class AdvancedSubgraphCacheStrategy implements SubgraphCacheStrategy {
  private logger: Logger;
  private blockNumberCache = new Map<string, { blockNumber: string; timestamp: number }>();
  private contractStateCache = new Map<string, { state: any; blockNumber: string }>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  shouldCache(request: JSONRPCRequest): boolean {
    switch (request.method) {
      case 'eth_blockNumber':
      case 'eth_chainId':
      case 'net_version':
        return true;
        
      case 'eth_getLogs':
        // Cache logs for immutable blocks
        const params = request.params as any[];
        const filter = params[0] || {};
        return this.isImmutableBlock(filter.toBlock);
        
      case 'eth_call':
        // Cache calls to specific blocks
        const callParams = request.params as any[];
        const callObject = callParams[0] || {};
        const blockTag = callParams[1];
        return this.isImmutableBlock(blockTag) || !!callObject.blockHash;
        
      case 'eth_getTransactionReceipt':
        // Cache receipts for confirmed transactions
        return true;
        
      default:
        return false;
    }
  }

  getCacheKey(request: JSONRPCRequest): string {
    const method = request.method;
    const params = request.params || [];
    
    switch (method) {
      case 'eth_getLogs':
        const filter = params[0] as any || {};
        return `logs:${filter.fromBlock || '0x0'}:${filter.toBlock || 'latest'}:${JSON.stringify(filter.topics || [])}`;
        
      case 'eth_call':
        const callObject = params[0] as any || {};
        const blockTag = params[1];
        return `call:${callObject.to || '0x0'}:${callObject.data || '0x'}:${blockTag}`;
        
      case 'eth_getTransactionReceipt':
        return `receipt:${params[0]}`;
        
      default:
        return `${method}:${JSON.stringify(params)}`;
    }
  }

  getCacheTTL(request: JSONRPCRequest): number {
    switch (request.method) {
      case 'eth_blockNumber':
        return 1000; // 1 second - changes frequently
        
      case 'eth_getLogs':
        const params = request.params as any[];
        const filter = params[0] || {};
        if (this.isImmutableBlock(filter.toBlock)) {
          return Number.POSITIVE_INFINITY; // Never expires
        }
        return 30000; // 30 seconds for recent blocks
        
      case 'eth_call':
        const callParams = request.params as any[];
        const blockTag = callParams[1];
        if (this.isImmutableBlock(blockTag)) {
          return Number.POSITIVE_INFINITY; // Never expires
        }
        return 10000; // 10 seconds for latest calls
        
      case 'eth_getTransactionReceipt':
        return Number.POSITIVE_INFINITY; // Never expires
        
      default:
        return 60000; // 1 minute default
    }
  }

  shouldInvalidate(request: JSONRPCRequest): boolean {
    // Invalidate cache when new blocks arrive
    if (request.method === 'eth_blockNumber') {
      const params = request.params as any[];
      const newBlockNumber = params[0];
      
      // Check if this is a significant block number change
      for (const [key, cached] of this.blockNumberCache.entries()) {
        const oldBlock = parseInt(cached.blockNumber, 16);
        const newBlock = parseInt(newBlockNumber, 16);
        
        if (newBlock > oldBlock + 10) { // More than 10 blocks behind
          this.logger.debug('Invalidating cache due to block progression', {
            oldBlock: cached.blockNumber,
            newBlock: newBlockNumber,
            key
          });
          return true;
        }
      }
    }
    
    return false;
  }

  private isImmutableBlock(blockTag: string): boolean {
    if (!blockTag) return false;
    
    // Blocks older than 12 blocks are considered immutable
    if (blockTag.startsWith('0x')) {
      return true; // Specific block number
    }
    
    return blockTag === 'earliest' || blockTag === 'finalized';
  }

  // Advanced caching for subgraph-specific patterns
  cacheBlockProgression(blockNumber: string, networkKey: string): void {
    this.blockNumberCache.set(networkKey, {
      blockNumber,
      timestamp: Date.now()
    });
  }

  cacheContractState(contractAddress: string, state: any, blockNumber: string): void {
    this.contractStateCache.set(contractAddress, {
      state,
      blockNumber
    });
  }

  getCachedContractState(contractAddress: string, blockNumber: string): any | null {
    const cached = this.contractStateCache.get(contractAddress);
    if (cached && cached.blockNumber === blockNumber) {
      return cached.state;
    }
    return null;
  }

  // Optimize cache for subgraph patterns
  optimizeForSubgraph(requests: JSONRPCRequest[]): JSONRPCRequest[] {
    const optimized: JSONRPCRequest[] = [];
    const logRequests: JSONRPCRequest[] = [];
    const callRequests: JSONRPCRequest[] = [];
    const otherRequests: JSONRPCRequest[] = [];

    // Group requests by type
    requests.forEach(req => {
      switch (req.method) {
        case 'eth_getLogs':
          logRequests.push(req);
          break;
        case 'eth_call':
          callRequests.push(req);
          break;
        default:
          otherRequests.push(req);
      }
    });

    // Optimize log requests by merging overlapping ranges
    if (logRequests.length > 0) {
      const mergedLogs = this.mergeLogRequests(logRequests);
      optimized.push(...mergedLogs);
    }

    // Optimize call requests by batching similar calls
    if (callRequests.length > 0) {
      const batchedCalls = this.batchCallRequests(callRequests);
      optimized.push(...batchedCalls);
    }

    optimized.push(...otherRequests);
    
    this.logger.debug('Optimized subgraph requests', {
      original: requests.length,
      optimized: optimized.length,
      reduction: ((requests.length - optimized.length) / requests.length * 100).toFixed(1) + '%'
    });

    return optimized;
  }

  private mergeLogRequests(requests: JSONRPCRequest[]): JSONRPCRequest[] {
    // Simple implementation - in production, this would be more sophisticated
    const merged = new Map<string, JSONRPCRequest>();
    
    requests.forEach(req => {
      const key = this.getCacheKey(req);
      if (!merged.has(key)) {
        merged.set(key, req);
      }
    });
    
    return Array.from(merged.values());
  }

  private batchCallRequests(requests: JSONRPCRequest[]): JSONRPCRequest[] {
    // Group calls by contract address
    const grouped = new Map<string, JSONRPCRequest[]>();
    
    requests.forEach(req => {
      const params = req.params as any[];
      const callObject = params[0] || {};
      const contractAddress = callObject.to || 'unknown';
      
      if (!grouped.has(contractAddress)) {
        grouped.set(contractAddress, []);
      }
      grouped.get(contractAddress)!.push(req);
    });
    
    // Return batched requests (simplified)
    return requests; // In production, would actually batch similar calls
  }
}
