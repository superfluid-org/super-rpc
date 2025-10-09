import { Logger } from '@/utils/logger';
import { JSONRPCRequest, JSONRPCResponse } from '@/types';

export interface StreamProcessor {
  processLargeResponse(request: JSONRPCRequest, response: JSONRPCResponse): Promise<JSONRPCResponse>;
  shouldStream(request: JSONRPCRequest): boolean;
  getChunkSize(request: JSONRPCRequest): number;
}

export class SubgraphStreamProcessor implements StreamProcessor {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  shouldStream(request: JSONRPCRequest): boolean {
    if (request.method !== 'eth_getLogs') return false;
    
    const params = request.params as any[];
    const filter = params[0] || {};
    const fromBlock = parseInt(filter.fromBlock || '0x0', 16);
    const toBlock = parseInt(filter.toBlock || '0x0', 16);
    
    // Stream if requesting more than 1000 blocks
    return (toBlock - fromBlock) > 1000;
  }

  getChunkSize(request: JSONRPCRequest): number {
    const params = request.params as any[];
    const filter = params[0] || {};
    const fromBlock = parseInt(filter.fromBlock || '0x0', 16);
    const toBlock = parseInt(filter.toBlock || '0x0', 16);
    const blockRange = toBlock - fromBlock;
    
    // Adjust chunk size based on block range
    if (blockRange > 10000) return 50;
    if (blockRange > 5000) return 100;
    if (blockRange > 1000) return 200;
    return 500;
  }

  async processLargeResponse(request: JSONRPCRequest, response: JSONRPCResponse): Promise<JSONRPCResponse> {
    if (!this.shouldStream(request)) {
      return response;
    }

    const logs = response.result as any[];
    if (!Array.isArray(logs) || logs.length === 0) {
      return response;
    }

    const chunkSize = this.getChunkSize(request);
    const chunks: any[][] = [];
    
    // Split logs into chunks
    for (let i = 0; i < logs.length; i += chunkSize) {
      chunks.push(logs.slice(i, i + chunkSize));
    }

    this.logger.info('Processing large response in chunks', {
      method: request.method,
      totalLogs: logs.length,
      chunks: chunks.length,
      chunkSize
    });

    // Process chunks with slight delays to prevent overwhelming
    const processedChunks: any[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      // Process chunk (could include filtering, transformation, etc.)
      const processedChunk = await this.processChunk(chunk);
      processedChunks.push(...processedChunk);
      
      // Small delay between chunks to prevent overwhelming downstream
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    return {
      ...response,
      result: processedChunks
    };
  }

  private async processChunk(chunk: any[]): Promise<any[]> {
    // Apply subgraph-specific optimizations to each chunk
    return chunk.map(log => this.optimizeLogForSubgraph(log));
  }

  private optimizeLogForSubgraph(log: any): any {
    // Remove unnecessary fields to reduce memory usage
    const optimized: any = {
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      blockHash: log.blockHash
    };

    // Remove undefined/null values
    Object.keys(optimized).forEach(key => {
      if (optimized[key] === undefined || optimized[key] === null) {
        delete optimized[key];
      }
    });

    return optimized;
  }

  // Memory-efficient processing for very large datasets
  async processStreamingResponse(
    request: JSONRPCRequest, 
    responseStream: AsyncIterable<any>
  ): Promise<JSONRPCResponse> {
    const results: any[] = [];
    let processedCount = 0;

    for await (const chunk of responseStream) {
      const processedChunk = await this.processChunk(chunk);
      results.push(...processedChunk);
      processedCount += chunk.length;

      // Log progress for large datasets
      if (processedCount % 1000 === 0) {
        this.logger.debug('Streaming progress', {
          processed: processedCount,
          method: request.method
        });
      }

      // Prevent memory overflow
      if (results.length > 10000) {
        this.logger.warn('Large response detected, consider implementing pagination', {
          method: request.method,
          resultCount: results.length
        });
      }
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: results
    };
  }
}
