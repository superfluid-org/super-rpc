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
  
  // Upstream health tracking
  private upstreamHealth = new Map<string, {
    isHealthy: boolean;
    lastFailure: number;
    consecutiveFailures: number;
    lastSuccess: number;
  }>();

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
    
    // Enhanced fallback logic for networks with retry integration
    if (networkKey && this.config.rpc.networks[networkKey]) {
      const networkConfig = this.config.rpc.networks[networkKey];
      
      // Try primary first with retry logic
      let response: AxiosResponse<JSONRPCResponse>;
      let upstreamUsed = 'primary';
      
      try {
        // Check if primary is healthy before attempting
        if (!this.isUpstreamHealthy(networkConfig.primary.url) && networkConfig.fallback) {
          this.logger.debug('Primary upstream is unhealthy, using fallback directly', {
            method: requestBody.method,
            requestId: requestBody.id,
            networkKey,
            primaryUrl: networkConfig.primary.url
          });
          
          response = await this.makeRequestWithRetry(
            requestBody, 
            networkConfig.fallback.url, 
            networkKey, 
            retries, 
            timeoutMs
          );
          upstreamUsed = 'fallback';
        } else {
          response = await this.makeRequestWithRetry(
            requestBody, 
            networkConfig.primary.url, 
            networkKey, 
            retries, 
            timeoutMs
          );
          
          // Smart fallback logic for subgraph syncing
          const shouldTryFallback = this.shouldTryFallback(requestBody, response.data);
          
          if (shouldTryFallback && networkConfig.fallback && this.isUpstreamHealthy(networkConfig.fallback.url)) {
            this.logger.debug('Primary returned historical data error, trying fallback', {
              method: requestBody.method,
              requestId: requestBody.id,
              networkKey,
              error: response.data?.error
            });
            
            try {
              response = await this.makeRequestWithRetry(
                requestBody, 
                networkConfig.fallback.url, 
                networkKey, 
                retries, 
                timeoutMs
              );
              if (response.data && response.data.result !== null) {
                upstreamUsed = 'fallback';
              }
            } catch (fallbackError) {
              this.logger.debug('Fallback upstream failed', {
                method: requestBody.method,
                requestId: requestBody.id,
                networkKey,
                fallbackUrl: networkConfig.fallback.url,
                error: (fallbackError as Error).message
              });
              // If fallback also fails, return the primary response (which had the error)
              // This ensures we don't lose the original error context
              response = await this.tryUpstream(requestBody, networkConfig.primary.url, networkKey);
            }
          }
        }
      } catch (primaryError) {
        this.logger.debug('Primary upstream failed', {
          method: requestBody.method,
          requestId: requestBody.id,
          networkKey,
          primaryUrl: networkConfig.primary.url,
          error: (primaryError as Error).message
        });
        
        // Try fallback if primary fails completely
        if (networkConfig.fallback && this.isUpstreamHealthy(networkConfig.fallback.url)) {
          try {
            response = await this.makeRequestWithRetry(
              requestBody, 
              networkConfig.fallback.url, 
              networkKey, 
              retries, 
              timeoutMs
            );
            upstreamUsed = 'fallback';
          } catch (fallbackError) {
            this.logger.debug('Fallback upstream failed', {
              method: requestBody.method,
              requestId: requestBody.id,
              networkKey,
              fallbackUrl: networkConfig.fallback.url,
              error: (fallbackError as Error).message
            });
            // If both primary and fallback fail, throw the most recent error (fallback)
            // This provides better error context for debugging
            throw fallbackError;
          }
        } else if (networkConfig.fallback && !this.isUpstreamHealthy(networkConfig.fallback.url)) {
          this.logger.warn('Both primary and fallback upstreams are unhealthy', {
            method: requestBody.method,
            requestId: requestBody.id,
            networkKey,
            primaryUrl: networkConfig.primary.url,
            fallbackUrl: networkConfig.fallback.url
          });
          throw primaryError;
        } else {
          throw primaryError;
        }
      }
      
      // Log which upstream was used
      this.logger.info('RPC request completed', {
        method: requestBody.method,
        requestId: requestBody.id,
        networkKey,
        upstreamUsed,
        hasResult: response.data && response.data.result !== null
      });
      
      return response;
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

  // Smart fallback logic for subgraph syncing
  private shouldTryFallback(requestBody: JSONRPCRequest, responseData: any): boolean {
    // Subgraph-critical methods that need fallback
    const subgraphCriticalMethods = [
      'eth_call',
      'eth_getLogs', 
      'eth_getBlockByNumber',
      'eth_getBlockByHash',
      'eth_getBlockReceipts',
      'eth_getTransactionReceipt',
      'eth_getStorageAt',
      'eth_getBalance'
    ];
    
    if (!subgraphCriticalMethods.includes(requestBody.method)) return false;
    
    const params = Array.isArray(requestBody.params) ? requestBody.params : [];
    
    // Check if it's a historical request (not "latest" or "pending")
    const isHistorical = this.isHistoricalRequest(params);
    
    if (isHistorical) {
      // Try fallback for JSON-RPC errors on historical calls
      if (responseData?.error?.code === -32000) {
        return true; // "missing trie node" error
      }
      
      // Try fallback for other common historical data errors
      if (responseData?.error?.code === -32801) {
        return true; // "no historical RPC available" error
      }
      
      // Try fallback for empty results on historical requests
      if (responseData?.result === null || responseData?.result === undefined) {
        return true; // Missing data
      }
      
      // For eth_getLogs, try fallback if empty array (might indicate missing events)
      if (requestBody.method === 'eth_getLogs' && Array.isArray(responseData?.result) && responseData.result.length === 0) {
        return true; // Empty logs might indicate missing events
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

  // Track upstream health
  private recordUpstreamSuccess(url: string): void {
    const health = this.upstreamHealth.get(url) || {
      isHealthy: true,
      lastFailure: 0,
      consecutiveFailures: 0,
      lastSuccess: 0
    };
    
    health.isHealthy = true;
    health.consecutiveFailures = 0;
    health.lastSuccess = Date.now();
    
    this.upstreamHealth.set(url, health);
  }

  private recordUpstreamFailure(url: string): void {
    const health = this.upstreamHealth.get(url) || {
      isHealthy: true,
      lastFailure: 0,
      consecutiveFailures: 0,
      lastSuccess: 0
    };
    
    health.consecutiveFailures++;
    health.lastFailure = Date.now();
    
    // Mark as unhealthy after 3 consecutive failures
    if (health.consecutiveFailures >= 3) {
      health.isHealthy = false;
      this.logger.warn('Upstream marked as unhealthy', {
        url,
        consecutiveFailures: health.consecutiveFailures
      });
    }
    
    this.upstreamHealth.set(url, health);
  }

  private isUpstreamHealthy(url: string): boolean {
    const health = this.upstreamHealth.get(url);
    if (!health) return true; // Assume healthy if no data
    
    // Auto-recovery after 5 minutes
    if (!health.isHealthy && Date.now() - health.lastFailure > 300000) {
      health.isHealthy = true;
      health.consecutiveFailures = 0;
      this.upstreamHealth.set(url, health);
      this.logger.info('Upstream auto-recovered', { url });
    }
    
    return health.isHealthy;
  }

  // Enhanced upstream method with retry logic and health tracking
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
        this.recordUpstreamSuccess(url);
        return response;
      } catch (error) {
        lastError = error as Error;
        const axiosError = error as AxiosError;
        
        this.recordUpstreamFailure(url);
        
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
          url,
          upstreamHealthy: this.isUpstreamHealthy(url)
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

  // Get upstream health status for monitoring
  getUpstreamHealth(): Record<string, {
    isHealthy: boolean;
    lastFailure: number;
    consecutiveFailures: number;
    lastSuccess: number;
  }> {
    const health: Record<string, any> = {};
    for (const [url, status] of this.upstreamHealth.entries()) {
      health[url] = {
        isHealthy: status.isHealthy,
        lastFailure: status.lastFailure,
        consecutiveFailures: status.consecutiveFailures,
        lastSuccess: status.lastSuccess,
        timeSinceLastFailure: status.lastFailure ? Date.now() - status.lastFailure : null,
        timeSinceLastSuccess: status.lastSuccess ? Date.now() - status.lastSuccess : null
      };
    }
    return health;
  }
}
