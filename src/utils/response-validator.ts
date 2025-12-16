import { JSONRPCRequest, JSONRPCResponse } from '@/types';
import { Logger } from '@/utils/logger';

/**
 * Response Validator - Validates response completeness and integrity
 */
export class ResponseValidator {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
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
   * Validate eth_getLogs response completeness
   */
  private validateGetLogsResponse(request: JSONRPCRequest, response: JSONRPCResponse): boolean {
    const params = Array.isArray(request.params) ? request.params : [];
    const filter = params[0] as any;

    if (!filter || typeof filter !== 'object') {
      this.logger.warn('Invalid eth_getLogs filter in request', { request });
      return false;
    }

    const result = response.result;
    if (!Array.isArray(result)) {
      this.logger.warn('eth_getLogs response result is not an array', { request });
      return false;
    }

    // Optimized: Single pass validation with early exit
    const expectedAddress = filter.address ? filter.address.toLowerCase() : null;
    const topics = filter.topics && Array.isArray(filter.topics) ? filter.topics : null;
    const fromBlock = filter.fromBlock;
    const toBlock = filter.toBlock;
    
    // Pre-compute block numbers if needed
    let fromBlockNum: number | null = null;
    let toBlockNum: number | null = null;
    if (fromBlock && toBlock && fromBlock !== 'latest' && toBlock !== 'latest' && fromBlock !== 'pending' && toBlock !== 'pending') {
      fromBlockNum = this.parseBlockNumber(fromBlock);
      toBlockNum = this.parseBlockNumber(toBlock);
    }

    // Single loop validation - much faster than multiple .every() calls
    for (let i = 0; i < result.length; i++) {
      const log = result[i];
      if (!log) continue;

      // Validate address (early exit on mismatch)
      if (expectedAddress) {
        if (!log.address || log.address.toLowerCase() !== expectedAddress) {
          this.logger.warn('eth_getLogs response contains logs with mismatched address', {
            expectedAddress: filter.address,
            request,
          });
          return false;
        }
      }

      // Validate topics (early exit on mismatch)
      if (topics) {
        for (let j = 0; j < topics.length; j++) {
          const expectedTopic = topics[j];
          if (expectedTopic === null || expectedTopic === undefined) continue;
          
          const expectedTopicLower = typeof expectedTopic === 'string' ? expectedTopic.toLowerCase() : expectedTopic;
          if (!log.topics || !Array.isArray(log.topics) || log.topics[j]?.toLowerCase() !== expectedTopicLower) {
            this.logger.warn('eth_getLogs response contains logs with mismatched topics', {
              topicIndex: j,
              expectedTopic,
              request,
            });
            return false;
          }
        }
      }

      // Validate block range (early exit on mismatch)
      if (fromBlockNum !== null && toBlockNum !== null) {
        if (!log.blockNumber) {
          this.logger.warn('eth_getLogs response contains logs without blockNumber', { request });
          return false;
        }
        const logBlockNum = this.parseBlockNumber(log.blockNumber);
        if (logBlockNum === null || logBlockNum < fromBlockNum || logBlockNum > toBlockNum) {
          this.logger.warn('eth_getLogs response contains logs outside requested block range', {
            fromBlock,
            toBlock,
            request,
          });
          return false;
        }
      }
    }

    // Check for suspicious truncation patterns (only check last log)
    if (fromBlockNum !== null && toBlockNum !== null && result.length > 0) {
      const lastLog = result[result.length - 1];
      const lastLogBlockNum = this.parseBlockNumber(lastLog.blockNumber);
      if (lastLogBlockNum !== null && lastLogBlockNum === toBlockNum) {
        this.logger.debug('eth_getLogs response ends exactly at toBlock boundary', {
          toBlock,
          logCount: result.length,
          request,
        });
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
   * Validate cached eth_getLogs response matches current request
   */
  private validateCachedGetLogsResponse(request: JSONRPCRequest, cachedResponse: JSONRPCResponse): boolean {
    const params = Array.isArray(request.params) ? request.params : [];
    const filter = params[0] as any;

    if (!filter || typeof filter !== 'object') {
      return false;
    }

    const cachedResult = cachedResponse.result;
    if (!Array.isArray(cachedResult)) {
      return false;
    }

    // Quick validation: check if address matches (if specified)
    if (filter.address) {
      const expectedAddress = filter.address.toLowerCase();
      const firstLog = cachedResult[0];
      if (firstLog && firstLog.address && firstLog.address.toLowerCase() !== expectedAddress) {
        this.logger.warn('Cached eth_getLogs response address mismatch', {
          expectedAddress: filter.address,
          cachedAddress: firstLog.address,
        });
        return false;
      }
    }

    // Check block range matches
    const fromBlock = filter.fromBlock;
    const toBlock = filter.toBlock;

    if (fromBlock && toBlock && fromBlock !== 'latest' && toBlock !== 'latest') {
      const fromBlockNum = this.parseBlockNumber(fromBlock);
      const toBlockNum = this.parseBlockNumber(toBlock);

      if (fromBlockNum !== null && toBlockNum !== null && cachedResult.length > 0) {
        const firstLogBlock = this.parseBlockNumber(cachedResult[0].blockNumber);
        const lastLogBlock = this.parseBlockNumber(cachedResult[cachedResult.length - 1].blockNumber);

        if (firstLogBlock !== null && lastLogBlock !== null) {
          // Cached logs should be within the requested range
          if (firstLogBlock < fromBlockNum || lastLogBlock > toBlockNum) {
            this.logger.warn('Cached eth_getLogs response block range mismatch', {
              requestedFrom: fromBlock,
              requestedTo: toBlock,
              cachedFrom: cachedResult[0].blockNumber,
              cachedTo: cachedResult[cachedResult.length - 1].blockNumber,
            });
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Parse block number from hex string or number
   */
  private parseBlockNumber(block: string | number | null | undefined): number | null {
    if (block === null || block === undefined) return null;
    if (typeof block === 'number') return block;
    if (typeof block !== 'string') return null;
    if (block === 'latest' || block === 'pending' || block === 'earliest') return null;

    try {
      // Remove 0x prefix if present
      const hexStr = block.startsWith('0x') ? block.slice(2) : block;
      return parseInt(hexStr, 16);
    } catch {
      return null;
    }
  }
}
