/**
 * JSON-RPC 2.0 Type Definitions
 */

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown[];
  id: string | number | null;
}

export interface JSONRPCResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Cache-related types
 */
export interface CacheEntry {
  val: unknown;
  ts: number;
  readCnt: number;
  writeCnt: number;
  compressed?: boolean;
  originalSize?: number;
  compressedSize?: number;
}

export interface DatabaseRow {
  val: string;
  ts: number;
}

/**
 * Statistics and monitoring types
 */
export interface ProxyStats {
  httpRequestsProcessed: number;
  httpUpstreamResponses: number;
  httpCachedResponses: number;
  websocketConnections: number;
  cacheHits: number;
  cacheMisses: number;
  uptime: number;
}

export interface CacheStats {
  memoryEntries: number;
  readCount: number;
  writeCount: number;
}

/**
 * Health check response type
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  version: string;
  upstream: 'connected' | 'disconnected' | 'unknown';
}
