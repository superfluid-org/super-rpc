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
