/**
 * Simplified Application Configuration Types
 */

export interface ProxyConfig {
  server: ServerConfig;
  rpc: RPCConfig;
  cache: CacheConfig;
  rateLimit: RateLimitConfig;
  cors: CorsConfig;
  helmet: HelmetConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
  environment: string;
}

export interface RPCConfig {
  url: string;
  timeout: number;
  retries: number;
  initialTimeoutMs: number;
  networks: Record<string, any>;
  batchConcurrencyLimit: number;
  batchTimeout: number;
}

export interface CacheConfig {
  maxAge: number;
  dbFile?: string;
  maxSize: number;
  enableDb: boolean;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface CorsConfig {
  enabled: boolean;
  origin: string;
  credentials: boolean;
}

export interface HelmetConfig {
  enabled: boolean;
  contentSecurityPolicy: boolean;
}