/**
 * Application Configuration Types
 */

export interface ProxyConfig {
  server: ServerConfig;
  rpc: RPCConfig;
  cache: CacheConfig;
  rateLimit: RateLimitConfig;
  logging: LoggingConfig;
  security: SecurityConfig;
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
}

export interface CacheConfig {
  maxAge: number;
  dbFile?: string;
  maxSize: number;
  enableDb: boolean;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface LoggingConfig {
  level: string;
  enableConsole: boolean;
}

export interface SecurityConfig {
  allowedOrigins: string[];
  enableHelmet: boolean;
  enableCors: boolean;
}