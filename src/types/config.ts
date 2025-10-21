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
  log_level?: string;
}

export interface UpstreamConfig {
  url: string;
  timeout?: number;
  retries?: number;
  retry_delay?: number;
  weight?: number; // For load balancing
  priority?: number; // For failover order
}

export interface NetworkConfig {
  primary: UpstreamConfig;
  fallbacks?: UpstreamConfig[];
  timeout?: number;
  retries?: number;
  retry_delay?: number;
  failover_strategy?: 'immediate' | 'circuit_breaker' | 'health_check';
  health_check_interval?: number;
}

export interface RPCConfig {
  url: string;
  timeout: number;
  retries: number;
  initialTimeoutMs: number;
  networks: Record<string, NetworkConfig>;
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