import axios, { AxiosResponse, AxiosError } from 'axios';
import { JSONRPCRequest, JSONRPCResponse } from '@/types';
import { ProxyConfig } from '@/types/config';
import { Logger } from '@/utils/logger';
import { ConnectionPoolManager } from '@/utils/connection-pool';

/**
 * HTTP Client with Retry Logic and Exponential Backoff
 */
export class HTTPClient {
  private config: ProxyConfig;
  private logger: Logger;
  private connectionPool?: ConnectionPoolManager;

  constructor(config: ProxyConfig, logger: Logger, connectionPool?: ConnectionPoolManager) {
    this.config = config;
    this.logger = logger;
    this.connectionPool = connectionPool;
  }

  async makeRequest(
    requestBody: JSONRPCRequest,
    retries: number = this.config.rpc.retries,
    timeoutMs: number = this.config.rpc.initialTimeoutMs,
    targetUrl?: string,
    networkKey?: string
  ): Promise<AxiosResponse<JSONRPCResponse>> {
    const startTime = Date.now();
    
    // Simple sequential failover for networks with primary/fallback
    if (networkKey && this.config.rpc.networks[networkKey]) {
      const networkConfig = this.config.rpc.networks[networkKey];
      
      // Try primary first (no retries - failover immediately on failure)
      try {
        const primaryResponse = await this.tryUpstream(
          requestBody,
          networkConfig.primary.url,
          networkKey
        );
        
        // Check if primary returned valid data
        const hasValidResult = this.hasValidResult(primaryResponse.data, requestBody.method);
        
        if (hasValidResult && !primaryResponse.data.error) {
          this.logger.debug('RPC request completed', {
            method: requestBody.method,
            requestId: requestBody.id,
            networkKey,
            upstreamUsed: 'primary'
          });
          return primaryResponse;
        }
        
        // Primary returned invalid data - try fallback if available
        if (networkConfig.fallback && this.shouldTryFallback(requestBody, primaryResponse.data)) {
          this.logger.debug('Primary returned invalid data, trying fallback', {
            method: requestBody.method,
            requestId: requestBody.id,
            networkKey,
            error: primaryResponse.data?.error,
            result: primaryResponse.data?.result
          });
          
          try {
            const fallbackResponse = await this.makeRequestWithRetry(
              requestBody,
              networkConfig.fallback.url,
              networkKey,
              retries,
              timeoutMs
            );
            
            this.logger.debug('RPC request completed', {
              method: requestBody.method,
              requestId: requestBody.id,
              networkKey,
              upstreamUsed: 'fallback'
            });
            return fallbackResponse;
          } catch (fallbackError) {
            // Fallback failed, return primary response
            this.logger.debug('Fallback failed, returning primary response', {
              method: requestBody.method,
              requestId: requestBody.id,
              networkKey,
              error: (fallbackError as Error).message
            });
            return primaryResponse;
          }
        }
        
        // Not a fallback-worthy error or no fallback, return primary response
        return primaryResponse;
        
      } catch (primaryError) {
        // Primary failed - immediately try fallback (no retries on primary)
        if (networkConfig.fallback) {
          this.logger.debug('Primary failed, trying fallback immediately', {
            method: requestBody.method,
            requestId: requestBody.id,
            networkKey,
            error: (primaryError as Error).message
          });
          
          try {
            const fallbackResponse = await this.makeRequestWithRetry(
              requestBody,
              networkConfig.fallback.url,
              networkKey,
              retries,
              timeoutMs
            );
            
            this.logger.debug('RPC request completed', {
              method: requestBody.method,
              requestId: requestBody.id,
              networkKey,
              upstreamUsed: 'fallback'
            });
            return fallbackResponse;
          } catch (fallbackError) {
            // Both failed, throw the fallback error
            this.logger.debug('Both primary and fallback failed', {
              method: requestBody.method,
              requestId: requestBody.id,
              networkKey
            });
            throw this.formatError(fallbackError as AxiosError);
          }
        }
        
        // No fallback, throw primary error
        throw this.formatError(primaryError as AxiosError);
      }
    }
    
    // Fallback to single URL
    const url = targetUrl || this.config.rpc.url;
    
    // Get appropriate agent for the network
    let httpAgent, httpsAgent;
    if (this.connectionPool && networkKey) {
      const agent = this.connectionPool.getAgentForNetwork(networkKey);
      httpAgent = agent.httpAgent;
      httpsAgent = agent.httpsAgent;
    }
    
    try {
      const response = await axios.post<JSONRPCResponse>(
        url,
        requestBody,
        {
          timeout: this.config.rpc.timeout,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'RPC-Proxy/1.0.0',
          },
          httpAgent,
          httpsAgent,
          // Disable automatic JSON parsing to handle malformed responses
          transformResponse: [(data) => {
            try {
              return JSON.parse(data);
            } catch {
              return data;
            }
          }],
        }
      );

      const duration = Date.now() - startTime;
      this.logger.debug('Upstream request successful', {
        method: requestBody.method,
        requestId: requestBody.id,
        duration,
        statusCode: response.status,
      });

      return response;
    } catch (error) {
      const axiosError = error as AxiosError;
      const duration = Date.now() - startTime;
      
      this.logger.debug('Upstream request failed', {
        error: axiosError.message,
        method: requestBody.method,
        requestId: requestBody.id,
        duration,
        retriesLeft: retries,
        nextTimeoutMs: timeoutMs,
      });

      // Don't retry on certain error types
      if (this.shouldNotRetry(axiosError)) {
        throw this.formatError(axiosError);
      }

      if (retries > 0) {
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.1 * timeoutMs; // Up to 10% jitter
        const actualDelay = timeoutMs + jitter;
        
        this.logger.debug('Retrying upstream request', {
          method: requestBody.method,
          requestId: requestBody.id,
          delayMs: Math.round(actualDelay),
          retriesLeft: retries - 1,
        });

        await new Promise(resolve => setTimeout(resolve, actualDelay));
        return this.makeRequest(requestBody, retries - 1, timeoutMs * 2, url);
      }

      throw this.formatError(axiosError);
    }
  }

  private shouldNotRetry(error: AxiosError): boolean {
    // Don't retry on DNS/connection errors - these are immediate failures
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return true;
    }
    
    if (error.response?.status) {
      const status = error.response.status;
      
      if (status === 401 || status === 403) {
        return true;
      }
    
      if (status === 400) {
        return true;
      }
      
      if (status >= 400 && status < 500 && status !== 429) {
        return true;
      }
    }

    return false;
  }

  private formatError(axiosError: AxiosError): Error {
    let errorMessage = 'Unspecified upstream error';
    
    if (axiosError.response) {
      const { status, statusText, data } = axiosError.response;
      errorMessage = `HTTP ${status} ${statusText}`;
      
      if (data && typeof data === 'object') {
        try {
          errorMessage += `: ${JSON.stringify(data)}`;
        } catch {
          errorMessage += `: ${String(data)}`;
        }
      }
    } else if (axiosError.request) {
      if (axiosError.code === 'ECONNABORTED') {
        errorMessage = 'Request timeout - upstream server did not respond in time';
      } else if (axiosError.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused - upstream server is not accessible';
      } else if (axiosError.code === 'ENOTFOUND') {
        errorMessage = 'DNS resolution failed - upstream server hostname not found';
      } else {
        errorMessage = 'No response received from upstream server';
      }
    } else {
      errorMessage = axiosError.message || 'Unknown network error';
    }

    const error = new Error(errorMessage);
    error.name = 'UpstreamError';
    
    // Attach original error for debugging
    (error as any).originalError = axiosError;
    (error as any).isRetryable = !this.shouldNotRetry(axiosError);

    return error;
  }

  // Check if response has valid result data
  private hasValidResult(responseData: any, method: string): boolean {
    if (!responseData) return false;
    
    // If there's an error, result is not valid
    if (responseData.error) return false;
    
    const result = responseData.result;
    
    // null or undefined are invalid
    if (result === null || result === undefined) return false;
    
    // Empty string is invalid for most methods
    if (result === '') return false;
    
    // For eth_getLogs, empty array might be valid (no events), but we'll check separately
    if (method === 'eth_getLogs' && Array.isArray(result)) {
      return true; // Empty array is valid (means no logs)
    }
    
    // For other methods, empty array is invalid
    if (Array.isArray(result) && result.length === 0 && method !== 'eth_getLogs') {
      return false;
    }
    
    // For hex strings, "0x" alone is often invalid (except for some methods)
    if (typeof result === 'string' && result === '0x' && !['eth_call', 'eth_getCode'].includes(method)) {
      return false;
    }
    
    return true;
  }

  // Enhanced fallback logic for critical RPC methods
  private shouldTryFallback(requestBody: JSONRPCRequest, responseData: any): boolean {
    // Critical methods that need fallback
    const criticalMethods = [
      'eth_call',
      'eth_getLogs', 
      'eth_getBlockByNumber',
      'eth_getBlockByHash',
      'eth_getBlockReceipts',
      'eth_getTransactionReceipt',
      'eth_getStorageAt',
      'eth_getBalance',
      'eth_getCode',
      'eth_getTransactionByHash',
      'eth_getTransactionByBlockHashAndIndex',
      'eth_getTransactionByBlockNumberAndIndex'
    ];
    
    // Always try fallback for critical methods if primary returns invalid data
    if (!criticalMethods.includes(requestBody.method)) {
      // For non-critical methods, only try fallback if there's a clear error
      if (responseData?.error?.code && responseData.error.code < 0) {
        return true; // JSON-RPC error
      }
      return false;
    }
    
    // For critical methods, be more aggressive
    const params = Array.isArray(requestBody.params) ? requestBody.params : [];
    const isHistorical = this.isHistoricalRequest(params);
    
    // Check for JSON-RPC errors (any error code)
    if (responseData?.error) {
      const errorCode = responseData.error.code;
      // Try fallback for any JSON-RPC error on critical methods
      if (errorCode < 0) {
        return true;
      }
    }
    
    // Check for invalid/null results
    if (!this.hasValidResult(responseData, requestBody.method)) {
      return true; // Always try fallback if result is invalid
    }
    
    // For historical requests, be even more aggressive
    if (isHistorical) {
      // Try fallback for empty results on historical requests
      if (responseData?.result === null || responseData?.result === undefined) {
        return true;
      }
      
      // For eth_getLogs, try fallback if empty array on historical requests
      // (might indicate missing events due to incomplete archive)
      if (requestBody.method === 'eth_getLogs' && Array.isArray(responseData?.result) && responseData.result.length === 0) {
        return true;
      }
    }
    
    // For "latest" requests on critical methods, also try fallback if result seems invalid
    // This helps when primary is out of sync
    if (!isHistorical && ['eth_call', 'eth_getBlockByNumber', 'eth_getBlockReceipts'].includes(requestBody.method)) {
      const result = responseData?.result;
      // If result is null/undefined/empty for latest, primary might be out of sync
      if (result === null || result === undefined || result === '' || (Array.isArray(result) && result.length === 0)) {
        return true;
      }
    }
    
    return false;
  }

  private isHistoricalRequest(params: any[]): boolean {
    // Check for historical block parameters
    const historicalBlockParams = ['fromBlock', 'toBlock', 'blockNumber', 'blockHash'];
    
    for (const param of params) {
      if (typeof param === 'string') {
        // Check if it's a specific block number/hash (not "latest" or "pending")
        if (param !== 'latest' && param !== 'pending' && param.startsWith('0x')) {
          return true;
        }
      }
      
      if (typeof param === 'object' && param !== null) {
        // Check object parameters for historical blocks
        for (const key of historicalBlockParams) {
          if (param[key] && param[key] !== 'latest' && param[key] !== 'pending') {
            return true;
          }
        }
      }
    }
    
    return false;
  }

  // Simple upstream method with retry logic
  private async makeRequestWithRetry(
    requestBody: JSONRPCRequest,
    url: string,
    networkKey: string,
    retries: number,
    timeoutMs: number
  ): Promise<AxiosResponse<JSONRPCResponse>> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.tryUpstream(requestBody, url, networkKey);
        return response;
      } catch (error) {
        lastError = error as Error;
        const axiosError = error as AxiosError;
        
        // Don't retry on certain error types
        if (this.shouldNotRetry(axiosError)) {
          throw this.formatError(axiosError);
        }
        
        // If this is the last attempt, throw the error
        if (attempt === retries) {
          throw this.formatError(axiosError);
        }
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.1 * timeoutMs; // Up to 10% jitter
        const actualDelay = timeoutMs + jitter;
        
        this.logger.debug('Retrying upstream request', {
          method: requestBody.method,
          requestId: requestBody.id,
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          delayMs: Math.round(actualDelay),
          url
        });

        await new Promise(resolve => setTimeout(resolve, actualDelay));
        timeoutMs *= 2; // Exponential backoff
      }
    }
    
    throw lastError!;
  }

  // Simple upstream try method
  private async tryUpstream(
    requestBody: JSONRPCRequest,
    url: string,
    networkKey: string
  ): Promise<AxiosResponse<JSONRPCResponse>> {
    // Get appropriate agent for the network
    let httpAgent, httpsAgent;
    if (this.connectionPool) {
      const agent = this.connectionPool.getAgentForNetwork(networkKey);
      httpAgent = agent.httpAgent;
      httpsAgent = agent.httpsAgent;
    }
    
    return await axios.post<JSONRPCResponse>(
      url,
      requestBody,
      {
        timeout: this.config.rpc.timeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'RPC-Proxy/1.0.0',
        },
        httpAgent,
        httpsAgent,
        validateStatus: (status) => status < 500,
      }
    );
  }

  // Health check method for upstream connectivity
  async healthCheck(timeoutMs: number = 5000, targetUrl?: string): Promise<boolean> {
    try {
      const testRequest: JSONRPCRequest = {
        jsonrpc: '2.0',
        method: 'net_version',
        id: 'health-check',
      };

      await axios.post(targetUrl || this.config.rpc.url, testRequest, {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });

      return true;
    } catch {
      return false;
    }
  }

  getClientInfo(): { url: string; timeout: number; retries: number } {
    return {
      url: this.config.rpc.url,
      timeout: this.config.rpc.timeout,
      retries: this.config.rpc.retries,
    };
  }
}
