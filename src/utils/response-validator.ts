import { JSONRPCRequest, JSONRPCResponse } from '@/types';
import { Logger } from '@/utils/logger';

/**
 * Response Validator - Validates response completeness and integrity
 * Optimized for performance with minimal conditionals
 */
export class ResponseValidator {
  constructor(_logger: Logger) {
    // Logger kept for interface compatibility but not used for performance
  }

  /**
   * Validate that a response is complete and matches the request before caching
   */
  validateResponseForCache(request: JSONRPCRequest, response: JSONRPCResponse): boolean {
    if (!response || response.error) {
      return false;
    }

    if (request.method === 'eth_getLogs') {
      return this.validateGetLogsResponse(request, response);
    }

    // For other methods, basic validation is sufficient
    return response.result !== undefined && response.result !== null;
  }

  /**
   * Validate eth_getLogs response completeness - optimized: only sample validation
   */
  private validateGetLogsResponse(request: JSONRPCRequest, response: JSONRPCResponse): boolean {
    const filter = (Array.isArray(request.params) ? request.params[0] : null) as any;
    const result = response.result;

    // Fast path: basic structure checks
    if (!filter || typeof filter !== 'object' || !Array.isArray(result)) {
      return false;
    }

    // Fast path: empty result is always valid
    if (result.length === 0) {
      return true;
    }

    // Performance optimization: only validate a sample of logs (first, middle, last)
    // This is much faster than validating all logs while still catching most issues
    const resultLen = result.length;
    const indices = resultLen <= 3 
      ? [0, resultLen - 1].filter(i => i >= 0 && i < resultLen) // First and last if small
      : [0, Math.floor(resultLen / 2), resultLen - 1]; // First, middle, last if large

    const expectedAddress = filter.address?.toLowerCase();
    const topics = Array.isArray(filter.topics) ? filter.topics : null;
    const fromBlock = filter.fromBlock;
    const toBlock = filter.toBlock;
    
    // Pre-compute block numbers only if both are provided and not tags
    const needsBlockCheck = fromBlock && toBlock && 
      fromBlock !== 'latest' && toBlock !== 'latest' && 
      fromBlock !== 'pending' && toBlock !== 'pending';
    const fromBlockNum = needsBlockCheck ? this.parseBlockNumber(fromBlock) : null;
    const toBlockNum = needsBlockCheck ? this.parseBlockNumber(toBlock) : null;
    const hasBlockRange = fromBlockNum !== null && toBlockNum !== null;

    // Validate only sample logs
    for (const i of indices) {
      const log = result[i];
      if (!log) continue;

      // Address check
      if (expectedAddress && log.address?.toLowerCase() !== expectedAddress) {
        return false;
      }

      // Topics check (simplified - only check first topic if present)
      if (topics && topics[0] != null && log.topics?.[0]?.toLowerCase() !== topics[0].toLowerCase()) {
        return false;
      }

      // Block range check
      if (hasBlockRange && log.blockNumber) {
        const logBlockNum = this.parseBlockNumber(log.blockNumber);
        if (logBlockNum == null || logBlockNum < fromBlockNum! || logBlockNum > toBlockNum!) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Validate cached response matches current request (cache integrity check)
   */
  validateCachedResponse(request: JSONRPCRequest, cachedResponse: JSONRPCResponse): boolean {
    if (!cachedResponse || cachedResponse.error) {
      return false;
    }

    if (request.method === 'eth_getLogs') {
      return this.validateCachedGetLogsResponse(request, cachedResponse);
    }

    // For other methods, basic structure validation
    return cachedResponse.result !== undefined && cachedResponse.result !== null;
  }

  /**
   * Validate cached eth_getLogs response matches current request - optimized for speed
   */
  private validateCachedGetLogsResponse(request: JSONRPCRequest, cachedResponse: JSONRPCResponse): boolean {
    const filter = (Array.isArray(request.params) ? request.params[0] : null) as any;
    const cachedResult = cachedResponse.result;

    // Fast path: basic checks
    if (!filter || typeof filter !== 'object' || !Array.isArray(cachedResult) || cachedResult.length === 0) {
      return true; // Empty or invalid is acceptable for cache check
    }

    // Quick validation: only check first log for address match (if specified)
    if (filter.address) {
      const firstLog = cachedResult[0];
      if (firstLog?.address?.toLowerCase() !== filter.address.toLowerCase()) {
        return false;
      }
    }

    // Quick block range check: only validate first and last log
    const fromBlock = filter.fromBlock;
    const toBlock = filter.toBlock;
    if (fromBlock && toBlock && fromBlock !== 'latest' && toBlock !== 'latest') {
      const fromBlockNum = this.parseBlockNumber(fromBlock);
      const toBlockNum = this.parseBlockNumber(toBlock);
      
      if (fromBlockNum != null && toBlockNum != null) {
        const firstLogBlock = this.parseBlockNumber(cachedResult[0]?.blockNumber);
        const lastLogBlock = this.parseBlockNumber(cachedResult[cachedResult.length - 1]?.blockNumber);
        
        if (firstLogBlock == null || lastLogBlock == null || 
            firstLogBlock < fromBlockNum || lastLogBlock > toBlockNum) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Parse block number from hex string or number - optimized
   */
  private parseBlockNumber(block: string | number | null | undefined): number | null {
    if (block == null) return null;
    if (typeof block === 'number') return block;
    if (typeof block !== 'string') return null;
    
    // Fast path: common block tags
    if (block === 'latest' || block === 'pending' || block === 'earliest') return null;

    // Optimized hex parsing
    const hexStr = block.startsWith('0x') ? block.slice(2) : block;
    const parsed = parseInt(hexStr, 16);
    return isNaN(parsed) ? null : parsed;
  }
}
