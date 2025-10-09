import { Logger } from './logger';
import { JSONRPCRequest } from '@/types';

export interface BlockRange {
  fromBlock: string;
  toBlock: string;
  logs: any[];
}

export interface SubgraphOptimizer {
  mergeOverlappingRanges(requests: Array<{fromBlock: string, toBlock: string}>): BlockRange[];
  splitLargeRanges(range: BlockRange, maxSize: number): BlockRange[];
  optimizeLogQueries(requests: JSONRPCRequest[]): JSONRPCRequest[];
}

export class SubgraphBlockRangeOptimizer implements SubgraphOptimizer {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  mergeOverlappingRanges(requests: Array<{fromBlock: string, toBlock: string}>): BlockRange[] {
    if (requests.length === 0) return [];

    // Sort by fromBlock
    const sorted = requests.sort((a, b) => parseInt(a.fromBlock, 16) - parseInt(b.fromBlock, 16));
    const merged: BlockRange[] = [];
    
    let current = { ...sorted[0], logs: [] };
    
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      const currentEnd = parseInt(current.toBlock, 16);
      const nextStart = parseInt(next.fromBlock, 16);
      
      // If ranges overlap or are adjacent, merge them
      if (nextStart <= currentEnd + 1) {
        current.toBlock = parseInt(current.toBlock, 16) > parseInt(next.toBlock, 16) 
          ? current.toBlock 
          : next.toBlock;
      } else {
        // No overlap, add current and start new
        merged.push(current);
        current = { ...next, logs: [] };
      }
    }
    
    merged.push(current);
    
    this.logger.debug('Merged block ranges', {
      original: requests.length,
      merged: merged.length,
      reduction: ((requests.length - merged.length) / requests.length * 100).toFixed(1) + '%'
    });
    
    return merged;
  }

  splitLargeRanges(range: BlockRange, maxSize: number = 2000): BlockRange[] {
    const fromBlock = parseInt(range.fromBlock, 16);
    const toBlock = parseInt(range.toBlock, 16);
    const blockCount = toBlock - fromBlock + 1;
    
    if (blockCount <= maxSize) {
      return [range];
    }
    
    const ranges: BlockRange[] = [];
    let currentFrom = fromBlock;
    
    while (currentFrom <= toBlock) {
      const currentTo = Math.min(currentFrom + maxSize - 1, toBlock);
      ranges.push({
        fromBlock: '0x' + currentFrom.toString(16),
        toBlock: '0x' + currentTo.toString(16),
        logs: []
      });
      currentFrom = currentTo + 1;
    }
    
    return ranges;
  }

  optimizeLogQueries(requests: JSONRPCRequest[]): JSONRPCRequest[] {
    const logRequests = requests.filter(req => req.method === 'eth_getLogs');
    const otherRequests = requests.filter(req => req.method !== 'eth_getLogs');
    
    if (logRequests.length === 0) return requests;
    
    // Extract block ranges from log requests
    const ranges = logRequests.map(req => {
      const params = req.params as any[];
      const filter = params[0] || {};
      return {
        fromBlock: filter.fromBlock || '0x0',
        toBlock: filter.toBlock || 'latest',
        originalRequest: req
      };
    });
    
    // Merge overlapping ranges
    const mergedRanges = this.mergeOverlappingRanges(ranges);
    
    // Split large ranges
    const optimizedRanges = mergedRanges.flatMap(range => 
      this.splitLargeRanges(range, 2000) // Max 2000 blocks per request
    );
    
    // Create optimized requests
    const optimizedLogRequests = optimizedRanges.map((range, index) => ({
      jsonrpc: '2.0' as const,
      method: 'eth_getLogs' as const,
      params: [{
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        // Merge all topics from original requests
        topics: this.mergeTopics(ranges.filter(r => 
          parseInt(r.fromBlock, 16) <= parseInt(range.fromBlock, 16) &&
          parseInt(r.toBlock, 16) >= parseInt(range.toBlock, 16)
        ).map(r => (r.originalRequest.params as any[])[0]?.topics).filter(Boolean))
      }],
      id: `optimized_${index}`
    }));
    
    this.logger.info('Optimized log queries', {
      original: logRequests.length,
      optimized: optimizedLogRequests.length,
      reduction: ((logRequests.length - optimizedLogRequests.length) / logRequests.length * 100).toFixed(1) + '%'
    });
    
    return [...optimizedLogRequests, ...otherRequests];
  }

  private mergeTopics(topicArrays: any[][]): any[] {
    const allTopics = new Set<string>();
    topicArrays.forEach(topics => {
      topics?.forEach(topic => {
        if (topic) allTopics.add(topic);
      });
    });
    return Array.from(allTopics);
  }
}
